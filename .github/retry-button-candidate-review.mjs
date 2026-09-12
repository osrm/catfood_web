import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const ORIGIN = 'http://127.0.0.1:4173/'
const PRODUCT_SHA = process.env.PRODUCT_SHA || 'e1eb0d7459f2ac6dabd5593e456bff8d72734e96'
const OUT = 'qa-artifacts/retry-button-candidate'
const API_HOST = 'gnosbstdatkytsyxuapt.supabase.co'
const GO = { id: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리' }
const MONGE = { id: 'product_11dc2e0bf60b0874' }
const DETAIL_RESOURCES = ['switch_current_variant_options', 'compare_product_nutrition', 'compare_product_ingredients', 'product_detail_manufacturing', 'product_detail_markets']
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
let launchSequence = 0

function viewFromUrl(url) {
  try {
    const parsed = new URL(url)
    const marker = '/rest/v1/'
    const index = parsed.pathname.indexOf(marker)
    return index >= 0 ? parsed.pathname.slice(index + marker.length).split('/')[0] || null : null
  } catch { return null }
}
function detailUrl(tab) {
  const params = new URLSearchParams({ view: 'workspace', mode: 'lookup', q: GO.query, selected: GO.id, detail: GO.id, detailTab: tab })
  return `${ORIGIN}?${params.toString()}`
}
function compareUrl(tab) {
  const params = new URLSearchParams({ view: 'workspace', mode: 'lookup', q: 'go!', selected: GO.id, compare: `${GO.id},${MONGE.id}`, compareOpen: '1', compareTab: tab })
  return `${ORIGIN}?${params.toString()}`
}
function counts(entries) {
  const out = {}
  for (const entry of entries) out[entry.view || 'unknown'] = (out[entry.view || 'unknown'] || 0) + 1
  return out
}

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.rules = new Map()
    this.hits = new Map()
    this.pausedLog = []
    this.requests = []
    this.exceptions = []
    this.console = []
  }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ at: new Date().toISOString(), url: message.params.request.url, method: message.params.request.method, view: viewFromUrl(message.params.request.url) })
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push({ text: message.params.exceptionDetails?.text ?? null, description: message.params.exceptionDetails?.exception?.description ?? null })
      if (message.method === 'Runtime.consoleAPICalled') this.console.push({ type: message.params.type, values: (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type) })
      if (message.method === 'Fetch.requestPaused') void this.handlePaused(message.params)
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(method)
    await this.send('Fetch.enable', { patterns: [{ urlPattern: `*${API_HOST}/rest/v1/*`, requestStage: 'Request' }] })
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch=window.fetch.bind(window),nativeBeacon=navigator.sendBeacon?.bind(navigator);
      window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;
      window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'',method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return Promise.resolve(new Response(null,{status:204}))}if(url.includes('${API_HOST}')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1;return Promise.resolve(new Response(null,{status:204}))}return nativeFetch(input,init)};
      if(nativeBeacon){navigator.sendBeacon=(url,data)=>{const u=String(url||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return true}return nativeBeacon(url,data)}}
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
  async wait(expression, label, ms = 30000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`)) return
      await sleep(80)
    }
    throw new Error(`timeout ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'root')
    await this.eval('document.fonts?.ready')
    await sleep(120)
  }
  async shot(name) {
    await this.eval('document.fonts?.ready')
    await sleep(40)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    const path = `${OUT}/${name}`
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
  }
  setRule(view, fn) { this.rules.set(view, fn) }
  async handlePaused(params) {
    const request = params.request
    const view = viewFromUrl(request.url)
    const hit = (this.hits.get(view) || 0) + 1
    this.hits.set(view, hit)
    const log = { order: this.pausedLog.length + 1, at: new Date().toISOString(), method: request.method, view, hit, url: request.url, action: 'continue', delayMs: 0 }
    this.pausedLog.push(log)
    try {
      const rule = request.method === 'GET' && view ? this.rules.get(view) : null
      const decision = rule ? await rule({ view, hit, url: request.url }) : { kind: 'continue' }
      if (decision?.kind === 'fulfill') {
        log.action = decision.label || `mock_${decision.status}`
        const body = typeof decision.body === 'string' ? decision.body : JSON.stringify(decision.body ?? [])
        await this.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: decision.status,
          responsePhrase: decision.status === 503 ? 'Service Unavailable' : 'OK',
          responseHeaders: [
            { name: 'content-type', value: 'application/json; charset=utf-8' },
            { name: 'access-control-allow-origin', value: '*' },
            { name: 'access-control-expose-headers', value: '*' },
          ],
          body: Buffer.from(body, 'utf8').toString('base64'),
        })
        return
      }
      if (decision?.delayMs) {
        log.action = decision.label || 'delay_then_continue'
        log.delayMs = decision.delayMs
        await sleep(decision.delayMs)
      } else if (decision?.label) log.action = decision.label
      await this.send('Fetch.continueRequest', { requestId: params.requestId })
    } catch (error) {
      log.interceptorError = String(error?.stack || error)
      try { await this.send('Fetch.continueRequest', { requestId: params.requestId }) } catch {}
    }
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width = 360, height = 844, mobile = true) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const sequence = ++launchSequence
  const port = 9960 + (process.pid % 30) + sequence
  const dir = `/tmp/catfood-retry-candidate-${process.pid}-${sequence}`
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await c.send('Emulation.setUserAgentOverride', mobile
          ? { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' }
          : { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Linux x86_64' })
        return { c, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}
function cleanup(x) {
  x?.c?.close(); try { x?.proc?.kill('SIGTERM') } catch {}
  setTimeout(() => { try { if (x?.proc?.exitCode == null) x.proc.kill('SIGKILL') } catch {}; try { rmSync(x?.dir, { recursive: true, force: true }) } catch {} }, 250)
}

async function tabTo(c, selector) {
  const sequence = []
  for (let i = 0; i < 28; i++) {
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await sleep(25)
    const current = await c.eval(`(()=>{const a=document.activeElement;return{tag:a?.tagName??null,text:(a?.textContent||'').trim(),className:a?.className??null,matches:Boolean(a&&a.matches(${js(selector)}))}})()`)
    sequence.push(current)
    if (current.matches) return { reached: true, steps: i + 1, sequence }
  }
  return { reached: false, steps: 28, sequence }
}
async function pressEnter(c) {
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
}
async function clickButton(c, selector) {
  const metric = await c.eval(`(()=>{const n=document.querySelector(${js(selector)});if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:Boolean(h&&(h===n||n.contains(h))),disabled:Boolean(n.disabled)}})()`)
  assert.ok(metric?.hit && !metric.disabled, `pointer target unavailable ${selector}: ${JSON.stringify(metric)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: metric.x, y: metric.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: metric.x, y: metric.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: metric.x, y: metric.y, button: 'left', clickCount: 1 })
  return metric
}
async function repeatPointerAttempt(c, selector) {
  const state = await c.eval(`(()=>{const n=document.querySelector(${js(selector)});if(!n)return{present:false};const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{present:true,hit:Boolean(h&&(h===n||n.contains(h))),x,y}})()`)
  if (!state.present || !state.hit) return { attempted: true, clicked: false, reason: 'retry button removed or no longer hit-testable during loading' }
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: state.x, y: state.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: state.x, y: state.y, button: 'left', clickCount: 1 })
  return { attempted: true, clicked: true, reason: 'retry button remained hit-testable and received a second click' }
}

async function metrics(c, selector) {
  return c.eval(`(()=>{
    const n=document.querySelector(${js(selector)});if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y),box=n.closest('.detail-state,.compare-state'),p=box?.querySelector('p')??null,br=box?.getBoundingClientRect()??null,pr=p?.getBoundingClientRect()??null;
    const parse=(v)=>{const m=String(v).match(/rgba?\\(([^)]+)\\)/);if(!m)return null;return m[1].split(',').map(Number).slice(0,3)};const lum=(rgb)=>{if(!rgb)return null;const a=rgb.map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*a[0]+.7152*a[1]+.0722*a[2]};const l1=lum(parse(s.color)),l2=lum(parse(s.backgroundColor)),contrast=l1==null||l2==null?null:(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
    const overlap=pr?!(r.right<=pr.left||r.left>=pr.right||r.bottom<=pr.top||r.top>=pr.bottom):false;const gap=pr?(r.top>=pr.bottom?r.top-pr.bottom:r.left>=pr.right?r.left-pr.right:0):null;
    return {rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},containerRect:br?{x:br.x,y:br.y,width:br.width,height:br.height,right:br.right,bottom:br.bottom}:null,messageRect:pr?{x:pr.x,y:pr.y,width:pr.width,height:pr.height,right:pr.right,bottom:pr.bottom}:null,color:s.color,backgroundColor:s.backgroundColor,borderColor:s.borderColor,borderWidth:s.borderWidth,borderRadius:s.borderRadius,minHeight:s.minHeight,padding:s.padding,fontSize:s.fontSize,fontWeight:s.fontWeight,cursor:s.cursor,disabled:Boolean(n.disabled),hitCenter:Boolean(h&&(h===n||n.contains(h))),active:document.activeElement===n,contrast,outlineWidth:s.outlineWidth,outlineStyle:s.outlineStyle,outlineColor:s.outlineColor,outlineOffset:s.outlineOffset,focusVisible:document.activeElement===n&&s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0,withinViewport:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,overlapMessage:overlap,gapToMessage:gap};
  })()`)
}
async function navState(c) {
  return c.eval(`(()=>{const u=new URL(location.href),params=u.searchParams;return{url:u.href,selected:params.get('selected'),detail:params.get('detail'),detailTab:params.get('detailTab'),compare:(params.get('compare')||'').split(',').filter(Boolean),compareOpen:params.get('compareOpen'),compareTab:params.get('compareTab'),activeDetailTab:document.querySelector('.detail-tabs button[aria-selected="true"]')?.id??null,activeCompareTab:document.querySelector('.compare-tabs button[aria-selected="true"]')?.id??null,productTitle:document.querySelector('.detail-identity-copy h1')?.textContent?.trim()??null,retry:Boolean(document.querySelector('.detail-state.is-error button,.compare-state.is-error button')),loading:[...document.querySelectorAll('.detail-state,.compare-state')].map(n=>(n.textContent||'').trim()).filter(Boolean)}})()`)
}
async function safety(c) {
  const browser = await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`)
  const writes = c.requests.filter((entry) => entry.url.includes(API_HOST) && !['GET','HEAD','OPTIONS'].includes(entry.method))
  assert.equal(writes.length, 0, `production write request observed: ${JSON.stringify(writes)}`)
  return { ...browser, networkWriteRequests: writes }
}
function failOnceThenDelay(c, view, delayMs = 1200) {
  c.setRule(view, ({ hit }) => hit === 1
    ? { kind: 'fulfill', status: 503, body: { message: 'QA injected 503' }, label: 'mock_503' }
    : hit === 2 ? { kind: 'continue', delayMs, label: 'retry_delayed_then_continue' } : { kind: 'continue', label: 'continue' })
}
function emptyAlways(c, view) {
  c.setRule(view, () => ({ kind: 'fulfill', status: 200, body: [], label: 'mock_200_empty' }))
}
function assertButton(metric, label, focused = false) {
  assert.ok(metric, `${label}: missing metrics`)
  assert.ok(metric.rect.width >= 44, `${label}: width ${metric.rect.width} < 44`)
  assert.ok(metric.rect.height >= 44, `${label}: height ${metric.rect.height} < 44`)
  assert.ok(metric.contrast >= 4.5, `${label}: contrast ${metric.contrast} < 4.5`)
  assert.equal(metric.disabled, false, `${label}: button disabled`)
  assert.equal(metric.hitCenter, true, `${label}: pointer hit-test failed`)
  assert.equal(metric.overlapMessage, false, `${label}: overlaps error message`)
  assert.equal(metric.withinViewport, true, `${label}: button clipped by viewport`)
  if (focused) assert.equal(metric.focusVisible, true, `${label}: focus-visible outline missing`)
}

async function detailPointerScenario() {
  const launched = await launch(360, 844, true); const { c } = launched
  try {
    failOnceThenDelay(c, 'compare_product_nutrition', 1300)
    await c.nav(detailUrl('nutrition'))
    const selector = '.detail-state.is-error button'
    await c.wait(`document.querySelector(${js(selector)})`, 'detail nutrition retry')
    const initialState = await navState(c); const initialCounts = counts(c.pausedLog)
    const button = await metrics(c, selector); assertButton(button, 'detail pointer error')
    const errorPng = await c.shot('01-detail-nutrition-error.png')
    await clickButton(c, selector)
    await c.wait(`document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&!document.querySelector(${js(selector)})`, 'detail nutrition loading')
    const pendingPng = await c.shot('02-detail-nutrition-pending.png')
    const repeat = await repeatPointerAttempt(c, selector)
    const pendingCounts = counts(c.pausedLog); const pendingState = await navState(c)
    await c.wait(`!document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&!document.querySelector('.detail-state.is-error')&&document.querySelector('.detail-nutrition-grid')`, 'detail nutrition recovered')
    const recoveredState = await navState(c); const finalCounts = counts(c.pausedLog); const recoveredPng = await c.shot('03-detail-nutrition-recovered.png')
    assert.equal(recoveredState.detail, GO.id); assert.equal(recoveredState.detailTab, 'nutrition'); assert.equal(recoveredState.selected, GO.id)
    assert.equal(finalCounts.compare_product_nutrition, 2, `detail nutrition retry count unexpected: ${JSON.stringify(finalCounts)}`)
    return { initialState, pendingState, recoveredState, initialCounts, pendingCounts, finalCounts, repeat, button, errorPng, pendingPng, recoveredPng, requestLog: c.pausedLog, safety: await safety(c), exceptions: c.exceptions, consoleErrors: c.console.filter(x => x.type === 'error') }
  } finally { cleanup(launched) }
}

async function detailKeyboardScenario() {
  const launched = await launch(360, 844, true); const { c } = launched
  try {
    failOnceThenDelay(c, 'compare_product_ingredients', 1100)
    await c.nav(detailUrl('ingredients'))
    const selector = '.detail-state.is-error button'
    await c.wait(`document.querySelector(${js(selector)})`, 'detail ingredients retry')
    const initialState = await navState(c); const initialCounts = counts(c.pausedLog)
    const tab = await tabTo(c, selector); assert.equal(tab.reached, true, 'detail retry not reachable by Tab')
    const focused = await metrics(c, selector); assertButton(focused, 'detail keyboard focus', true)
    const focusPng = await c.shot('04-detail-ingredients-focus.png')
    await pressEnter(c)
    await c.wait(`document.body.innerText.includes('원재료 정보를 불러오는 중입니다.')&&!document.querySelector(${js(selector)})`, 'detail ingredients loading')
    await pressEnter(c)
    const pendingState = await navState(c); const pendingCounts = counts(c.pausedLog); const pendingPng = await c.shot('05-detail-ingredients-pending.png')
    await c.wait(`!document.body.innerText.includes('원재료 정보를 불러오는 중입니다.')&&!document.querySelector('.detail-state.is-error')&&document.querySelector('.detail-ingredient-copy')`, 'detail ingredients recovered')
    const recoveredState = await navState(c); const finalCounts = counts(c.pausedLog); const recoveredPng = await c.shot('06-detail-ingredients-recovered.png')
    assert.equal(recoveredState.detail, GO.id); assert.equal(recoveredState.detailTab, 'ingredients'); assert.equal(recoveredState.selected, GO.id)
    assert.equal(finalCounts.compare_product_ingredients, 2, `detail ingredient retry count unexpected: ${JSON.stringify(finalCounts)}`)
    return { initialState, pendingState, recoveredState, initialCounts, pendingCounts, finalCounts, tab, focused, focusPng, pendingPng, recoveredPng, requestLog: c.pausedLog, safety: await safety(c), exceptions: c.exceptions, consoleErrors: c.console.filter(x => x.type === 'error') }
  } finally { cleanup(launched) }
}

async function comparePointerScenario() {
  const launched = await launch(360, 844, true); const { c } = launched
  try {
    failOnceThenDelay(c, 'compare_product_nutrition', 1300)
    await c.nav(compareUrl('nutrition'))
    const selector = '.compare-state.is-error button'
    await c.wait(`document.querySelector(${js(selector)})`, 'compare nutrition retry')
    const initialState = await navState(c); const initialCounts = counts(c.pausedLog)
    const button = await metrics(c, selector); assertButton(button, 'compare pointer error')
    const errorPng = await c.shot('07-compare-nutrition-error.png')
    await clickButton(c, selector)
    await c.wait(`document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&!document.querySelector(${js(selector)})`, 'compare nutrition loading')
    const pendingPng = await c.shot('08-compare-nutrition-pending.png')
    const repeat = await repeatPointerAttempt(c, selector); const pendingCounts = counts(c.pausedLog); const pendingState = await navState(c)
    await c.wait(`!document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&!document.querySelector('.compare-state.is-error')&&document.body.innerText.includes('영양 성분')`, 'compare nutrition recovered')
    const recoveredState = await navState(c); const finalCounts = counts(c.pausedLog); const recoveredPng = await c.shot('09-compare-nutrition-recovered.png')
    assert.deepEqual(recoveredState.compare, [GO.id, MONGE.id]); assert.equal(recoveredState.compareTab, 'nutrition'); assert.equal(recoveredState.compareOpen, '1')
    assert.equal(finalCounts.compare_product_nutrition, 2, `compare nutrition retry count unexpected: ${JSON.stringify(finalCounts)}`)
    return { initialState, pendingState, recoveredState, initialCounts, pendingCounts, finalCounts, repeat, button, errorPng, pendingPng, recoveredPng, requestLog: c.pausedLog, safety: await safety(c), exceptions: c.exceptions, consoleErrors: c.console.filter(x => x.type === 'error') }
  } finally { cleanup(launched) }
}

async function compareKeyboardScenario() {
  const launched = await launch(360, 844, true); const { c } = launched
  try {
    failOnceThenDelay(c, 'compare_product_nutrition', 900)
    await c.nav(compareUrl('nutrition'))
    const selector = '.compare-state.is-error button'
    await c.wait(`document.querySelector(${js(selector)})`, 'compare keyboard retry')
    const tab = await tabTo(c, selector); assert.equal(tab.reached, true, 'compare retry not reachable by Tab')
    const focused = await metrics(c, selector); assertButton(focused, 'compare keyboard focus', true)
    const focusPng = await c.shot('10-compare-nutrition-focus.png')
    await pressEnter(c)
    await c.wait(`document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&!document.querySelector(${js(selector)})`, 'compare keyboard loading')
    await pressEnter(c)
    const pendingCounts = counts(c.pausedLog)
    await c.wait(`!document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&!document.querySelector('.compare-state.is-error')&&document.body.innerText.includes('영양 성분')`, 'compare keyboard recovered')
    const finalCounts = counts(c.pausedLog); const finalState = await navState(c)
    assert.equal(finalCounts.compare_product_nutrition, 2, `compare keyboard retry count unexpected: ${JSON.stringify(finalCounts)}`)
    assert.deepEqual(finalState.compare, [GO.id, MONGE.id]); assert.equal(finalState.compareTab, 'nutrition')
    return { tab, focused, focusPng, pendingCounts, finalCounts, finalState, requestLog: c.pausedLog, safety: await safety(c), exceptions: c.exceptions, consoleErrors: c.console.filter(x => x.type === 'error') }
  } finally { cleanup(launched) }
}

async function emptyScenario(kind) {
  const launched = await launch(360, 844, true); const { c } = launched
  try {
    emptyAlways(c, kind === 'detail' ? 'compare_product_nutrition' : 'compare_product_ingredients')
    await c.nav(kind === 'detail' ? detailUrl('nutrition') : compareUrl('ingredients'))
    if (kind === 'detail') await c.wait(`document.body.innerText.includes('현재 확인된 영양 정보가 없습니다.')`, 'detail empty')
    else await c.wait(`!document.body.innerText.includes('원재료 정보를 불러오는 중입니다.')&&document.querySelector('.compare-table-wrap')`, 'compare empty')
    const snapshot = await c.eval(`(()=>({retry:Boolean(document.querySelector('.detail-state.is-error button,.compare-state.is-error button')),error:Boolean(document.querySelector('.detail-state.is-error,.compare-state.is-error')),body:document.body.innerText.slice(0,8000)}))()`)
    assert.equal(snapshot.retry, false, `${kind} 200 empty unexpectedly has retry`); assert.equal(snapshot.error, false, `${kind} 200 empty unexpectedly has error state`)
    const png = await c.shot(kind === 'detail' ? '11-detail-200-empty.png' : '12-compare-200-empty.png')
    return { snapshot: { retry: snapshot.retry, error: snapshot.error, expectedTextPresent: kind === 'detail' ? snapshot.body.includes('현재 확인된 영양 정보가 없습니다.') : snapshot.body.includes('확인값 없음') || snapshot.body.includes('미확인') }, png, requestLog: c.pausedLog, safety: await safety(c) }
  } finally { cleanup(launched) }
}

async function layoutScenario(name, width, mobile, kind) {
  const launched = await launch(width, 844, mobile); const { c } = launched
  try {
    const view = 'compare_product_nutrition'; let once = false
    c.setRule(view, () => { if (!once) { once = true; return { kind: 'fulfill', status: 503, body: { message: 'QA injected 503' }, label: 'mock_503' } } return { kind: 'continue' } })
    const selector = kind === 'detail' ? '.detail-state.is-error button' : '.compare-state.is-error button'
    await c.nav(kind === 'detail' ? detailUrl('nutrition') : compareUrl('nutrition'))
    await c.wait(`document.querySelector(${js(selector)})`, `${name} retry`)
    const metric = await metrics(c, selector); assertButton(metric, name)
    const png = await c.shot(`${name}.png`)
    return { width, mobile, kind, metric, png, safety: await safety(c) }
  } finally { cleanup(launched) }
}

const report = { productSha: PRODUCT_SHA, generatedAt: new Date().toISOString(), chrome: execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim(), status: 'running', scenarios: {} }
try {
  report.scenarios.detailPointer = await detailPointerScenario()
  report.scenarios.detailKeyboard = await detailKeyboardScenario()
  report.scenarios.comparePointer = await comparePointerScenario()
  report.scenarios.compareKeyboard = await compareKeyboardScenario()
  report.scenarios.detailEmpty = await emptyScenario('detail')
  report.scenarios.compareEmpty = await emptyScenario('compare')
  report.scenarios.layout390Detail = await layoutScenario('13-layout-390-detail', 390, true, 'detail')
  report.scenarios.layout390Compare = await layoutScenario('14-layout-390-compare', 390, true, 'compare')
  report.scenarios.layout1280Detail = await layoutScenario('15-layout-1280-detail', 1280, false, 'detail')
  report.scenarios.layout1280Compare = await layoutScenario('16-layout-1280-compare', 1280, false, 'compare')
  for (const scenario of Object.values(report.scenarios)) {
    if (scenario?.exceptions?.length) throw new Error(`runtime exceptions: ${JSON.stringify(scenario.exceptions)}`)
    if (scenario?.consoleErrors?.length) throw new Error(`console errors: ${JSON.stringify(scenario.consoleErrors)}`)
  }
  report.status = 'passed'
  report.failure = null
} catch (error) {
  report.status = 'failed'
  report.failure = String(error?.stack || error)
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
if (report.status !== 'passed') process.exitCode = 1
