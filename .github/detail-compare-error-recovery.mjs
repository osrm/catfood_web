import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const ORIGIN = 'http://127.0.0.1:4173/'
const TARGET_SHA = process.env.TARGET_SHA || 'b5218c85269e25a2250de88d65a15a4f27fae98c'
const OUT = 'qa-artifacts/detail-compare-error-recovery'
const GO = { id: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리', name: '카니보 치킨&칠면조&오리' }
const MONGE = { id: 'product_11dc2e0bf60b0874', name: '몬지 비와일드 그레인프리 어덜트 연어' }
const API_HOST = 'gnosbstdatkytsyxuapt.supabase.co'
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const DETAIL_VIEWS = ['switch_current_variant_options', 'compare_product_nutrition', 'compare_product_ingredients', 'product_detail_manufacturing', 'product_detail_markets']
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
let launchSequence = 0

function viewFromUrl(url) {
  try {
    const parsed = new URL(url)
    const marker = '/rest/v1/'
    const index = parsed.pathname.indexOf(marker)
    if (index < 0) return null
    return parsed.pathname.slice(index + marker.length).split('/')[0] || null
  } catch {
    return null
  }
}

function searchParamsObject(url) {
  try {
    const parsed = new URL(url)
    return Object.fromEntries(parsed.searchParams.entries())
  } catch {
    return {}
  }
}

function summarizeGetViews(entries) {
  const counts = {}
  for (const entry of entries) {
    if (entry.method !== 'GET' || !entry.view) continue
    counts[entry.view] = (counts[entry.view] || 0) + 1
  }
  return counts
}

function relevantLog(entries) {
  return entries.filter((entry) => entry.method === 'GET' && DETAIL_VIEWS.includes(entry.view))
}

function detailUrl(tab, options = {}) {
  const params = new URLSearchParams({
    view: 'workspace',
    mode: 'lookup',
    q: options.query || GO.query,
    selected: options.selected || GO.id,
    detail: options.detail || GO.id,
    detailTab: tab,
  })
  return `${ORIGIN}?${params.toString()}`
}

function compareUrl(tab) {
  const params = new URLSearchParams({
    view: 'workspace',
    mode: 'lookup',
    q: 'go!',
    selected: GO.id,
    compare: `${GO.id},${MONGE.id}`,
    compareOpen: '1',
    compareTab: tab,
  })
  return `${ORIGIN}?${params.toString()}`
}

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = []
    this.responses = []
    this.loadingFailures = []
    this.exceptions = []
    this.console = []
    this.logEntries = []
    this.pausedLog = []
    this.rules = new Map()
    this.sequence = 0
    this.scenario = 'unset'
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
      const now = new Date().toISOString()
      if (message.method === 'Network.requestWillBeSent') {
        this.requests.push({ at: now, requestId: message.params.requestId, url: message.params.request.url, method: message.params.request.method, view: viewFromUrl(message.params.request.url) })
      } else if (message.method === 'Network.responseReceived') {
        this.responses.push({ at: now, requestId: message.params.requestId, url: message.params.response.url, status: message.params.response.status, type: message.params.type, view: viewFromUrl(message.params.response.url) })
      } else if (message.method === 'Network.loadingFailed') {
        this.loadingFailures.push({ at: now, requestId: message.params.requestId, errorText: message.params.errorText, canceled: Boolean(message.params.canceled), type: message.params.type })
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push({ at: now, text: message.params.exceptionDetails?.text ?? null, description: message.params.exceptionDetails?.exception?.description ?? null, url: message.params.exceptionDetails?.url ?? null, lineNumber: message.params.exceptionDetails?.lineNumber ?? null })
      } else if (message.method === 'Runtime.consoleAPICalled') {
        this.console.push({ at: now, type: message.params.type, values: (message.params.args ?? []).map((item) => item.value ?? item.description ?? item.type) })
      } else if (message.method === 'Log.entryAdded') {
        this.logEntries.push({ at: now, level: message.params.entry.level, text: message.params.entry.text, source: message.params.entry.source, url: message.params.entry.url ?? null })
      } else if (message.method === 'Fetch.requestPaused') {
        void this.handlePaused(message.params)
      }
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })

    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await this.send(method)
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

  async wait(expression, label, ms = 35000) {
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
    await sleep(100)
  }

  async shot(name) {
    await this.eval('document.fonts?.ready')
    await sleep(40)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    const path = `${OUT}/${name}`
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
  }

  setRule(view, rule) {
    this.rules.set(view, rule)
  }

  async handlePaused(params) {
    const request = params.request
    const method = request.method
    const url = request.url
    const view = viewFromUrl(url)
    const entry = {
      order: ++this.sequence,
      at: new Date().toISOString(),
      scenario: this.scenario,
      method,
      view,
      url,
      params: searchParamsObject(url),
      action: 'continue',
      delayMs: 0,
    }
    this.pausedLog.push(entry)
    try {
      if (method !== 'GET' || !view) {
        await this.send('Fetch.continueRequest', { requestId: params.requestId })
        return
      }
      const rule = this.rules.get(view)
      const decision = rule ? await rule({ entry, request, params }) : { kind: 'continue' }
      if (decision?.kind === 'fulfill') {
        entry.action = decision.label || `mock_${decision.status}`
        const body = typeof decision.body === 'string' ? decision.body : JSON.stringify(decision.body ?? [])
        await this.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: decision.status,
          responsePhrase: decision.status === 503 ? 'Service Unavailable' : 'OK',
          responseHeaders: [
            { name: 'content-type', value: 'application/json; charset=utf-8' },
            { name: 'access-control-allow-origin', value: ORIGIN.replace(/\/$/, '') },
            { name: 'access-control-expose-headers', value: '*' },
          ],
          body: Buffer.from(body, 'utf8').toString('base64'),
        })
        return
      }
      const delayMs = Number(decision?.delayMs || 0)
      if (delayMs > 0) {
        entry.action = decision.label || 'delay_then_continue'
        entry.delayMs = delayMs
        await sleep(delayMs)
      } else {
        entry.action = decision?.label || 'continue'
      }
      await this.send('Fetch.continueRequest', { requestId: params.requestId })
    } catch (error) {
      entry.interceptorError = String(error?.stack || error)
      try { await this.send('Fetch.continueRequest', { requestId: params.requestId }) } catch {}
    }
  }

  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const sequence = ++launchSequence
  const port = 9900 + (process.pid % 100) + sequence
  const dir = `/tmp/catfood-error-recovery-${process.pid}-${sequence}`
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })
  for (let index = 0; index < 200; index++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844 })
        await c.send('Emulation.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
          acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android',
        })
        return { c, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

function cleanup(launched) {
  launched?.c?.close()
  try { launched?.proc?.kill('SIGTERM') } catch {}
  setTimeout(() => {
    try { if (launched?.proc?.exitCode == null) launched.proc.kill('SIGKILL') } catch {}
    try { rmSync(launched?.dir, { recursive: true, force: true }) } catch {}
  }, 350)
}

async function clickVisible(c, selector, text = null) {
  const metric = await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${js(selector)})],n=${text == null ? 'nodes[0]??null' : `nodes.find(x=>(x.textContent||'').includes(${js(text)}))??null`};if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],text:(n.textContent||'').replace(/\\s+/g,' ').trim(),x,y,hit:Boolean(h&&(h===n||n.contains(h))),disabled:Boolean(n.disabled)}})()`)
  assert.ok(metric && metric.rect[2] > 0 && metric.rect[3] > 0 && metric.hit && !metric.disabled, `pointer target unavailable ${selector}${text ? ` text=${text}` : ''}: ${JSON.stringify(metric)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: metric.x, y: metric.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: metric.x, y: metric.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: metric.x, y: metric.y, button: 'left', clickCount: 1 })
  await sleep(40)
  return metric
}

