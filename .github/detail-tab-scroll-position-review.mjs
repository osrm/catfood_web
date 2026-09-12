import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  cleanup,
  clickVisibleNoScroll,
  detailGeometry,
  js,
  launch,
  network,
  setStageBottom,
  setStageScroll,
  sleep,
  waitForHttpResponse,
} from './detail-tab-scroll-qa-helpers.mjs'

const ORIGIN = process.env.QA_ORIGIN || 'http://127.0.0.1:4173/'
const TARGET_SHA = process.env.TARGET_SHA || 'ce908a52eae206225f2241b607b22d78f36c2ac8'
const OUT = 'qa-artifacts/detail-tab-scroll-position'
const GO = { id: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리', label: 'go' }
const MONGE = { id: 'product_11dc2e0bf60b0874', query: '몬지 비와일드 그레인프리 어덜트 연어', label: 'monge' }
const COMPARE_IDS = `${GO.id},${MONGE.id}`
mkdirSync(OUT, { recursive: true })

function lookupUrl(product) {
  const url = new URL(ORIGIN)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', product.query)
  url.searchParams.set('compare', COMPARE_IDS)
  url.searchParams.set('compareTab', 'ingredients')
  return url.href
}

function compareUrl() {
  const url = new URL(ORIGIN)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', GO.query)
  url.searchParams.set('selected', GO.id)
  url.searchParams.set('compare', COMPARE_IDS)
  url.searchParams.set('compareOpen', '1')
  url.searchParams.set('compareTab', 'ingredients')
  return url.href
}

async function waitDetailSettled(c, label = 'detail resources settled') {
  await c.wait(`[...document.querySelectorAll('.detail-status-grid strong')].every(n=>!n.textContent.includes('불러오는 중'))`, label)
  await sleep(80)
}

async function catalogPreflight(c, product, selector) {
  const response = await waitForHttpResponse(c, '/rest/v1/effective_product_catalog_summary', 30000)
  const request = c.requests.find((item) => item.requestId === response.requestId) ?? null
  assert.equal(request?.method, 'GET', `catalog request was not GET: ${JSON.stringify(request)}`)
  assert.equal(response.status, 200, `catalog GET failed with HTTP ${response.status}: ${response.url}`)
  try {
    await c.wait(`document.querySelector(${js(selector)})`, `lookup card ${product.id}`, 30000)
  } catch (error) {
    const diagnostic = await c.eval(`(()=>({body:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,1200),cardCount:document.querySelectorAll('.research-result-card').length,lookupValue:document.querySelector('.lookup-input')?.value??null,url:location.href}))()`)
    throw new Error(`catalog GET succeeded with HTTP 200 but target card ${product.id} did not render; diagnostic=${JSON.stringify(diagnostic)}; cause=${String(error)}`)
  }
  const dom = await c.eval(`(()=>({cardExists:Boolean(document.querySelector(${js(selector)})),cardCount:document.querySelectorAll('.research-result-card').length,lookupValue:document.querySelector('.lookup-input')?.value??null,url:location.href}))()`)
  assert.equal(dom.cardExists, true, `target product card missing after successful catalog GET: ${product.id}`)
  return { candidateUrl: dom.url, request, response, cardExists: dom.cardExists, cardCount: dom.cardCount, lookupValue: dom.lookupValue }
}

async function setNetworkLatency(c, latencyMs) {
  await c.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: latencyMs,
    downloadThroughput: latencyMs > 0 ? 5_000_000 : -1,
    uploadThroughput: latencyMs > 0 ? 5_000_000 : -1,
    connectionType: latencyMs > 0 ? 'cellular3g' : 'none',
  })
}

