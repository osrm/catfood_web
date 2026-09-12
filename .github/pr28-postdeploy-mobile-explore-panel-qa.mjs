import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const LIVE = 'https://osrm.github.io/catfood_web/'
const TARGET_SHA = process.env.TARGET_SHA
const OUT = 'qa-artifacts/pr28-postdeploy-mobile-explore-panel'
const WIDTH = 360
const HEIGHT = 844
mkdirSync(OUT, { recursive: true })
assert.ok(TARGET_SHA, 'TARGET_SHA is required')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const js = value => JSON.stringify(value)

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })
    this.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data)
      if (m.method === 'Network.requestWillBeSent') this.requests.push({ url: m.params.request.url, method: m.params.request.method })
      const p = m.id ? this.pending.get(m.id) : null
      if (!p) return
      this.pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'CSS.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const nativeFetch=window.fetch.bind(window);const nativeBeacon=navigator.sendBeacon?.bind(navigator);window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return Promise.resolve(new Response(null,{status:204}))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1;return Promise.resolve(new Response(null,{status:204}))}return nativeFetch(input,init)};if(nativeBeacon){navigator.sendBeacon=(url,data)=>{const u=String(url||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return true}return nativeBeacon(url,data)}}})();` })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const x = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text)
    return x.result?.value
  }
  async wait(expression, label, ms = 45000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'root')
    await this.eval('document.fonts?.ready')
    await sleep(250)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(100)
    const x = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(x.data, 'base64'))
  }
  async fonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId, `font node missing ${selector}`)
    return (await this.send('CSS.getPlatformFontsForNode', { nodeId })).fonts ?? []
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9910 + (process.pid % 70)
  const dir = `/tmp/pr28-postdeploy-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find(x => x.type === 'page' && x.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: true, screenWidth: WIDTH, screenHeight: HEIGHT })
        await c.send('Emulation.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
          acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android'
        })
        return { c, proc, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function info(c, selector, text = null, index = 0) {
  return c.eval(`(()=>{const norm=v=>(v||'').replace(/\\s+/g,' ').trim(),all=[...document.querySelectorAll(${js(selector)})],list=${text === null ? 'all' : `all.filter(n=>norm(n.textContent)===${js(text)})`},n=list[${index}];if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=r.width>0&&r.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight?document.elementFromPoint(x,y):null;return{text:norm(n.textContent),rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],rendered:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,inViewport:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,centerHit:Boolean(h&&(h===n||n.contains(h))),disabled:Boolean(n.disabled),hit:h?.className||h?.tagName||null}})()`)
}

async function pointer(c, selector, text = null, index = 0) {
  const ok = await c.eval(`(()=>{const norm=v=>(v||'').replace(/\\s+/g,' ').trim(),all=[...document.querySelectorAll(${js(selector)})],list=${text === null ? 'all' : `all.filter(n=>norm(n.textContent)===${js(text)})`},n=list[${index}];if(!n)return false;n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});return true})()`)
  assert.equal(ok, true, `missing ${selector} ${text ?? ''}`)
  await sleep(100)
  const m = await info(c, selector, text, index)
  assert.ok(m?.rendered && m.inViewport && m.centerHit && !m.disabled, `unavailable ${JSON.stringify(m)}`)
  const x = m.rect[0] + m.rect[2] / 2
  const y = m.rect[1] + m.rect[3] / 2
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(220)
  return { ...m, x, y }
}

const exactButton = label => `(()=>{const norm=v=>(v||'').replace(/\\s+/g,' ').trim();return [...document.querySelectorAll('button')].find(n=>norm(n.textContent)===${js(label)})||null})()`

async function buttonInfo(c, label) {
  return c.eval(`(()=>{const n=${exactButton(label)};if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=(x>=0&&x<innerWidth&&y>=0&&y<innerHeight)?document.elementFromPoint(x,y):null;return{text:n.textContent.replace(/\\s+/g,' ').trim(),disabled:Boolean(n.disabled),rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],rendered:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,inViewport:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,centerHit:Boolean(h&&(h===n||n.contains(h))),hit:h?.className||h?.tagName||null}})()`)
}

async function wheelUntilButton(c, label) {
  for (let i = 0; i < 24; i++) {
    const m = await buttonInfo(c, label)
    if (m?.rendered && m.inViewport && m.centerHit && !m.disabled) return m
    const pos = await c.eval(`({x:Math.max(10,Math.floor(innerWidth/2)),y:Math.max(80,Math.floor(innerHeight*0.72))})`)
    const deltaY = m && m.rect[1] < 0 ? -460 : 460
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pos.x, y: pos.y, deltaX: 0, deltaY })
    await sleep(160)
  }
  throw new Error(`button not reachable by document wheel: ${label}`)
}

async function selectedLabels(c) {
  return c.eval(`(()=>[...document.querySelectorAll('.research-filter-scroll button[aria-pressed="true"]')].map(n=>n.textContent.replace(/\\s+/g,' ').trim()))()`)
}

async function editorMetrics(c) {
  return c.eval(`(()=>{const box=n=>{if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect();return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,scrollTop:n.scrollTop,overflowY:s.overflowY,maxHeight:s.maxHeight}};const panel=document.querySelector('.research-filters'),inner=document.querySelector('.research-filter-scroll'),actions=document.querySelector('.condition-actions'),sections=[...document.querySelectorAll('.filter-section')],last=sections.at(-1),p=box(panel),i=box(inner),a=box(actions),l=box(last),inside=(outer,child)=>Boolean(outer&&child&&child.rect[0]>=outer.rect[0]-1&&child.rect[4]<=outer.rect[4]+1&&child.rect[1]>=outer.rect[1]-1&&child.rect[5]<=outer.rect[5]+1),panelScrollable=Boolean(panel&&panel.scrollHeight>panel.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(panel).overflowY)),innerScrollable=Boolean(inner&&inner.scrollHeight>inner.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(inner).overflowY)),docScrollable=document.documentElement.scrollHeight>innerHeight+1;return{viewport:[innerWidth,innerHeight],panel:p,inner:i,actions:a,lastSection:l,actionsInsidePanelRect:inside(p,a),lastInsidePanelRect:inside(p,l),panelScrollable,innerScrollable,doubleVerticalScroll:Boolean(docScrollable&&(panelScrollable||innerScrollable)),document:{scrollY,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight,scrollable:docScrollable}}})()`)
}

function assertEditorContained(m, label) {
  assert.ok(m.panel && m.inner && m.actions && m.lastSection, `${label}: editor geometry missing`)
  assert.equal(m.panel.maxHeight, 'none', `${label}: panel max-height should be none`)
  assert.equal(m.actionsInsidePanelRect, true, `${label}: actions outside panel rect`)
  assert.equal(m.lastInsidePanelRect, true, `${label}: last condition outside panel rect`)
  assert.equal(m.panelScrollable, false, `${label}: panel became internal scroller`)
  assert.equal(m.innerScrollable, false, `${label}: filter content became internal scroller`)
  assert.equal(m.doubleVerticalScroll, false, `${label}: double vertical scroll`)
  assert.equal(m.document.scrollable, true, `${label}: document should carry scrolling`)
}

async function resultState(c) {
  return c.eval(`(()=>{const p=new URL(location.href).searchParams;return{url:location.href,params:Object.fromEntries(p.entries()),chips:[...document.querySelectorAll('.criteria-chips span')].map(n=>n.textContent.trim()),cards:[...document.querySelectorAll('.research-result-card')].slice(0,5).map(n=>({name:n.querySelector('.research-result-identity strong')?.textContent.trim()||null,meta:n.querySelector('.research-result-meta')?.textContent.trim()||null,relation:n.querySelector('.result-relations')?.textContent.replace(/\\s+/g,' ').trim()||null}))}})()`)
}

async function network(c) {
  const sentAnalytics = c.requests.filter(r => r.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter(r => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(r.method))
  return {
    blocked: await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`),
    sentAnalytics, sentWrites,
    publicReads: c.requests.filter(r => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && r.method === 'GET').length
  }
}

