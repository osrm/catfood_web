import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cleanup, info, js, launch, network, norm, pointer, sleep } from './manufacturing-distribution-review-helpers.mjs'

const PROD = 'https://osrm.github.io/catfood_web/'
const TARGET_SHA = 'af8b3d01689ab5e2985f1a89256a0bc1a8aef7c5'
const OUT = 'qa-artifacts/manufacturing-distribution-review'
const VIEWPORTS = [{ width: 360, height: 844 }, { width: 390, height: 900 }]
const COUNTRY_LABELS = { KR: '한국', US: '미국', CA: '캐나다', GB: '영국', AU: '호주', NZ: '뉴질랜드', NL: '네덜란드', TH: '태국', DE: '독일', FR: '프랑스', IT: '이탈리아', CZ: '체코', AT: '오스트리아', JP: '일본' }
const CATALOG_FIELDS = 'product_id,brand,canonical_name,manufacturing_observation_count,has_manufacturing_details,manufacturing_country_codes,market_observation_count,has_market_details,assessed_market_country_codes,current_market_country_codes,formula_match_market_country_codes,variant_count,has_variants'
const MANUFACTURING_FIELDS = 'product_id,observation_scope,country_code,manufacturer,plant,is_current_resolved_formula'
const MARKET_FIELDS = 'product_id,country_code,distribution_status,formula_correspondence_status,counterpart_name,assessed_at,is_current_product_confirmed,is_formula_match_confirmed,display_rank,country_observation_count'
mkdirSync(OUT, { recursive: true })

function publicApiConfig() {
  const env = readFileSync('.env.example', 'utf8')
  const baseUrl = env.match(/^VITE_SUPABASE_URL=(.+)$/m)?.[1]?.trim()
  const publishableKey = env.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.+)$/m)?.[1]?.trim()
  assert.ok(baseUrl && publishableKey, 'public API config missing')
  return { baseUrl: baseUrl.replace(/\/$/, ''), publishableKey }
}

