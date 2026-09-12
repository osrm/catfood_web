import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const ORIGIN = 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.MERGE_SHA || 'af8b3d01689ab5e2985f1a89256a0bc1a8aef7c5'
const OUT = 'qa-artifacts/pr30-retry-postdeploy'
const API_HOST = 'gnosbstdatkytsyxuapt.supabase.co'
const GO = { id: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리' }
const MONGE = { id: 'product_11dc2e0bf60b0874' }
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
let launchSeq = 0

function detailUrl() {
  const p = new URLSearchParams({ view: 'workspace', mode: 'lookup', q: GO.query, selected: GO.id, detail: GO.id, detailTab: 'nutrition' })
  return `${ORIGIN}?${p.toString()}`
}
function compareUrl() {
  const p = new URLSearchParams({ view: 'workspace', mode: 'lookup', q: 'go!', selected: GO.id, compare: `${GO.id},${MONGE.id}`, compareOpen: '1', compareTab: 'nutrition' })
  return `${ORIGIN}?${p.toString()}`
}
function viewFromUrl(url) {
  try {
    const u = new URL(url)
    const marker = '/rest/v1/'
    const i = u.pathname.indexOf(marker)
    return i >= 0 ? u.pathname.slice(i + marker.length).split('/')[0] || null : null
  } catch { return null }
}

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.rules = new Map()
    this.requests = []
    this.paused = []
    this.console = []
    this.exceptions = []
    this.blockedAnalytics = 0
    this.blockedWrites = 0
  }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Network.requestWillBeSent') {
        this.requests.push({ url: msg.params.request.url, method: msg.params.request.method, view: viewFromUrl(msg.params.request.url) })
      }
      if (msg.method === 'Runtime.consoleAPICalled') this.console.push({ type: msg.params.type, values: (msg.params.args || []).map((x) => x.value ?? x.description ?? x.type) })
      if (msg.method === 'Runtime.exceptionThrown') this.exceptions.push({ text: msg.params.exceptionDetails?.text ?? null, description: msg.params.exceptionDetails?.exception?.description ?? null })
      if (msg.method === 'Fetch.requestPaused') void this.handlePaused(msg.params)
      if (!msg.id) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    })
    for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(m)
    await this.send('Fetch.enable', { patterns: [
      { urlPattern: `*${API_HOST}/rest/v1/*`, requestStage: 'Request' },
      { urlPattern: `*${API_HOST}/functions/v1/decision-intake*`, requestStage: 'Request' },
    ] })
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch=window.fetch.bind(window);const nativeBeacon=navigator.sendBeacon?.bind(navigator);
      window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;
      window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics++;return Promise.resolve(new Response(null,{status:204}))}if(url.includes('${API_HOST}')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites++;return Promise.resolve(new Response(null,{status:204}))}return nativeFetch(input,init)};
      if(nativeBeacon){navigator.sendBeacon=(url,data)=>{const u=String(url||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics++;return true}return nativeBeacon(url,data)}}
    })();` })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, ms = 35000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`)) return
      await sleep(100)
    }
    throw new Error(`timeout waiting for ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document complete')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'React root')
    await this.eval('document.fonts?.ready')
    await sleep(150)
  }
  async shot(name) {
    await this.eval('document.fonts?.ready')
    await sleep(60)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    const path = `${OUT}/${name}`
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
  }
  setRule(view, fn) { this.rules.set(view, fn) }
  async fulfill(requestId, status, body = null) {
    await this.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responsePhrase: status === 503 ? 'Service Unavailable' : 'OK',
      responseHeaders: [
        { name: 'content-type', value: 'application/json; charset=utf-8' },
        { name: 'access-control-allow-origin', value: '*' },
        { name: 'access-control-expose-headers', value: '*' },
      ],
      body: Buffer.from(body == null ? '' : JSON.stringify(body), 'utf8').toString('base64'),
    })
  }
  async handlePaused(params) {
    const req = params.request
    const log = { url: req.url, method: req.method, view: viewFromUrl(req.url), action: 'continue' }
    this.paused.push(log)
    try {
      if (req.url.includes('/functions/v1/decision-intake')) {
        this.blockedAnalytics++
        log.action = 'blocked_analytics'
        await this.fulfill(params.requestId, 204)
        return
      }
      if (req.url.includes(API_HOST) && !['GET','HEAD','OPTIONS'].includes(req.method)) {
        this.blockedWrites++
        log.action = 'blocked_write'
        await this.fulfill(params.requestId, 204)
        return
      }
      const rule = req.method === 'GET' && log.view ? this.rules.get(log.view) : null
      const decision = rule ? await rule({ url: req.url, view: log.view }) : null
      if (decision?.kind === '503') {
        log.action = 'mock_503'
        await this.fulfill(params.requestId, 503, { message: 'QA browser-injected 503' })
        return
      }
      log.action = decision?.label || 'continue'
      await this.send('Fetch.continueRequest', { requestId: params.requestId })
    } catch (error) {
      log.interceptorError = String(error?.stack || error)
      try { await this.send('Fetch.continueRequest', { requestId: params.requestId }) } catch {}
    }
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const seq = ++launchSeq
  const port = 9970 + (process.pid % 20) + seq
  const dir = `/tmp/catfood-pr30-postdeploy-${process.pid}-${seq}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i=0;i<200;i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844 })
        await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' })
        return { c, proc, dir, chrome: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}
