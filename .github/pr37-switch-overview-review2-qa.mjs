import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const CANDIDATE_BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/catfood_web/'
const BASELINE_BASE = process.env.BASELINE_BASE ?? 'http://127.0.0.1:4174/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA ?? 'unknown'
const BASELINE_SHA = process.env.BASELINE_SHA ?? 'unknown'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const STORAGE_KEY = 'catfood.switch-session.v1'
const OUT = 'qa-artifacts'
mkdirSync(OUT, { recursive: true })
assert.ok(SUPABASE_URL && SUPABASE_KEY, 'public Supabase read config missing')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
let launchIndex = 0

async function apiRows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view} read failed: ${response.status}`)
  return response.json()
}

async function makeContext() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,manufacturing_country_codes,variant_count',
    order: 'brand.asc,canonical_name.asc',
    limit: 1000,
  })
  const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어')
  assert.ok(current, 'AATU 연어 current food not found')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,units_per_sale,display_rank',
    product_id: `eq.${current.product_id}`,
    order: 'display_rank.asc,variant_id.asc',
    limit: 100,
  })
  const sku = variants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? ''))
  assert.ok(sku, 'AATU 연어 1 kg SKU not found')

  const eligible = products.filter((row) => row.product_id !== current.product_id)
  const groups = new Map()
  for (const product of eligible) {
    const rows = groups.get(product.brand) ?? []
    rows.push(product)
    groups.set(product.brand, rows)
  }
  const sameBrand = [...groups.values()].filter((rows) => rows.length >= 2)
    .sort((a, b) => Math.max(...b.map((row) => row.canonical_name.length)) - Math.max(...a.map((row) => row.canonical_name.length)))[0]
    .sort((a, b) => b.canonical_name.length - a.canonical_name.length)
    .slice(0, 2)
  assert.equal(sameBrand.length, 2, 'same-brand candidate pair not found')
  const longest = [...eligible].sort((a, b) => b.canonical_name.length - a.canonical_name.length)[0]
  const unknown = eligible.find((row) => !row.feed_type || !row.life_stage || !(row.manufacturing_country_codes?.length))
  assert.ok(longest && unknown, 'long/unknown candidate not found')
  const five = []
  for (const product of [...sameBrand, longest, unknown, ...eligible]) {
    if (!five.some((row) => row.product_id === product.product_id)) five.push(product)
    if (five.length === 5) break
  }
  assert.equal(five.length, 5, 'five candidates required')
  const unknownField = !unknown.feed_type ? '사료 형태' : !unknown.life_stage ? '대상 연령' : '제조국'
  return { current, sku, five, sameBrand, longest, unknown, unknownField }
}

function emptyCriteria() {
  return { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false }
}
function fixtureSnapshot(ctx, compareIds) {
  return {
    version: 1,
    state: {
      query: `${ctx.current.brand} ${ctx.current.canonical_name}`,
      currentProductId: ctx.current.product_id,
      variantSelection: { kind: 'variant', variantId: ctx.sku.variant_id },
      change: emptyCriteria(),
      keep: emptyCriteria(),
      changeBrand: false,
      keepBrand: false,
      ingredientAvoidTerms: [],
      noChangeIntent: true,
      step: 'results',
      visibleCandidateCount: 40,
      selectedCandidateId: null,
      compareIds,
      compareOpen: true,
      compareTab: 'overview',
      detailProductId: null,
      detailTab: 'overview',
    },
  }
}

class Browser {
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
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
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
    for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(domain)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, timeout = 30000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout: ${label}`)
  }
  async navigate(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, 'document ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'app root')
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

async function launch({ width, height, mobile, snapshot = null }) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9700 + (process.pid % 100) + launchIndex++ * 100
  const dir = `/tmp/pr37-review2-${process.pid}-${launchIndex}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('page not ready')
      const browser = new Browser(page.webSocketDebuggerUrl)
      await browser.connect()
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
      await browser.send('Emulation.setUserAgentOverride', {
        userAgent: mobile
          ? 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8',
        platform: mobile ? 'Android' : 'Linux',
      })
      await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        ${snapshot ? `try { sessionStorage.setItem(${js(STORAGE_KEY)}, ${js(JSON.stringify(snapshot))}) } catch {}` : ''}
        const nativeFetch = window.fetch.bind(window)
        window.__qaBlockedAnalytics = 0
        window.__qaBlockedWrites = 0
        window.fetch = (input, init = {}) => {
          const url = typeof input === 'string' ? input : (input && input.url) || ''
          const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
          if (url.includes('/functions/v1/decision-intake')) {
            window.__qaBlockedAnalytics += 1
            return Promise.reject(new TypeError('QA blocked analytics before send'))
          }
          if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(method)) {
            window.__qaBlockedWrites += 1
            return Promise.reject(new TypeError('QA blocked production write before send'))
          }
          return nativeFetch(input, init)
        }
      })();` })
      return { browser, proc, dir }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function cleanup(handle) {
  handle.browser.close()
  handle.proc.kill('SIGTERM')
  await sleep(200)
  if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL')
  try { rmSync(handle.dir, { recursive: true, force: true }) } catch {}
}

