import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cleanup, info, js, launch, network, norm, pointer, sleep, typeInput, wheelTo } from './mobile-detail-review-helpers.mjs'

const PROD = 'https://osrm.github.io/catfood_web/'
const TARGET_SHA = 'd7080165e1bffe4cbe93eb69f3dc2f85d90c42ae'
const OUT = 'qa-artifacts/mobile-detail-review'
const ING_FIELDS = 'product_id,variant_id,observation_scope,market_code,declaration_scope,completeness_status,raw_text,ingredient_names,ingredient_count,is_korea_market_observation,is_current_resolved_formula,supplemental_full_raw_text,supplemental_full_ingredient_names,supplemental_full_ingredient_count,supplemental_observation_scope,supplemental_market_code,supplemental_is_current_resolved_formula'
const NUT_FIELDS = 'product_id,variant_id,observation_scope,market_code,panel_type,protein_pct,protein_qualifier,fat_pct,fat_qualifier,fiber_pct,fiber_qualifier,moisture_pct,moisture_qualifier,ash_pct,ash_qualifier,kcal_per_kg,kcal_per_100g,energy_basis,is_korea_market_observation,is_current_resolved_formula,additional_nutrients,additional_nutrient_count,supplemental_nutrition_fields,supplemental_observation_scope,supplemental_market_code,supplemental_is_current_resolved_formula,basis_specific_nutrition_basis,basis_specific_nutrition_values'
const NUTRIENTS = [
  ['조단백질', 'protein_pct', 'protein_qualifier'],
  ['조지방', 'fat_pct', 'fat_qualifier'],
  ['조섬유', 'fiber_pct', 'fiber_qualifier'],
  ['수분', 'moisture_pct', 'moisture_qualifier'],
  ['조회분', 'ash_pct', 'ash_qualifier'],
]
const QUALIFIER = { min: ' 이상', max: ' 이하', typical: ' 평균값', reported: '', exact: '' }
mkdirSync(OUT, { recursive: true })

function headerValue(headers, name) {
  const target = name.toLowerCase()
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === target)?.[1] ?? null
}
function array(value) { return Array.isArray(value) ? value : [] }
function rawLength(row) { return Math.max(String(row?.raw_text ?? '').trim().length, String(row?.supplemental_full_raw_text ?? '').trim().length) }
function ingredientCount(row) { return Math.max(array(row?.ingredient_names).length, array(row?.supplemental_full_ingredient_names).length, Number(row?.ingredient_count ?? 0), Number(row?.supplemental_full_ingredient_count ?? 0)) }
function nutritionValueCount(row) {
  if (!row) return 0
  const standard = ['protein_pct', 'fat_pct', 'fiber_pct', 'moisture_pct', 'ash_pct', 'kcal_per_kg', 'kcal_per_100g'].filter((key) => row[key] != null).length
  const additional = array(row.additional_nutrients).filter((value) => value?.amount != null).length
  const basis = array(row.basis_specific_nutrition_values).filter((value) => value?.amount != null).length
  return standard + additional + basis
}
function qualifierCount(row) { return row ? ['protein_qualifier', 'fat_qualifier', 'fiber_qualifier', 'moisture_qualifier', 'ash_qualifier'].filter((key) => row[key] && !['reported', 'exact'].includes(row[key])).length : 0 }
function rowByProduct(rows) { return new Map(rows.map((row) => [row.product_id, row])) }

async function publicRows(origin, apikey, view, fields, ids) {
  const rows = []
  for (let offset = 0; offset < ids.length; offset += 45) {
    const batch = ids.slice(offset, offset + 45)
    const url = new URL(`${origin}/rest/v1/${view}`)
    url.searchParams.set('select', fields)
    url.searchParams.set('product_id', `in.(${batch.join(',')})`)
    url.searchParams.set('limit', '1000')
    const response = await fetch(url, { headers: { apikey, 'Accept-Profile': 'api' } })
    if (!response.ok) throw new Error(`${view} discovery ${response.status}: ${(await response.text()).slice(0, 180)}`)
    rows.push(...await response.json())
  }
  return rows
}