async function publicRows(view, select, order = null) {
  const { baseUrl, publishableKey } = publicApiConfig()
  const rows = []
  for (let offset = 0; offset < 10000; offset += 1000) {
    const url = new URL(`${baseUrl}/rest/v1/${view}`)
    url.searchParams.set('select', select)
    if (order) url.searchParams.set('order', order)
    url.searchParams.set('limit', '1000')
    url.searchParams.set('offset', String(offset))
    const response = await fetch(url, { headers: { apikey: publishableKey, 'Accept-Profile': 'api' } })
    assert.ok(response.ok, `${view} public API ${response.status}`)
    const page = await response.json()
    assert.ok(Array.isArray(page), `${view} public API did not return an array`)
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows
}

function countryLabel(value) { return value ? (COUNTRY_LABELS[value] ?? value) : '미확인' }
function distributionLabel(status) {
  if (status === 'current_product_confirmed') return '현재 제품 유통 확인'
  if (status === 'gate_confirmed_product_not_found') return '브랜드는 유통되지만 이 제품은 확인하지 못했습니다'
  if (status === 'distribution_not_confirmed') return '공식 유통 미확인'
  return '판매 여부 미확인'
}
function formulaMarketLabel(status) {
  if (status === 'exact_same') return '동일 배합 확인'
  if (status === 'same_formula_different_package') return '동일 배합 · 다른 패키지'
  if (status === 'different_generation') return '다른 세대 확인'
  if (status === 'not_found') return '동일 배합 미확인'
  return '같은 배합인지 확인하지 못했습니다'
}
function addFinding(report, severity, code, details) { report.findings.push({ severity, code, details }) }
function arrays(value) { return Array.isArray(value) ? value : [] }
function byProduct(rows) {
  const map = new Map()
  for (const row of rows) {
    const list = map.get(row.product_id) ?? []
    list.push(row)
    map.set(row.product_id, list)
  }
  return map
}
function firstByProduct(rows) {
  const map = new Map()
  for (const row of rows) if (!map.has(row.product_id)) map.set(row.product_id, row)
  return map
}
function maxCounterpartLength(rows) { return Math.max(0, ...rows.map((row) => String(row.counterpart_name ?? '').length)) }

function chooseCases(catalog, manufacturingRows, marketRows) {
  const mMap = firstByProduct(manufacturingRows)
  const marketMap = byProduct(marketRows)
  const candidates = catalog.map((product) => ({ product, manufacturing: mMap.get(product.product_id) ?? null, markets: marketMap.get(product.product_id) ?? [] }))

  const complete = candidates.filter((x) => x.manufacturing && x.markets.length).sort((a, b) => {
    const score = (x) => (x.manufacturing.country_code ? 30 : 0) + (x.manufacturing.manufacturer?.trim() ? 35 : 0) + (x.manufacturing.plant?.trim() ? 35 : 0)
      + (x.markets.some((r) => r.is_current_product_confirmed) ? 50 : 0) + (x.markets.some((r) => r.is_formula_match_confirmed) ? 50 : 0)
      + (x.markets.some((r) => r.assessed_at) ? 10 : 0) + Math.min(40, maxCounterpartLength(x.markets))
    return score(b) - score(a)
  })[0] ?? null

  const unknown = candidates.filter((x) => x.product.product_id !== complete?.product.product_id && (!x.manufacturing || !x.markets.length)).sort((a, b) => {
    const score = (x) => ((!x.manufacturing) !== (!x.markets.length) ? 300 : 100) + (x.manufacturing ? 40 : 0) + (x.markets.length ? 40 : 0)
      + (x.manufacturing && (!x.manufacturing.manufacturer?.trim() || !x.manufacturing.plant?.trim()) ? 20 : 0)
    return score(b) - score(a)
  })[0] ?? null

  const used = new Set([complete?.product.product_id, unknown?.product.product_id].filter(Boolean))
  const stress = candidates.filter((x) => !used.has(x.product.product_id) && (x.manufacturing?.observation_scope === 'variant' || maxCounterpartLength(x.markets) >= 28)).sort((a, b) => {
    const score = (x) => (x.manufacturing?.observation_scope === 'variant' ? 1000 : 0) + maxCounterpartLength(x.markets)
    return score(b) - score(a)
  })[0] ?? null

  const selected = []
  if (complete) selected.push({ role: 'manufacturing_and_overseas', ...complete })
  if (unknown) selected.push({ role: 'unknown_manufacturing_or_distribution', ...unknown })
  if (stress) selected.push({ role: stress.manufacturing?.observation_scope === 'variant' ? 'variant_scope_or_long_local_name' : 'long_local_name', ...stress })
  return {
    selected,
    unavailable: {
      manufacturing_and_overseas: complete ? null : '공개 API에서 제조 정보와 해외 판매·배합 정보가 함께 있는 제품을 찾지 못함',
      unknown_manufacturing_or_distribution: unknown ? null : '공개 API에서 제조 또는 유통 정보가 미확인인 제품을 찾지 못함',
      variant_scope_or_long_local_name: stress ? null : '선정된 다른 사례와 중복되지 않는 규격 기준 제조 정보 또는 긴 현지 제품명 사례를 찾지 못함',
    },
  }
}

function expectedManufacturing(row) {
  if (!row) return { empty: '현재 확정된 제조 정보가 없습니다.', facts: [], notes: [] }
  const facts = [{ label: '제조국', value: countryLabel(row.country_code) }]
  const missing = []
  if (row.manufacturer?.trim()) facts.push({ label: '제조 업체', value: row.manufacturer })
  else missing.push('제조 업체')
  if (row.plant?.trim()) facts.push({ label: '제조 공장', value: row.plant })
  else missing.push('공장')
  const notes = []
  if (missing.length) notes.push(`${missing.join('와 ')} 정보는 확인하지 못했습니다.`)
  if (row.observation_scope === 'variant') notes.push('제조국은 확인한 포장을 기준으로 안내합니다. 구매할 제품의 포장도 확인해 주세요.')
  return { empty: '', facts, notes }
}

function expectedMarkets(rows) {
  if (!rows.length) return { empty: '현재 확정된 해외 유통 정보가 없습니다.', rows: [] }
  return {
    empty: '',
    rows: rows.map((row) => ({
      country: countryLabel(row.country_code),
      assessed: row.assessed_at ? `${row.assessed_at} 확인` : '확인일 미기재',
      distribution: distributionLabel(row.distribution_status),
      formula: formulaMarketLabel(row.formula_correspondence_status),
      counterpart: row.counterpart_name?.trim() || null,
    })),
  }
}

async function waitChecked(c, expression, label, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await c.eval(`Boolean(${expression})`).catch(() => false)) return
    await sleep(120)
  }
  throw new Error(`timeout ${label}`)
}

