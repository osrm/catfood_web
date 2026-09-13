import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const EXPECTED_MAIN = '7fd488d226eba38080c73b95b6e4735f868a0bf7'
const OUT = 'qa-artifacts/explore-result-unknown-review'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = []
    this.catalogRequestId = null
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
      if (message.method === 'Network.responseReceived') {
        const url = message.params.response.url || ''
        if (url.includes('/rest/v1/effective_product_catalog_summary')) this.catalogRequestId = message.params.requestId
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
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'app root')
    await this.eval('document.fonts?.ready')
    await this.wait(`document.querySelector('.research-status span:last-child')?.textContent.includes('데이터 연결됨')`, 'catalog loaded')
    await this.wait(`document.querySelector('.research-result-card')`, 'result cards')
    await sleep(180)
  }
  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height })
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(120)
    const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(image.data, 'base64'))
  }
  async catalogRows() {
    for (let i = 0; i < 100 && !this.catalogRequestId; i += 1) await sleep(100)
    assert.ok(this.catalogRequestId, 'catalog request id not observed')
    for (let i = 0; i < 100; i += 1) {
      try {
        const body = await this.send('Network.getResponseBody', { requestId: this.catalogRequestId })
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
        return JSON.parse(text)
      } catch {
        await sleep(100)
      }
    }
    throw new Error('catalog response body unavailable')
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launchBrowser() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9870 + (process.pid % 100)
  const dir = `/tmp/explore-unknown-${process.pid}`
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

async function pointerSelector(c, selector) {
  const target = await c.eval(`(()=>{const n=document.querySelector(${js(selector)});if(!n)return null;n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,disabled:Boolean(n.disabled),centerHit:Boolean(h&&(h===n||n.contains(h)))}})()`)
  assert.ok(target, `missing selector ${selector}`)
  assert.equal(target.disabled, false, `disabled selector ${selector}`)
  assert.equal(target.centerHit, true, `pointer center unavailable ${selector}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await sleep(160)
}

async function cardData(c) {
  return c.eval(`[...document.querySelectorAll('.research-result-card')].map(card=>{const id=card.getAttribute('data-product-id');const brand=card.querySelector('.research-result-brand')?.textContent?.trim()||'';const name=card.querySelector('.research-result-identity strong')?.textContent?.trim()||'';const meta=card.querySelector('.research-result-meta')?.textContent?.trim()||'';const confirmed=card.querySelector('.relation-line.is-confirmed strong')?.textContent?.trim()||'';const unknown=card.querySelector('.relation-line.is-unknown strong')?.textContent?.trim()||'';const confirmedLabel=card.querySelector('.relation-line.is-confirmed span')?.textContent?.trim()||'';const unknownLabel=card.querySelector('.relation-line.is-unknown span')?.textContent?.trim()||'';return{id,brand,name,meta,confirmed,unknown,confirmedLabel,unknownLabel}})`)
}

async function findCases(c) {
  for (let round = 0; round < 30; round += 1) {
    const cards = await cardData(c)
    const confirmed = cards.find((card) => card.confirmed.includes('건식') && card.confirmed.includes('실내묘') && !card.unknown)
    const unknown = cards.find((card) => card.confirmed.includes('건식') && card.unknown.includes('실내묘')) || cards.find((card) => card.unknown)
    if (confirmed && unknown) return { confirmed, unknown, rendered: cards.length }
    const hasMore = await c.eval(`Boolean(document.querySelector('.load-more'))`)
    if (!hasMore) return { confirmed, unknown, rendered: cards.length }
    const before = cards.length
    await pointerSelector(c, '.load-more')
    await c.wait(`document.querySelectorAll('.research-result-card').length>${before}`, 'more results')
  }
  throw new Error('case search exceeded load rounds')
}

async function headingState(c) {
  return c.eval(`(()=>({criteria:[...document.querySelectorAll('.criteria-chips span')].map(n=>n.textContent.trim()),count:document.querySelector('.research-results-heading>div>span')?.textContent?.trim()||'',context:document.querySelector('.research-results-context')?.textContent?.trim()||''}))()`)
}

async function relationStyle(c, id) {
  return c.eval(`(()=>{const card=document.querySelector('[data-product-id="'+${js(id)}+'"]');const take=(line)=>{if(!line)return null;const label=line.querySelector('span'),value=line.querySelector('strong'),ls=getComputedStyle(label),vs=getComputedStyle(value);return{label:label?.textContent?.trim()||'',value:value?.textContent?.trim()||'',labelColor:ls.color,valueColor:vs.color,fontWeight:vs.fontWeight}};return{confirmed:take(card?.querySelector('.relation-line.is-confirmed')),unknown:take(card?.querySelector('.relation-line.is-unknown'))}})()`)
}

async function quickViewState(c) {
  return c.eval(`(()=>{const q=document.querySelector('.research-quick-view');const section=[...q.querySelectorAll('.quick-view-section')].find(s=>s.querySelector('h2')?.textContent?.trim()==='선택한 조건과 비교');const defs={};for(const d of section?.querySelectorAll('.definition')||[]){const k=d.querySelector('dt')?.textContent?.trim()||'';defs[k]=d.querySelector('dd')?.textContent?.replace(/\\s+/g,' ').trim()||''}return{name:q.querySelector('h1')?.textContent?.trim()||'',identity:q.querySelector('.quick-view-identity p')?.textContent?.replace(/\\s+/g,' ').trim()||'',definitions:defs,fullText:q.textContent.replace(/\\s+/g,' ').trim()}})()`)
}

const report = { expectedMain: EXPECTED_MAIN, base: BASE, status: 'running' }
let browser
try {
  browser = await launchBrowser()
  const { c } = browser
  await c.viewport(360, 844)
  const url = new URL(BASE)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('applied', '1')
  url.searchParams.set('feed', '건식')
  url.searchParams.set('targets', 'indoor')
  await c.nav(url.toString())

  const heading = await headingState(c)
  assert.deepEqual(heading.criteria, ['건식', '실내묘'])
  assert.match(heading.count, /제품|표시/)

  const catalog = await c.catalogRows()
  const cases = await findCases(c)
  assert.ok(cases.confirmed, 'confirmed dry + indoor case not found')
  assert.ok(cases.unknown, 'unknown selected-condition case not found')

  const confirmedRow = catalog.find((row) => row.product_id === cases.confirmed.id)
  const unknownRow = catalog.find((row) => row.product_id === cases.unknown.id)
  assert.ok(confirmedRow, 'confirmed public catalog row missing')
  assert.ok(unknownRow, 'unknown public catalog row missing')
  assert.equal(confirmedRow.feed_type, '건식')
  assert.ok(Array.isArray(confirmedRow.official_targets) && confirmedRow.official_targets.includes('indoor'))
  if (cases.unknown.confirmed.includes('건식') && cases.unknown.unknown.includes('실내묘')) {
    assert.equal(unknownRow.feed_type, '건식')
    assert.ok(!Array.isArray(unknownRow.official_targets) || !unknownRow.official_targets.includes('indoor'))
  }

  await c.eval(`document.querySelector('[data-product-id="${cases.confirmed.id}"]').scrollIntoView({block:'center',behavior:'instant'})`)
  await sleep(120)
  const confirmedStyle = await relationStyle(c, cases.confirmed.id)
  await c.shot(`${OUT}/01-confirmed-card.png`)
  await pointerSelector(c, `[data-product-id="${cases.confirmed.id}"]`)
  await c.wait(`document.querySelector('.research-quick-view h1')?.textContent?.trim()===${js(cases.confirmed.name)}`, 'confirmed quick view')
  const confirmedQuick = await quickViewState(c)
  await pointerSelector(c, '.quick-view-topline button')
  await c.wait(`!document.querySelector('.research-quick-view')`, 'confirmed quick view close')

  await c.eval(`document.querySelector('[data-product-id="${cases.unknown.id}"]').scrollIntoView({block:'center',behavior:'instant'})`)
  await sleep(120)
  const unknownStyle = await relationStyle(c, cases.unknown.id)
  await c.shot(`${OUT}/02-unknown-card.png`)
  await pointerSelector(c, `[data-product-id="${cases.unknown.id}"]`)
  await c.wait(`document.querySelector('.research-quick-view h1')?.textContent?.trim()===${js(cases.unknown.name)}`, 'unknown quick view')
  const unknownQuick = await quickViewState(c)
  await c.shot(`${OUT}/03-unknown-quick-view.png`)
  await pointerSelector(c, '.quick-view-topline button')
  await c.wait(`!document.querySelector('.research-quick-view')`, 'unknown quick view close')

  assert.match(confirmedQuick.definitions['확인됨'] || '', /건식/)
  assert.match(confirmedQuick.definitions['확인됨'] || '', /실내묘/)
  assert.equal(confirmedQuick.definitions['미확인'], '—')
  assert.ok((unknownQuick.definitions['미확인'] || '').length > 0)

  const networkState = await c.eval(`({blockedAnalytics:window.__qaBlockedAnalytics||0,blockedWrites:window.__qaBlockedWrites||0})`)
  const actualAnalytics = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const actualWrites = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(request.method))
  const publicGets = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && request.method === 'GET')
  assert.equal(actualAnalytics.length, 0, `analytics escaped blocker: ${JSON.stringify(actualAnalytics)}`)
  assert.equal(actualWrites.length, 0, `production write escaped blocker: ${JSON.stringify(actualWrites)}`)

  report.status = 'pass'
  report.heading = heading
  report.renderedCards = cases.rendered
  report.confirmed = {
    card: cases.confirmed,
    publicFields: { product_id: confirmedRow.product_id, brand: confirmedRow.brand, canonical_name: confirmedRow.canonical_name, feed_type: confirmedRow.feed_type, official_targets: confirmedRow.official_targets },
    style: confirmedStyle,
    quickView: confirmedQuick,
  }
  report.unknown = {
    card: cases.unknown,
    publicFields: { product_id: unknownRow.product_id, brand: unknownRow.brand, canonical_name: unknownRow.canonical_name, feed_type: unknownRow.feed_type, official_targets: unknownRow.official_targets },
    style: unknownStyle,
    quickView: unknownQuick,
  }
  report.network = { ...networkState, actualAnalytics, actualWrites, publicGetCount: publicGets.length, publicGetUrls: [...new Set(publicGets.map((request) => request.url.split('?')[0]))] }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('EXPLORE_UNKNOWN_REVIEW_PASS', JSON.stringify({ heading, confirmed: report.confirmed.publicFields, unknown: report.unknown.publicFields, network: report.network }))
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
