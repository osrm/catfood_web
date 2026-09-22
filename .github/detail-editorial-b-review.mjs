import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  cleanup,
  clickVisibleNoScroll,
  js,
  launch,
  network,
  setStageBottom,
  setStageScroll,
  sleep,
} from './detail-editorial-b-qa-helpers.mjs'

const ORIGIN = process.env.QA_ORIGIN || 'http://127.0.0.1:4173/'
const PRODUCT_SHA = process.env.PRODUCT_SHA || '5671172dfc8eede12b421b5433f60f0e864ee69d'
const OUT = 'qa-artifacts/detail-editorial-b'
const GO = { id: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리', label: 'go' }
const MONGE = { id: 'product_11dc2e0bf60b0874', query: '몬지 비와일드 그레인프리 어덜트 연어', label: 'monge' }
mkdirSync(OUT, { recursive: true })

function detailUrl(product, tab = 'overview') {
  const url = new URL(ORIGIN)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', product.query)
  url.searchParams.set('detail', product.id)
  url.searchParams.set('detailTab', tab)
  return url.href
}

function lookupUrl(product) {
  const url = new URL(ORIGIN)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', product.query)
  return url.href
}

function compareUrl() {
  const url = new URL(ORIGIN)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'lookup')
  url.searchParams.set('q', GO.query)
  url.searchParams.set('compare', `${GO.id},${MONGE.id}`)
  url.searchParams.set('compareOpen', '1')
  return url.href
}

async function waitDetail(c, product, tab = 'overview') {
  await c.wait(`document.querySelector('.detail-stage') && document.querySelector('.detail-identity h1')?.textContent?.includes(${js(product.query)})`, `detail identity ${product.label}`, 30000)
  await c.wait(`document.querySelector('#detail-tab-${tab}')?.getAttribute('aria-selected')==='true'`, `detail tab ${tab}`, 30000)
  await c.wait(`![...document.querySelectorAll('.detail-state')].some(n=>(n.textContent||'').includes('불러오는 중'))`, `detail resources settled ${product.label}`, 30000)
  await c.eval('document.fonts?.ready')
  await sleep(120)
}

async function openDirect(c, product, tab = 'overview') {
  await c.nav(detailUrl(product, tab))
  await waitDetail(c, product, tab)
}

async function assertNetworkReadOnly(c, label) {
  const net = await network(c)
  assert.equal(net.sentAnalytics.length, 0, `${label}: analytics request escaped blocker`)
  assert.equal(net.sentWrites.length, 0, `${label}: production write request observed`)
  assert.equal(net.blocked.writes, 0, `${label}: production write was attempted`)
  return net
}

async function pageMetrics(c) {
  return c.eval(`(()=>{
    const rect=(n)=>{if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
    const stage=document.querySelector('.detail-stage')
    const layout=document.querySelector('.detail-layout')
    const identity=document.querySelector('.detail-identity')
    const reading=document.querySelector('.detail-reading')
    const h1=document.querySelector('.detail-identity h1')
    const img=document.querySelector('.detail-product-image')
    const placeholder=document.querySelector('.detail-image-placeholder')
    const tabs=document.querySelector('.detail-tabs')
    const topbar=document.querySelector('.detail-topbar')
    const hs=h1?getComputedStyle(h1):null
    const ls=layout?getComputedStyle(layout):null
    const ts=tabs?getComputedStyle(tabs):null
    return {
      viewport:[innerWidth,innerHeight],
      stage:{clientWidth:stage?.clientWidth??null,scrollWidth:stage?.scrollWidth??null,clientHeight:stage?.clientHeight??null,scrollHeight:stage?.scrollHeight??null,scrollTop:stage?.scrollTop??null},
      bodyOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      layoutDisplay:ls?.display??null,
      gridTemplateColumns:ls?.gridTemplateColumns??null,
      identity:rect(identity),reading:rect(reading),h1:rect(h1),image:rect(img||placeholder),tabs:rect(tabs),topbar:rect(topbar),
      title:h1?.textContent?.trim()??null,
      lineClamp:hs?.webkitLineClamp??null,
      textOverflow:hs?.textOverflow??null,
      tabsPosition:ts?.position??null,
      tabsTop:ts?.top??null,
      activeTab:document.querySelector('.detail-tabs [aria-selected="true"]')?.id??null,
      productImageSrc:img?.getAttribute('src')??null,
      placeholder:Boolean(placeholder),
    }
  })()`)
}