async function discoverCandidates(c) {
  const mark = c.responseMark()
  await c.nav(`${PROD}?view=workspace&mode=lookup`)
  await c.wait(`document.querySelector('.lookup-input')`, 'lookup input')
  const catalogResponse = await c.waitResponse('effective_product_catalog_summary', null, mark)
  const request = c.requestFor(catalogResponse.requestId)
  const apikey = headerValue(request?.headers, 'apikey')
  assert.ok(apikey, 'publishable API key was not present on public catalog request')
  const origin = new URL(catalogResponse.url).origin
  const catalog = catalogResponse.json
  assert.ok(Array.isArray(catalog) && catalog.length > 100, 'catalog response unexpectedly small')
  const ids = catalog.map((row) => row.product_id)
  const ingredients = await publicRows(origin, apikey, 'compare_product_ingredients', ING_FIELDS, ids)
  const nutrition = await publicRows(origin, apikey, 'compare_product_nutrition', NUT_FIELDS, ids)
  const ingMap = rowByProduct(ingredients), nutMap = rowByProduct(nutrition)

  const fullRanked = catalog.map((product) => {
    const ing = ingMap.get(product.product_id) ?? null, nut = nutMap.get(product.product_id) ?? null
    const longRaw = rawLength(ing), values = nutritionValueCount(nut), qualifiers = qualifierCount(nut)
    const hasFull = ing && (ing.completeness_status === 'full' || String(ing.supplemental_full_raw_text ?? '').trim() || array(ing.supplemental_full_ingredient_names).length)
    const eligible = Boolean(hasFull && longRaw >= 220 && values >= 3)
    const score = longRaw + ingredientCount(ing) * 12 + values * 70 + qualifiers * 130 + (array(nut?.basis_specific_nutrition_values).length ? 260 : 0) + (array(nut?.supplemental_nutrition_fields).length ? 180 : 0) + (String(ing?.supplemental_full_raw_text ?? '').trim() ? 140 : 0)
    return { product, ing, nut, eligible, score, longRaw, values, qualifiers }
  }).filter((item) => item.eligible).sort((a, b) => b.score - a.score)
  assert.ok(fullRanked.length, 'no full long-ingredient candidate found')
  const full = fullRanked[0]

  const partialRanked = catalog.filter((product) => product.product_id !== full.product.product_id).map((product) => {
    const ing = ingMap.get(product.product_id) ?? null, nut = nutMap.get(product.product_id) ?? null
    const partialList = Boolean(ing && ['partial', 'summary'].includes(ing.completeness_status) && !String(ing.supplemental_full_raw_text ?? '').trim() && !array(ing.supplemental_full_ingredient_names).length)
    const missingStandard = nut ? ['protein_pct', 'fat_pct', 'fiber_pct', 'moisture_pct', 'ash_pct', 'kcal_per_kg', 'kcal_per_100g'].filter((key) => nut[key] == null).length : 7
    const explicitUnknown = !nut || missingStandard > 0
    const eligible = Boolean(partialList || explicitUnknown)
    const score = (partialList ? 5000 : 0) + (ing?.completeness_status === 'partial' ? 1000 : 0) + (ing?.completeness_status === 'summary' ? 700 : 0) + missingStandard * 90 + ingredientCount(ing) * 3 + (nut ? 120 : 0)
    return { product, ing, nut, eligible, score, partialList, missingStandard }
  }).filter((item) => item.eligible).sort((a, b) => b.score - a.score)
  const partial = partialRanked[0] ?? null

  return {
    catalogCount: catalog.length,
    publicDetailCounts: { ingredients: ingredients.length, nutrition: nutrition.length },
    full: { product: full.product, ingredients: full.ing, nutrition: full.nut, selection: { rawLength: full.longRaw, nutritionValueCount: full.values, qualifierCount: full.qualifiers } },
    partial: partial ? { product: partial.product, ingredients: partial.ing, nutrition: partial.nut, selection: { partialList: partial.partialList, missingStandardCount: partial.missingStandard } } : null,
  }
}