async function enterDetail(c, product, { waitForData = true, detailLatencyMs = 0 } = {}) {
  const selector = `.research-result-card[data-product-id="${product.id}"]`
  const url = lookupUrl(product)
  await c.nav(url)
  await c.wait(`document.querySelector('.lookup-input')?.value===${js(product.query)}`, `lookup query ${product.id}`)
  const preflight = await catalogPreflight(c, product, selector)
  const lookup = await c.eval(`(()=>({url:location.href,input:document.querySelector('.lookup-input')?.value??null,cardCount:document.querySelectorAll('.research-result-card').length,exactCardCount:document.querySelectorAll(${js(selector)}).length}))()`)
  const card = await clickVisibleNoScroll(c, selector)
  await c.wait(`document.querySelector('.research-quick-view')`, `quick view ${product.id}`)
  const quickView = await c.eval(`(()=>({title:document.querySelector('.quick-view-identity h1')?.textContent?.trim()??null,url:location.href,params:Object.fromEntries(new URLSearchParams(location.search))}))()`)
  assert.equal(quickView.params.selected, product.id, `quick view did not select ${product.id}`)
  assert.equal(quickView.params.compare, COMPARE_IDS, 'quick view lost compare selection')
  assert.equal(quickView.params.compareOpen, undefined, 'lookup detail entry unexpectedly opened compare view')
  assert.equal(quickView.params.compareTab, 'ingredients', 'quick view changed compare tab')

  if (detailLatencyMs > 0) await setNetworkLatency(c, detailLatencyMs)
  const detailButton = await clickVisibleNoScroll(c, '.quick-view-actions button', '상세 보기')
  await c.wait(`document.querySelector('.detail-stage')`, `detail stage ${product.id}`)
  await c.wait(`document.querySelector('#detail-tab-overview')?.getAttribute('aria-selected')==='true'`, `detail overview ${product.id}`)
  if (waitForData) await waitDetailSettled(c)
  const detail = await c.eval(`(()=>({url:location.href,params:Object.fromEntries(new URLSearchParams(location.search)),loading:[...document.querySelectorAll('.detail-status-grid strong')].map(n=>(n.textContent||'').trim())}))()`)
  assert.equal(detail.params.detail, product.id, 'detail URL missing product')
  assert.equal(detail.params.compare, COMPARE_IDS, 'detail entry lost compare selection')
  assert.equal(detail.params.compareOpen, undefined, 'detail entry unexpectedly opened compare view')
  assert.equal(detail.params.compareTab, 'ingredients', 'detail entry changed compare tab')
  return { url, preflight, lookup, card, quickView, detailButton, detail }
}

function assertPanelStartVisible(metric, label) {
  assert.ok(metric?.heading && metric.title && metric.description && Number.isFinite(metric.stickyBottom), `${label}: missing heading/sticky geometry ${JSON.stringify(metric)}`)
  assert.ok(metric.heading.rect[1] >= metric.stickyBottom - 1, `${label}: panel heading starts behind sticky region ${JSON.stringify(metric)}`)
  assert.ok(metric.title.rect[1] >= metric.stickyBottom - 1, `${label}: panel title starts behind sticky region ${JSON.stringify(metric)}`)
  assert.ok(metric.description.rect[1] >= metric.stickyBottom - 1, `${label}: panel description starts behind sticky region ${JSON.stringify(metric)}`)
}

async function selectTabAndCapture(c, { from, to, file, label }) {
  const before = await detailGeometry(c)
  assert.equal(before.activeTab, `detail-tab-${from}`, `${label}: wrong source tab`)
  await clickVisibleNoScroll(c, `#detail-tab-${to}`)
  await c.wait(`document.querySelector('#detail-tab-${to}')?.getAttribute('aria-selected')==='true'`, `${label}: ${to} selected`)
  const after = await detailGeometry(c)
  assertPanelStartVisible(after, label)
  if (file) await c.shot(file)
  return { before, after, file: file ?? null }
}

async function activateNutrition(c, label) {
  return selectTabAndCapture(c, { from: 'overview', to: 'nutrition', label, file: null })
}

async function scrollSummaryButtonIntoView(c, text) {
  const moved = await c.eval(`(()=>{const stage=document.querySelector('.detail-stage'),button=[...document.querySelectorAll('.detail-status-action button')].find(n=>(n.textContent||'').includes(${js(text)}));if(!stage||!button)return null;const sr=stage.getBoundingClientRect(),br=button.getBoundingClientRect();stage.scrollTop=Math.max(0,Math.min(stage.scrollHeight-stage.clientHeight,stage.scrollTop+br.top-sr.top-Math.min(220,sr.height*0.28)));const r=button.getBoundingClientRect();return{scrollTop:stage.scrollTop,maxScrollTop:Math.max(0,stage.scrollHeight-stage.clientHeight),buttonRect:[r.left,r.top,r.width,r.height,r.right,r.bottom]}})()`)
  assert.ok(moved, `summary button not found: ${text}`)
  await sleep(40)
  return moved
}