async function scrollElementIntoView(c, selector) {
  return c.eval(`(()=>{const stage=document.querySelector('.detail-stage'),n=document.querySelector(${js(selector)});if(!stage||!n)return null;const sr=stage.getBoundingClientRect(),r=n.getBoundingClientRect();stage.scrollTop=Math.max(0,Math.min(stage.scrollHeight-stage.clientHeight,stage.scrollTop+r.top-sr.top-Math.min(260,sr.height*0.32)));const rr=n.getBoundingClientRect();return{scrollTop:stage.scrollTop,rect:[rr.left,rr.top,rr.width,rr.height]}})()`)
}

async function stickyMetric(c) {
  return c.eval(`(()=>{const stage=document.querySelector('.detail-stage'),topbar=document.querySelector('.detail-topbar'),tabs=document.querySelector('.detail-tabs'),heading=document.querySelector('.detail-body .detail-section-heading');if(!stage||!topbar||!tabs||!heading)return null;const sr=stage.getBoundingClientRect(),a=getComputedStyle(topbar),b=getComputedStyle(tabs),sticky=sr.top+Math.max((parseFloat(a.top)||0)+topbar.getBoundingClientRect().height,(parseFloat(b.top)||0)+tabs.getBoundingClientRect().height),hr=heading.getBoundingClientRect();return{scrollTop:stage.scrollTop,max:Math.max(0,stage.scrollHeight-stage.clientHeight),stickyBottom:sticky,headingTop:hr.top,active:document.querySelector('.detail-tabs [aria-selected="true"]')?.id??null}})()`)
}

async function mobileOverviewScenario() {
  const launched = await launch(390, 900, true)
  const c = launched.c
  try {
    await openDirect(c, GO, 'overview')
    const metrics = await pageMetrics(c)
    assert.equal(metrics.layoutDisplay, 'block')
    assert.equal(metrics.title, GO.query)
    assert.ok(metrics.productImageSrc && !metrics.placeholder, 'GO product image missing')
    assert.ok(metrics.stage.scrollWidth <= metrics.stage.clientWidth + 1, `390 stage horizontal overflow: ${JSON.stringify(metrics.stage)}`)
    assert.ok(metrics.bodyOverflow <= 1, `390 document horizontal overflow: ${metrics.bodyOverflow}`)
    assert.ok(metrics.h1.height > 0 && metrics.lineClamp !== '1' && metrics.textOverflow !== 'ellipsis', 'product name appears truncated')
    assert.equal(metrics.tabsPosition, 'sticky')
    await scrollElementIntoView(c, '.detail-disclosure > summary')
    const before = await c.eval(`document.querySelector('.detail-disclosure')?.open??null`)
    await clickVisibleNoScroll(c, '.detail-disclosure > summary', '판매 단위와 총중량')
    const after = await c.eval(`document.querySelector('.detail-disclosure')?.open??null`)
    assert.notEqual(after, before, 'sale disclosure did not toggle from pointer click')
    const saleText = await c.eval(`document.querySelector('.detail-section:nth-of-type(2)')?.innerText??''`)
    assert.match(saleText, /판매 단위와 총중량/)
    await c.shot(`${OUT}/candidate-go-overview-390.png`)
    return { chrome: launched.version, metrics, saleText, network: await assertNetworkReadOnly(c, 'mobile overview') }
  } finally { cleanup(launched.proc, launched.dir, c) }
}

