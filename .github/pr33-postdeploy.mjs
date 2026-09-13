import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/?view=workspace'
const OUT = 'qa-artifacts/pr33-postdeploy'
const MERGE_SHA = process.env.MERGE_SHA
mkdirSync(OUT, { recursive: true })
assert.equal(MERGE_SHA, '7fd488d226eba38080c73b95b6e4735f868a0bf7')

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
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const nativeFetch=window.fetch.bind(window);const nativeBeacon=navigator.sendBeacon?.bind(navigator);window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return Promise.resolve(url.endsWith('/search-runs')?Response.json({search_run_id:'qa-run'}):Response.json({ok:true}))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1;return Promise.resolve(Response.json({ok:true}))}return nativeFetch(input,init)};if(nativeBeacon){navigator.sendBeacon=(url,data)=>{const u=String(url||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return true}return nativeBeacon(url,data)}}})();` })
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
  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height })
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'app root')
    await this.eval('document.fonts?.ready')
    await this.wait(`document.querySelector('.research-status span:last-child')?.textContent.includes('데이터 연결됨')`, 'catalog loaded')
    await sleep(250)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(100)
    const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(image.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launchBrowser() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9930 + (process.pid % 60)
  const dir = `/tmp/pr33-postdeploy-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    '--disable-features=OverlayScrollbar', '--force-device-scale-factor=1', `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Linux x86_64' })
        return { c, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function clickSelector(c, selector) {
  const target = await c.eval(`(()=>{const n=document.querySelector(${js(selector)});if(!n)return null;n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,disabled:Boolean(n.disabled),centerHit:Boolean(h&&(h===n||n.contains(h)))}})()`)
  assert.ok(target, `missing selector ${selector}`)
  assert.equal(target.disabled, false, `disabled selector ${selector}`)
  assert.equal(target.centerHit, true, `pointer center unavailable ${selector}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await sleep(140)
}