function cleanup(x) {
  x?.c?.close(); try { x?.proc?.kill('SIGTERM') } catch {}
  setTimeout(() => { try { if (x?.proc?.exitCode == null) x.proc.kill('SIGKILL') } catch {}; rmSync(x?.dir || '', { recursive: true, force: true }) }, 250)
}

async function metrics(c, selector) {
  return c.eval(`(()=>{const n=document.querySelector(${js(selector)});if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);const parse=v=>{const m=String(v).match(/rgba?\\(([^)]+)\\)/);return m?m[1].split(',').map(Number).slice(0,3):null};const lum=rgb=>{const a=rgb.map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*a[0]+.7152*a[1]+.0722*a[2]};const a=lum(parse(s.color)),b=lum(parse(s.backgroundColor));return{rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},color:s.color,backgroundColor:s.backgroundColor,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),disabled:Boolean(n.disabled),hitCenter:Boolean(h&&(h===n||n.contains(h))),active:document.activeElement===n,outlineWidth:s.outlineWidth,outlineStyle:s.outlineStyle,outlineColor:s.outlineColor,outlineOffset:s.outlineOffset,focusVisible:document.activeElement===n&&s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0,withinViewport:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}})()`)
}
async function tabTo(c, selector) {
  for (let i=0;i<28;i++) {
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await sleep(30)
    if (await c.eval(`Boolean(document.activeElement?.matches(${js(selector)}))`)) return i+1
  }
  throw new Error(`Tab did not reach ${selector}`)
}
async function click(c, selector) {
  const m = await metrics(c, selector)
  assert.ok(m?.hitCenter && !m.disabled, `pointer hit failed ${selector}: ${JSON.stringify(m)}`)
  const x = m.rect.x + m.rect.width/2, y = m.rect.y + m.rect.height/2
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
async function pressEnter(c) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
}
async function state(c) {
  return c.eval(`(()=>{const u=new URL(location.href),p=u.searchParams;return{url:u.href,selected:p.get('selected'),detail:p.get('detail'),detailTab:p.get('detailTab'),compare:(p.get('compare')||'').split(',').filter(Boolean),compareOpen:p.get('compareOpen'),compareTab:p.get('compareTab'),retry:Boolean(document.querySelector('.detail-state.is-error button,.compare-state.is-error button')),stylesheet:[...document.styleSheets].map(s=>s.href).filter(Boolean)}})()`)
}
async function safety(c) {
  const page = await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`)
  const writeAttempts = c.requests.filter((r) => r.url.includes(API_HOST) && !['GET','HEAD','OPTIONS'].includes(r.method))
  assert.equal(writeAttempts.length, 0, `production write attempted: ${JSON.stringify(writeAttempts)}`)
  return { ...page, cdpBlockedAnalytics: c.blockedAnalytics, cdpBlockedWrites: c.blockedWrites, writeAttempts }
}
function assertCandidateMatch(m, expectedContrast, label, focused=false) {
  assert.ok(m, `${label}: metrics missing`)
  assert.ok(Math.abs(m.rect.width - 88) < 0.6, `${label}: width ${m.rect.width}`)
  assert.ok(Math.abs(m.rect.height - 44) < 0.6, `${label}: height ${m.rect.height}`)
  assert.ok(Math.abs(m.contrast - expectedContrast) < 0.15, `${label}: contrast ${m.contrast}`)
  assert.equal(m.disabled, false, `${label}: disabled`)
  assert.equal(m.hitCenter, true, `${label}: center hit-test`)
  assert.equal(m.withinViewport, true, `${label}: clipped`)
  if (focused) {
    assert.equal(m.focusVisible, true, `${label}: focus invisible`)
    assert.equal(m.outlineWidth, '2px', `${label}: focus outline width ${m.outlineWidth}`)
    assert.equal(m.outlineOffset, '2px', `${label}: focus outline offset ${m.outlineOffset}`)
  }
}

async function detailScenario() {
  const launched = await launch(), { c } = launched
  let mode = 'error'
  try {
    c.setRule('compare_product_nutrition', () => mode === 'error' ? { kind: '503' } : { kind: 'continue', label: 'real_recovery' })
    await c.nav(detailUrl())
    const selector = '.detail-state.is-error button'
    await c.wait(`document.querySelector(${js(selector)})`, 'detail retry error')
    const before = await state(c)
    const errorMetrics = await metrics(c, selector); assertCandidateMatch(errorMetrics, 9.605308481892601, 'detail error')
    const errorPng = await c.shot('01-detail-error.png')
    const tabSteps = await tabTo(c, selector)
    const focusMetrics = await metrics(c, selector); assertCandidateMatch(focusMetrics, 9.605308481892601, 'detail focus', true)
    const focusPng = await c.shot('02-detail-focus.png')
    mode = 'recover'
    await click(c, selector)
    await c.wait(`!document.querySelector(${js(selector)})&&document.body.innerText.includes('영양 정보를 불러오는 중입니다.')`, 'detail loading')
    await c.wait(`!document.querySelector('.detail-state.is-error')&&!document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&document.querySelector('.detail-nutrition-grid')`, 'detail recovery')
    const after = await state(c)
    assert.equal(after.selected, GO.id); assert.equal(after.detail, GO.id); assert.equal(after.detailTab, 'nutrition')
    const recoveredPng = await c.shot('03-detail-recovered.png')
    return { chrome: launched.chrome, before, after, tabSteps, errorMetrics, focusMetrics, errorPng, focusPng, recoveredPng, paused: c.paused, safety: await safety(c), exceptions: c.exceptions, consoleErrors: c.console.filter(x=>x.type==='error') }
  } finally { cleanup(launched) }
}

async function compareScenario() {
  const launched = await launch(), { c } = launched
  let mode = 'error'
  try {
    c.setRule('compare_product_nutrition', () => mode === 'error' ? { kind: '503' } : { kind: 'continue', label: 'real_recovery' })
    await c.nav(compareUrl())
    const selector = '.compare-state.is-error button'
    await c.wait(`document.querySelector(${js(selector)})`, 'compare retry error')
    const before = await state(c)
    const errorMetrics = await metrics(c, selector); assertCandidateMatch(errorMetrics, 14.986976017638051, 'compare error')
    const errorPng = await c.shot('04-compare-error.png')
    const tabSteps = await tabTo(c, selector)
    const focusMetrics = await metrics(c, selector); assertCandidateMatch(focusMetrics, 14.986976017638051, 'compare focus', true)
    const focusPng = await c.shot('05-compare-focus.png')
    mode = 'recover'
    await pressEnter(c)
    await c.wait(`!document.querySelector(${js(selector)})&&document.body.innerText.includes('영양 정보를 불러오는 중입니다.')`, 'compare loading')
    await c.wait(`!document.querySelector('.compare-state.is-error')&&!document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&document.body.innerText.includes('영양 성분')`, 'compare recovery')
    const after = await state(c)
    assert.deepEqual(after.compare, [GO.id, MONGE.id]); assert.equal(after.compareOpen, '1'); assert.equal(after.compareTab, 'nutrition')
    const recoveredPng = await c.shot('06-compare-recovered.png')
    return { chrome: launched.chrome, before, after, tabSteps, errorMetrics, focusMetrics, errorPng, focusPng, recoveredPng, paused: c.paused, safety: await safety(c), exceptions: c.exceptions, consoleErrors: c.console.filter(x=>x.type==='error') }
  } finally { cleanup(launched) }
}

const report = { mergeSha: MERGE_SHA, origin: ORIGIN, generatedAt: new Date().toISOString(), validationLabel: 'deployed UI + browser mock error validation', status: 'running', scenarios: {}, failure: null }
try {
  report.scenarios.detail = await detailScenario()
  report.scenarios.compare = await compareScenario()
  for (const [name, s] of Object.entries(report.scenarios)) {
    assert.equal(s.exceptions.length, 0, `${name}: runtime exception`)
    assert.equal(s.consoleErrors.length, 0, `${name}: console error`)
  }
  report.status = 'success'
} catch (error) {
  report.status = 'failure'
  report.failure = String(error?.stack || error)
} finally {
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
}
if (report.status !== 'success') throw new Error(report.failure)