async function desktopScenario() {
  const launched = await launch(1440, 1000, false)
  const c = launched.c
  try {
    await openDirect(c, GO, 'overview')
    const overview = await pageMetrics(c)
    assert.equal(overview.layoutDisplay, 'grid')
    assert.ok(overview.identity.right < overview.reading.x, `desktop identity/reading columns overlap: ${JSON.stringify(overview)}`)
    assert.ok(overview.reading.width <= 742, `desktop reading width escaped managed width: ${overview.reading.width}`)
    assert.ok(overview.stage.scrollWidth <= overview.stage.clientWidth + 1, 'desktop horizontal overflow')
    await c.shot(`${OUT}/candidate-go-overview-1440.png`)
    await clickVisibleNoScroll(c, '#detail-tab-nutrition')
    await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'nutrition selected')
    await c.wait(`document.querySelector('.detail-energy') || document.querySelector('.detail-empty') || document.querySelector('[role="alert"]')`, 'nutrition rendered')
    const nutrition = await c.eval(`(()=>({text:document.querySelector('.detail-body')?.innerText??'',rows:document.querySelectorAll('.detail-nutrition-table tr').length,energy:document.querySelector('.detail-energy strong')?.textContent?.trim()??null}))()`)
    assert.ok(nutrition.rows > 0, `GO nutrition rows missing: ${JSON.stringify(nutrition)}`)
    assert.match(nutrition.text, /% (이상|이하)|%/)
    await c.shot(`${OUT}/candidate-go-nutrition-1440.png`)
    return { chrome: launched.version, overview, nutrition, network: await assertNetworkReadOnly(c, 'desktop') }
  } finally { cleanup(launched.proc, launched.dir, c) }
}

async function mongeIngredientsScenario() {
  const launched = await launch(360, 844, true)
  const c = launched.c
  try {
    await openDirect(c, MONGE, 'ingredients')
    const metrics = await pageMetrics(c)
    const content = await c.eval(`(()=>({text:document.querySelector('.detail-body')?.innerText??'',raw:document.querySelector('.detail-raw')?.textContent?.trim()??'',rawWidth:document.querySelector('.detail-raw')?.getBoundingClientRect().width??null,rawScroll:document.querySelector('.detail-raw')?.scrollWidth??null,partial:Boolean(document.querySelector('.detail-partial-notice'))}))()`)
    assert.equal(content.partial, true, 'Monge partial ingredient warning missing')
    assert.match(content.text, /목록에 없는 원료도 포함될 수 있습니다/)
    assert.ok(content.raw.length > 20, 'Monge raw source text missing')
    assert.ok(metrics.stage.scrollWidth <= metrics.stage.clientWidth + 1, '360 stage horizontal overflow')
    assert.ok(content.rawScroll <= content.rawWidth + 1, `360 raw text horizontal overflow: ${JSON.stringify(content)}`)
    await c.shot(`${OUT}/candidate-monge-ingredients-360.png`)
    return { chrome: launched.version, metrics, content, network: await assertNetworkReadOnly(c, 'monge ingredients') }
  } finally { cleanup(launched.proc, launched.dir, c) }
}

async function tabScrollAndKeyboardScenario() {
  const launched = await launch(390, 900, true)
  const c = launched.c
  try {
    await openDirect(c, GO, 'nutrition')
    await setStageBottom(c)
    await clickVisibleNoScroll(c, '#detail-tab-ingredients')
    await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'ingredients selected from bottom')
    const switched = await stickyMetric(c)
    assert.ok(switched.headingTop >= switched.stickyBottom - 1, `explicit tab start hidden by sticky UI: ${JSON.stringify(switched)}`)
    const moved = await setStageScroll(c, Math.min(switched.max, switched.scrollTop + 140))
    const beforeSame = await stickyMetric(c)
    await clickVisibleNoScroll(c, '#detail-tab-ingredients')
    await sleep(80)
    const afterSame = await stickyMetric(c)
    assert.ok(Math.abs(afterSame.scrollTop - beforeSame.scrollTop) <= 1, `same-tab click reset reading position: ${beforeSame.scrollTop} -> ${afterSame.scrollTop}`)

    await c.eval(`document.querySelector('#detail-tab-ingredients').focus({preventScroll:true})`)
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home' })
    await c.wait(`document.querySelector('#detail-tab-overview')?.getAttribute('aria-selected')==='true' && document.activeElement?.id==='detail-tab-overview'`, 'Home selects and focuses overview')
    const home = await stickyMetric(c)
    assert.ok(home.headingTop >= home.stickyBottom - 1, `Home panel hidden by sticky UI: ${JSON.stringify(home)}`)
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' })
    await c.wait(`document.querySelector('#detail-tab-context')?.getAttribute('aria-selected')==='true' && document.activeElement?.id==='detail-tab-context'`, 'End selects and focuses context')
    const end = await stickyMetric(c)
    assert.ok(end.headingTop >= end.stickyBottom - 1, `End panel hidden by sticky UI: ${JSON.stringify(end)}`)
    return { chrome: launched.version, moved, switched, beforeSame, afterSame, home, end, network: await assertNetworkReadOnly(c, 'tab scroll keyboard') }
  } finally { cleanup(launched.proc, launched.dir, c) }
}

