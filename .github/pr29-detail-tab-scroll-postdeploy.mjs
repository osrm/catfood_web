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

const ORIGIN = 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.TARGET_SHA || 'b5218c85269e25a2250de88d65a15a4f27fae98c'
const OUT = 'qa-artifacts/pr29-detail-tab-scroll-postdeploy'
const PRODUCT = { id: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리' }
mkdirSync(OUT, { recursive: true })

function lookupUrl() {
  const url = new URL(ORIGIN)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', PRODUCT.query)
  return url.href
}

function assertPanelStartVisible(metric, label) {
  assert.ok(metric?.heading && metric.title && metric.description && Number.isFinite(metric.stickyBottom), `${label}: missing geometry ${JSON.stringify(metric)}`)
  assert.ok(metric.heading.rect[1] >= metric.stickyBottom - 1, `${label}: heading starts behind sticky region ${JSON.stringify(metric)}`)
  assert.ok(metric.title.rect[1] >= metric.stickyBottom - 1, `${label}: title starts behind sticky region ${JSON.stringify(metric)}`)
  assert.ok(metric.description.rect[1] >= metric.stickyBottom - 1, `${label}: description starts behind sticky region ${JSON.stringify(metric)}`)
}

async function waitDetailSettled(c) {
  await c.wait(`[...document.querySelectorAll('.detail-status-grid strong')].every(n=>!n.textContent.includes('불러오는 중'))`, 'detail resources settled')
  await sleep(80)
}

async function run() {
  const launched = await launch(360, 844, true)
  const c = launched.c
  const report = {
    status: 'started',
    mergeSha: MERGE_SHA,
    origin: ORIGIN,
    viewport: { width: 360, height: 844 },
    product: PRODUCT,
    chrome: launched.version,
    entry: null,
    transition: null,
    sameTab: null,
    parentReturn: null,
    network: null,
  }
  try {
    const url = lookupUrl()
    await c.nav(url)
    assert.ok(locationMatches(await c.eval('location.href')), `unexpected deployed URL: ${await c.eval('location.href')}`)
    await c.wait(`document.querySelector('.lookup-input')?.value===${js(PRODUCT.query)}`, 'public q lookup')

    const catalog = await waitForHttpResponse(c, '/rest/v1/effective_product_catalog_summary', 30000, 'GET')
    assert.equal(catalog.status, 200, `catalog GET failed: ${catalog.status}`)
    const selector = `.research-result-card[data-product-id="${PRODUCT.id}"]`
    await c.wait(`document.querySelector(${js(selector)})`, 'target product card')
    const preflight = await c.eval(`(()=>({url:location.href,input:document.querySelector('.lookup-input')?.value??null,cardCount:document.querySelectorAll('.research-result-card').length,exactCardCount:document.querySelectorAll(${js(selector)}).length}))()`)
    assert.equal(preflight.exactCardCount, 1, `target card count unexpected: ${JSON.stringify(preflight)}`)

    const card = await clickVisibleNoScroll(c, selector)
    await c.wait(`document.querySelector('.research-quick-view')`, 'quick view')
    const quick = await c.eval(`(()=>({title:document.querySelector('.quick-view-identity h1')?.textContent?.trim()??null,params:Object.fromEntries(new URLSearchParams(location.search)),url:location.href}))()`)
    assert.equal(quick.params.selected, PRODUCT.id, 'quick view did not select target product')
    assert.equal(quick.params.compareOpen, undefined, 'quick view unexpectedly opened compare state')

    const detailButton = await clickVisibleNoScroll(c, '.quick-view-actions button', '상세 보기')
    await c.wait(`document.querySelector('.detail-stage')`, 'detail stage')
    await waitDetailSettled(c)
    const detail = await c.eval(`(()=>({title:document.querySelector('.detail-identity h1')?.textContent?.trim()??null,params:Object.fromEntries(new URLSearchParams(location.search)),url:location.href}))()`)
    assert.equal(detail.title, PRODUCT.query, 'detail product title mismatch')
    assert.equal(detail.params.detail, PRODUCT.id, 'detail URL missing product id')
    assert.equal(detail.params.compareOpen, undefined, 'detail URL unexpectedly has compareOpen')
    report.entry = { url, catalog, preflight, card, quick, detailButton, detail }

    await clickVisibleNoScroll(c, '#detail-tab-nutrition')
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'nutrition selected')
    const nutritionBottom = await setStageBottom(c)
    assert.ok(nutritionBottom?.max > 0, 'nutrition tab had no scroll range')

    const beforeTransition = await detailGeometry(c)
    await clickVisibleNoScroll(c, '#detail-tab-ingredients')
    await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'ingredients selected')
    const immediate = await detailGeometry(c)
    assertPanelStartVisible(immediate, 'nutrition bottom -> ingredients immediate')
    const transitionFile = `${OUT}/360x844-go-nutrition-bottom-to-ingredients-immediate.png`
    await c.shot(transitionFile)
    report.transition = { before: beforeTransition, after: immediate, file: transitionFile }

    const moved = await setStageScroll(c, Math.min(immediate.maxScrollTop, immediate.scrollTop + 180))
    const beforeSame = await detailGeometry(c)
    await clickVisibleNoScroll(c, '#detail-tab-ingredients')
    await sleep(100)
    const afterSame = await detailGeometry(c)
    assert.equal(afterSame.activeTab, 'detail-tab-ingredients', 'same-tab reselection changed active tab')
    assert.ok(Math.abs(afterSame.scrollTop - beforeSame.scrollTop) <= 1, `same-tab reselection changed scrollTop ${beforeSame.scrollTop} -> ${afterSame.scrollTop}`)
    const sameTabFile = `${OUT}/360x844-go-ingredients-same-tab-reselection.png`
    await c.shot(sameTabFile)
    report.sameTab = { moved, before: beforeSame, after: afterSame, file: sameTabFile }

    await clickVisibleNoScroll(c, '.detail-topbar button', '돌아가기')
    await c.wait(`document.querySelector('.research-quick-view')`, 'quick view after detail back')
    const parent = await c.eval(`(()=>({title:document.querySelector('.quick-view-identity h1')?.textContent?.trim()??null,params:Object.fromEntries(new URLSearchParams(location.search)),url:location.href}))()`)
    assert.equal(parent.title, PRODUCT.query, 'back did not restore same product quick view')
    assert.equal(parent.params.selected, PRODUCT.id, 'back did not preserve selected product')
    assert.equal(parent.params.detail, undefined, 'back left detail state in URL')
    const parentFile = `${OUT}/360x844-go-parent-return.png`
    await c.shot(parentFile)
    report.parentReturn = { parent, file: parentFile }

    const net = await network(c)
    assert.equal(net.sentAnalytics.length, 0, 'analytics request escaped blocker')
    assert.equal(net.sentWrites.length, 0, 'production write request observed')
    assert.equal(net.blocked.writes, 0, 'production write attempt was blocked')
    report.network = net
    report.status = 'passed'
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  } catch (error) {
    report.status = 'failed'
    report.error = String(error?.stack || error)
    try { report.failure = await c.eval(`(()=>({url:location.href,body:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,1600),scrollTop:document.querySelector('.detail-stage')?.scrollTop??null,activeTab:document.querySelector('.detail-tabs [aria-selected="true"]')?.id??null}))()`) } catch {}
    try { await c.shot(`${OUT}/failure.png`) } catch {}
    try { report.network = await network(c) } catch {}
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
    throw error
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

function locationMatches(value) {
  try {
    const parsed = new URL(value)
    return parsed.origin === 'https://osrm.github.io' && parsed.pathname === '/catfood_web/'
  } catch { return false }
}

await run()