async function findLookupResult(c, product) {
  const selector = `.research-result-card[data-product-id="${product.product_id}"]`
  const queries = [product.canonical_name, `${product.brand} ${product.canonical_name}`, product.brand].filter((value, index, list) => value && list.indexOf(value) === index)
  for (const query of queries) {
    const url = `${PROD}?view=workspace&mode=lookup&q=${encodeURIComponent(query)}`
    await c.nav(url)
    await waitChecked(c, `document.querySelector('.lookup-input')`, 'lookup input')
    const matchedInput = await c.eval(`document.querySelector('.lookup-input')?.value===${js(query)}`)
    assert.equal(matchedInput, true, 'q parameter was not reflected in lookup input')
    for (let i = 0; i < 80; i++) {
      if (await c.eval(`Boolean(document.querySelector(${js(selector)}))`)) return { query, selector, url }
      await sleep(120)
    }
  }
  throw new Error(`product card not found through q parameter: ${product.product_id} ${product.canonical_name}`)
}

async function detectScrollOwner(c) {
  const candidates = await c.eval(`(()=>{const start=document.querySelector('.detail-body>.detail-section')||document.querySelector('.detail-body');if(!start)return[];const out=[];let n=start;while(n){const s=getComputedStyle(n),r=n.getBoundingClientRect();out.push({tag:n.tagName,className:n.className||'',id:n.id||'',overflowY:s.overflowY,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,scrollTop:n.scrollTop,rect:[r.left,r.top,r.width,r.height,r.right,r.bottom]});n=n.parentElement}const d=document.scrollingElement,s=getComputedStyle(d),r=d.getBoundingClientRect();out.push({tag:'DOCUMENT',className:d.className||'',id:d.id||'',overflowY:s.overflowY,clientHeight:d.clientHeight,scrollHeight:d.scrollHeight,scrollTop:d.scrollTop,rect:[r.left,r.top,r.width,r.height,r.right,r.bottom]});return out})()`)
  const owner = candidates.find((item) => item.tag !== 'DOCUMENT' && item.scrollHeight > item.clientHeight + 2 && /(auto|scroll|overlay)/.test(item.overflowY))
    ?? candidates.find((item) => item.tag === 'DOCUMENT' && item.scrollHeight > item.clientHeight + 2)
  assert.ok(owner, `detail scroll owner not found: ${JSON.stringify(candidates)}`)
  const marker = await c.eval(`(()=>{const start=document.querySelector('.detail-body>.detail-section')||document.querySelector('.detail-body');let n=start;while(n){const s=getComputedStyle(n);if(n.scrollHeight>n.clientHeight+2&&/(auto|scroll|overlay)/.test(s.overflowY)){n.setAttribute('data-qa-manufacturing-scroll-owner','1');return{kind:'element',selector:'[data-qa-manufacturing-scroll-owner="1"]'}}n=n.parentElement}return{kind:'document',selector:null}})()`)
  return { candidates, owner, marker }
}

