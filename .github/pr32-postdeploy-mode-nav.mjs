import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const EXPECTED_SHA = process.env.EXPECTED_SHA
const OUT = 'qa-artifacts/pr32-postdeploy-mode-nav'
const LABELS = ['조건으로 찾기', '제품 찾기', '현재 사료']
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
  const port = 9750 + (process.pid % 150)
  const dir = `/tmp/pr32-postdeploy-${process.pid}`
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

async function pointer(c, label) {
  const value = await c.eval(`(()=>{const norm=v=>(v||'').replace(/\\s+/g,' ').trim(),n=[...document.querySelectorAll('.mode-nav .mode-button')].find(x=>norm(x.textContent)===${js(label)});if(!n)return null;n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{rect:[r.left,r.top,r.width,r.height],x,y,centerHit:Boolean(h&&(h===n||n.contains(h))),disabled:Boolean(n.disabled)}})()`)
  assert.ok(value, `missing mode button ${label}`)
  assert.equal(value.centerHit, true, `pointer center unavailable ${label}`)
  assert.equal(value.disabled, false, `mode button disabled ${label}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: value.x, y: value.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 })
  await sleep(250)
  return value
}

async function waitMode(c, mode) {
  if (mode === 'lookup') return c.wait(`document.querySelector('.lookup-input')&&!document.querySelector('.switch-find-stage,.switch-step-layout,.switch-results-stage')`, 'LOOKUP')
  if (mode === 'explore') return c.wait(`document.querySelector('.condition-group-title')&&!document.querySelector('.lookup-input')&&!document.querySelector('.switch-find-stage,.switch-step-layout,.switch-results-stage')`, 'EXPLORE')
  return c.wait(`document.querySelector('.switch-find-stage,.switch-step-layout,.switch-results-stage')`, 'SWITCH')
}

async function measure(c) {
  return c.eval(`(()=>{const nav=document.querySelector('.mode-nav');if(!nav)return null;const ns=getComputedStyle(nav),nr=nav.getBoundingClientRect();const buttons=[...nav.querySelectorAll('.mode-button')].map(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y),range=document.createRange();range.selectNodeContents(n);return{text:n.textContent.replace(/\\s+/g,' ').trim(),ariaCurrent:n.getAttribute('aria-current'),className:n.className,rect:[r.left,r.top,r.width,r.height],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,whiteSpace:s.whiteSpace,textRects:[...range.getClientRects()].length,centerHit:Boolean(h&&(h===n||n.contains(h)))}});return{href:location.href,viewport:{innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,dpr:devicePixelRatio},document:{scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},nav:{rect:[nr.left,nr.top,nr.width,nr.height],clientWidth:nav.clientWidth,scrollWidth:nav.scrollWidth,clientHeight:nav.clientHeight,scrollHeight:nav.scrollHeight,overflowX:ns.overflowX,overflowY:ns.overflowY},buttons}})()`)
}

function assertMode(value, activeLabel) {
  assert.ok(value, `missing layout ${activeLabel}`)
  assert.equal(value.viewport.innerWidth, 360, `innerWidth ${activeLabel}`)
  assert.equal(value.viewport.innerHeight, 844, `innerHeight ${activeLabel}`)
  assert.equal(value.viewport.dpr, 1, `DPR ${activeLabel}`)
  assert.deepEqual(value.buttons.map((button) => button.text), LABELS, `labels ${activeLabel}`)
  assert.equal(value.buttons.filter((button) => button.ariaCurrent === 'page').length, 1, `aria-current count ${activeLabel}`)
  assert.equal(value.buttons.find((button) => button.ariaCurrent === 'page')?.text, activeLabel, `active mode ${activeLabel}`)
  assert.ok(value.nav.scrollWidth <= value.nav.clientWidth + 1, `nav horizontal scrollbar ${activeLabel}: ${JSON.stringify(value.nav)}`)
  assert.ok(value.nav.scrollHeight <= value.nav.clientHeight + 1, `nav vertical scrollbar ${activeLabel}: ${JSON.stringify(value.nav)}`)
  for (const button of value.buttons) {
    assert.ok(Math.abs(button.rect[3] - 48) <= 1, `button height ${activeLabel}: ${JSON.stringify(button)}`)
    assert.ok(button.scrollWidth <= button.clientWidth + 1, `button horizontal overflow ${activeLabel}: ${JSON.stringify(button)}`)
    assert.ok(button.scrollHeight <= button.clientHeight + 1, `button vertical overflow ${activeLabel}: ${JSON.stringify(button)}`)
    assert.equal(button.textRects, 1, `wrapped label ${activeLabel}: ${button.text}`)
    assert.equal(button.whiteSpace, 'nowrap', `white-space ${activeLabel}: ${button.text}`)
    assert.equal(button.centerHit, true, `pointer hit ${activeLabel}: ${button.text}`)
  }
}

const report = { expectedSha: EXPECTED_SHA, url: BASE, viewport: [360, 844], environment: 'GitHub-hosted Chrome, classic scrollbar forced, DPR=1, ko-KR', status: 'running' }
let browser
try {
  browser = await launch()
  report.chrome = browser.version
  const { c } = browser
  await c.nav(`${BASE}?view=workspace&mode=lookup`)
  await waitMode(c, 'lookup')
  report.lookup = await measure(c)
  assertMode(report.lookup, '제품 찾기')

  report.pointerToExplore = await pointer(c, '조건으로 찾기')
  await waitMode(c, 'explore')
  report.explore = await measure(c)
  assertMode(report.explore, '조건으로 찾기')
  assert.ok(report.explore.viewport.innerWidth - report.explore.viewport.clientWidth >= 14, `classic scrollbar did not consume width: ${JSON.stringify(report.explore.viewport)}`)
  await c.shot(`${OUT}/360x844-explore.png`)

  report.pointerToSwitch = await pointer(c, '현재 사료')
  await waitMode(c, 'switch')
  report.switch = await measure(c)
  assertMode(report.switch, '현재 사료')

  const sentAnalytics = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  report.network = {
    blocked: await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`),
    sentAnalytics,
    sentWrites,
    publicReads: c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && request.method === 'GET').length,
  }
  assert.equal(report.network.blocked.analytics, 0, `analytics attempt blocked: ${JSON.stringify(report.network)}`)
  assert.equal(report.network.blocked.writes, 0, `write attempt blocked: ${JSON.stringify(report.network)}`)
  assert.equal(sentAnalytics.length, 0, `analytics request sent: ${JSON.stringify(sentAnalytics)}`)
  assert.equal(sentWrites.length, 0, `write request sent: ${JSON.stringify(sentWrites)}`)
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR32_POSTDEPLOY_PASS', JSON.stringify({
    expectedSha: EXPECTED_SHA,
    lookup: report.lookup.buttons.map((button) => [button.text, button.rect[3], button.ariaCurrent]),
    exploreViewport: report.explore.viewport,
    exploreNav: report.explore.nav,
    explore: report.explore.buttons.map((button) => [button.text, button.rect[3], button.ariaCurrent]),
    switch: report.switch.buttons.map((button) => [button.text, button.rect[3], button.ariaCurrent]),
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