const report = { targetSha: TARGET_SHA, url: LIVE, viewport: [WIDTH, HEIGHT], status: 'running', captures: [] }
let browser
const shot = async (name) => {
  const file = `${OUT}/${name}.png`
  await browser.c.shot(file)
  report.captures.push(`${name}.png`)
}

try {
  browser = await launch()
  const c = browser.c
  report.chrome = browser.version
  await c.nav(LIVE)
  await c.wait(`/\\d/.test(document.querySelector('.home-search-console-copy small')?.textContent||'')`, 'catalog loaded')
  await pointer(c, 'button', '조건 고르기 →')
  await c.wait(`document.querySelector('.condition-actions')&&document.querySelector('.research-filter-scroll')`, 'initial condition editor')
  report.fonts = await c.fonts('.research-pane-heading strong')
  assert.ok(report.fonts.some(f => f.familyName.includes('Noto Sans CJK KR')), 'Korean font mismatch')

  await c.eval('scrollTo(0,0)')
  report.initialTop = await editorMetrics(c)
  assertEditorContained(report.initialTop, 'initial top')
  await shot('360x844-01-initial-top')

  await pointer(c, 'button', '건식')
  await pointer(c, 'button', '실내묘')
  await pointer(c, 'button', '체중 관리')
  report.initialSelected = await selectedLabels(c)
  assert.deepEqual([...report.initialSelected].sort(), ['건식', '실내묘', '체중 관리'].sort())

  report.lastReach = await wheelUntilButton(c, 'Grain-Free 표기')
  report.applyReach = await wheelUntilButton(c, '이 조건으로 찾기')
  report.initialBottom = await editorMetrics(c)
  assertEditorContained(report.initialBottom, 'initial bottom')
  report.initialApply = await buttonInfo(c, '이 조건으로 찾기')
  report.initialReset = await buttonInfo(c, '초기화')
  assert.equal(report.initialApply?.centerHit, true, 'initial apply not hit-testable')
  assert.equal(report.initialReset?.centerHit, true, 'initial reset not hit-testable')
  await shot('360x844-02-initial-bottom-actions')
  await pointer(c, 'button', '이 조건으로 찾기')

  await c.wait(`document.querySelector('.criteria-bar')&&document.querySelectorAll('.research-result-card').length>0`, 'first applied results')
  report.firstApplied = await resultState(c)
  assert.equal(report.firstApplied.params.feed, '건식')
  assert.equal(report.firstApplied.params.targets, 'indoor')
  assert.equal(report.firstApplied.params.features, 'weight_management')
  for (const label of ['건식', '실내묘', '체중 관리']) assert.ok(report.firstApplied.chips.includes(label), `missing chip ${label}`)

  await c.eval('scrollTo(0,0)')
  await sleep(120)
  await pointer(c, '.criteria-bar button', '조건 수정')
  await c.wait(`document.querySelector('.condition-actions')`, 're-edit')
  await c.eval('scrollTo(0,0)')
  report.reeditTop = await editorMetrics(c)
  assertEditorContained(report.reeditTop, 're-edit top')
  report.reeditSelected = await selectedLabels(c)
  assert.deepEqual([...report.reeditSelected].sort(), ['건식', '실내묘', '체중 관리'].sort(), 'applied selections not restored')
  await shot('360x844-03-reedit-top')

  await pointer(c, 'button', '실내묘')
  await pointer(c, 'button', '중성화묘')
  await pointer(c, 'button', '체중 관리')
  await pointer(c, 'button', '헤어볼')
  report.changedSelected = await selectedLabels(c)
  assert.deepEqual([...report.changedSelected].sort(), ['건식', '중성화묘', '헤어볼'].sort(), 'changed draft mismatch')

  await wheelUntilButton(c, '이 조건으로 찾기')
  report.reeditBottom = await editorMetrics(c)
  assertEditorContained(report.reeditBottom, 're-edit bottom')
  report.reeditApply = await buttonInfo(c, '이 조건으로 찾기')
  report.reeditReset = await buttonInfo(c, '초기화')
  assert.equal(report.reeditApply?.centerHit, true, 're-edit apply not hit-testable')
  assert.equal(report.reeditReset?.centerHit, true, 're-edit reset not hit-testable')
  await shot('360x844-04-reedit-bottom-actions')
  await pointer(c, 'button', '이 조건으로 찾기')

  await c.wait(`document.querySelector('.criteria-bar')&&document.querySelectorAll('.research-result-card').length>0`, 'reapplied results')
  report.reapplied = await resultState(c)
  assert.equal(report.reapplied.params.feed, '건식')
  assert.equal(report.reapplied.params.targets, 'sterilized')
  assert.equal(report.reapplied.params.features, 'hairball')
  for (const label of ['건식', '중성화묘', '헤어볼']) assert.ok(report.reapplied.chips.includes(label), `missing reapplied chip ${label}`)
  assert.ok(report.reapplied.cards.length > 0 && report.reapplied.cards.every(x => x.meta?.includes('건식')), 'reapplied hard feed mismatch')
  assert.ok(report.reapplied.cards[0]?.relation?.includes('중성화묘') && report.reapplied.cards[0]?.relation?.includes('헤어볼'), 'reapplied relation summary mismatch')
  await c.eval('scrollTo(0,0)')
  await shot('360x844-05-reapplied-results')

  report.network = await network(c)
  assert.deepEqual(report.network.sentAnalytics, [], 'analytics request escaped blocker')
  assert.deepEqual(report.network.sentWrites, [], 'production write escaped blocker')
  report.status = 'pass'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (browser?.c) {
    try { await shot('360x844-99-failure') } catch {}
  }
  throw error
} finally {
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2) + '\n')
  if (browser) {
    browser.c.close()
    browser.proc.kill('SIGTERM')
    await sleep(180)
  }
}

console.log(JSON.stringify(report, null, 2))