async function clickVisible(c, selector, text = null) {
  const metric = await info(c, selector, text)
  assert.ok(metric?.rendered && metric.inViewport && metric.centerHit && !metric.disabled, `visible click target unavailable ${selector} ${text ?? ''}: ${JSON.stringify(metric)}`)
  const [left, top, width, height] = metric.rect
  const x = left + width / 2, y = top + height / 2
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(220)
  return metric
}

async function waitDetailResources(c, productId, mark) {
  const [nutrition, ingredients] = await Promise.all([
    c.waitResponse('compare_product_nutrition', productId, mark),
    c.waitResponse('compare_product_ingredients', productId, mark),
  ])
  await c.wait(`[...document.querySelectorAll('.detail-status-grid strong')].every(n=>!n.textContent.includes('불러오는 중'))`, 'detail status loading complete')
  return { nutrition: nutrition.json[0] ?? null, ingredients: ingredients.json[0] ?? null, responseStatus: { nutrition: nutrition.status, ingredients: ingredients.status } }
}

function numberText(value) { return Number(value).toLocaleString('ko-KR') }
function nutrientText(value, qualifier, unit = '%') {
  if (value == null) return '미확인'
  const suffix = qualifier ? (QUALIFIER[qualifier] ?? ` ${qualifier}`) : ''
  return `${numberText(value)}${unit}${suffix}`
}
function expectedEnergy(row) {
  if (!row) return '미확인'
  if (row.kcal_per_kg != null) return `${numberText(row.kcal_per_kg)} kcal/kg`
  if (row.kcal_per_100g != null) return `${numberText(row.kcal_per_100g)} kcal/100g`
  return '미확인'
}

async function nutritionUI(c) {
  return c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim();return {facts:[...document.querySelectorAll('.detail-nutrition-grid .detail-fact')].map(n=>({label:nrm(n.querySelector('span')?.textContent),value:nrm(n.querySelector('strong')?.textContent),rect:(()=>{const r=n.getBoundingClientRect();return[r.left,r.top,r.width,r.height]})(),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight})),statuses:[...document.querySelectorAll('.detail-nutrition-status dl>div')].map(n=>({label:nrm(n.querySelector('dt')?.textContent),value:nrm(n.querySelector('dd')?.textContent)})),evidence:[...document.querySelectorAll('.detail-evidence-context')].map(n=>nrm(n.textContent)),subheadings:[...document.querySelectorAll('.detail-nutrition-subheading')].map(n=>nrm(n.textContent)),note:nrm(document.querySelector('.detail-note')?.textContent),empty:nrm(document.querySelector('.detail-empty')?.textContent),error:nrm(document.querySelector('.detail-state.is-error')?.textContent),loading:nrm(document.querySelector('.detail-state:not(.is-error)')?.textContent)}})()`)
}
async function ingredientUI(c) {
  return c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim(),boxes=n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return{text:nrm(n.textContent),rect:[r.left,r.top,r.width,r.height],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,overflowX:s.overflowX,overflowY:s.overflowY,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow}};return {evidence:[...document.querySelectorAll('.detail-evidence-context')].map(n=>nrm(n.textContent)),copies:[...document.querySelectorAll('.detail-ingredient-copy')].map(boxes),lists:[...document.querySelectorAll('.detail-ingredient-list')].map(n=>({rect:(()=>{const r=n.getBoundingClientRect();return[r.left,r.top,r.width,r.height]})(),items:[...n.querySelectorAll('span')].map(x=>nrm(x.textContent)),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight})),note:nrm(document.querySelector('.detail-note')?.textContent),empty:nrm(document.querySelector('.detail-empty')?.textContent),error:nrm(document.querySelector('.detail-state.is-error')?.textContent),loading:nrm(document.querySelector('.detail-state:not(.is-error)')?.textContent)}})()`)
}