async function breakpointScenario(width, height) {
  const launched = await launch(width, height, width < 768)
  const c = launched.c
  try {
    await openDirect(c, GO, 'overview')
    const metrics = await pageMetrics(c)
    const expected = width >= 1120 ? 'grid' : 'block'
    assert.equal(metrics.layoutDisplay, expected, `unexpected layout at ${width}`)
    assert.ok(metrics.stage.scrollWidth <= metrics.stage.clientWidth + 1, `horizontal overflow at ${width}`)
    assert.ok(metrics.bodyOverflow <= 1, `document overflow at ${width}`)
    return { width, height, expected, metrics, network: await assertNetworkReadOnly(c, `breakpoint ${width}`) }
  } finally { cleanup(launched.proc, launched.dir, c) }
}

async function installNutritionMock(c, mode) {
  const source = mode === 'error-once'
    ? `(()=>{const base=window.fetch.bind(window);let n=0;window.fetch=(input,init={})=>{const u=typeof input==='string'?input:(input&&input.url)||'';if(u.includes('/rest/v1/compare_product_nutrition')&&++n===1)return Promise.resolve(new Response('qa failure',{status:503}));return base(input,init)}})();`
    : mode === 'empty'
      ? `(()=>{const base=window.fetch.bind(window);window.fetch=(input,init={})=>{const u=typeof input==='string'?input:(input&&input.url)||'';if(u.includes('/rest/v1/compare_product_nutrition'))return Promise.resolve(new Response('[]',{status:200,headers:{'Content-Type':'application/json'}}));return base(input,init)}})();`
      : `(()=>{const base=window.fetch.bind(window);window.fetch=(input,init={})=>{const u=typeof input==='string'?input:(input&&input.url)||'';if(u.includes('/rest/v1/compare_product_nutrition'))return new Promise((resolve,reject)=>setTimeout(()=>base(input,init).then(resolve,reject),900));return base(input,init)}})();`
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source })
}

async function stateScenario(mode) {
  const launched = await launch(390, 900, true)
  const c = launched.c
  try {
    await installNutritionMock(c, mode)
    await c.nav(detailUrl(GO, 'nutrition'))
    await c.wait(`document.querySelector('.detail-stage')`, `${mode} detail stage`, 30000)
    if (mode === 'error-once') {
      await c.wait(`document.querySelector('[role="alert"]')`, 'nutrition error', 30000)
      const errorText = await c.eval(`document.querySelector('[role="alert"]')?.innerText??''`)
      assert.equal(errorText.replace(/\\s+/g, ' ').trim(), '영양 정보를 불러오지 못했습니다. 다시 시도')
      assert.doesNotMatch(errorText, /잠시 후/)
      await c.shot(`${OUT}/candidate-error-390.png`)
      await clickVisibleNoScroll(c, '[role="alert"] button', '다시 시도')
      await c.wait(`!document.querySelector('[role="alert"]') && (document.querySelector('.detail-energy') || document.querySelector('.detail-empty'))`, 'nutrition retry success', 30000)
      return { mode, errorText, afterRetry: await c.eval(`document.querySelector('.detail-body')?.innerText??''`), network: await assertNetworkReadOnly(c, mode) }
    }
    if (mode === 'empty') {
      await c.wait(`document.querySelector('.detail-empty')?.textContent?.includes('확인된 영양 정보가 없습니다.')`, 'normal empty nutrition', 30000)
      assert.equal(await c.eval(`Boolean(document.querySelector('[role="alert"]'))`), false)
      return { mode, text: await c.eval(`document.querySelector('.detail-body')?.innerText??''`), network: await assertNetworkReadOnly(c, mode) }
    }
    await c.wait(`[...document.querySelectorAll('.detail-state')].some(n=>(n.textContent||'').includes('영양 정보를 불러오는 중입니다.'))`, 'nutrition delayed loading', 30000)
    const loadingText = await c.eval(`document.querySelector('.detail-body')?.innerText??''`)
    await c.wait(`![...document.querySelectorAll('.detail-state')].some(n=>(n.textContent||'').includes('영양 정보를 불러오는 중입니다.'))`, 'nutrition delayed completion', 30000)
    return { mode, loadingText, settledText: await c.eval(`document.querySelector('.detail-body')?.innerText??''`), network: await assertNetworkReadOnly(c, mode) }
  } finally { cleanup(launched.proc, launched.dir, c) }
}