async function pointerClick(browser, selector, { index = 0, text = null } = {}) {
  const target = await browser.eval(`(() => {
    const nodes=[...document.querySelectorAll(${js(selector)})]
    const n=${text ? `nodes.find((el)=>el.textContent?.includes(${js(text)}))` : `nodes[${index}]`}
    if(!n)return null
    n.scrollIntoView({block:'center',inline:'center'})
    const r=n.getBoundingClientRect()
    return {x:r.left+r.width/2,y:r.top+r.height/2,text:n.textContent?.trim()||'',tag:n.tagName}
  })()`)
  assert.ok(target, `missing pointer target: ${selector} ${text ?? index}`)
  await browser.eval(`window.__qaPointerEvents=[]; (() => {
    const nodes=[...document.querySelectorAll(${js(selector)})]
    const n=${text ? `nodes.find((el)=>el.textContent?.includes(${js(text)}))` : `nodes[${index}]`}
    if(!n)return
    for(const type of ['pointerdown','pointerup','click']) n.addEventListener(type,(event)=>window.__qaPointerEvents.push({type,isTrusted:event.isTrusted}),true)
  })()`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none', buttons: 0, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(180)
  const events = await browser.eval('window.__qaPointerEvents')
  assert.ok(events.some((event) => event.type === 'click' && event.isTrusted), `trusted click missing: ${selector}`)
  return { target, events }
}

async function typeInto(browser, selector, value) {
  await pointerClick(browser, selector)
  await browser.send('Input.insertText', { text: value })
  await sleep(300)
  assert.equal(await browser.eval(`document.querySelector(${js(selector)})?.value`), value)
}

async function sessionState(browser) {
  return browser.eval(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`)
}

async function goHistoryBack(browser, successExpression, label) {
  const history = await browser.send('Page.getNavigationHistory')
  assert.ok(history.currentIndex > 0, `no app-created previous history entry: ${label}`)
  const entry = history.entries[history.currentIndex - 1]
  await browser.send('Page.navigateToHistoryEntry', { entryId: entry.id })
  await browser.wait(successExpression, label)
  await sleep(200)
  return { fromIndex: history.currentIndex, toEntryId: entry.id, entryUrl: entry.url }
}

function browserNetworkReport(browser, currentId) {
  const compareRequests = browser.requests.filter((request) => request.url.includes('/compare_product_nutrition') || request.url.includes('/compare_product_ingredients'))
  const writes = browser.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(request.method))
  const analytics = browser.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  for (const request of compareRequests) {
    const filter = new URL(request.url).searchParams.get('product_id') ?? ''
    assert.equal(filter.includes(currentId), false, `current product leaked into compare request: ${filter}`)
  }
  assert.equal(writes.length, 0, 'production write request sent')
  assert.equal(analytics.length, 0, 'analytics request sent')
  return { compareRequests: compareRequests.map((request) => new URL(request.url).searchParams.get('product_id')), writes, analytics }
}

async function runActualJourney(ctx) {
  const handle = await launch({ width: 360, height: 844, mobile: true })
  const { browser } = handle
  try {
    await browser.navigate(`${CANDIDATE_BASE}?view=workspace&mode=switch`)
    const initialJourneySession = await sessionState(browser)
    assert.equal(initialJourneySession.currentProductId, null, 'journey unexpectedly started with injected current product')
    assert.deepEqual(initialJourneySession.compareIds, [], 'journey unexpectedly started with injected compareIds')
    assert.equal(initialJourneySession.compareOpen, false, 'journey unexpectedly started in compare')
    assert.equal(initialJourneySession.step, 'current', 'journey did not start from app CURRENT step')
    await browser.wait(`document.querySelector('.switch-find-search input')`, 'current product search')
    await typeInto(browser, '.switch-find-search input', 'AATU 연어')
    await browser.wait(`document.querySelector('.switch-find-result')`, 'current product result')
    const currentResult = await browser.eval(`document.querySelector('.switch-find-result')?.textContent`)
    assert.match(currentResult, /AATU/)
    assert.match(currentResult, /연어/)
    await pointerClick(browser, '.switch-find-result')
    await browser.wait(`document.querySelector('.switch-current-preview')`, 'current preview')
    await pointerClick(browser, '.switch-current-preview button', { text: '이 제품을 현재 사료로 선택' })
    await browser.wait(`document.querySelector('.switch-sku-list')`, 'SKU step')
    await pointerClick(browser, '.switch-sku-option', { text: '1 kg' })
    await pointerClick(browser, '.switch-step-actions .switch-primary-action', { text: '다음' })
    await browser.wait(`[...document.querySelectorAll('h1')].some((node)=>node.textContent?.includes('무엇을 바꾸고 싶나요'))`, 'CHANGE step')
    await pointerClick(browser, '.switch-no-change', { text: '특별히 바꾸고 싶은 점 없음' })
    await pointerClick(browser, '.switch-step-actions .switch-primary-action', { text: '다음' })
    await browser.wait(`[...document.querySelectorAll('h1')].some((node)=>node.textContent?.includes('무엇을 그대로 유지할까요'))`, 'KEEP step')
    await pointerClick(browser, '.switch-step-actions .switch-primary-action', { text: '후보 제품 보기' })
    await browser.wait(`document.querySelectorAll('.switch-candidate-row').length >= 2`, 'candidate results')

    const candidateNames = await browser.eval(`[...document.querySelectorAll('.switch-candidate-row')].slice(0,2).map((row)=>({
      brand:row.querySelector('.switch-candidate-identity > span')?.textContent?.trim(),
      name:row.querySelector('.switch-candidate-identity > strong')?.textContent?.trim()
    }))`)
    assert.equal(candidateNames.length, 2)

    await pointerClick(browser, '.switch-candidate-row', { index: 0 })
    await browser.wait(`document.querySelector('.switch-candidate-inspector')`, 'first candidate inspector')
    await pointerClick(browser, '.switch-inspector-actions .switch-compare-action', { text: '비교에 추가' })
    await pointerClick(browser, '.switch-preview-topline button', { text: '닫기' })
    await pointerClick(browser, '.switch-candidate-row', { index: 1 })
    await browser.wait(`document.querySelector('.switch-candidate-inspector')`, 'second candidate inspector')
    await pointerClick(browser, '.switch-inspector-actions .switch-compare-action', { text: '비교에 추가' })
    const beforeCompare = await sessionState(browser)
    assert.equal(beforeCompare.compareIds.length, 2)
    await pointerClick(browser, '.switch-compare-dock button', { text: '비교 보기' })
    await browser.wait(`document.querySelector('.compare-switch-mobile-overview')`, 'mobile compare')

    const compareHistory = await browser.send('Page.getNavigationHistory')
    assert.ok(compareHistory.currentIndex > 0, 'compare entry was not created by app UI')
    const pickerButtons = await browser.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].map((button)=>button.textContent.trim())`)
    assert.equal(pickerButtons.length, 2)
    assert.ok(pickerButtons.every((text) => text.includes(' · ')), 'picker must show brand and product name')

    await pointerClick(browser, '.compare-mobile-candidate-picker button', { index: 1 })
    await browser.wait(`document.querySelector('.compare-mobile-product-head.is-candidate')?.textContent.includes(${js(candidateNames[1].name)})`, 'second displayed candidate')
    const stateAfterPicker = await sessionState(browser)
    assert.deepEqual(stateAfterPicker.compareIds, beforeCompare.compareIds, 'local candidate picker changed compareIds')
    assert.deepEqual(stateAfterPicker.change, beforeCompare.change, 'local candidate picker changed CHANGE')
    assert.deepEqual(stateAfterPicker.keep, beforeCompare.keep, 'local candidate picker changed KEEP')
    await browser.shot(`${OUT}/journey-360-compare.png`)

    const historyBeforeDetail = await browser.send('Page.getNavigationHistory')
    await pointerClick(browser, '.compare-mobile-head-actions button', { text: '상세 보기' })
    await browser.wait(`document.querySelector('.detail-stage')`, 'candidate detail')
    const historyAfterDetail = await browser.send('Page.getNavigationHistory')
    assert.equal(historyAfterDetail.currentIndex, historyBeforeDetail.currentIndex + 1, 'detail did not create app history entry')
    const detailBack = await goHistoryBack(browser, `document.querySelector('.compare-switch-mobile-overview')`, 'back from detail')
    assert.match(await browser.eval(`document.querySelector('.compare-mobile-product-head.is-candidate')?.textContent`), new RegExp(candidateNames[1].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const beforeRemove = await sessionState(browser)
    const removedId = beforeRemove.compareIds[1]
    await pointerClick(browser, '.compare-mobile-head-actions button', { text: '비교에서 제거' })
    await browser.wait(`(${js(removedId)}) !== (JSON.parse(sessionStorage.getItem(${js(STORAGE_KEY)})).state.compareIds[1] || '')`, 'candidate removed')
    const afterRemove = await sessionState(browser)
    assert.deepEqual(afterRemove.compareIds, [beforeRemove.compareIds[0]])
    const compareBack = await goHistoryBack(browser, `document.querySelector('.switch-results-stage') && !document.querySelector('.compare-stage')`, 'back to results after removal')
    const afterBack = await sessionState(browser)
    assert.deepEqual(afterBack.compareIds, [beforeRemove.compareIds[0]], 'browser back resurrected removed candidate')
    assert.equal(afterBack.compareIds.includes(removedId), false)
    const dockText = await browser.eval(`document.querySelector('.switch-compare-dock')?.textContent || ''`)
    assert.equal(dockText.includes(candidateNames[1].name), false, 'removed candidate returned in compare dock')
    const blocked = await browser.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`)
    const network = browserNetworkReport(browser, ctx.current.product_id)
    return { candidateNames, beforeCompareIds: beforeCompare.compareIds, removedId, remainingIds: afterBack.compareIds, detailBack, compareBack, blocked, network }
  } finally {
    await cleanup(handle)
  }
}

async function openFixture(base, ctx, compareIds, width, height, mobile) {
  const handle = await launch({ width, height, mobile, snapshot: fixtureSnapshot(ctx, compareIds) })
  await handle.browser.navigate(`${base}?view=workspace&mode=switch`)
  await handle.browser.wait(`document.querySelector('.compare-stage')`, 'fixture compare stage')
  await handle.browser.wait(`document.body.textContent.includes('사용 규격 · 1 kg')`, 'fixture current SKU')
  return handle
}

async function firstFactMetric(base, ctx, compareIds, name) {
  const handle = await openFixture(base, ctx, compareIds, 360, 844, true)
  try {
    const metric = await handle.browser.eval(`(() => {
      const row=[...document.querySelectorAll('.compare-mobile-overview-row')].find((node)=>node.querySelector('.compare-mobile-row-label')?.textContent.trim()==='사료 형태')
      const header=document.querySelector('.compare-header')
      if(!row)return null
      const r=row.getBoundingClientRect(), h=header.getBoundingClientRect()
      return {top:r.top,bottom:r.bottom,height:r.height,headerBottom:h.bottom,documentHeight:document.documentElement.scrollHeight}
    })()`)
    assert.ok(metric, `${name}: first fact row missing`)
    await handle.browser.shot(`${OUT}/${name}-360-first-fact.png`)
    return metric
  } finally {
    await cleanup(handle)
  }
}

async function mobileFiveFixture(ctx) {
  const ids = ctx.five.map((row) => row.product_id)
  const handle = await openFixture(CANDIDATE_BASE, ctx, ids, 390, 900, true)
  const { browser } = handle
  try {
    const labels = await browser.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].map((button)=>({text:button.textContent.trim(),id:button.dataset.productId,height:button.getBoundingClientRect().height}))`)
    assert.equal(labels.length, 5)
    assert.deepEqual(labels.map((row) => row.id), ids)
    for (let index = 0; index < 5; index += 1) {
      assert.equal(labels[index].text, `${ctx.five[index].brand} · ${ctx.five[index].canonical_name}`)
      assert.ok(labels[index].height <= 52, `picker button became card-like: ${labels[index].height}`)
      await pointerClick(browser, '.compare-mobile-candidate-picker button', { index })
      await browser.wait(`document.querySelector('.compare-mobile-product-head.is-candidate')?.textContent.includes(${js(ctx.five[index].canonical_name)})`, `picker candidate ${index + 1}`)
    }
    assert.equal(ctx.sameBrand[0].brand, ctx.sameBrand[1].brand)
    assert.notEqual(labels[0].text, labels[1].text, 'same-brand products are not distinguishable')

    const longIndex = ctx.five.findIndex((row) => row.product_id === ctx.longest.product_id)
    assert.ok(longIndex >= 0)
    await pointerClick(browser, '.compare-mobile-candidate-picker button', { index: longIndex })
    const longMetric = await browser.eval(`(() => {
      const n=document.querySelector('.compare-mobile-product-head.is-candidate > strong'), s=getComputedStyle(n)
      return {text:n.textContent.trim(),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,lineClamp:s.webkitLineClamp,overflow:s.overflow}
    })()`)
    assert.equal(longMetric.text, ctx.longest.canonical_name)
    assert.equal(longMetric.scrollWidth, longMetric.clientWidth)
    assert.equal(longMetric.scrollHeight, longMetric.clientHeight)
    assert.ok(!longMetric.lineClamp || longMetric.lineClamp === 'none')

    const unknownIndex = ctx.five.findIndex((row) => row.product_id === ctx.unknown.product_id)
    assert.ok(unknownIndex >= 0)
    await pointerClick(browser, '.compare-mobile-candidate-picker button', { index: unknownIndex })
    const unknownText = await browser.eval(`(() => {
      const row=[...document.querySelectorAll('.compare-mobile-overview-row')].find((node)=>node.querySelector('.compare-mobile-row-label')?.textContent.trim()===${js(ctx.unknownField)})
      return row?.querySelector('.compare-mobile-pair > div:nth-child(2)')?.textContent || ''
    })()`)
    assert.match(unknownText, /미확인/)

    await pointerClick(browser, '.compare-mobile-candidate-picker button', { index: longIndex })
    const firstFact = await browser.eval(`(() => {
      const row=[...document.querySelectorAll('.compare-mobile-overview-row')].find((node)=>node.querySelector('.compare-mobile-row-label')?.textContent.trim()==='사료 형태')
      const r=row.getBoundingClientRect()
      return {top:r.top,bottom:r.bottom}
    })()`)
    await browser.shot(`${OUT}/after-390-five-picker-long.png`)
    return { labels, longMetric, unknownField: ctx.unknownField, unknownText, firstFact }
  } finally {
    await cleanup(handle)
  }
}

async function desktopRightEnd(ctx, width) {
  const ids = ctx.five.map((row) => row.product_id)
  const handle = await openFixture(CANDIDATE_BASE, ctx, ids, width, 900, false)
  const { browser } = handle
  try {
    const metrics = await browser.eval(`(() => {
      const wrap=document.querySelector('.compare-table-wrap')
      wrap.scrollLeft=wrap.scrollWidth
      const corner=document.querySelector('.compare-switch-overview-desktop .compare-corner')
      const currentHead=document.querySelector('.compare-switch-overview-desktop .compare-current-product-head')
      const row=[...document.querySelectorAll('.compare-switch-overview-row')].find((node)=>node.querySelector('.compare-row-label')?.textContent.trim()==='사료 형태')
      const label=row.querySelector('.compare-row-label')
      const current=row.querySelector('.compare-cell.is-current')
      const cells=[...row.querySelectorAll('.compare-cell:not(.is-current)')]
      const lastCell=cells.at(-1)
      const heads=[...document.querySelectorAll('.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head)')]
      const lastHead=heads.at(-1)
      const detail=lastHead.querySelector('.compare-detail-link')
      const remove=lastHead.querySelector('.compare-remove')
      const rect=(node)=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
      const hit=(node)=>{const r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,e=document.elementFromPoint(x,y);return {x,y,tag:e?.tagName||null,className:e?.className||'',same:e===node||node.contains(e)}}
      return {
        scrollLeft:wrap.scrollLeft,scrollMax:wrap.scrollWidth-wrap.clientWidth,wrap:rect(wrap),
        corner:rect(corner),label:rect(label),currentHead:rect(currentHead),current:rect(current),lastHead:rect(lastHead),lastCell:rect(lastCell),
        detail:rect(detail),remove:rect(remove),detailHit:hit(detail),removeHit:hit(remove),
        currentName:currentHead.querySelector('.compare-product-copy > strong')?.textContent?.trim(),
        lastName:lastHead.querySelector('.compare-product-copy > strong')?.textContent?.trim()
      }
    })()`)
    assert.ok(Math.abs(metrics.scrollLeft - metrics.scrollMax) <= 1, `${width}: not at right end`)
    assert.ok(Math.abs(metrics.currentHead.left - metrics.current.left) <= 1 && Math.abs(metrics.currentHead.right - metrics.current.right) <= 1, `${width}: current header/value column misaligned`)
    assert.ok(Math.abs(metrics.corner.left - metrics.label.left) <= 1 && Math.abs(metrics.corner.right - metrics.label.right) <= 1, `${width}: label column misaligned`)
    assert.ok(metrics.label.left >= metrics.wrap.left - 1 && metrics.label.right <= metrics.wrap.right + 1, `${width}: label not visible`)
    assert.ok(metrics.current.left >= metrics.wrap.left - 1 && metrics.current.right <= metrics.wrap.right + 1, `${width}: current value not visible`)
    assert.ok(metrics.lastCell.left >= metrics.current.right - 1 && metrics.lastCell.left < metrics.wrap.right, `${width}: last candidate value is covered`)
    assert.ok(metrics.detailHit.same, `${width}: last detail button hit-test blocked`)
    assert.ok(metrics.removeHit.same, `${width}: last remove button hit-test blocked`)
    assert.equal(metrics.currentName, ctx.current.canonical_name)
    assert.equal(metrics.lastName, ctx.five.at(-1).canonical_name)
    await browser.shot(`${OUT}/${width}x900-right-end.png`)
    return metrics
  } finally {
    await cleanup(handle)
  }
}

const ctx = await makeContext()
const report = {
  productSha: PRODUCT_SHA,
  baselineSha: BASELINE_SHA,
  browserVersion: execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim(),
  context: {
    current: { brand: ctx.current.brand, name: ctx.current.canonical_name, id: ctx.current.product_id, sku: ctx.sku.package_size_text },
    sameBrand: ctx.sameBrand.map((row) => ({ brand: row.brand, name: row.canonical_name, id: row.product_id })),
    longest: { brand: ctx.longest.brand, name: ctx.longest.canonical_name, id: ctx.longest.product_id },
    unknown: { brand: ctx.unknown.brand, name: ctx.unknown.canonical_name, id: ctx.unknown.product_id, field: ctx.unknownField },
  },
}

try {
  report.actualJourney = await runActualJourney(ctx)
  const fixtureIds = ctx.five.slice(0, 2).map((row) => row.product_id)
  report.firstFact = {
    before: await firstFactMetric(BASELINE_BASE, ctx, fixtureIds, 'before-e7da'),
    after: await firstFactMetric(CANDIDATE_BASE, ctx, fixtureIds, 'after-c18'),
  }
  report.firstFact.deltaTop = report.firstFact.after.top - report.firstFact.before.top
  assert.ok(report.firstFact.after.top < report.firstFact.before.top, `first fact did not move earlier: ${report.firstFact.deltaTop}`)
  report.mobileFive = await mobileFiveFixture(ctx)
  report.desktop = {
    761: await desktopRightEnd(ctx, 761),
    1280: await desktopRightEnd(ctx, 1280),
  }
  const boundary = await openFixture(CANDIDATE_BASE, ctx, ctx.five.map((row) => row.product_id), 760, 900, true)
  try {
    assert.equal(await boundary.browser.eval(`getComputedStyle(document.querySelector('.compare-switch-mobile-overview')).display !== 'none'`), true)
    await boundary.browser.shot(`${OUT}/760x900-boundary.png`)
  } finally {
    await cleanup(boundary)
  }
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR37_REVIEW2_QA PASS', JSON.stringify({ productSha: PRODUCT_SHA, deltaTop: report.firstFact.deltaTop, journeyCandidates: report.actualJourney.candidateNames, desktop761: report.desktop[761].scrollMax, desktop1280: report.desktop[1280].scrollMax }))
} catch (error) {
  report.status = 'fail'
  report.error = String(error?.stack ?? error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}