async function ownerState(c, marker) {
  return c.eval(marker.kind === 'element'
    ? `(()=>{const n=document.querySelector(${js(marker.selector)}),r=n.getBoundingClientRect();return{scrollTop:n.scrollTop,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,rect:[r.left,r.top,r.width,r.height,r.right,r.bottom]}})()`
    : `(()=>{const n=document.scrollingElement,r=n.getBoundingClientRect();return{scrollTop:n.scrollTop,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,rect:[r.left,r.top,r.width,r.height,r.right,r.bottom]}})()`)
}

async function wheelOwner(c, marker, target) {
  for (let i = 0; i < 40; i++) {
    const state = await ownerState(c, marker)
    const max = Math.max(0, state.scrollHeight - state.clientHeight)
    const wanted = target === 'bottom' ? max : 0
    const delta = wanted - state.scrollTop
    if (Math.abs(delta) <= 3) return await ownerState(c, marker)
    const x = Math.max(5, Math.min(350, state.rect[0] + Math.max(10, state.rect[2] / 2)))
    const y = Math.max(5, Math.min(800, state.rect[1] + Math.max(10, state.rect[3] / 2)))
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Math.sign(delta) * Math.min(520, Math.abs(delta)) })
    await sleep(90)
  }
  return ownerState(c, marker)
}

async function contextUI(c) {
  return c.eval(`(()=>{
    const nrm=v=>(v||'').replace(/\\s+/g,' ').trim();
    const metric=n=>{if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{text:nrm(n.textContent),rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,overflowX:s.overflowX,overflowY:s.overflowY,whiteSpace:s.whiteSpace,wordBreak:s.wordBreak,overflowWrap:s.overflowWrap};};
    const sections=[...document.querySelectorAll('.detail-body>.detail-section')];
    const manufacturing=sections.find(s=>nrm(s.querySelector('h2')?.textContent)==='제조 정보')||null;
    const markets=sections.find(s=>nrm(s.querySelector('h2')?.textContent)==='해외 판매 · 배합 확인')||null;
    const facts=manufacturing?[...manufacturing.querySelectorAll('.detail-fact')].map(n=>({label:nrm(n.querySelector('span')?.textContent),value:nrm(n.querySelector('strong')?.textContent),valueMetric:metric(n.querySelector('strong'))})):[];
    const notes=manufacturing?[...manufacturing.querySelectorAll('.detail-note')].map(n=>metric(n)):[];
    const marketRows=markets?[...markets.querySelectorAll('.detail-market-row')].map(row=>{const cells=[...row.children].map(cell=>({label:nrm(cell.querySelector('span')?.textContent),value:nrm(cell.querySelector('strong')?.textContent),labelMetric:metric(cell.querySelector('span')),valueMetric:metric(cell.querySelector('strong')),rect:metric(cell)?.rect}));return{rect:metric(row)?.rect,clientWidth:row.clientWidth,scrollWidth:row.scrollWidth,cells};}):[];
    return{
      manufacturingHeading:metric(manufacturing?.querySelector('.detail-section-heading')),
      marketHeading:metric(markets?.querySelector('.detail-section-heading')),
      manufacturingFacts:facts,
      manufacturingNotes:notes,
      manufacturingEmpty:nrm(manufacturing?.querySelector('.detail-empty')?.textContent),
      marketRows,
      marketEmpty:nrm(markets?.querySelector('.detail-empty')?.textContent),
      contextText:nrm(document.querySelector('#detail-panel-context')?.textContent),
    };
  })()`)
}

function normalizeActualMarketRows(uiRows) {
  return uiRows.map((row) => {
    const first = row.cells[0] ?? {}
    const distribution = row.cells.find((cell) => cell.label === '유통')
    const formula = row.cells.find((cell) => cell.label === '한국 제품과의 배합 비교')
    const counterpart = row.cells.find((cell) => cell.label === '현지 제품명')
    return { country: first.value ?? '', assessed: first.label ?? '', distribution: distribution?.value ?? '', formula: formula?.value ?? '', counterpart: counterpart?.value || null }
  })
}

