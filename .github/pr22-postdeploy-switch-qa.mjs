import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'https://osrm.github.io/catfood_web/'
const DEPLOY_SHA = process.env.DEPLOY_SHA ?? 'unknown'
const EXPECTED_ASSET = process.env.EXPECTED_ASSET ?? ''
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const OUT = 'qa-artifacts'
const STORAGE_KEY = 'catfood.switch-session.v1'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)

assert.ok(SUPABASE_URL && SUPABASE_KEY, 'public Supabase read config missing')

async function apiRows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view} read failed: ${response.status}`)
  return response.json()
}

async function chooseCurrentProduct() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,variant_count,has_variants',
    order: 'brand.asc,canonical_name.asc',
    limit: 1000,
  })
  const candidates = products.filter((row) => row?.product_id && row?.canonical_name && row?.brand && row?.feed_type && Number(row?.variant_count) >= 2)
  for (const product of candidates) {
    const hasPeer = products.some((row) => row?.product_id !== product.product_id && row?.brand !== product.brand && row?.feed_type === product.feed_type)
    if (!hasPeer) continue
    const variants = await apiRows('switch_current_variant_options', {
      select: 'product_id,variant_id,package_size_text,display_rank',
      product_id: `eq.${product.product_id}`,
      order: 'display_rank.asc,variant_id.asc',
      limit: 100,
    })
    if (variants.length >= 2) return { product, variants }
  }
  throw new Error('no suitable multi-SKU current product found')
}

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.listeners = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method) {
        if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method })
        for (const fn of this.listeners.get(message.method) ?? []) fn(message.params)
      }
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('DOM.enable')
    await this.send('CSS.enable')
    await this.send('Network.enable')
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const originalFetch = window.fetch.bind(window)
      window.__qaBlockedAnalytics = 0
      window.__qaBlockedWrites = 0
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
        if (url.includes('/functions/v1/decision-intake')) {
          window.__qaBlockedAnalytics += 1
          return Promise.reject(new TypeError('QA blocked analytics before network send'))
        }
        if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          window.__qaBlockedWrites += 1
          return Promise.reject(new TypeError('QA blocked production write before network send'))
        }
        return originalFetch(input, init)
      }
    })();` })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, ms = 30000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, 'document ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'root content')
    await this.eval('document.fonts?.ready')
    await sleep(300)
  }
  async reload() {
    await this.send('Page.reload', { ignoreCache: true })
    await this.wait(`document.readyState === 'complete'`, 'reload ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'reload root')
    await this.eval('document.fonts?.ready')
    await sleep(350)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready'); await sleep(120)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }
  async platformFonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId, `missing node for font check: ${selector}`)
    const result = await this.send('CSS.getPlatformFontsForNode', { nodeId })
    return result.fonts ?? []
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const bin = '/usr/bin/google-chrome'
  assert.ok(existsSync(bin), 'hosted runner Chrome unavailable')
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
  const port = 9970 + (process.pid % 20)
  const dir = `/tmp/pr22-postdeploy-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) { const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect(); return { cdp, version, proc, dir } }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function clickExact(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${js(text)}); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing exact button: ${text}`); await sleep(180)
}
async function clickContains(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing button containing: ${text}`); await sleep(180)
}
async function clickSelectorContaining(cdp, selector, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll(${js(selector)})].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing ${selector} containing: ${text}`); await sleep(180)
}
async function setInput(cdp, selector, value) {
  const ok = await cdp.eval(`(() => { const n=document.querySelector(${js(selector)}); if(!n)return false; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(n,${js(value)}); n.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(ok, true, `missing input ${selector}`); await sleep(250)
}
async function sessionState(cdp) {
  return cdp.eval(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`)
}