async function tryRepeatRetry(c, selector) {
  const available = await c.eval(`(()=>{const n=document.querySelector(${js(selector)});if(!n)return{available:false};const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{available:r.width>0&&r.height>0&&Boolean(h&&(h===n||n.contains(h))),text:(n.textContent||'').trim(),x,y}})()`)
  if (!available?.available) return { attempted: true, clicked: false, reason: 'retry control unavailable after first retry click' }
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: available.x, y: available.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: available.x, y: available.y, button: 'left', clickCount: 1 })
  await sleep(30)
  return { attempted: true, clicked: true, reason: 'retry control remained clickable and received a second pointer click' }
}

async function detailState(c) {
  return c.eval(`(()=>{const params=Object.fromEntries(new URL(location.href).searchParams.entries()),tabs=[...document.querySelectorAll('.detail-tabs [role=tab]')].map(n=>({id:n.id,selected:n.getAttribute('aria-selected'),text:(n.textContent||'').trim()}));return{url:location.href,params,productTitle:document.querySelector('.detail-identity-copy h1')?.textContent?.trim()??null,activeTab:tabs.find(x=>x.selected==='true')??null,error:document.querySelector('.detail-state.is-error')?.textContent?.replace(/\\s+/g,' ').trim()??null,loading:[...document.querySelectorAll('.detail-state:not(.is-error)')].map(n=>(n.textContent||'').replace(/\\s+/g,' ').trim()),empty:[...document.querySelectorAll('.detail-empty')].map(n=>(n.textContent||'').replace(/\\s+/g,' ').trim()),retryButtons:[...document.querySelectorAll('.detail-state.is-error button')].map(n=>(n.textContent||'').trim()),nutritionGrid:Boolean(document.querySelector('.detail-nutrition-grid')),ingredientCopy:document.querySelector('.detail-ingredient-copy')?.textContent?.slice(0,240)??null,status:[...document.querySelectorAll('.detail-status-grid .detail-fact')].map(n=>(n.textContent||'').replace(/\\s+/g,' ').trim())}})()`)
}