function validateNutrition(api, ui) {
  const result = { apiPresent: Boolean(api), matched: [], missing: [], nullSemantics: [] }
  if (!api) {
    assert.ok(ui.empty.includes('현재 확인된 영양 정보가 없습니다'), `missing nutrition not explicit: ${ui.empty}`)
    return result
  }
  if (!nutritionValueCount(api)) {
    assert.ok(ui.empty.includes('영양 수치를 확인하지 못했습니다'), `unstructured nutrition not explicit: ${ui.empty}`)
    return result
  }
  const facts = new Map(ui.facts.map((item) => [item.label, item.value]))
  assert.equal(facts.get('열량'), expectedEnergy(api), 'energy API/UI mismatch')
  result.matched.push({ label: '열량', value: facts.get('열량') })
  const statuses = new Map(ui.statuses.map((item) => [item.label, item.value]))
  for (const [label, key, qualifierKey] of NUTRIENTS) {
    if (api[key] != null) {
      const expected = nutrientText(api[key], api[qualifierKey])
      assert.equal(facts.get(label), expected, `${label} API/UI mismatch`)
      result.matched.push({ label, value: expected })
    } else {
      const status = statuses.get(label)
      assert.ok(status, `${label} missing API value has no explicit status`)
      assert.ok(!/(^|\s)0(?:\.0+)?(?:%|\s|$)/.test(status) && !/^없음$/.test(status), `${label} null could be mistaken for zero/none: ${status}`)
      result.nullSemantics.push({ label, status })
    }
  }
  assert.ok(ui.note.includes('추정해 채우지 않습니다') && ui.note.includes('한정자') && ui.note.includes('단위'), 'nutrition preservation note missing')
  for (const item of ui.facts) assert.ok(item.scrollWidth <= item.clientWidth + 1 && item.scrollHeight <= item.clientHeight + 1, `nutrition fact clipped: ${JSON.stringify(item)}`)
  if (api.market_code === 'KR') assert.ok(ui.evidence.some((text) => text.includes('한국 확인')), 'nutrition evidence lost KR market context')
  if (array(api.supplemental_nutrition_fields).length) assert.ok(ui.evidence.some((text) => text.includes('보완')), 'supplemental nutrition context not displayed')
  if (array(api.basis_specific_nutrition_values).some((item) => item?.amount != null)) assert.ok(ui.subheadings.some((text) => text.includes('자료')), 'basis-specific nutrition heading not displayed')
  return result
}

function validateIngredients(api, ui) {
  const result = { apiPresent: Boolean(api), rawMatches: [], normalizedCounts: [], completeness: api?.completeness_status ?? null }
  if (!api) {
    assert.ok(ui.empty.includes('현재 확인된 원재료 목록이 없습니다'), `missing ingredients not explicit: ${ui.empty}`)
    return result
  }
  assert.ok(ui.evidence.length >= 1, 'ingredient evidence context missing')
  if (api.market_code === 'KR') assert.ok(ui.evidence.some((text) => text.includes('한국 확인')), 'ingredient evidence lost KR market context')
  const primaryRaw = String(api.raw_text ?? '').trim()
  if (primaryRaw) {
    assert.equal(ui.copies[0]?.text, norm(primaryRaw), 'primary raw ingredient text mismatch')
    result.rawMatches.push({ kind: 'primary', length: primaryRaw.length })
  }
  const primaryNames = array(api.ingredient_names)
  if (primaryNames.length) {
    assert.equal(ui.lists[0]?.items.length, primaryNames.length, 'primary normalized ingredient count mismatch')
    for (const name of primaryNames) assert.ok(ui.lists[0].items.some((item) => item.includes(name)), `normalized ingredient missing: ${name}`)
    result.normalizedCounts.push({ kind: 'primary', count: primaryNames.length })
  }
  const supplementalRaw = String(api.supplemental_full_raw_text ?? '').trim()
  const supplementalNames = array(api.supplemental_full_ingredient_names)
  if (supplementalRaw || supplementalNames.length) {
    const copyIndex = primaryRaw || primaryNames.length ? 1 : 0
    if (supplementalRaw) {
      assert.equal(ui.copies[copyIndex]?.text, norm(supplementalRaw), 'supplemental raw ingredient text mismatch')
      result.rawMatches.push({ kind: 'supplemental', length: supplementalRaw.length })
    }
    const listIndex = primaryNames.length ? 1 : 0
    if (supplementalNames.length) {
      assert.equal(ui.lists[listIndex]?.items.length, supplementalNames.length, 'supplemental normalized ingredient count mismatch')
      result.normalizedCounts.push({ kind: 'supplemental', count: supplementalNames.length })
    }
    assert.ok(ui.evidence.some((text) => text.includes('전체 목록')), 'supplemental full-list evidence not displayed')
  }
  if (api.completeness_status === 'partial') assert.ok(ui.evidence.some((text) => text.includes('일부 목록')), 'partial-list label missing')
  if (api.completeness_status === 'summary') assert.ok(ui.evidence.some((text) => text.includes('요약 정보')), 'summary-list label missing')
  assert.ok(ui.note.includes('표시되지 않은 원료가 들어 있지 않다는 뜻은 아닙니다'), 'partial-list caution note missing')
  for (const copy of ui.copies) assert.ok(copy.scrollWidth <= copy.clientWidth + 1 && !(copy.scrollHeight > copy.clientHeight + 1 && ['hidden', 'clip'].includes(copy.overflowY)), `ingredient raw text clipped: ${JSON.stringify(copy)}`)
  for (const list of ui.lists) assert.ok(list.scrollWidth <= list.clientWidth + 1, `ingredient normalized list horizontally clipped: ${JSON.stringify(list)}`)
  return result
}