async function parentReturnScenario() {
  const launched = await launch(390, 900, true)
  const c = launched.c
  try {
    await c.nav(lookupUrl(GO))
    const cardSelector = `.research-result-card[data-product-id="${GO.id}"]`
    await c.wait(`document.querySelector(${js(cardSelector)})`, 'GO lookup card', 30000)
    await scrollElementIntoView(c, cardSelector)
    await clickVisibleNoScroll(c, cardSelector)
    await c.wait(`document.querySelector('.research-quick-view')`, 'quick view')
    await clickVisibleNoScroll(c, '.quick-view-actions button', '상세 보기')
    await waitDetail(c, GO, 'overview')
    await clickVisibleNoScroll(c, '.detail-topbar-inner button', '제품 목록')
    await c.wait(`document.querySelector('.research-quick-view')`, 'detail returns to quick view')
    const quickViewReturn = await c.eval(`document.querySelector('.quick-view-identity h1')?.textContent?.trim()??null`)

    await c.nav(compareUrl())
    await c.wait(`document.querySelector('.compare-stage')`, 'compare stage', 30000)
    const detailLinks = await c.eval(`[...document.querySelectorAll('.compare-detail-link')].map(n=>n.textContent?.trim())`)
    assert.ok(detailLinks.length >= 1, 'compare detail action missing')
    await scrollElementIntoView(c, '.compare-detail-link')
    await clickVisibleNoScroll(c, '.compare-detail-link')
    await c.wait(`document.querySelector('.detail-stage')`, 'compare detail')
    await clickVisibleNoScroll(c, '.detail-topbar-inner button', '제품 목록')
    await c.wait(`document.querySelector('.compare-stage')`, 'detail returns to compare')
    return { chrome: launched.version, quickViewReturn, compareDetailLinks: detailLinks, network: await assertNetworkReadOnly(c, 'parent returns') }
  } finally { cleanup(launched.proc, launched.dir, c) }
}

const report = {
  productSha: PRODUCT_SHA,
  generatedAt: new Date().toISOString(),
  mobileOverview: await mobileOverviewScenario(),
  desktop: await desktopScenario(),
  mongeIngredients: await mongeIngredientsScenario(),
  tabScrollKeyboard: await tabScrollAndKeyboardScenario(),
  breakpoints: [],
  states: [],
  parentReturn: null,
}

for (const [width, height] of [[768, 1024], [1024, 900], [1119, 900], [1120, 900], [1121, 900]]) {
  report.breakpoints.push(await breakpointScenario(width, height))
}
for (const mode of ['error-once', 'empty', 'delay']) {
  report.states.push(await stateScenario(mode))
}
report.parentReturn = await parentReturnScenario()

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
writeFileSync(`${OUT}/README.txt`, [
  `PRODUCT_SHA=${PRODUCT_SHA}`,
  'Live public API reads only. Analytics/write blocker installed before first navigation.',
  'Screenshots: GO overview 390/1440, GO nutrition 1440, Monge ingredients 360, mocked nutrition error 390.',
  'Fixture-only contracts such as basis-specific nutrition, supplemental full ingredients, kcal/100g, bundle SKU, and no-image are covered by product tests.',
].join('\n'))
console.log(JSON.stringify({
  productSha: report.productSha,
  mobile: report.mobileOverview.metrics,
  desktop: report.desktop.overview,
  mongePartial: report.mongeIngredients.content.partial,
  breakpoints: report.breakpoints.map((x) => ({ width: x.width, display: x.metrics.layoutDisplay })),
  states: report.states.map((x) => x.mode),
  parentReturn: report.parentReturn.quickViewReturn,
}, null, 2))