async function compareState(c) {
  return c.eval(`(()=>{const params=Object.fromEntries(new URL(location.href).searchParams.entries()),tabs=[...document.querySelectorAll('.compare-tabs [role=tab]')].map(n=>({id:n.id,selected:n.getAttribute('aria-selected'),text:(n.textContent||'').trim()})),text=document.querySelector('.compare-table-wrap')?.textContent?.replace(/\\s+/g,' ').trim()??'';return{url:location.href,params,heading:document.querySelector('.compare-header h1')?.textContent?.trim()??null,activeTab:tabs.find(x=>x.selected==='true')??null,error:document.querySelector('.compare-state.is-error')?.textContent?.replace(/\\s+/g,' ').trim()??null,loading:document.querySelector('.compare-state:not(.is-error)')?.textContent?.replace(/\\s+/g,' ').trim()??null,retryButtons:[...document.querySelectorAll('.compare-state.is-error button')].map(n=>(n.textContent||'').trim()),tableText:text.slice(0,900),hasNutritionSection:text.includes('영양 성분'),hasIngredientSection:text.includes('원재료'),unknownCount:(text.match(/미확인/g)||[]).length,noValueCount:(text.match(/확인값 없음/g)||[]).length}})()`)
}

async function safetyState(c) {
  const browser = await c.eval(`({blockedAnalytics:window.__qaBlockedAnalytics??null,blockedWrites:window.__qaBlockedWrites??null})`)
  const actualWrites = c.requests.filter((request) => request.url.includes(API_HOST) && !READ_METHODS.has(request.method))
  const analyticsNetwork = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  return { ...browser, actualWrites, analyticsNetwork }
}

function makeRule({ fail = 0, empty = 0 } = {}) {
  const state = { failRemaining: fail, emptyRemaining: empty, delayNextMs: 0 }
  const handler = async () => {
    if (state.failRemaining > 0) {
      state.failRemaining -= 1
      return { kind: 'fulfill', status: 503, body: { error: 'qa injected 503' }, label: 'mock_503' }
    }
    if (state.emptyRemaining > 0) {
      state.emptyRemaining -= 1
      return { kind: 'fulfill', status: 200, body: [], label: 'mock_200_empty' }
    }
    if (state.delayNextMs > 0) {
      const delayMs = state.delayNextMs
      state.delayNextMs = 0
      return { kind: 'continue', delayMs, label: 'delay_then_continue' }
    }
    return { kind: 'continue', label: 'continue_live_read' }
  }
  return { state, handler }
}