function checkClipping(ui, report, context) {
  const metrics = []
  for (const fact of ui.manufacturingFacts) metrics.push({ kind: `manufacturing:${fact.label}`, ...fact.valueMetric })
  for (const note of ui.manufacturingNotes) metrics.push({ kind: 'manufacturing-note', ...note })
  ui.marketRows.forEach((row, i) => row.cells.forEach((cell) => {
    metrics.push({ kind: `market-${i}:${cell.label || 'country'}:label`, ...cell.labelMetric })
    metrics.push({ kind: `market-${i}:${cell.label || 'country'}:value`, ...cell.valueMetric })
  }))
  const reviewed = metrics.filter((item) => item && item.rect).map((item) => {
    const horizontalOverflow = item.scrollWidth > item.clientWidth + 1
    const verticalOverflow = item.scrollHeight > item.clientHeight + 1
    const outOfViewport = item.rect[0] < -1 || item.rect[4] > context.viewportWidth + 1
    const clipped = outOfViewport || (horizontalOverflow && ['hidden','clip'].includes(item.overflowX)) || (verticalOverflow && ['hidden','clip'].includes(item.overflowY))
    if (clipped) addFinding(report, 'medium', 'context_text_clipped_or_outside', { context, item, horizontalOverflow, verticalOverflow, outOfViewport })
    return { kind: item.kind, horizontalOverflow, verticalOverflow, outOfViewport, clipped, rect: item.rect, clientWidth: item.clientWidth, scrollWidth: item.scrollWidth, clientHeight: item.clientHeight, scrollHeight: item.scrollHeight, whiteSpace: item.whiteSpace, overflowWrap: item.overflowWrap, wordBreak: item.wordBreak, textLength: item.text?.length ?? 0 }
  })
  return reviewed
}

function compareApiUi(apiManufacturing, apiMarkets, ui, report, context) {
  const expectedM = expectedManufacturing(apiManufacturing)
  const expectedG = expectedMarkets(apiMarkets)
  const actualFacts = ui.manufacturingFacts.map(({ label, value }) => ({ label, value }))
  const actualNotes = ui.manufacturingNotes.map((item) => item.text)
  const actualMarkets = normalizeActualMarketRows(ui.marketRows)
  if (JSON.stringify(actualFacts) !== JSON.stringify(expectedM.facts)) addFinding(report, 'high', 'manufacturing_api_ui_mismatch', { context, expected: expectedM.facts, actual: actualFacts, raw: apiManufacturing })
  if (ui.manufacturingEmpty !== expectedM.empty) addFinding(report, 'high', 'manufacturing_empty_state_mismatch', { context, expected: expectedM.empty, actual: ui.manufacturingEmpty, raw: apiManufacturing })
  for (const note of expectedM.notes) if (!actualNotes.includes(note)) addFinding(report, 'medium', 'manufacturing_note_missing', { context, expected: note, actualNotes, raw: apiManufacturing })
  if (JSON.stringify(actualMarkets) !== JSON.stringify(expectedG.rows)) addFinding(report, 'high', 'markets_api_ui_mismatch', { context, expected: expectedG.rows, actual: actualMarkets, raw: apiMarkets })
  if (ui.marketEmpty !== expectedG.empty) addFinding(report, 'high', 'markets_empty_state_mismatch', { context, expected: expectedG.empty, actual: ui.marketEmpty, raw: apiMarkets })

  const uncertainDistribution = apiMarkets.filter((row) => row.distribution_status !== 'current_product_confirmed')
  for (const row of uncertainDistribution) {
    const expected = distributionLabel(row.distribution_status)
    if (expected.includes('판매 안 함')) addFinding(report, 'high', 'unknown_distribution_rendered_as_not_sold', { context, row, expected })
  }
  const uncertainFormula = apiMarkets.filter((row) => !['exact_same','same_formula_different_package','different_generation'].includes(row.formula_correspondence_status))
  for (const row of uncertainFormula) {
    const expected = formulaMarketLabel(row.formula_correspondence_status)
    if (expected === '다른 세대 확인') addFinding(report, 'high', 'unknown_formula_rendered_as_different', { context, row, expected })
  }
  if (!apiManufacturing && ui.manufacturingEmpty.includes('없습니다') && /판매 안|다른 배합/.test(ui.manufacturingEmpty)) addFinding(report, 'high', 'missing_manufacturing_negative_claim', { context, text: ui.manufacturingEmpty })
  if (!apiMarkets.length && /판매 안|다른 배합/.test(ui.marketEmpty)) addFinding(report, 'high', 'missing_market_negative_claim', { context, text: ui.marketEmpty })

  return { expected: { manufacturing: expectedM, markets: expectedG }, actual: { manufacturingFacts: actualFacts, manufacturingNotes: actualNotes, manufacturingEmpty: ui.manufacturingEmpty, marketRows: actualMarkets, marketEmpty: ui.marketEmpty } }
}

