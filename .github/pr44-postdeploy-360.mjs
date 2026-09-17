import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  cleanup,
  clickVisibleNoScroll,
  detailGeometry,
  js,
  launch,
  network,
  sleep,
} from './detail-tab-scroll-qa-helpers.mjs'

const ORIGIN = 'https://osrm.github.io/catfood_web/'
const OUT = 'qa-artifacts/pr44-postdeploy-360'
const PRODUCT = {
  id: 'product_31bc515d78d43d5d',
  brand: 'GO! SOLUTIONS',
  name: '카니보 치킨&칠면조&오리',
  meta: '건식 · 전연령',
}
const TAB_NAMES = ['개요', '영양', '원재료', '제조 · 유통']
mkdirSync(OUT, { recursive: true })

function lookupUrl() {
  const url = new URL(ORIGIN)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', PRODUCT.name)
  return url.href
}

function visibleRect(n) {
  if (!n) return null
  const r = n.getBoundingClientRect()
  const s = getComputedStyle(n)
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, display: s.display, visibility: s.visibility }
}

async function waitDetail(c) {
  await c.wait(`document.querySelector('.detail-stage')`, 'detail stage')
  await c.wait(`document.querySelector('.detail-identity h1')?.textContent?.trim()===${js(PRODUCT.name)}`, 'detail identity')
  await c.wait(`[...document.querySelectorAll('.detail-status-grid strong')].every(n=>!n.textContent.includes('불러오는 중'))`, 'detail resources settled', 30000)
  await c.wait(`(()=>{const img=document.querySelector('.detail-product-image');return Boolean(img&&img.complete&&img.naturalWidth>0)})()`, 'detail image loaded', 30000)
  await sleep(120)
}

async function overviewMetrics(c) {
  return c.eval(`(()=>{
    const rect=${visibleRect.toString()};
    const identity=document.querySelector('.detail-identity');
    const tabs=document.querySelector('.detail-tabs');
    const status=document.querySelector('.detail-status-grid');
    const section=document.querySelector('.detail-body .detail-section');
    const heading=section?.querySelector('.detail-section-heading');
    const tabButtons=[...document.querySelectorAll('.detail-tabs button')];
    const img=document.querySelector('.detail-product-image');
    return {
      viewport:{width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth},
      identity:rect(identity),
      brand:document.querySelector('.detail-identity-copy>span')?.textContent?.trim()??null,
      name:document.querySelector('.detail-identity-copy h1')?.textContent?.trim()??null,
      meta:document.querySelector('.detail-identity-copy p')?.textContent?.trim()??null,
      image:{rect:rect(img),naturalWidth:img?.naturalWidth??0,naturalHeight:img?.naturalHeight??0},
      status:rect(status),
      tabs:rect(tabs),
      tabNames:tabButtons.map(n=>(n.textContent||'').trim()),
      section:rect(section),
      heading:rect(heading),
      headingText:heading?.querySelector('h2')?.textContent?.trim()??null,
      tabToSectionGap:tabs&&section?section.getBoundingClientRect().top-tabs.getBoundingClientRect().bottom:null,
    }
  })()`)
}

function assertHeadingBelowSticky(metric, label) {
  assert.ok(metric?.heading && Number.isFinite(metric.stickyBottom), `${label}: geometry missing`)
  assert.ok(metric.heading.rect[1] >= metric.stickyBottom - 1, `${label}: section heading hidden by sticky UI: ${JSON.stringify(metric)}`)
}