async function runScenario(name, body) {
  const launched = await launch()
  const { c } = launched
  c.scenario = name
  try {
    const result = await body(c, launched.version)
    const safety = await safetyState(c)
    assert.equal(safety.actualWrites.length, 0, `${name}: unexpected external write request`)
    assert.equal(safety.analyticsNetwork.length, 0, `${name}: analytics network request escaped blocker/build flag`)
    return {
      name,
      chrome: launched.version,
      result,
      safety,
      injectedAndApiRequests: relevantLog(c.pausedLog),
      runtimeExceptions: c.exceptions,
      consoleErrors: c.console.filter((entry) => entry.type === 'error'),
      browserLogErrors: c.logEntries.filter((entry) => ['error', 'warning'].includes(entry.level)),
      loadingFailures: c.loadingFailures,
      relevantResponses: c.responses.filter((entry) => DETAIL_VIEWS.includes(entry.view)),
    }
  } finally {
    cleanup(launched)
    await sleep(450)
  }
}

const report = {
  status: 'running',
  targetSha: TARGET_SHA,
  candidate: {
    servedAt: ORIGIN,
    viewport: '360x844',
    locale: 'ko-KR',
    buildAnalyticsFlag: false,
    browserBlockerInstalledBeforeFirstNavigation: true,
    errorInjection: 'CDP Fetch interception on localhost candidate; production server was not made to fail',
  },
  scenarios: [],
  limitations: [
    'Injected HTTP 503/200-empty responses and client-side request delay; no production outage was induced.',
    'Recovery success uses normal public GET reads after interception is released.',
    'No physical mobile device or screen reader coverage.',
    'Catalog/SKU retry coverage was intentionally not repeated.',
  ],
}