async function runCase(viewport, selectedCase, report) {
  const { product, role } = selectedCase
  const launched = await launch(viewport.width, viewport.height)
  const { c } = launched
  const prefix = `${viewport.width}x${viewport.height}-${role}-${product.product_id}`
  try {
    const entry = await findLookupResult(c, product)
    const card = await pointer(c, entry.selector)
    await waitChecked(c, `document.querySelector('.research-quick-view')`, 'quick view')
    const quickView = await c.eval(`(()=>{const n=v=>(v||'').replace(/\\s+/g,' ').trim();return{title:n(document.querySelector('.quick-view-identity h1')?.textContent),brand:n(document.querySelector('.quick-view-identity>div span')?.textContent),url:location.href}})()`)
    const detailMark = c.responseMark()
    await pointer(c, '.quick-view-actions button', '상세 보기')
    await waitChecked(c, `document.querySelector('.detail-stage')`, 'detail stage')
    const manufacturingResponse = await c.waitResponse('product_detail_manufacturing', product.product_id, detailMark)
    const marketResponse = await c.waitResponse('product_detail_markets', product.product_id, detailMark)
    await waitChecked(c, `[...document.querySelectorAll('.detail-state')].every(n=>!n.textContent.includes('불러오는 중'))`, 'detail resources complete')
    const apiManufacturing = manufacturingResponse.json[0] ?? null
    const apiMarkets = marketResponse.json

    const scrollInfo = await detectScrollOwner(c)
    const preTabBottom = await wheelOwner(c, scrollInfo.marker, 'bottom')
    await pointer(c, '#detail-tab-context')
    await waitChecked(c, `document.querySelector('#detail-tab-context')?.getAttribute('aria-selected')==='true'`, 'context tab active')
    await waitChecked(c, `document.querySelector('#detail-panel-context .detail-section-heading h2')?.textContent.includes('제조 정보')`, 'manufacturing heading')
    await sleep(180)
    const postTabOwner = await ownerState(c, scrollInfo.marker)
    const topUi = await contextUI(c)
    const headingVisible = await c.eval(`(()=>{const h=[...document.querySelectorAll('#detail-panel-context h2')].find(n=>n.textContent.includes('제조 정보')),o=${scrollInfo.marker.kind === 'element' ? `document.querySelector(${js(scrollInfo.marker.selector)})` : 'document.scrollingElement'};if(!h||!o)return null;const hr=h.getBoundingClientRect(),or=${scrollInfo.marker.kind === 'element' ? 'o.getBoundingClientRect()' : '{top:0,bottom:innerHeight}'};return{headingRect:[hr.left,hr.top,hr.width,hr.height,hr.right,hr.bottom],ownerRect:[or.left||0,or.top||0,or.width||innerWidth,or.height||innerHeight,or.right||innerWidth,or.bottom||innerHeight],visible:hr.bottom>or.top&&hr.top<or.bottom}})()`)
    if (!headingVisible?.visible) addFinding(report, 'high', 'context_heading_not_visible_after_tab_switch', { viewport, product, preTabBottom, postTabOwner, headingVisible })
    if (postTabOwner.scrollTop > 80) addFinding(report, 'medium', 'context_tab_did_not_return_near_heading', { viewport, product, preTabBottom, postTabOwner, headingVisible })

    const topPng = `${OUT}/${prefix}-top.png`
    await c.shot(topPng)
    const comparison = compareApiUi(apiManufacturing, apiMarkets, topUi, report, { viewportWidth: viewport.width, viewportHeight: viewport.height, productId: product.product_id, role })
    const clipping = checkClipping(topUi, report, { viewportWidth: viewport.width, viewportHeight: viewport.height, productId: product.product_id, role })

    const beforeBottom = await ownerState(c, scrollInfo.marker)
    const maxScroll = Math.max(0, beforeBottom.scrollHeight - beforeBottom.clientHeight)
    let bottomPng = null
    let bottomState = beforeBottom
    let lastReachable = null
    if (maxScroll > 8) {
      bottomState = await wheelOwner(c, scrollInfo.marker, 'bottom')
      await sleep(120)
      bottomPng = `${OUT}/${prefix}-bottom.png`
      await c.shot(bottomPng)
      lastReachable = await c.eval(`(()=>{const rows=[...document.querySelectorAll('#detail-panel-context .detail-market-row')],fallback=[...document.querySelectorAll('#detail-panel-context .detail-note,#detail-panel-context .detail-empty')],n=rows.at(-1)||fallback.at(-1)||document.querySelector('#detail-panel-context .detail-section:last-child'),o=${scrollInfo.marker.kind === 'element' ? `document.querySelector(${js(scrollInfo.marker.selector)})` : 'document.scrollingElement'};if(!n||!o)return null;const r=n.getBoundingClientRect(),or=${scrollInfo.marker.kind === 'element' ? 'o.getBoundingClientRect()' : '{top:0,bottom:innerHeight}'};return{text:(n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,500),rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],ownerTop:or.top||0,ownerBottom:or.bottom||innerHeight,visible:r.bottom>or.top&&r.top<or.bottom,fullyVisible:r.top>=or.top-2&&r.bottom<=or.bottom+2}})()`)
      if (!lastReachable?.visible) addFinding(report, 'high', 'context_last_row_not_reachable_at_bottom', { viewport, product, bottomState, lastReachable })
    }

    const returnClick = await pointer(c, '.detail-topbar button', '돌아가기')
    await waitChecked(c, `!document.querySelector('.detail-stage')&&document.querySelector('.research-quick-view')`, 'return to parent quick view')
    const parent = await c.eval(`(()=>{const u=new URL(location.href);return{url:u.href,q:u.searchParams.get('q'),selected:u.searchParams.get('selected'),detail:u.searchParams.get('detail'),detailTab:u.searchParams.get('detailTab'),quickViewTitle:(document.querySelector('.quick-view-identity h1')?.textContent||'').replace(/\\s+/g,' ').trim()}})()`)
    if (parent.selected !== product.product_id || parent.detail !== null || parent.quickViewTitle !== product.canonical_name) addFinding(report, 'high', 'parent_return_state_not_preserved', { viewport, product, parent })

    const safety = await network(c)
    assert.equal(safety.sentWrites.length, 0, 'production write request observed')
    assert.equal(safety.sentAnalytics.length, 0, 'analytics request escaped pre-navigation blocker')
    return {
      viewport,
      role,
      product,
      entry: { method: 'url_q_parameter', query: entry.query, typingValidated: false, url: entry.url },
      card,
      quickView,
      api: {
        manufacturing: apiManufacturing,
        markets: apiMarkets,
        responseStatus: { manufacturing: manufacturingResponse.status, markets: marketResponse.status },
        responseUrls: { manufacturing: manufacturingResponse.url, markets: marketResponse.url },
      },
      comparison,
      contextUiAtTop: topUi,
      clipping,
      scroll: { candidates: scrollInfo.candidates, owner: scrollInfo.owner, marker: scrollInfo.marker, preTabBottom, postTabOwner, maxScroll, bottomState, headingVisible, lastReachable, shortContentSingleScreen: maxScroll <= 8 },
      parentReturn: { click: returnClick, state: parent },
      screenshots: { top: topPng, bottom: bottomPng },
      safety,
      chrome: launched.version,
    }
  } catch (error) {
    const failurePng = `${OUT}/${prefix}-failure.png`
    try { await c.shot(failurePng) } catch {}
    addFinding(report, 'high', 'case_execution_failure', { viewport, role, product, error: String(error?.stack || error), failurePng })
    return { viewport, role, product, error: String(error?.stack || error), screenshots: { failure: failurePng }, safety: await network(c).catch(() => null), chrome: launched.version }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

const report = {
  title: 'CATFOOD manufacturing and distribution detail review',
  generatedAt: new Date().toISOString(),
  targetSha: TARGET_SHA,
  deployedUrl: PROD,
  scope: {
    productChanges: false,
    entry: 'Actual Pages product card -> quick view -> detail -> 제조 · 유통. Search state is entered with q= URL parameters; this is not a typing/IME validation.',
    externalFactValidation: false,
    privateCoreUsed: false,
    viewports: VIEWPORTS,
  },
  publicApiSelection: null,
  cases: [],
  findings: [],
  limitations: [
    '공개 API와 배포 UI의 표시 계약만 대조하며 외부 제조사 자료의 사실성은 검증하지 않음',
    'q= URL parameter로 검색 상태를 구성했으며 키보드 타이핑/IME 동작을 검증하지 않음',
    '실물 포장, 물리 모바일, 실제 터치, 스크린리더, 비-Chrome 브라우저는 검증하지 않음',
  ],
}

try {
  const [catalog, manufacturingRows, marketRows] = await Promise.all([
    publicRows('effective_product_catalog_summary', CATALOG_FIELDS, 'brand.asc,canonical_name.asc'),
    publicRows('product_detail_manufacturing', MANUFACTURING_FIELDS, 'product_id.asc'),
    publicRows('product_detail_markets', MARKET_FIELDS, 'product_id.asc,display_rank.asc,country_code.asc'),
  ])
  const selection = chooseCases(catalog, manufacturingRows, marketRows)
  report.publicApiSelection = {
    counts: { catalog: catalog.length, manufacturingRows: manufacturingRows.length, marketRows: marketRows.length },
    selected: selection.selected.map((item) => ({ role: item.role, product: item.product, manufacturing: item.manufacturing, markets: item.markets, maxCounterpartNameLength: maxCounterpartLength(item.markets) })),
    unavailable: selection.unavailable,
  }
  assert.ok(selection.selected.length >= 2, `too few public cases selected: ${selection.selected.length}`)

  for (const viewport of VIEWPORTS) {
    for (const selectedCase of selection.selected) report.cases.push(await runCase(viewport, selectedCase, report))
  }

  const successful = report.cases.filter((item) => !item.error)
  assert.equal(successful.length, VIEWPORTS.length * selection.selected.length, 'one or more browser cases failed')
  const severe = report.findings.filter((item) => item.severity === 'high')
  report.status = severe.length ? 'review_required' : 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, selected: report.publicApiSelection.selected.map((x) => ({ role: x.role, productId: x.product.product_id, brand: x.product.brand, name: x.product.canonical_name })), findingCount: report.findings.length, highCount: severe.length }, null, 2))
} catch (error) {
  report.status = 'harness_failure'
  report.harnessError = String(error?.stack || error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.error(error)
  process.exitCode = 1
}