async function verifyNetwork(c) {
  const net = await network(c)
  assert.equal(net.sentAnalytics.length, 0, 'analytics request escaped blocker')
  assert.equal(net.sentWrites.length, 0, 'production write request observed')
  assert.equal(net.blocked.writes, 0, 'production write was attempted and blocked')
  const badPublic = net.publicResponses.filter((item) => item.status >= 400)
  assert.deepEqual(badPublic, [], `public API error responses: ${JSON.stringify(badPublic)}`)
  const nonReadSupabase = c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'OPTIONS', 'HEAD'].includes(item.method))
  assert.deepEqual(nonReadSupabase, [], `non-read Supabase requests: ${JSON.stringify(nonReadSupabase)}`)
  const documentResponse = c.responses.find((item) => item.type === 'Document' && item.url.startsWith(ORIGIN))
  assert.equal(documentResponse?.status, 200, `Pages document status: ${documentResponse?.status}`)
  return {
    ...net,
    methods: [...new Set(c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co')).map((item) => item.method))],
    pagesDocumentStatus: documentResponse?.status ?? null,
  }
}

const launched = await launch(360, 844, true)
const c = launched.c
try {
  await c.nav(lookupUrl())
  await c.wait(`document.querySelector('.lookup-input')?.value===${js(PRODUCT.name)}`, 'lookup query')
  const cardSelector = `.research-result-card[data-product-id="${PRODUCT.id}"]`
  await c.wait(`document.querySelector(${js(cardSelector)})`, 'product result card', 30000)

  await clickVisibleNoScroll(c, cardSelector)
  await c.wait(`document.querySelector('.research-quick-view .quick-view-identity h1')?.textContent?.trim()===${js(PRODUCT.name)}`, 'same-product quick view')
  await clickVisibleNoScroll(c, '.quick-view-actions button', '상세 보기')
  await waitDetail(c)

  const overview = await overviewMetrics(c)
  assert.equal(overview.brand, PRODUCT.brand, 'brand changed')
  assert.equal(overview.name, PRODUCT.name, 'full product name changed')
  assert.equal(overview.meta, PRODUCT.meta, 'feed type / life stage changed')
  assert.ok(overview.image.naturalWidth > 0 && overview.image.rect?.width > 0, 'product image missing')
  assert.equal(overview.status?.display, 'none', 'mobile summary cards are visible')
  assert.deepEqual(overview.tabNames, TAB_NAMES, 'detail tab names changed')
  assert.equal(overview.headingText, '제품 기본 정보', 'overview does not begin with product basics')
  assert.ok((overview.tabToSectionGap ?? 999) >= 0 && (overview.tabToSectionGap ?? 999) < 80, `tabs and basic facts are not visually contiguous: gap=${overview.tabToSectionGap}`)
  assert.ok(overview.viewport.docWidth <= overview.viewport.width + 1, 'horizontal document overflow')
  await c.shot(`${OUT}/overview-360x844.png`)

  await clickVisibleNoScroll(c, '#detail-tab-nutrition')
  await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'nutrition selected')
  const nutrition = await detailGeometry(c)
  assertHeadingBelowSticky(nutrition, 'nutrition')

  await clickVisibleNoScroll(c, '#detail-tab-ingredients')
  await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'ingredients selected')
  const ingredients = await detailGeometry(c)
  assertHeadingBelowSticky(ingredients, 'ingredients')
  await c.shot(`${OUT}/ingredients-360x844.png`)

  await clickVisibleNoScroll(c, '.detail-topbar button', '제품 목록')
  await c.wait(`!document.querySelector('.detail-stage')&&document.querySelector('.research-quick-view')`, 'parent quick view restored')
  const parent = await c.eval(`({name:document.querySelector('.research-quick-view .quick-view-identity h1')?.textContent?.trim()??null,detail:new URLSearchParams(location.search).get('detail')})`)
  assert.equal(parent.name, PRODUCT.name, 'returned to a different product quick view')
  assert.equal(parent.detail, null, 'detail URL state remained after return')

  const net = await verifyNetwork(c)
  const report = {
    mergeSha: '8391c76965b8ec94ce25856dad611c7b0f306aac',
    url: ORIGIN,
    viewport: '360x844',
    chrome: launched.version,
    product: PRODUCT,
    overview,
    transitions: { nutrition, ingredients },
    parent,
    network: net,
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR44_POSTDEPLOY_360_PASS')
  console.log(JSON.stringify({ overview: { status: overview.status, tabs: overview.tabNames, heading: overview.headingText, gap: overview.tabToSectionGap }, parent, network: { methods: net.methods, publicReads: net.publicReads, pagesDocumentStatus: net.pagesDocumentStatus } }, null, 2))
} finally {
  cleanup(launched.proc, launched.dir, c)
}