try {
  report.scenarios.push(await runScenario('detail_nutrition_503_then_recover', async (c) => {
    const nutritionRule = makeRule({ fail: 1 })
    c.setRule('compare_product_nutrition', nutritionRule.handler)
    await c.nav(detailUrl('nutrition'))
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'nutrition tab active')
    await c.wait(`document.querySelector('.detail-state.is-error')?.textContent?.includes('영양 정보를 불러오지 못했습니다.')`, 'nutrition 503 error')
    const errorState = await detailState(c)
    assert.ok(errorState.error?.includes('영양 정보를 불러오지 못했습니다.'), 'nutrition error not surfaced')
    assert.equal(errorState.empty.some((text) => text.includes('현재 확인된 영양 정보가 없습니다.')), false, '503 was shown as normal empty nutrition')
    const errorShot = await c.shot('01-detail-nutrition-503.png')

    await clickVisible(c, '#detail-tab-ingredients')
    await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'ingredients tab active while nutrition failed')
    await c.wait(`!document.querySelector('.detail-state.is-error') && (document.querySelector('.detail-ingredient-copy') || document.querySelector('.detail-empty'))`, 'ingredients usable while nutrition failed')
    const ingredientsState = await detailState(c)
    assert.equal(ingredientsState.error, null, 'ingredients tab inherited nutrition error')
    const ingredientsShot = await c.shot('02-detail-ingredients-usable-during-nutrition-error.png')

    await clickVisible(c, '#detail-tab-nutrition')
    await c.wait(`document.querySelector('.detail-state.is-error button')`, 'nutrition retry button')
    const beforeRetryIndex = c.pausedLog.length
    await clickVisible(c, '.detail-state.is-error button')
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true' && !document.querySelector('.detail-state.is-error') && document.querySelector('.detail-nutrition-grid')`, 'nutrition recovery')
    const recoveredState = await detailState(c)
    const recoveredShot = await c.shot('03-detail-nutrition-recovered.png')
    return {
      injected: 'first compare_product_nutrition GET => 503; retry GET passed through normally',
      errorState,
      ingredientsState,
      recoveredState,
      retryRequestCounts: summarizeGetViews(c.pausedLog.slice(beforeRetryIndex)),
      screenshots: [errorShot, ingredientsShot, recoveredShot],
    }
  }))

  report.scenarios.push(await runScenario('detail_ingredients_503_delayed_retry_parent_return', async (c) => {
    const ingredientRule = makeRule({ fail: 1 })
    c.setRule('compare_product_ingredients', ingredientRule.handler)
    await c.nav(detailUrl('ingredients'))
    await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'ingredients tab active')
    await c.wait(`document.querySelector('.detail-state.is-error')?.textContent?.includes('원재료 정보를 불러오지 못했습니다.')`, 'ingredients 503 error')
    const errorState = await detailState(c)
    assert.ok(errorState.error?.includes('원재료 정보를 불러오지 못했습니다.'), 'ingredients error not surfaced')
    assert.equal(errorState.empty.some((text) => text.includes('현재 확인된 원재료 목록이 없습니다.')), false, '503 was shown as normal empty ingredients')
    const errorShot = await c.shot('04-detail-ingredients-503.png')

    ingredientRule.state.delayNextMs = 1400
    const beforeRetryIndex = c.pausedLog.length
    await clickVisible(c, '.detail-state.is-error button')
    await sleep(120)
    const pendingState = await detailState(c)
    const repeat = await tryRepeatRetry(c, '.detail-state.is-error button')
    const pendingShot = await c.shot('05-detail-ingredients-retry-pending.png')
    await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true' && !document.querySelector('.detail-state.is-error') && document.querySelector('.detail-ingredient-copy')`, 'ingredients recovery', 45000)
    const recoveredState = await detailState(c)
    const recoveredShot = await c.shot('06-detail-ingredients-recovered.png')
    assert.equal(recoveredState.activeTab?.id, 'detail-tab-ingredients', 'ingredient tab changed across retry')
    assert.equal(recoveredState.productTitle, GO.name, 'product identity changed across retry')

    await clickVisible(c, '.detail-topbar button')
    await c.wait(`!document.querySelector('.detail-stage') && document.querySelector('.research-quick-view')`, 'detail parent return')
    const parentState = await c.eval(`(()=>{const p=new URL(location.href).searchParams;return{url:location.href,q:p.get('q'),selected:p.get('selected'),detail:p.get('detail'),detailTab:p.get('detailTab'),quickViewTitle:document.querySelector('.quick-view-identity h1')?.textContent?.trim()??null}})()`)
    assert.equal(parentState.selected, GO.id, 'selected product not preserved on parent return')
    assert.equal(parentState.q, GO.query, 'lookup query not preserved on parent return')
    assert.equal(parentState.detail, null, 'detail parameter remained after parent return')
    assert.equal(parentState.quickViewTitle, GO.name, 'quick view parent product changed')
    const parentShot = await c.shot('07-detail-parent-return-after-recovery.png')

    return {
      injected: 'first compare_product_ingredients GET => 503; retry ingredients GET delayed 1400ms then passed through normally',
      errorState,
      pendingState,
      repeatRetryAttempt: repeat,
      recoveredState,
      parentState,
      retryRequestCounts: summarizeGetViews(c.pausedLog.slice(beforeRetryIndex)),
      screenshots: [errorShot, pendingShot, recoveredShot, parentShot],
    }
  }))

  report.scenarios.push(await runScenario('compare_nutrition_503_delayed_retry', async (c) => {
    const nutritionRule = makeRule({ fail: 1 })
    c.setRule('compare_product_nutrition', nutritionRule.handler)
    await c.nav(compareUrl('nutrition'))
    await c.wait(`document.querySelector('.compare-stage') && document.querySelector('#compare-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'compare nutrition active')
    await c.wait(`document.querySelector('.compare-state.is-error')?.textContent?.includes('영양 정보를 불러오지 못했습니다.')`, 'compare nutrition 503 error')
    const errorState = await compareState(c)
    assert.ok(errorState.error?.includes('영양 정보를 불러오지 못했습니다.'), 'compare nutrition error not surfaced')
    assert.equal(errorState.hasNutritionSection, false, 'compare 503 rendered normal nutrition data table')
    const errorShot = await c.shot('08-compare-nutrition-503.png')

    nutritionRule.state.delayNextMs = 1200
    const beforeRetryIndex = c.pausedLog.length
    await clickVisible(c, '.compare-state.is-error button')
    await sleep(100)
    const pendingState = await compareState(c)
    const repeat = await tryRepeatRetry(c, '.compare-state.is-error button')
    const pendingShot = await c.shot('09-compare-nutrition-retry-pending.png')
    await c.wait(`document.querySelector('#compare-tab-nutrition')?.getAttribute('aria-selected')==='true' && !document.querySelector('.compare-state.is-error') && document.querySelector('.compare-table-wrap')?.textContent?.includes('영양 성분')`, 'compare nutrition recovery', 45000)
    const recoveredState = await compareState(c)
    const compareIds = (recoveredState.params.compare || '').split(',')
    assert.deepEqual(compareIds, [GO.id, MONGE.id], 'compare IDs changed across retry')
    assert.equal(recoveredState.params.compareTab, 'nutrition', 'compare tab URL state changed across retry')
    assert.equal(recoveredState.activeTab?.id, 'compare-tab-nutrition', 'compare active tab changed across retry')
    const recoveredShot = await c.shot('10-compare-nutrition-recovered.png')
    return {
      injected: 'first two-product compare_product_nutrition GET => 503; retry nutrition GET delayed 1200ms then passed through normally',
      errorState,
      pendingState,
      repeatRetryAttempt: repeat,
      recoveredState,
      retryRequestCounts: summarizeGetViews(c.pausedLog.slice(beforeRetryIndex)),
      screenshots: [errorShot, pendingShot, recoveredShot],
    }
  }))

  report.scenarios.push(await runScenario('detail_nutrition_200_empty', async (c) => {
    const nutritionRule = makeRule({ empty: 1 })
    c.setRule('compare_product_nutrition', nutritionRule.handler)
    await c.nav(detailUrl('nutrition'))
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'detail empty nutrition tab active')
    await c.wait(`document.body.innerText.includes('현재 확인된 영양 정보가 없습니다.')`, 'detail normal empty nutrition')
    const state = await detailState(c)
    assert.equal(state.error, null, '200 empty nutrition incorrectly shown as error')
    assert.ok(state.empty.some((text) => text.includes('현재 확인된 영양 정보가 없습니다.')), 'normal empty nutrition message missing')
    assert.equal(state.retryButtons.length, 0, 'normal empty nutrition exposed retry error control')
    const shot = await c.shot('11-detail-nutrition-200-empty.png')
    return { injected: 'first compare_product_nutrition GET => HTTP 200 []', state, screenshots: [shot] }
  }))

  report.scenarios.push(await runScenario('compare_ingredients_200_empty', async (c) => {
    const ingredientRule = makeRule({ empty: 1 })
    c.setRule('compare_product_ingredients', ingredientRule.handler)
    await c.nav(compareUrl('ingredients'))
    await c.wait(`document.querySelector('.compare-stage') && document.querySelector('#compare-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'compare empty ingredients active')
    await c.wait(`!document.querySelector('.compare-state') && document.querySelector('.compare-table-wrap')?.textContent?.includes('목록 상태')`, 'compare normal empty ingredients')
    const state = await compareState(c)
    assert.equal(state.error, null, '200 empty compare ingredients incorrectly shown as error')
    assert.ok(state.unknownCount > 0 || state.noValueCount > 0, 'compare empty response did not render unknown/no-value semantics')
    assert.equal(state.retryButtons.length, 0, 'normal empty compare ingredients exposed retry error control')
    const compareIds = (state.params.compare || '').split(',')
    assert.deepEqual(compareIds, [GO.id, MONGE.id], 'compare IDs changed in empty response case')
    const shot = await c.shot('12-compare-ingredients-200-empty.png')
    return { injected: 'first two-product compare_product_ingredients GET => HTTP 200 []', state, screenshots: [shot] }
  }))

  for (const scenario of report.scenarios) {
    assert.equal(scenario.runtimeExceptions.length, 0, `${scenario.name}: runtime exception observed`)
    assert.equal(scenario.consoleErrors.length, 0, `${scenario.name}: console error observed`)
  }
  report.status = 'pass'
} catch (error) {
  report.status = 'fail'
  report.failure = String(error?.stack || error)
} finally {
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
}

if (report.status !== 'pass') process.exitCode = 1
