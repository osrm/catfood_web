import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  cleanup,
  clickVisibleNoScroll,
  detailGeometry,
  launch,
  network,
  setStageBottom,
  setStageScroll,
  sleep,
} from './detail-tab-scroll-qa-helpers.mjs'

const ORIGIN = process.env.QA_ORIGIN || 'http://127.0.0.1:4173/'
const TARGET_SHA = process.env.TARGET_SHA || 'ce908a52eae206225f2241b607b22d78f36c2ac8'
const OUT = 'qa-artifacts/detail-tab-scroll-position'
const GO = { id: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리', label: 'go' }
const MONGE = { id: 'product_11dc2e0bf60b0874', query: '몬지 비와일드 그레인프리 어덜트 연어', label: 'monge' }
const COMPARE_IDS = `${GO.id},${MONGE.id}`
mkdirSync(OUT, { recursive: true })

function detailUrl(product, tab = 'nutrition') {
  const url = new URL(ORIGIN)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', product.query)
  url.searchParams.set('selected', product.id)
  url.searchParams.set('compare', COMPARE_IDS)
  url.searchParams.set('compareTab', 'ingredients')
  url.searchParams.set('detail', product.id)
  if (tab !== 'overview') url.searchParams.set('detailTab', tab)
  return url.href
}

async function waitDetail(c, product, tab, waitForData = true) {
  await c.nav(detailUrl(product, tab))
  await c.wait(`document.querySelector('.detail-stage')`, `detail stage ${product.id}`)
  await c.wait(`document.querySelector('#detail-tab-${tab}')?.getAttribute('aria-selected')==='true'`, `initial detail tab ${tab}`)
  if (waitForData) {
    await c.wait(`[...document.querySelectorAll('.detail-status-grid strong')].every(n=>!n.textContent.includes('불러오는 중'))`, 'detail resources settled')
    await sleep(80)
  }
}

function assertPanelStartVisible(metric, label) {
  assert.ok(metric?.heading && metric.title && metric.description && Number.isFinite(metric.stickyBottom), `${label}: missing heading/sticky geometry ${JSON.stringify(metric)}`)
  assert.ok(metric.heading.rect[1] >= metric.stickyBottom - 1, `${label}: panel heading starts behind sticky region ${JSON.stringify(metric)}`)
  assert.ok(metric.title.rect[1] >= metric.stickyBottom - 1, `${label}: panel title starts behind sticky region ${JSON.stringify(metric)}`)
  assert.ok(metric.description.rect[1] >= metric.stickyBottom - 1, `${label}: panel description starts behind sticky region ${JSON.stringify(metric)}`)
}

async function switchAndCapture(c, { from, to, file, label }) {
  const before = await detailGeometry(c)
  assert.equal(before.activeTab, `detail-tab-${from}`, `${label}: wrong source tab`)
  await clickVisibleNoScroll(c, `#detail-tab-${to}`)
  await c.wait(`document.querySelector('#detail-tab-${to}')?.getAttribute('aria-selected')==='true'`, `${label}: ${to} selected`)
  const after = await detailGeometry(c)
  assertPanelStartVisible(after, label)
  await c.shot(file)
  return { before, after, file }
}

async function verifyNetwork(c, label) {
  const net = await network(c)
  assert.equal(net.sentAnalytics.length, 0, `${label}: analytics request escaped blocker`)
  assert.equal(net.sentWrites.length, 0, `${label}: production write request observed`)
  return net
}

async function pointerScenario(width, height, product, mobile = true) {
  const launched = await launch(width, height, mobile)
  const c = launched.c
  const prefix = `${width}x${height}-${product.label}`
  try {
    await waitDetail(c, product, 'nutrition', true)
    const initial = await detailGeometry(c)
    const firstBottom = await setStageBottom(c)
    assert.ok(firstBottom?.max > 0, `${prefix}: nutrition tab did not have a scroll range`)
    const toIngredients = await switchAndCapture(c, {
      from: 'nutrition',
      to: 'ingredients',
      file: `${OUT}/${prefix}-nutrition-bottom-to-ingredients-immediate.png`,
      label: `${prefix} nutrition bottom -> ingredients`,
    })

    const ingredientsBottom = await setStageBottom(c)
    const toNutrition = await switchAndCapture(c, {
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
    return { width, height, mobile, product, chrome: launched.version, initial, firstBottom, toIngredients, ingredientsBottom, toNutrition, sameTab, network: net }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

async function keyboardScenario() {
  const launched = await launch(360, 844, true)
  const c = launched.c
  try {
    await waitDetail(c, GO, 'nutrition', true)
    await setStageBottom(c)
    await c.eval(`document.querySelector('#detail-tab-nutrition').focus({preventScroll:true})`)
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' })
    await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'keyboard ArrowRight ingredients')
    const metric = await detailGeometry(c)
    assertPanelStartVisible(metric, 'keyboard ArrowRight nutrition -> ingredients')
    assert.equal(metric.activeElement, 'detail-tab-ingredients', 'keyboard ArrowRight did not keep focus on selected tab')
    const arrowFile = `${OUT}/360x844-keyboard-arrowright-immediate.png`
    await c.shot(arrowFile)

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home' })
    await c.wait(`document.querySelector('#detail-tab-overview')?.getAttribute('aria-selected')==='true'`, 'keyboard Home overview')
    const home = await detailGeometry(c)
    assertPanelStartVisible(home, 'keyboard Home -> overview')
    assert.equal(home.activeElement, 'detail-tab-overview', 'keyboard Home did not keep focus on selected tab')

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' })
    await c.wait(`document.querySelector('#detail-tab-context')?.getAttribute('aria-selected')==='true'`, 'keyboard End context')
    const end = await detailGeometry(c)
    assertPanelStartVisible(end, 'keyboard End -> context')
    assert.equal(end.activeElement, 'detail-tab-context', 'keyboard End did not keep focus on selected tab')
    const endFile = `${OUT}/360x844-keyboard-end-immediate.png`
    await c.shot(endFile)

    return { arrowRight: metric, home, end, files: [arrowFile, endFile], network: await verifyNetwork(c, 'keyboard') }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

async function asyncActionScenario() {
  const launched = await launch(360, 844, true)
  const c = launched.c
  try {
    await waitDetail(c, MONGE, 'overview', false)
    await c.eval(`(()=>{const stage=document.querySelector('.detail-stage'),button=document.querySelector('.detail-status-action button');if(!stage||!button)return false;const sr=stage.getBoundingClientRect(),br=button.getBoundingClientRect();stage.scrollTop+=br.top-sr.top-220;return true})()`)
    await sleep(60)
    await clickVisibleNoScroll(c, '.detail-status-action button')
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'status action nutrition selected')
    const immediate = await detailGeometry(c)
    assertPanelStartVisible(immediate, 'nutrition status action immediate')
    const file = `${OUT}/360x844-monge-status-action-nutrition-immediate.png`
    await c.shot(file)
    const scrollTopAfterSelection = immediate.scrollTop

    await c.wait(`[...document.querySelectorAll('.detail-status-grid strong')].every(n=>!n.textContent.includes('불러오는 중'))`, 'async data settled after tab change')
    await sleep(120)
    const afterData = await detailGeometry(c)
    assert.ok(Math.abs(afterData.scrollTop - scrollTopAfterSelection) <= 2, `async resource completion reset reading position: ${scrollTopAfterSelection} -> ${afterData.scrollTop}`)
    assert.equal(afterData.activeTab, 'detail-tab-nutrition', 'async resource completion changed active tab')
    return { immediate, afterData, file, network: await verifyNetwork(c, 'async action') }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

async function parentAndCompareScenario() {
  const launched = await launch(390, 900, true)
  const c = launched.c
  try {
    await waitDetail(c, GO, 'nutrition', true)
    const beforeParams = await c.eval(`Object.fromEntries(new URLSearchParams(location.search))`)
    await setStageBottom(c)
    const transition = await switchAndCapture(c, {
      from: 'nutrition',
      to: 'ingredients',
      file: `${OUT}/390x900-parent-compare-before-return.png`,
      label: 'parent/compare nutrition -> ingredients',
    })
    const duringParams = await c.eval(`Object.fromEntries(new URLSearchParams(location.search))`)
    assert.equal(duringParams.compare, COMPARE_IDS, 'detail tab change lost compare selection')
    assert.equal(duringParams.compareOpen, undefined, 'detail review unexpectedly opened compare view')
    assert.equal(duringParams.compareTab, 'ingredients', 'detail tab change changed compare tab')
    assert.equal(duringParams.selected, GO.id, 'detail tab change lost selected product')
    assert.equal(duringParams.detailTab, 'ingredients', 'detail tab URL did not track selected detail tab')

    await clickVisibleNoScroll(c, '.detail-topbar > button')
    await c.wait(`!document.querySelector('.detail-stage')`, 'detail parent return')
    const returned = await c.eval(`(()=>({params:Object.fromEntries(new URLSearchParams(location.search)),compare:Boolean(document.querySelector('.compare-stage')),quickView:Boolean(document.querySelector('.research-quick-view')),url:location.href}))()`)
    assert.equal(returned.params.compare, COMPARE_IDS, 'detail return lost compare selection')
    assert.equal(returned.params.compareOpen, undefined, 'detail return unexpectedly opened compare view')
    assert.equal(returned.params.compareTab, 'ingredients', 'detail return lost compare tab')
    assert.equal(returned.params.selected, GO.id, 'detail return lost selected product')
    assert.equal(returned.params.detail, undefined, 'detail return retained detail product')
    assert.equal(returned.params.detailTab, undefined, 'detail return retained detail tab')
    assert.ok(returned.quickView, `detail return did not restore selected-product quick view: ${JSON.stringify(returned)}`)
    return { beforeParams, transition, duringParams, returned, network: await verifyNetwork(c, 'parent/compare') }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

const report = {
  status: 'running',
  targetSha: TARGET_SHA,
  origin: ORIGIN,
  baselineEvidence: {
    run: 34675129404,
    artifact: 10292146777,
    regression: '360x844 GO! nutrition bottom -> ingredients previously placed heading/description behind sticky region',
    assertion: 'heading/title/description top must be at or below measured sticky bottom immediately after tab selection',
  },
  pointerScenarios: [],
  keyboard: null,
  asyncAction: null,
  parentAndCompare: null,
  limitations: [
    'Physical mobile devices and assistive technologies were not used.',
    'No intentional production API error or retry failure was induced.',
    'Search-input typing behavior was outside this focused regression review.',
  ],
  startedAt: new Date().toISOString(),
}

try {
  for (const viewport of [[360, 844], [390, 900]]) {
    report.pointerScenarios.push(await pointerScenario(viewport[0], viewport[1], GO, true))
    report.pointerScenarios.push(await pointerScenario(viewport[0], viewport[1], MONGE, true))
  }
  report.pointerScenarios.push(await pointerScenario(1280, 900, GO, false))
  report.keyboard = await keyboardScenario()
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