const html = await (await fetch(BASE, { cache: 'no-store' })).text()
assert.ok(EXPECTED_ASSET && html.includes(`./assets/${EXPECTED_ASSET}`), `Pages does not serve expected merge asset ${EXPECTED_ASSET}`)
const { product: current, variants } = await chooseCurrentProduct()
const { cdp, version, proc, dir } = await launch()
const report = {
  deploySha: DEPLOY_SHA,
  pageUrl: BASE,
  expectedAsset: EXPECTED_ASSET,
  browserVersion: version,
  koreanFontEnvironment: true,
  analyticsInterceptInstalledBeforeNavigation: true,
  productionWrites: false,
  currentProduct: current,
  publicVariantCount: variants.length,
  checks: {},
}

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  const url = new URL(BASE)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'switch')
  await cdp.nav(url.toString())
  await cdp.wait(`document.body.innerText.includes('데이터 연결됨')`, 'production catalog connected')

  await setInput(cdp, '.switch-find-search input', current.canonical_name)
  await cdp.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes(${js(current.canonical_name)}) && n.textContent.includes(${js(current.brand)}))`, 'current product search')
  await clickSelectorContaining(cdp, '.switch-find-result', current.canonical_name)
  await clickContains(cdp, '이 제품을 현재 사료로 선택')
  await cdp.wait(`document.body.innerText.includes('현재 먹이는 규격을 골라주세요') && document.querySelectorAll('.switch-sku-option').length >= 2`, 'actual SKU options')

  const skuText = await cdp.eval(`document.querySelector('.switch-sku-option strong')?.textContent.trim()`)
  assert.ok(skuText, 'actual SKU label missing')
  await clickSelectorContaining(cdp, '.switch-sku-option', skuText)
  let state = await sessionState(cdp)
  assert.equal(state?.variantSelection?.kind, 'variant')
  const variantId = state.variantSelection.variantId
  assert.ok(variantId, 'actual variant id not stored')

  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE step')
  await clickExact(cdp, '다른 브랜드로 보기')
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP step')
  await clickExact(cdp, `${current.feed_type} 유지`)
  state = await sessionState(cdp)
  assert.equal(state.changeBrand, true)
  assert.equal(state.keep.feedType, current.feed_type)
  await cdp.shot(`${OUT}/pr22-postdeploy-${DEPLOY_SHA.slice(0,8)}-01-keep-selected.png`)

  await clickExact(cdp, '← 바꿀 것 수정')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'explicit back to CHANGE')
  state = await sessionState(cdp)
  assert.equal(state.changeBrand, true)
  assert.equal(state.keep.feedType, current.feed_type)
  assert.equal(state.variantSelection.variantId, variantId)
  await cdp.shot(`${OUT}/pr22-postdeploy-${DEPLOY_SHA.slice(0,8)}-02-back-change-preserved.png`)

  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP reentry')
  assert.equal(await cdp.eval(`[...document.querySelectorAll('button')].some(n=>n.textContent.trim()===${js(`${current.feed_type} 유지`)} && n.getAttribute('aria-pressed')==='true')`), true)
  await clickExact(cdp, '← 바꿀 것 수정')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE before SKU back')
  await clickExact(cdp, '← 사용 규격')
  await cdp.wait(`document.body.innerText.includes('현재 먹이는 규격을 골라주세요')`, 'explicit back to SKU')
  state = await sessionState(cdp)
  assert.equal(state.variantSelection.variantId, variantId)
  assert.equal(state.changeBrand, true)
  assert.equal(state.keep.feedType, current.feed_type)
  assert.equal(await cdp.eval(`document.querySelector('.switch-sku-option.is-selected strong')?.textContent.trim()`), skuText)
  await cdp.shot(`${OUT}/pr22-postdeploy-${DEPLOY_SHA.slice(0,8)}-03-back-sku-preserved.png`)

  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE after SKU')
  assert.equal(await cdp.eval(`[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='다른 브랜드로 보기' && n.getAttribute('aria-pressed')==='true')`), true)
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP after SKU')
  assert.equal(await cdp.eval(`[...document.querySelectorAll('button')].some(n=>n.textContent.trim()===${js(`${current.feed_type} 유지`)} && n.getAttribute('aria-pressed')==='true')`), true)
  await clickContains(cdp, '후보 제품 보기')
  await cdp.wait(`document.querySelector('.switch-results-stage')`, 'candidate results')
  await cdp.wait(`document.querySelectorAll('.switch-candidate-row').length > 0`, 'at least one real candidate')
  const initialSummary = await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent.trim()`)
  const initialState = await sessionState(cdp)

  await clickExact(cdp, '제품 찾기')
  await cdp.wait(`document.querySelector('.mode-button.is-active')?.textContent.includes('제품 찾기')`, 'LOOKUP mode')
  await clickExact(cdp, '현재 사료')
  await cdp.wait(`document.querySelector('.switch-results-stage')`, 'SWITCH mode roundtrip')
  let roundtripSummary = await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent.trim()`)
  state = await sessionState(cdp)
  assert.equal(roundtripSummary, initialSummary)
  assert.equal(state.currentProductId, current.product_id)
  assert.equal(state.variantSelection.variantId, variantId)
  assert.equal(state.changeBrand, true)
  assert.equal(state.keep.feedType, current.feed_type)

  await cdp.reload()
  await cdp.wait(`document.body.innerText.includes('데이터 연결됨') && document.querySelector('.switch-results-stage')`, 'refresh restored SWITCH')
  const refreshSummary = await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent.trim()`)
  state = await sessionState(cdp)
  assert.equal(refreshSummary, initialSummary)
  assert.equal(state.currentProductId, current.product_id)
  assert.equal(state.variantSelection.variantId, variantId)
  assert.equal(state.changeBrand, true)
  assert.equal(state.keep.feedType, current.feed_type)
  const fonts = await cdp.platformFonts('.mode-button.is-active')
  assert.ok(fonts.some((font) => /Noto Sans CJK KR/i.test(font.familyName) && font.glyphCount > 0), `Korean UI did not use Noto Sans CJK KR: ${JSON.stringify(fonts)}`)
  await cdp.shot(`${OUT}/pr22-postdeploy-${DEPLOY_SHA.slice(0,8)}-04-roundtrip-refresh.png`)

  const candidateName = await cdp.eval(`document.querySelector('.switch-candidate-row .switch-candidate-identity strong')?.textContent.trim()`)
  assert.ok(candidateName, 'candidate name missing')
  await clickSelectorContaining(cdp, '.switch-candidate-row', candidateName)
  await cdp.wait(`document.querySelector('.switch-candidate-inspector')`, 'candidate inspector')
  await clickExact(cdp, '상세 보기 →')
  await cdp.wait(`!document.querySelector('.switch-results-stage') && document.body.innerText.includes(${js(candidateName)})`, 'candidate detail')
  await cdp.shot(`${OUT}/pr22-postdeploy-${DEPLOY_SHA.slice(0,8)}-05-detail.png`)

  await cdp.eval('history.back()')
  await cdp.wait(`document.querySelector('.switch-results-stage')`, 'browser back to results')
  await cdp.shot(`${OUT}/pr22-postdeploy-${DEPLOY_SHA.slice(0,8)}-06-browser-back-results.png`)
  await cdp.eval('history.forward()')
  await cdp.wait(`!document.querySelector('.switch-results-stage') && document.body.innerText.includes(${js(candidateName)})`, 'browser forward to detail')
  await cdp.shot(`${OUT}/pr22-postdeploy-${DEPLOY_SHA.slice(0,8)}-07-browser-forward-detail.png`)

  const blocked = await cdp.eval(`({ analytics: window.__qaBlockedAnalytics || 0, writes: window.__qaBlockedWrites || 0 })`)
  const supabaseWritesSent = cdp.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  const analyticsSent = cdp.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const catalogReads = cdp.requests.filter((request) => request.url.includes('/rest/v1/effective_product_catalog_summary') && request.method === 'GET')
  assert.deepEqual(supabaseWritesSent, [])
  assert.deepEqual(analyticsSent, [])
  assert.ok(catalogReads.length > 0, 'browser did not read the public production catalog')

  report.checks = {
    skuText,
    variantId,
    explicitBackState: { changeBrand: initialState.changeBrand, keepFeedType: initialState.keep.feedType },
    lookupSwitchRoundtrip: roundtripSummary === initialSummary,
    refreshRestored: refreshSummary === initialSummary,
    candidateName,
    browserBackForward: true,
    blockedBeforeSend: blocked,
    supabaseWritesSent,
    analyticsSent,
    publicCatalogReads: catalogReads.length,
    platformFonts: fonts,
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR22_POSTDEPLOY_SWITCH_QA_PASS', JSON.stringify({
    deploySha: DEPLOY_SHA,
    asset: EXPECTED_ASSET,
    currentProduct: { product_id: current.product_id, brand: current.brand, canonical_name: current.canonical_name },
    skuText,
    variantId,
    changeBrand: state.changeBrand,
    keepFeedType: state.keep.feedType,
    candidateName,
    blocked,
    publicCatalogReads: catalogReads.length,
    browserVersion: version,
  }))
} finally {
  cdp.close()
  try { proc.kill('SIGTERM') } catch {}
  rmSync(dir, { recursive: true, force: true })
}