async function activeMetrics(c, tab) {
  return c.eval(`(()=>{const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,overflowX:s.overflowX,overflowY:s.overflowY,position:s.position,zIndex:s.zIndex}},top=rect(document.querySelector('.detail-topbar')),tabs=rect(document.querySelector('.detail-tabs')),section=rect(document.querySelector('.detail-body>.detail-section')),heading=rect(document.querySelector('.detail-body>.detail-section .detail-section-heading')),note=rect(document.querySelector('.detail-body>.detail-section .detail-note')),blocks=[...document.querySelectorAll('.detail-body>.detail-section .detail-evidence-context,.detail-body>.detail-section .detail-nutrition-grid,.detail-body>.detail-section .detail-nutrition-status,.detail-body>.detail-section .detail-ingredient-copy,.detail-body>.detail-section .detail-ingredient-list,.detail-body>.detail-section .detail-note,.detail-body>.detail-section .detail-empty')].map(n=>({className:n.className,...rect(n)})),stickyBottom=tabs?.rect?.[5]??0;return{tab:${js(tab)},scrollY,viewport:[innerWidth,innerHeight],document:{clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth},topbar:top,tabs,section,heading,note,blocks,stickyBottom,headingOccluded:Boolean(heading&&(heading.rect[1]<stickyBottom&&heading.rect[5]>0)),horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1}})()`)
}

async function capturePositions(c, prefix, tab) {
  const geometry = await c.eval(`(()=>{const section=document.querySelector('.detail-body>.detail-section'),top=document.querySelector('.detail-topbar')?.getBoundingClientRect(),tabs=document.querySelector('.detail-tabs')?.getBoundingClientRect();if(!section)return null;const r=section.getBoundingClientRect(),sticky=(tabs?.bottom??((top?.height??0)+(tabs?.height??0))),docTop=r.top+scrollY,docBottom=r.bottom+scrollY,max=Math.max(0,document.documentElement.scrollHeight-innerHeight),start=Math.max(0,Math.min(max,docTop-sticky-8)),end=Math.max(start,Math.min(max,docBottom-innerHeight+24));return{start,mid:(start+end)/2,end,max,sticky}})()`)
  assert.ok(geometry, `missing active section ${tab}`)
  const result = { targets: geometry, captures: {} }
  for (const [position, target] of [['top', geometry.start], ['mid', geometry.mid], ['bottom', geometry.end]]) {
    await wheelTo(c, target)
    await sleep(120)
    const metric = await activeMetrics(c, tab)
    const file = `${prefix}-${tab}-${position}.png`
    await c.shot(`${OUT}/${file}`)
    result.captures[position] = { file, metric }
  }
  return result
}