async function clickText(c, text) {
  const selector = await c.eval(`(()=>{const all=[...document.querySelectorAll('button')];const index=all.findIndex(n=>(n.textContent||'').replace(/\\s+/g,' ').trim()===${js(text)});return index})()`)
  assert.ok(selector >= 0, `missing button ${text}`)
  const target = await c.eval(`(()=>{const n=[...document.querySelectorAll('button')][${selector}];n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,disabled:Boolean(n.disabled),centerHit:Boolean(h&&(h===n||n.contains(h)))}})()`)
  assert.equal(target.disabled, false, `disabled button ${text}`)
  assert.equal(target.centerHit, true, `pointer center unavailable ${text}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await sleep(140)
}

async function measure(c) {
  await c.eval('window.scrollTo(0,0)')
  await sleep(60)
  return c.eval(`(()=>{const toggle=document.querySelector('.mobile-additional-toggle');const panel=document.querySelector('#explore-additional-conditions');const count=document.querySelector('.condition-draft-count');const summary=document.querySelector('.mobile-additional-summary');const meaning=document.querySelector('.desktop-additional-title');const apply=[...document.querySelectorAll('.condition-actions button')].find(n=>(n.textContent||'').includes('이 조건으로 찾기'));const ar=apply?.getBoundingClientRect();return{href:location.href,countText:(count?.textContent||'').replace(/\\s+/g,' ').trim(),toggle:toggle?{expanded:toggle.getAttribute('aria-expanded'),text:(toggle.textContent||'').replace(/\\s+/g,' ').trim()}:null,meaning:{display:meaning?getComputedStyle(meaning).display:null,text:(meaning?.textContent||'').replace(/\\s+/g,' ').trim()},summary:(summary?.textContent||'').replace(/\\s+/g,' ').trim(),visibleAdditionalButtons:panel?[...panel.querySelectorAll('button')].filter(n=>n.getClientRects().length>0).length:0,apply:ar?{docTop:ar.top+scrollY,docBottom:ar.bottom+scrollY,minScrollForFull:Math.max(0,ar.bottom+scrollY-innerHeight)}:null,viewport:{width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth},document:{scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}}})()`)
}

const report = { mergeSha: MERGE_SHA, url: BASE, status: 'running' }
let browser
try {
  browser = await launchBrowser()
  const { c } = browser
  await c.viewport(360, 844)
  await c.nav(BASE)
  await c.wait(`document.querySelector('.mobile-additional-toggle')`, 'initial disclosure')

  const initial = await measure(c)
  assert.equal(initial.viewport.width, 360)
  assert.equal(initial.toggle.expanded, 'false')
  assert.equal(initial.countText, '선택한 조건 0개')
  assert.match(initial.toggle.text, /선택 없음/)
  assert.notEqual(initial.meaning.display, 'none')
  assert.match(initial.meaning.text, /미확인은 후보에 유지/)
  assert.equal(initial.visibleAdditionalButtons, 0)
  assert.ok(initial.document.scrollWidth <= initial.viewport.clientWidth + 1)
  await c.shot(`${OUT}/01-360-initial-collapsed.png`)

  await clickText(c, '건식')
  await c.wait(`document.querySelector('.condition-draft-count')?.textContent.includes('1개')`, 'dry selected')
  const dry = await measure(c)
  assert.equal(dry.countText, '선택한 조건 1개')
  assert.equal(dry.toggle.expanded, 'false')

  await clickSelector(c, '.mobile-additional-toggle')
  await c.wait(`document.querySelector('.mobile-additional-toggle')?.getAttribute('aria-expanded')==='true'`, 'additional open')
  await clickText(c, '실내묘')
  await c.wait(`document.querySelector('.condition-draft-count')?.textContent.includes('2개')`, 'indoor selected')
  await clickSelector(c, '.mobile-additional-toggle')
  await c.wait(`document.querySelector('.mobile-additional-toggle')?.getAttribute('aria-expanded')==='false'`, 'additional collapsed')
  const selectedCollapsed = await measure(c)
  assert.equal(selectedCollapsed.countText, '선택한 조건 2개')
  assert.match(selectedCollapsed.toggle.text, /1개 선택/)
  assert.match(selectedCollapsed.summary, /실내묘/)
  assert.equal(selectedCollapsed.visibleAdditionalButtons, 0)

  await clickText(c, '이 조건으로 찾기')
  await c.wait(`new URLSearchParams(location.search).get('applied')==='1'&&document.querySelector('.criteria-bar')`, 'applied')
  const appliedHref = await c.eval('location.href')
  const params = new URL(appliedHref).searchParams
  assert.equal(params.get('feed'), '건식')
  assert.equal(params.get('targets'), 'indoor')

  await clickText(c, '조건 수정')
  await c.wait(`document.querySelector('.mobile-additional-toggle')?.getAttribute('aria-expanded')==='true'`, 'edit restored open')
  const restored = await measure(c)
  assert.equal(restored.countText, '선택한 조건 2개')
  assert.equal(restored.toggle.expanded, 'true')
  const restoredSelection = await c.eval(`(()=>{const buttons=[...document.querySelectorAll('button.choice[aria-pressed="true"]')];return buttons.map(n=>(n.textContent||'').trim())})()`)
  assert.ok(restoredSelection.includes('건식'))
  assert.ok(restoredSelection.includes('실내묘'))
  await c.shot(`${OUT}/02-360-edit-restored-expanded.png`)

  const blocker = await c.eval(`({blockedAnalytics:window.__qaBlockedAnalytics||0,blockedWrites:window.__qaBlockedWrites||0})`)
  const actualDecisionRequests = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const actualProductionWrites = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(request.method))
  const publicGets = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && request.method === 'GET')
  assert.equal(actualDecisionRequests.length, 0, `analytics escaped blocker: ${JSON.stringify(actualDecisionRequests)}`)
  assert.equal(actualProductionWrites.length, 0, `production write escaped blocker: ${JSON.stringify(actualProductionWrites)}`)
  assert.ok(publicGets.length > 0, 'expected public Supabase GET requests')

  report.status = 'pass'
  report.initial = initial
  report.dry = dry
  report.selectedCollapsed = selectedCollapsed
  report.restored = restored
  report.restoredSelection = restoredSelection
  report.network = { blocker, actualDecisionRequests, actualProductionWrites, publicGetCount: publicGets.length }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR33_POSTDEPLOY_PASS', JSON.stringify({ mergeSha: MERGE_SHA, dryApplyScroll: dry.apply.minScrollForFull, blocker, actualDecisionRequests: actualDecisionRequests.length, actualProductionWrites: actualProductionWrites.length, publicGetCount: publicGets.length }))
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
