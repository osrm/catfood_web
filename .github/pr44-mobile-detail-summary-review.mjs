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
} from './detail-tab-scroll-qa-helpers.mjs'

const BASE_ORIGIN = process.env.BASE_ORIGIN || 'http://127.0.0.1:4174/'
const CANDIDATE_ORIGIN = process.env.CANDIDATE_ORIGIN || 'http://127.0.0.1:4173/'
const OUT = 'qa-artifacts/pr44-mobile-detail-summary'
const PRODUCT = {
  id: 'product_31bc515d78d43d5d',
  query: '카니보 치킨&칠면조&오리',
}
const TAB_NAMES = ['개요', '영양', '원재료', '제조 · 유통']
mkdirSync(OUT, { recursive: true })

function detailUrl(origin) {
  const url = new URL(origin)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', PRODUCT.query)
  url.searchParams.set('detail', PRODUCT.id)
  url.searchParams.set('detailTab', 'overview')
  return url.href
}

function lookupUrl(origin) {
  const url = new URL(origin)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', PRODUCT.query)
  return url.href
}

async function waitDetail(c) {
  await c.wait(`document.querySelector('.detail-stage')`, 'detail stage')
  await c.wait(`document.querySelector('.detail-identity h1')?.textContent?.trim()===${js(PRODUCT.query)}`, 'detail identity')
  await c.wait(`[...document.querySelectorAll('.detail-status-grid strong')].every(n=>!n.textContent.includes('불러오는 중'))`, 'detail resources settled', 30000)
  await sleep(120)
}

async function screenMetrics(c) {
  return c.eval(`(()=>{
    const rect=(n)=>{if(!n)return null;const r=n.getBoundingClientRect();const s=getComputedStyle(n);return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,display:s.display,visibility:s.visibility}}
    const identity=document.querySelector('.detail-identity')
    const tabs=document.querySelector('.detail-tabs')
    const firstSection=document.querySelector('.detail-body .detail-section')
    const firstHeading=firstSection?.querySelector('.detail-section-heading')
    const firstFact=firstSection?.querySelector('.detail-fact-table .detail-fact')
    const status=document.querySelector('.detail-status-grid')
    const tabButtons=[...document.querySelectorAll('.detail-tabs button')]
    return {
      viewport:{width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth},
      identity:rect(identity),
      identityText:{brand:document.querySelector('.detail-identity-copy>span')?.textContent?.trim()??null,name:document.querySelector('.detail-identity-copy h1')?.textContent?.trim()??null,meta:document.querySelector('.detail-identity-copy p')?.textContent?.trim()??null,image:rect(document.querySelector('.detail-product-image,.detail-image-placeholder'))},
      status:rect(status),
      tabs:rect(tabs),
      tabNames:tabButtons.map(n=>(n.textContent||'').trim()),
      tabRects:tabButtons.map(n=>rect(n)),
      tabScroll:{clientWidth:tabs?.clientWidth??null,scrollWidth:tabs?.scrollWidth??null},
      firstSection:rect(firstSection),
      firstHeading:rect(firstHeading),
      firstHeadingText:firstHeading?.querySelector('h2')?.textContent?.trim()??null,
      firstFact:rect(firstFact),
      variantRows:document.querySelectorAll('.detail-variant-row').length,
      ingredientCountText:[...document.querySelectorAll('.detail-fact')].find(n=>n.querySelector('span')?.textContent?.trim()==='확인된 원재료')?.querySelector('strong')?.textContent?.trim()??null,
      retryButtons:[...document.querySelectorAll('.detail-state.is-error button')].map(n=>(n.textContent||'').trim()),
    }
  })()`)
}

async function verifyNetwork(c, label) {
  const net = await network(c)
  assert.equal(net.sentAnalytics.length, 0, `${label}: analytics request escaped blocker`)
  assert.equal(net.sentWrites.length, 0, `${label}: production write request observed`)
  assert.equal(net.blocked.writes, 0, `${label}: production write was attempted and blocked`)
  const bad = net.publicResponses.filter((item) => item.status >= 400)
  assert.deepEqual(bad, [], `${label}: public API error responses ${JSON.stringify(bad)}`)
  return net
}