async function verifyNetwork(c, label) {
  const net = await network(c)
  assert.equal(net.sentAnalytics.length, 0, `${label}: analytics request escaped blocker`)
  assert.equal(net.sentWrites.length, 0, `${label}: production write request observed`)
  assert.equal(net.blocked.writes, 0, `${label}: a production write was attempted and blocked`)
  return net
}

async function pointerScenario(width, height, product, mobile = true) {
  const launched = await launch(width, height, mobile)
  const c = launched.c
  const prefix = `${width}x${height}-${product.label}`
  try {
    const entry = await enterDetail(c, product, { waitForData: true })
    const initial = await detailGeometry(c)
    const nutritionEntry = await activateNutrition(c, `${prefix} overview -> nutrition`)
    const firstBottom = await setStageBottom(c)
    if (product.id === GO.id && width === 360) assert.ok(firstBottom?.max > 0, `${prefix}: regression source tab did not have a scroll range`)
    const toIngredients = await selectTabAndCapture(c, {
      from: 'nutrition',
      to: 'ingredients',
      file: `${OUT}/${prefix}-nutrition-bottom-to-ingredients-immediate.png`,
      label: `${prefix} nutrition bottom -> ingredients`,
    })

    const ingredientsBottom = await setStageBottom(c)
    const toNutrition = await selectTabAndCapture(c, {
      from: 'ingredients',
      to: 'nutrition',
      file: `${OUT}/${prefix}-ingredients-bottom-to-nutrition-immediate.png`,
      label: `${prefix} ingredients bottom -> nutrition`,
    })

    let sameTab = null
    if (product.id === GO.id && width === 360) {
      const current = await detailGeometry(c)
      const moved = await setStageScroll(c, Math.min(current.maxScrollTop, current.scrollTop + 180))
      const beforeSame = await detailGeometry(c)
      await clickVisibleNoScroll(c, '#detail-tab-nutrition')
      await sleep(100)
      const afterSame = await detailGeometry(c)
      assert.equal(afterSame.activeTab, 'detail-tab-nutrition', 'same-tab reselection changed active tab')
      assert.ok(Math.abs(afterSame.scrollTop - beforeSame.scrollTop) <= 1, `same-tab reselection changed scrollTop: ${beforeSame.scrollTop} -> ${afterSame.scrollTop}`)
      sameTab = { moved, before: beforeSame, after: afterSame }
    }

    const net = await verifyNetwork(c, prefix)
    return { width, height, mobile, product, chrome: launched.version, entry, initial, nutritionEntry, firstBottom, toIngredients, ingredientsBottom, toNutrition, sameTab, network: net }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

async function keyboardScenario() {
  const launched = await launch(360, 844, true)
  const c = launched.c
  try {
    const entry = await enterDetail(c, GO, { waitForData: true })
    const nutritionEntry = await activateNutrition(c, 'keyboard overview -> nutrition')
    await setStageBottom(c)
    await c.eval(`document.querySelector('#detail-tab-nutrition').focus({preventScroll:true})`)

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' })
    await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'keyboard ArrowRight ingredients')
    const arrowRight = await detailGeometry(c)
    assertPanelStartVisible(arrowRight, 'keyboard ArrowRight nutrition -> ingredients')
    assert.equal(arrowRight.activeElement, 'detail-tab-ingredients', 'keyboard ArrowRight did not keep focus on selected tab')
    const arrowRightFile = `${OUT}/360x844-keyboard-arrowright-immediate.png`
    await c.shot(arrowRightFile)

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft' })
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'keyboard ArrowLeft nutrition')
    const arrowLeft = await detailGeometry(c)
    assertPanelStartVisible(arrowLeft, 'keyboard ArrowLeft ingredients -> nutrition')
    assert.equal(arrowLeft.activeElement, 'detail-tab-nutrition', 'keyboard ArrowLeft did not keep focus on selected tab')
    const arrowLeftFile = `${OUT}/360x844-keyboard-arrowleft-immediate.png`
    await c.shot(arrowLeftFile)

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home' })
    await c.wait(`document.querySelector('#detail-tab-overview')?.getAttribute('aria-selected')==='true'`, 'keyboard Home overview')
    const home = await detailGeometry(c)
    assertPanelStartVisible(home, 'keyboard Home -> overview')
    assert.equal(home.activeElement, 'detail-tab-overview', 'keyboard Home did not keep focus on selected tab')
    const homeFile = `${OUT}/360x844-keyboard-home-immediate.png`
    await c.shot(homeFile)

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' })
    await c.wait(`document.querySelector('#detail-tab-context')?.getAttribute('aria-selected')==='true'`, 'keyboard End context')
    const end = await detailGeometry(c)
    assertPanelStartVisible(end, 'keyboard End -> context')
    assert.equal(end.activeElement, 'detail-tab-context', 'keyboard End did not keep focus on selected tab')
    const endFile = `${OUT}/360x844-keyboard-end-immediate.png`
    await c.shot(endFile)

    return { entry, nutritionEntry, arrowRight, arrowLeft, home, end, files: [arrowRightFile, arrowLeftFile, homeFile, endFile], network: await verifyNetwork(c, 'keyboard') }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

async function summaryButtonScenario() {
  const launched = await launch(360, 844, true)
  const c = launched.c
  try {
    const entry = await enterDetail(c, GO, { waitForData: true })

    const nutritionButtonSource = await scrollSummaryButtonIntoView(c, '영양 정보 보기')
    await clickVisibleNoScroll(c, '.detail-status-action button', '영양 정보 보기')
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'summary nutrition selected')
    const nutrition = await detailGeometry(c)
    assertPanelStartVisible(nutrition, 'summary button -> nutrition')
    const nutritionFile = `${OUT}/360x844-summary-button-nutrition-immediate.png`
    await c.shot(nutritionFile)

    await selectTabAndCapture(c, { from: 'nutrition', to: 'overview', label: 'summary nutrition -> overview', file: null })
    const ingredientsButtonSource = await scrollSummaryButtonIntoView(c, '원재료 보기')
    await clickVisibleNoScroll(c, '.detail-status-action button', '원재료 보기')
    await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'summary ingredients selected')
    const ingredients = await detailGeometry(c)
    assertPanelStartVisible(ingredients, 'summary button -> ingredients')
    const ingredientsFile = `${OUT}/360x844-summary-button-ingredients-immediate.png`
    await c.shot(ingredientsFile)

    return { entry, nutritionButtonSource, nutrition, ingredientsButtonSource, ingredients, files: [nutritionFile, ingredientsFile], network: await verifyNetwork(c, 'summary buttons') }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

async function asyncActionScenario() {
  const launched = await launch(360, 844, true)
  const c = launched.c
  try {
    const entry = await enterDetail(c, MONGE, { waitForData: false, detailLatencyMs: 1200 })
    const loadingBefore = await c.eval(`([...document.querySelectorAll('.detail-status-grid strong')].map(n=>(n.textContent||'').trim()))`)
    assert.ok(loadingBefore.some((value) => value.includes('불러오는 중')), `QA response delay did not leave detail resources pending: ${JSON.stringify(loadingBefore)}`)

    const source = await scrollSummaryButtonIntoView(c, '영양 정보 보기')
    await clickVisibleNoScroll(c, '.detail-status-action button', '영양 정보 보기')
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'status action nutrition selected')
    const immediate = await detailGeometry(c)
    assertPanelStartVisible(immediate, 'nutrition status action immediate while responses pending')
    const file = `${OUT}/360x844-monge-delayed-response-nutrition-immediate.png`
    await c.shot(file)
    const scrollTopAfterSelection = immediate.scrollTop

    await waitDetailSettled(c, 'delayed detail resources settled after tab change')
    const afterData = await detailGeometry(c)
    assert.ok(Math.abs(afterData.scrollTop - scrollTopAfterSelection) <= 2, `async resource completion reset reading position: ${scrollTopAfterSelection} -> ${afterData.scrollTop}`)
    assert.equal(afterData.activeTab, 'detail-tab-nutrition', 'async resource completion changed active tab')
    await setNetworkLatency(c, 0)
    return { entry, qaLatencyMs: 1200, loadingBefore, source, immediate, afterData, file, network: await verifyNetwork(c, 'async action') }
  } finally {
    try { await setNetworkLatency(c, 0) } catch {}
    cleanup(launched.proc, launched.dir, c)
  }
}

async function parentAndCompareScenario() {
  const launched = await launch(390, 900, true)
  const c = launched.c
  try {
    const entry = await enterDetail(c, GO, { waitForData: true })
    await activateNutrition(c, 'parent/compare overview -> nutrition')
    const beforeParams = await c.eval(`Object.fromEntries(new URLSearchParams(location.search))`)
    await setStageBottom(c)
    const transition = await selectTabAndCapture(c, {
      from: 'nutrition',
      to: 'ingredients',
      file: `${OUT}/390x900-quickview-parent-before-return-immediate.png`,
      label: 'quick-view parent nutrition -> ingredients',
    })
    const duringParams = await c.eval(`Object.fromEntries(new URLSearchParams(location.search))`)
    assert.equal(duringParams.compare, COMPARE_IDS, 'detail tab change lost compare selection')
    assert.equal(duringParams.compareOpen, undefined, 'detail review unexpectedly opened compare view')
    assert.equal(duringParams.compareTab, 'ingredients', 'detail tab change changed compare tab')
    assert.equal(duringParams.selected, GO.id, 'detail tab change lost selected product')
    assert.equal(duringParams.detailTab, 'ingredients', 'detail tab URL did not track selected detail tab')

    await clickVisibleNoScroll(c, '.detail-topbar > button', '돌아가기')
    await c.wait(`!document.querySelector('.detail-stage')&&document.querySelector('.research-quick-view')`, 'detail quick-view parent return')
    const returnedQuickView = await c.eval(`(()=>({params:Object.fromEntries(new URLSearchParams(location.search)),quickView:document.querySelector('.quick-view-identity h1')?.textContent?.trim()??null,url:location.href}))()`)
    assert.equal(returnedQuickView.params.compare, COMPARE_IDS, 'detail return lost compare selection')
    assert.equal(returnedQuickView.params.compareOpen, undefined, 'detail return unexpectedly opened compare view')
    assert.equal(returnedQuickView.params.compareTab, 'ingredients', 'detail return lost compare tab')
    assert.equal(returnedQuickView.params.selected, GO.id, 'detail return lost selected product')
    assert.equal(returnedQuickView.params.detail, undefined, 'detail return retained detail product')
    assert.equal(returnedQuickView.params.detailTab, undefined, 'detail return retained detail tab')
    assert.ok(returnedQuickView.quickView, `detail return did not restore selected-product quick view: ${JSON.stringify(returnedQuickView)}`)

    const compareParentUrl = compareUrl()
    await c.nav(compareParentUrl)
    await c.wait(`document.querySelector('.compare-stage')`, 'compare parent stage')
    await c.wait(`document.querySelector('#compare-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'compare ingredients tab preserved')
    const compareBeforeDetail = await c.eval(`(()=>({params:Object.fromEntries(new URLSearchParams(location.search)),activeTab:document.querySelector('.compare-tabs [aria-selected="true"]')?.id??null,detailLinks:document.querySelectorAll('.compare-detail-link').length,url:location.href}))()`)
    assert.equal(compareBeforeDetail.params.compareOpen, '1', 'compare parent was not open')
    assert.equal(compareBeforeDetail.params.compareTab, 'ingredients', 'compare parent tab was not ingredients')
    assert.equal(compareBeforeDetail.params.compare, COMPARE_IDS, 'compare parent lost selection')
    assert.ok(compareBeforeDetail.detailLinks >= 2, `compare detail links missing: ${JSON.stringify(compareBeforeDetail)}`)

    await clickVisibleNoScroll(c, '.compare-detail-link', '상세 보기')
    await c.wait(`document.querySelector('.detail-stage')`, 'detail opened from compare parent')
    const compareDetailEntry = await c.eval(`Object.fromEntries(new URLSearchParams(location.search))`)
    assert.equal(compareDetailEntry.compareOpen, '1', 'compare detail entry lost compare-open state')
    assert.equal(compareDetailEntry.compareTab, 'ingredients', 'compare detail entry lost compare tab')
    assert.equal(compareDetailEntry.compare, COMPARE_IDS, 'compare detail entry lost compare selection')
    assert.equal(compareDetailEntry.detail, GO.id, 'compare detail entry opened unexpected product')

    const compareDetailTransition = await selectTabAndCapture(c, {
      from: 'overview',
      to: 'ingredients',
      file: `${OUT}/390x900-compare-parent-detail-ingredients-immediate.png`,
      label: 'compare parent detail overview -> ingredients',
    })
    await clickVisibleNoScroll(c, '.detail-topbar > button', '돌아가기')
    await c.wait(`!document.querySelector('.detail-stage')&&document.querySelector('.compare-stage')`, 'detail compare parent return')
    const returnedCompare = await c.eval(`(()=>({params:Object.fromEntries(new URLSearchParams(location.search)),activeTab:document.querySelector('.compare-tabs [aria-selected="true"]')?.id??null,url:location.href}))()`)
    assert.equal(returnedCompare.params.compareOpen, '1', 'return to compare lost compare-open state')
    assert.equal(returnedCompare.params.compareTab, 'ingredients', 'return to compare lost compare tab')
    assert.equal(returnedCompare.params.compare, COMPARE_IDS, 'return to compare lost selected products')
    assert.equal(returnedCompare.params.selected, GO.id, 'return to compare lost selected product')
    assert.equal(returnedCompare.params.detail, undefined, 'return to compare retained detail product')
    assert.equal(returnedCompare.params.detailTab, undefined, 'return to compare retained detail tab')
    assert.equal(returnedCompare.activeTab, 'compare-tab-ingredients', 'compare UI did not restore ingredients tab')

    return {
      entry,
      beforeParams,
      transition,
      duringParams,
      returnedQuickView,
      compareParentUrl,
      compareBeforeDetail,
      compareDetailEntry,
      compareDetailTransition,
      returnedCompare,
      network: await verifyNetwork(c, 'parent/compare'),
    }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

const report = {
  status: 'running',
  targetSha: TARGET_SHA,
  origin: ORIGIN,
  buildContract: {
    base: './',
    servedAt: ORIGIN,
    publicSupabaseEnv: true,
    decisionIntakeBuildFlag: false,
    browserBlockerInstalledBeforeFirstNavigation: true,
  },
  entryMethod: 'public q= lookup URL, then real pointer card -> quick view -> detail; search input typing is intentionally not tested',
  baselineEvidence: {
    run: 34675129404,
    artifact: 10292146777,
    regression: '360x844 GO! nutrition bottom -> ingredients previously placed heading/description behind sticky region',
    assertion: 'heading/title/description top must be at or below measured sticky bottom immediately after tab selection',
  },
  regressionGuard: '.github/detail-tab-scroll-position-review.mjs assertPanelStartVisible() on immediate post-selection geometry; first pointer scenario fixes the original 360x844 GO! reproduction',
  pointerScenarios: [],
  keyboard: null,
  summaryButtons: null,
  asyncAction: null,
  parentAndCompare: null,
  limitations: [
    'Physical mobile devices and assistive technologies were not used.',
    'No production API failure, retry error, or production data mutation was induced.',
    'Search-input typing behavior was outside this focused regression review; q= navigation uses the public URL contract.',
    'Client-side network latency is used only in the async completion scenario and does not create a production outage.',
  ],
  startedAt: new Date().toISOString(),
}

try {
  report.pointerScenarios.push(await pointerScenario(360, 844, GO, true))
  report.pointerScenarios.push(await pointerScenario(360, 844, MONGE, true))
  report.pointerScenarios.push(await pointerScenario(390, 900, GO, true))
  report.pointerScenarios.push(await pointerScenario(390, 900, MONGE, true))
  report.pointerScenarios.push(await pointerScenario(1280, 900, GO, false))
  report.keyboard = await keyboardScenario()
  report.summaryButtons = await summaryButtonScenario()
  report.asyncAction = await asyncActionScenario()
  report.parentAndCompare = await parentAndCompareScenario()
  report.status = 'pass'
  report.completedAt = new Date().toISOString()
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, targetSha: report.targetSha, pointerScenarioCount: report.pointerScenarios.length }, null, 2))
} catch (error) {
  report.status = 'failure'
  report.error = String(error?.stack || error)
  report.completedAt = new Date().toISOString()
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}