async function runProduct(c, viewport, candidate, kind) {
  const { product } = candidate
  const prefix = `${viewport.width}x${viewport.height}-${kind}-${product.product_id}`
  const lookupUrl = `${PROD}?view=workspace&mode=lookup`
  await c.nav(lookupUrl)
  await c.wait(`document.querySelector('.lookup-input')`, 'lookup input rendered')
  await typeInput(c, '.lookup-input', product.canonical_name)
  await c.wait(`document.querySelector('.research-result-card[data-product-id=${js(product.product_id)}])`, `lookup result ${product.product_id}`)
  const cardMetric = await pointer(c, `.research-result-card[data-product-id=${js(product.product_id)}]`)
  await c.wait(`document.querySelector('.research-quick-view')`, 'quick view')
  const quickView = await c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim();return{title:nrm(document.querySelector('.quick-view-identity h1')?.textContent),brand:nrm(document.querySelector('.quick-view-identity>div span')?.textContent),url:location.href,scrollY}})()`)
  assert.equal(quickView.title, product.canonical_name, 'quick-view product mismatch')
  const detailMark = c.responseMark()
  await pointer(c, '.quick-view-actions button', '상세 보기')
  await c.wait(`document.querySelector('.detail-stage')`, 'detail stage')
  const openedUrl = await c.eval('location.href')
  assert.equal(new URL(openedUrl).searchParams.get('detail'), product.product_id, 'detail URL product mismatch')
  const api = await waitDetailResources(c, product.product_id, detailMark)
  await wheelTo(c, 0)
  await sleep(120)
  const detailIdentity = await c.eval(`(()=>({name:document.querySelector('.detail-identity h1')?.textContent?.trim(),url:location.href,scrollY}))()`)
  assert.equal(detailIdentity.name, product.canonical_name, 'detail identity mismatch')

  await pointer(c, '#detail-tab-nutrition')
  await c.wait(`document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'nutrition tab active')
  await sleep(150)
  const nutritionState = await nutritionUI(c)
  const nutritionMatch = validateNutrition(api.nutrition, nutritionState)
  const nutritionPositions = await capturePositions(c, prefix, 'nutrition')

  const transitionBefore = await activeMetrics(c, 'nutrition')
  const tabBeforeScrollY = await c.eval('scrollY')
  await clickVisible(c, '#detail-tab-ingredients')
  await c.wait(`document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'ingredients tab active')
  await sleep(160)
  const transitionAfter = await activeMetrics(c, 'ingredients')
  const transitionFile = `${prefix}-transition-nutrition-to-ingredients.png`
  await c.shot(`${OUT}/${transitionFile}`)
  const tabTransition = {
    file: transitionFile,
    beforeScrollY: tabBeforeScrollY,
    afterScrollY: transitionAfter.scrollY,
    headingRect: transitionAfter.heading?.rect ?? null,
    stickyBottom: transitionAfter.stickyBottom,
    startMissed: Boolean(transitionAfter.heading && (transitionAfter.heading.rect[5] <= transitionAfter.stickyBottom || transitionAfter.heading.rect[1] >= viewport.height || transitionAfter.heading.rect[1] < transitionAfter.stickyBottom)),
    before: transitionBefore,
    after: transitionAfter,
  }

  const ingredientsState = await ingredientUI(c)
  const ingredientsMatch = validateIngredients(api.ingredients, ingredientsState)
  const ingredientsPositions = await capturePositions(c, prefix, 'ingredients')
  const bottomMetric = ingredientsPositions.captures.bottom.metric
  const backMetric = await clickVisible(c, '.detail-topbar > button', '돌아가기')
  await c.wait(`!document.querySelector('.detail-stage')&&document.querySelector('.research-quick-view')`, 'return to quick view parent')
  const returned = await c.eval(`(()=>({url:location.href,selected:new URLSearchParams(location.search).get('selected'),q:new URLSearchParams(location.search).get('q'),quickView:document.querySelector('.quick-view-identity h1')?.textContent?.trim(),scrollY}))()`)
  assert.equal(returned.selected, product.product_id, 'return lost selected product')
  assert.equal(returned.quickView, product.canonical_name, 'return quick view mismatch')

  const findings = []
  if (tabTransition.startMissed) findings.push({ severity: 'review', type: 'tab_switch_position', message: '영양 탭 하단에서 원재료 탭으로 전환하면 기존 문서 scroll 위치가 유지되어 새 탭 시작 부분을 놓칩니다.', transition: tabTransition })
  for (const [tab, positions] of [['nutrition', nutritionPositions], ['ingredients', ingredientsPositions]]) {
    for (const [position, capture] of Object.entries(positions.captures)) {
      const m = capture.metric
      if (m.horizontalOverflow) findings.push({ severity: 'review', type: 'horizontal_overflow', tab, position, message: '문서 폭이 viewport를 초과합니다.', metric: m })
      const clipped = m.blocks.filter((block) => block.scrollWidth > block.clientWidth + 1 || (block.scrollHeight > block.clientHeight + 1 && ['hidden', 'clip'].includes(block.overflowY)))
      if (clipped.length) findings.push({ severity: 'review', type: 'content_clipping', tab, position, blocks: clipped })
    }
  }
  if (api.ingredients?.completeness_status === 'partial' && !ingredientsState.evidence.some((text) => text.includes('일부 목록'))) findings.push({ severity: 'high', type: 'partial_label_missing' })

  return {
    kind,
    product: { product_id: product.product_id, brand: product.brand, canonical_name: product.canonical_name, feed_type: product.feed_type, life_stage: product.life_stage },
    entry: { lookupUrl, cardMetric, quickView, detailIdentity, openedUrl },
    api,
    displayedBasis: { nutritionEvidence: nutritionState.evidence, nutritionSubheadings: nutritionState.subheadings, ingredientEvidence: ingredientsState.evidence },
    nutrition: { state: nutritionState, match: nutritionMatch, positions: nutritionPositions },
    ingredients: { state: ingredientsState, match: ingredientsMatch, positions: ingredientsPositions },
    tabTransition,
    returnToParent: { backMetric, returned, bottomBeforeBack: bottomMetric },
    findings,
  }
}

const report = { targetSha: TARGET_SHA, pagesUrl: PROD, status: 'running', discovery: null, browsers: {}, findings: [], unverified: ['외부 제조사 자료와의 데이터 정확성 대조', '물리 모바일 기기', '스크린리더', '기존 전체 회귀 QA'] }
let discoveryBrowser = null
try {
  discoveryBrowser = await launch(360, 844)
  report.browsers['360x844'] = { chrome: discoveryBrowser.version }
  report.discovery = await discoverCandidates(discoveryBrowser.c)
  cleanup(discoveryBrowser.proc, discoveryBrowser.dir, discoveryBrowser.c)
  discoveryBrowser = null

  for (const viewport of [{ width: 360, height: 844 }, { width: 390, height: 900 }]) {
    const key = `${viewport.width}x${viewport.height}`
    const browser = await launch(viewport.width, viewport.height)
    report.browsers[key] = { ...(report.browsers[key] ?? {}), chrome: browser.version, cases: {} }
    try {
      const cases = [{ kind: 'full', candidate: report.discovery.full }]
      if (report.discovery.partial) cases.push({ kind: 'partial', candidate: report.discovery.partial })
      for (const item of cases) {
        const result = await runProduct(browser.c, viewport, item.candidate, item.kind)
        report.browsers[key].cases[item.kind] = result
        report.findings.push(...result.findings.map((finding) => ({ viewport: key, product_id: result.product.product_id, ...finding })))
      }
      report.browsers[key].fonts = await browser.c.fonts('.detail-stage')
      report.browsers[key].network = await network(browser.c)
      assert.deepEqual(report.browsers[key].network.sentAnalytics, [], `${key} analytics sent`)
      assert.deepEqual(report.browsers[key].network.sentWrites, [], `${key} production writes sent`)
    } finally {
      cleanup(browser.proc, browser.dir, browser.c)
    }
  }
  if (!report.discovery.partial) report.findings.push({ severity: 'info', type: 'partial_case_unavailable', message: '공개 catalog/API에서 부분 목록 또는 명시적 미확인 사례를 확보하지 못했습니다.' })
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, full: report.discovery.full.product, partial: report.discovery.partial?.product ?? null, findings: report.findings.map(({ viewport, product_id, severity, type, message }) => ({ viewport, product_id, severity, type, message })) }, null, 2))
} catch (error) {
  if (discoveryBrowser) cleanup(discoveryBrowser.proc, discoveryBrowser.dir, discoveryBrowser.c)
  report.status = 'fail'
  report.error = String(error?.stack ?? error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}