async function capture(origin, label, width, height) {
  const launched = await launch(width, height, true)
  const c = launched.c
  try {
    await c.nav(detailUrl(origin))
    await waitDetail(c)
    const metrics = await screenMetrics(c)
    assert.equal(metrics.identityText.name, PRODUCT.query, `${label}: product name mismatch`)
    assert.ok(metrics.identityText.brand, `${label}: brand missing`)
    assert.match(metrics.identityText.meta || '', /·/, `${label}: feed/life-stage identity missing`)
    assert.ok(metrics.identityText.image?.width > 0 && metrics.identityText.image?.height > 0, `${label}: product image identity missing`)
    assert.deepEqual(metrics.tabNames, TAB_NAMES, `${label}: detail tabs changed`)
    assert.ok(metrics.tabRects.every((rect) => rect && rect.left >= -1 && rect.right <= metrics.viewport.width + 1), `${label}: a tab name is not fully visible at initial position: ${JSON.stringify(metrics.tabRects)}`)
    assert.equal(metrics.firstHeadingText, '제품 기본 정보', `${label}: overview no longer starts with product basics`)
    assert.ok(metrics.viewport.docWidth <= metrics.viewport.width + 1, `${label}: horizontal document overflow`)
    const file = `${OUT}/${label}-${width}x${height}.png`
    await c.shot(file)
    return { label, width, height, chrome: launched.version, metrics, file, network: await verifyNetwork(c, label) }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

function compareLayout(base, candidate) {
  assert.notEqual(base.metrics.status?.display, 'none', `${base.label}: baseline status cards unexpectedly hidden`)
  assert.equal(candidate.metrics.status?.display, 'none', `${candidate.label}: candidate status cards still visible`)
  assert.ok(candidate.metrics.tabs.top < base.metrics.tabs.top, `${candidate.label}: tabs did not move earlier`)
  assert.ok(candidate.metrics.firstHeading.top < base.metrics.firstHeading.top, `${candidate.label}: basic facts did not move earlier`)
  assert.equal(candidate.metrics.variantRows, base.metrics.variantRows, `${candidate.label}: package rows changed when summary cards were hidden`)
  assert.equal(candidate.metrics.ingredientCountText, base.metrics.ingredientCountText, `${candidate.label}: ingredient count fact changed when summary cards were hidden`)
  return {
    identityHeightBefore: base.metrics.identity.height,
    identityHeightAfter: candidate.metrics.identity.height,
    identityHeightDelta: candidate.metrics.identity.height - base.metrics.identity.height,
    tabsTopBefore: base.metrics.tabs.top,
    tabsTopAfter: candidate.metrics.tabs.top,
    tabsTopDelta: candidate.metrics.tabs.top - base.metrics.tabs.top,
    firstHeadingTopBefore: base.metrics.firstHeading.top,
    firstHeadingTopAfter: candidate.metrics.firstHeading.top,
    firstHeadingTopDelta: candidate.metrics.firstHeading.top - base.metrics.firstHeading.top,
    firstFactTopBefore: base.metrics.firstFact?.top ?? null,
    firstFactTopAfter: candidate.metrics.firstFact?.top ?? null,
    firstFactTopDelta: base.metrics.firstFact && candidate.metrics.firstFact ? candidate.metrics.firstFact.top - base.metrics.firstFact.top : null,
    variantRowsBefore: base.metrics.variantRows,
    variantRowsAfter: candidate.metrics.variantRows,
    ingredientCountBefore: base.metrics.ingredientCountText,
    ingredientCountAfter: candidate.metrics.ingredientCountText,
    tabScrollBefore: base.metrics.tabScroll,
    tabScrollAfter: candidate.metrics.tabScroll,
  }
}

async function boundary(width) {
  const launched = await launch(width, 900, false)
  const c = launched.c
  try {
    await c.nav(detailUrl(CANDIDATE_ORIGIN))
    await waitDetail(c)
    const metrics = await screenMetrics(c)
    return { width, statusDisplay: metrics.status?.display, tabs: metrics.tabNames, identityHeight: metrics.identity?.height, network: await verifyNetwork(c, `boundary-${width}`) }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

function assertPanelStart(metric, label) {
  assert.ok(metric?.heading && Number.isFinite(metric.stickyBottom), `${label}: geometry missing`)
  assert.ok(metric.heading.rect[1] >= metric.stickyBottom - 1, `${label}: section heading hidden by sticky UI: ${JSON.stringify(metric)}`)
}

async function interactionReview() {
  const launched = await launch(360, 844, true)
  const c = launched.c
  try {
    await c.nav(detailUrl(CANDIDATE_ORIGIN))
    await waitDetail(c)

    const initial = await screenMetrics(c)
    assert.equal(initial.status?.display, 'none', 'mobile summary cards are not hidden')

    const pointer = {}
    await clickVisibleNoScroll(c, '#detail-tab-nutrition')
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'pointer nutrition selected')
    pointer.nutrition = await detailGeometry(c)
    assertPanelStart(pointer.nutrition, 'pointer overview -> nutrition')

    await setStageBottom(c)
    await clickVisibleNoScroll(c, '#detail-tab-ingredients')
    await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'pointer ingredients selected')
    pointer.ingredients = await detailGeometry(c)
    assertPanelStart(pointer.ingredients, 'pointer nutrition bottom -> ingredients')

    const moved = await setStageScroll(c, Math.min(pointer.ingredients.maxScrollTop, pointer.ingredients.scrollTop + 160))
    const beforeSame = await detailGeometry(c)
    await clickVisibleNoScroll(c, '#detail-tab-ingredients')
    await sleep(100)
    const afterSame = await detailGeometry(c)
    assert.ok(Math.abs((afterSame.scrollTop ?? 0) - (beforeSame.scrollTop ?? 0)) <= 1, `same-tab reselection changed position: ${beforeSame.scrollTop} -> ${afterSame.scrollTop}`)

    await c.eval(`document.querySelector('#detail-tab-overview').focus({preventScroll:true})`)
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' })
    await c.wait(`document.activeElement?.id==='detail-tab-nutrition'&&document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'keyboard ArrowRight nutrition')
    const keyboardNutrition = await detailGeometry(c)
    assertPanelStart(keyboardNutrition, 'keyboard overview -> nutrition')

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' })
    await c.wait(`document.activeElement?.id==='detail-tab-context'&&document.querySelector('#detail-tab-context')?.getAttribute('aria-selected')==='true'`, 'keyboard End context')
    const keyboardContext = await detailGeometry(c)
    assertPanelStart(keyboardContext, 'keyboard End -> context')

    await c.nav(lookupUrl(CANDIDATE_ORIGIN))
    await c.wait(`document.querySelector('.lookup-input')?.value===${js(PRODUCT.query)}`, 'lookup restored')
    const cardSelector = `.research-result-card[data-product-id="${PRODUCT.id}"]`
    await c.wait(`document.querySelector(${js(cardSelector)})`, 'lookup product card', 30000)
    await clickVisibleNoScroll(c, cardSelector)
    await c.wait(`document.querySelector('.research-quick-view')`, 'quick view')
    await clickVisibleNoScroll(c, '.quick-view-actions button', '상세 보기')
    await waitDetail(c)
    await clickVisibleNoScroll(c, '.detail-topbar button', '제품 목록')
    await c.wait(`!document.querySelector('.detail-stage')&&(document.querySelector('.research-quick-view')||document.querySelector('.research-results'))`, 'detail parent restored')
    const parentReturn = await c.eval(`(()=>{const p=new URLSearchParams(location.search);return{url:location.href,q:p.get('q'),mode:p.get('mode'),selected:p.get('selected'),detail:p.get('detail'),quickView:Boolean(document.querySelector('.research-quick-view')),results:Boolean(document.querySelector('.research-results'))}})()`)
    assert.equal(parentReturn.q, PRODUCT.query, 'parent return URL lost lookup query')
    assert.equal(parentReturn.mode, 'lookup', 'parent return changed lookup mode')
    assert.equal(parentReturn.selected, PRODUCT.id, 'parent return did not restore selected quick-view product')
    assert.equal(parentReturn.detail, null, 'parent return retained detail URL state')
    assert.equal(parentReturn.quickView, true, 'parent return did not restore quick view parent')

    return {
      initial,
      pointer,
      sameTab: { moved, before: beforeSame, after: afterSame },
      keyboard: { nutrition: keyboardNutrition, context: keyboardContext },
      parentReturn,
      network: await verifyNetwork(c, 'interaction-review'),
    }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

const base360 = await capture(BASE_ORIGIN, 'base', 360, 844)
const candidate360 = await capture(CANDIDATE_ORIGIN, 'candidate', 360, 844)
const base390 = await capture(BASE_ORIGIN, 'base', 390, 900)
const candidate390 = await capture(CANDIDATE_ORIGIN, 'candidate', 390, 900)
const layout360 = compareLayout(base360, candidate360)
const layout390 = compareLayout(base390, candidate390)
const at760 = await boundary(760)
const at761 = await boundary(761)
assert.equal(at760.statusDisplay, 'none', '760px should use simplified mobile detail')
assert.notEqual(at761.statusDisplay, 'none', '761px should preserve desktop/tablet status cards')
const interactions = await interactionReview()

const report = {
  product: PRODUCT,
  base: { sha: process.env.BASE_SHA, captures: [base360, base390] },
  candidate: { sha: process.env.TARGET_SHA, captures: [candidate360, candidate390] },
  layout: { '360x844': layout360, '390x900': layout390 },
  boundary: { at760, at761 },
  interactions,
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log('PR44_MOBILE_DETAIL_SUMMARY_QA_PASS')
console.log(JSON.stringify({ layout: report.layout, boundary: report.boundary, parentReturn: interactions.parentReturn }, null, 2))
