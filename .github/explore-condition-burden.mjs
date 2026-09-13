import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const EXPECTED_SHA = process.env.EXPECTED_SHA
const OUT = 'qa-artifacts/explore-condition-burden'
mkdirSync(OUT, { recursive: true })
assert.ok(EXPECTED_SHA, 'EXPECTED_SHA is required')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = []
  }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') {
        this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      }
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(method)
    await this.send('Network.setCacheDisabled', { cacheDisabled: true })
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
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, ms = 45000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'app root')
    await this.eval('document.fonts?.ready')
    await sleep(300)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(100)
    const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(image.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9780 + (process.pid % 150)
  const dir = `/tmp/explore-burden-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    '--disable-features=OverlayScrollbar', '--force-device-scale-factor=1', `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: false, screenWidth: 360, screenHeight: 844 })
        await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Linux x86_64' })
        return { c, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function pointerElement(c, expression, label) {
  const value = await c.eval(`(()=>{const n=${expression};if(!n)return null;n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,centerHit:Boolean(h&&(h===n||n.contains(h))),disabled:Boolean(n.disabled)}})()`)
  assert.ok(value, `missing ${label}`)
  assert.equal(value.centerHit, true, `pointer center unavailable ${label}`)
  assert.equal(value.disabled, false, `disabled ${label}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: value.x, y: value.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 })
  return value
}

async function editorMeasure(c) {
  return c.eval(`(()=>{const n=document.querySelector('.condition-actions .primary-action');if(!n)return null;const r=n.getBoundingClientRect(),root=document.documentElement;const selected=[...document.querySelectorAll('.research-filter-scroll .choice[aria-pressed="true"]')].map(x=>x.textContent.replace(/\\s+/g,' ').trim());const headings=[...document.querySelectorAll('.condition-group-title')].map(x=>x.textContent.replace(/\\s+/g,' ').trim());const filters=[...document.querySelectorAll('.research-filter-scroll .filter-section')].map(s=>({heading:s.querySelector('.filter-heading')?.textContent.replace(/\\s+/g,' ').trim()||'',note:[...s.querySelectorAll('.field-note')].map(x=>x.textContent.replace(/\\s+/g,' ').trim())}));return{href:location.href,viewport:{innerWidth,innerHeight,clientWidth:root.clientWidth,clientHeight:root.clientHeight,dpr:devicePixelRatio},document:{scrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight,scrollY,bodyScrollHeight:document.body.scrollHeight},apply:{rect:[r.left,r.top,r.width,r.height],docTop:r.top+scrollY,docBottom:r.bottom+scrollY,inViewport:r.top>=0&&r.bottom<=innerHeight,minScrollToFullyReveal:Math.max(0,Math.ceil(r.bottom+scrollY-innerHeight)),maxScroll:Math.max(0,root.scrollHeight-innerHeight)},selected,headings,filters,summaryUi:{criteriaBar:Boolean(document.querySelector('.criteria-bar')),conditionSummary:Boolean(document.querySelector('.condition-summary')),visibleCountText:[...document.querySelectorAll('.research-filter-scroll *')].some(x=>/선택.*\\d|\\d.*선택/.test(x.textContent||''))}}})()`)
}

async function revealApply(c) {
  await c.eval(`document.querySelector('.condition-actions .primary-action')?.scrollIntoView({block:'end',behavior:'instant'})`)
  await sleep(150)
  return editorMeasure(c)
}

async function resultMeasure(c) {
  return c.eval(`(()=>({href:location.href,scrollY,criteria:[...document.querySelectorAll('.criteria-chips span')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),heading:document.querySelector('.research-results-heading')?.textContent.replace(/\\s+/g,' ').trim()||'',cards:document.querySelectorAll('.research-result-card').length,firstCards:[...document.querySelectorAll('.research-result-card')].slice(0,3).map(x=>x.textContent.replace(/\\s+/g,' ').trim()),hasCriteriaBar:Boolean(document.querySelector('.criteria-bar')),hasConditionEditor:Boolean(document.querySelector('.condition-actions'))}))()`)
}

const report = { expectedSha: EXPECTED_SHA, url: BASE, viewport: [360, 844], environment: 'GitHub-hosted Chrome, classic scrollbar forced, DPR=1, ko-KR', status: 'running' }
let browser
try {
  browser = await launch()
  report.chrome = browser.version
  const { c } = browser

  await c.nav(`${BASE}?view=workspace`)
  await c.wait(`document.querySelector('.condition-actions .primary-action')`, 'initial EXPLORE editor')
  await c.eval('scrollTo(0,0)')
  await sleep(100)
  report.initialNoSelection = await editorMeasure(c)
  assert.ok(report.initialNoSelection, 'initial editor unavailable')
  assert.deepEqual(report.initialNoSelection.selected, [], 'initial editor should have no selected conditions')
  assert.equal(new URL(report.initialNoSelection.href).searchParams.has('mode'), false, 'EXPLORE should omit mode')
  await c.shot(`${OUT}/01-initial-editor-top.png`)
  report.initialNoSelectionReveal = await revealApply(c)

  await pointerElement(c, `document.querySelector('.condition-actions .primary-action')`, 'no-condition apply')
  await c.wait(`new URL(location.href).searchParams.get('applied')==='1'&&document.querySelector('.criteria-bar')&&document.querySelector('.research-result-card')`, 'no-condition results')
  report.noConditionResult = await resultMeasure(c)
  assert.equal(new URL(report.noConditionResult.href).searchParams.has('mode'), false, 'applied EXPLORE should omit mode')
  assert.deepEqual(report.noConditionResult.criteria, ['추가 조건 없음'], 'no-condition criteria summary')

  await pointerElement(c, `document.querySelector('.criteria-bar > button')`, 'edit conditions after no-condition apply')
  await c.wait(`document.querySelector('.condition-actions .primary-action')`, 'editor after no-condition apply')
  await c.eval('scrollTo(0,0)')
  await sleep(100)
  report.reenteredNoSelection = await editorMeasure(c)
  assert.deepEqual(report.reenteredNoSelection.selected, [], 'no-condition re-entry draft')

  const dryExpression = `(()=>{const norm=v=>(v||'').replace(/\\s+/g,' ').trim();const section=[...document.querySelectorAll('.filter-section')].find(s=>norm(s.querySelector('.filter-heading')?.textContent||'').startsWith('사료 형태'));return section?[...section.querySelectorAll('.choice')].find(x=>norm(x.textContent)==='건식'):null})()`
  await pointerElement(c, dryExpression, 'dry condition')
  await c.wait(`(${dryExpression})?.getAttribute('aria-pressed')==='true'`, 'dry selection state')
  await c.eval('scrollTo(0,0)')
  await sleep(100)
  report.drySelected = await editorMeasure(c)
  assert.deepEqual(report.drySelected.selected, ['건식'], 'dry-only editor selection')
  report.drySelectedReveal = await revealApply(c)
  await c.shot(`${OUT}/02-dry-editor-apply.png`)

  await pointerElement(c, `document.querySelector('.condition-actions .primary-action')`, 'dry apply')
  await c.wait(`new URL(location.href).searchParams.get('applied')==='1'&&new URL(location.href).searchParams.get('feed')==='건식'&&document.querySelector('.criteria-bar')&&document.querySelector('.research-result-card')`, 'dry results')
  report.dryResult = await resultMeasure(c)
  assert.equal(new URL(report.dryResult.href).searchParams.has('mode'), false, 'dry EXPLORE should omit mode')
  assert.deepEqual(report.dryResult.criteria, ['건식'], 'dry criteria summary')
  await c.eval('scrollTo(0,0)')
  await sleep(100)
  await c.shot(`${OUT}/03-dry-result.png`)

  await pointerElement(c, `document.querySelector('.criteria-bar > button')`, 'edit conditions after dry apply')
  await c.wait(`document.querySelector('.condition-actions .primary-action')`, 'dry editor re-entry')
  await c.wait(`(${dryExpression})?.getAttribute('aria-pressed')==='true'`, 'dry draft restored')
  await c.eval('scrollTo(0,0)')
  await sleep(100)
  report.dryReentry = await editorMeasure(c)
  assert.deepEqual(report.dryReentry.selected, ['건식'], 'applied dry should restore into draft')
  assert.equal(new URL(report.dryReentry.href).searchParams.get('feed'), '건식', 'applied feed remains in editing URL')
  assert.equal(new URL(report.dryReentry.href).searchParams.has('applied'), false, 'editing URL should not be applied')

  await pointerElement(c, `document.querySelector('.condition-actions .secondary-action')`, 'reset draft')
  await c.wait(`document.querySelectorAll('.research-filter-scroll .choice[aria-pressed="true"]').length===0`, 'reset draft state')
  await c.eval('scrollTo(0,0)')
  await sleep(100)
  report.afterReset = await editorMeasure(c)
  assert.deepEqual(report.afterReset.selected, [], 'reset should clear draft')
  assert.equal(new URL(report.afterReset.href).searchParams.get('feed'), '건식', 'reset must not clear applied feed from URL before apply')
  assert.equal(new URL(report.afterReset.href).searchParams.has('applied'), false, 'reset remains editing state')

  const sentAnalytics = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  report.network = {
    blocked: await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`),
    sentAnalytics,
    sentWrites,
    publicReads: c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && request.method === 'GET').length,
  }
  assert.equal(sentAnalytics.length, 0, `analytics request escaped block: ${JSON.stringify(sentAnalytics)}`)
  assert.equal(sentWrites.length, 0, `write request escaped block: ${JSON.stringify(sentWrites)}`)
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('EXPLORE_CONDITION_BURDEN_PASS', JSON.stringify({
    expectedSha: EXPECTED_SHA,
    initial: report.initialNoSelection,
    initialReveal: report.initialNoSelectionReveal,
    noConditionResult: report.noConditionResult,
    dry: report.drySelected,
    dryReveal: report.drySelectedReveal,
    dryResult: report.dryResult,
    dryReentry: report.dryReentry,
    afterReset: report.afterReset,
    network: report.network,
  }))
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  if (browser) {
    browser.c.close()
    try { browser.proc.kill('SIGTERM') } catch {}
    await sleep(250)
    try { rmSync(browser.dir, { recursive: true, force: true }) } catch {}
  }
}
