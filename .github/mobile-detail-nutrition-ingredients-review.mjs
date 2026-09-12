import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cleanup, info, js, launch, network, norm, pointer, sleep } from './mobile-detail-review-helpers.mjs'

const PROD = 'https://osrm.github.io/catfood_web/'
const TARGET_SHA = 'd7080165e1bffe4cbe93eb69f3dc2f85d90c42ae'
const OUT = 'qa-artifacts/mobile-detail-review'
const FULL = process.env.QA_FULL === '1'
const PRODUCTS = [
  { kind: 'full', productId: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리', expectedBrand: 'GO! SOLUTIONS' },
  { kind: 'partial', productId: 'product_11dc2e0bf60b0874', query: '몬지 비와일드 그레인프리 어덜트 연어', expectedBrand: '몬지' },
]
const VIEWPORTS = [{ width: 360, height: 844 }, { width: 390, height: 900 }]
const QUALIFIER = { min: ' 이상', max: ' 이하', typical: ' 평균값', reported: '', exact: '' }
const NUTRIENTS = [
  ['조단백질', 'protein_pct', 'protein_qualifier'],
  ['조지방', 'fat_pct', 'fat_qualifier'],
  ['조섬유', 'fiber_pct', 'fiber_qualifier'],
  ['수분', 'moisture_pct', 'moisture_qualifier'],
  ['조회분', 'ash_pct', 'ash_qualifier'],
]
mkdirSync(OUT, { recursive: true })

function array(value) { return Array.isArray(value) ? value : [] }
function numberText(value) { return Number(value).toLocaleString('ko-KR') }
function nutrientText(value, qualifier, unit = '%') {
  if (value == null) return '미확인'
  const suffix = qualifier ? (QUALIFIER[qualifier] ?? ` ${qualifier}`) : ''
  return `${numberText(value)}${unit}${suffix}`
}
function energyText(row) {
  if (!row) return '미확인'
  if (row.kcal_per_kg != null) return `${numberText(row.kcal_per_kg)} kcal/kg`
  if (row.kcal_per_100g != null) return `${numberText(row.kcal_per_100g)} kcal/100g`
  return '미확인'
}
function safeName(value) { return value.replace(/[^a-zA-Z0-9가-힣_-]+/g, '_').slice(0, 90) }
function addFinding(report, severity, code, details) { report.findings.push({ severity, code, details }) }

async function waitChecked(c, expression, label, ms = 60000) {
  const end = Date.now() + ms
  let firstException = null
  while (Date.now() < end) {
    try {
      if (await c.eval(`Boolean(${expression})`)) return { firstException }
    } catch (error) {
      firstException ??= String(error?.stack || error)
      throw new Error(`CDP evaluation failed while waiting for ${label}: ${firstException}`)
    }
    await sleep(120)
  }
  throw new Error(`timeout ${label}${firstException ? `; first evaluation exception: ${firstException}` : ''}`)
}

async function failureSnapshot(c, prefix, selector, error) {
  const state = await c.eval(`(()=>({url:location.href,input:document.querySelector('.lookup-input')?.value??null,cardCount:document.querySelectorAll('.research-result-card').length,exactCardCount:${selector ? `document.querySelectorAll(${js(selector)}).length` : 'null'},viewport:[innerWidth,innerHeight],bodyText:(document.body.innerText||'').slice(0,2400)}))()`).catch((evalError) => ({ evaluationFailure: String(evalError) }))
  const jsonFile = `${OUT}/${prefix}-failure.json`
  const pngFile = `${OUT}/${prefix}-failure.png`
  writeFileSync(jsonFile, JSON.stringify({ error: String(error?.stack || error), state }, null, 2))
  try { await c.shot(pngFile) } catch {}
  return { jsonFile, pngFile, state }
}

async function waitDetailResources(c, productId, mark) {
  const [nutrition, ingredients] = await Promise.all([
    c.waitResponse('compare_product_nutrition', productId, mark),
    c.waitResponse('compare_product_ingredients', productId, mark),
  ])
  await waitChecked(c, `[...document.querySelectorAll('.detail-state')].every(n=>!n.textContent.includes('불러오는 중'))`, 'detail resource loading complete')
  return {
    nutrition: nutrition.json[0] ?? null,
    ingredients: ingredients.json[0] ?? null,
    responseStatus: { nutrition: nutrition.status, ingredients: ingredients.status },
  }
}

async function nutritionUI(c) {
  return c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim(),box=n=>{const r=n.getBoundingClientRect();return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,text:nrm(n.textContent)}};return{facts:[...document.querySelectorAll('.detail-nutrition-grid .detail-fact')].map(n=>({label:nrm(n.querySelector('span')?.textContent),value:nrm(n.querySelector('strong')?.textContent),...box(n)})),statuses:[...document.querySelectorAll('.detail-nutrition-status dl>div')].map(n=>({label:nrm(n.querySelector('dt')?.textContent),value:nrm(n.querySelector('dd')?.textContent)})),evidence:[...document.querySelectorAll('.detail-evidence-context')].map(n=>nrm(n.textContent)),subheadings:[...document.querySelectorAll('.detail-nutrition-subheading')].map(n=>nrm(n.textContent)),note:nrm(document.querySelector('.detail-note')?.textContent),empty:nrm(document.querySelector('.detail-empty')?.textContent),errors:[...document.querySelectorAll('.detail-state.is-error')].map(n=>nrm(n.textContent)),loading:[...document.querySelectorAll('.detail-state')].filter(n=>n.textContent.includes('불러오는 중')).map(n=>nrm(n.textContent))}})()`)
}

async function ingredientUI(c) {
  return c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim(),box=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,overflowX:s.overflowX,overflowY:s.overflowY,whiteSpace:s.whiteSpace,text:nrm(n.textContent)}};return{evidence:[...document.querySelectorAll('.detail-evidence-context')].map(n=>nrm(n.textContent)),copies:[...document.querySelectorAll('.detail-ingredient-copy')].map(box),lists:[...document.querySelectorAll('.detail-ingredient-list')].map(n=>({...box(n),items:[...n.querySelectorAll('span')].map(x=>nrm(x.textContent))})),note:nrm(document.querySelector('.detail-note')?.textContent),empty:nrm(document.querySelector('.detail-empty')?.textContent),errors:[...document.querySelectorAll('.detail-state.is-error')].map(n=>nrm(n.textContent)),loading:[...document.querySelectorAll('.detail-state')].filter(n=>n.textContent.includes('불러오는 중')).map(n=>nrm(n.textContent))}})()`)
}

function reviewNutrition(api, ui, report) {
  const checks = { matched: [], unknowns: [], clipping: [], evidence: ui.evidence, subheadings: ui.subheadings, note: ui.note }
  if (!api) {
    if (!ui.empty.includes('현재 확인된 영양 정보가 없습니다')) addFinding(report, 'high', 'nutrition_missing_state_ambiguous', { empty: ui.empty })
    return checks
  }
  const facts = new Map(ui.facts.map((item) => [item.label, item.value]))
  const statuses = new Map(ui.statuses.map((item) => [item.label, item.value]))
  const expectedEnergy = energyText(api)
  if (facts.get('열량') !== expectedEnergy) addFinding(report, 'high', 'energy_api_ui_mismatch', { api: expectedEnergy, ui: facts.get('열량') })
  else checks.matched.push({ label: '열량', value: expectedEnergy })
  if (expectedEnergy === '미확인') {
    const displayed = facts.get('열량') ?? ''
    if (/^0(?:\.0+)?(?:\s|kcal|$)/.test(displayed) || displayed === '없음') addFinding(report, 'high', 'unknown_energy_looks_like_zero_or_none', { displayed })
    checks.unknowns.push({ label: '열량', displayed })
  }
  for (const [label, key, qualifierKey] of NUTRIENTS) {
    if (api[key] != null) {
      const expected = nutrientText(api[key], api[qualifierKey])
      if (facts.get(label) !== expected) addFinding(report, 'high', 'nutrition_value_api_ui_mismatch', { label, api: expected, ui: facts.get(label) })
      else checks.matched.push({ label, value: expected })
    } else {
      const displayed = statuses.get(label) ?? facts.get(label) ?? ''
      if (!displayed || /^0(?:\.0+)?%?$/.test(displayed) || displayed === '없음') addFinding(report, 'high', 'unknown_nutrient_ambiguous', { label, displayed })
      checks.unknowns.push({ label, displayed })
    }
  }
  if (!ui.note.includes('추정해 채우지 않습니다') || !ui.note.includes('한정자') || !ui.note.includes('단위')) addFinding(report, 'medium', 'nutrition_preservation_note_missing', { note: ui.note })
  if (api.market_code === 'KR' && !ui.evidence.some((text) => text.includes('한국 확인'))) addFinding(report, 'medium', 'nutrition_market_context_missing', { evidence: ui.evidence })
  if (array(api.supplemental_nutrition_fields).length && !ui.evidence.some((text) => text.includes('보완'))) addFinding(report, 'medium', 'supplemental_nutrition_context_missing', { fields: api.supplemental_nutrition_fields, evidence: ui.evidence })
  if (array(api.basis_specific_nutrition_values).some((item) => item?.amount != null) && !ui.subheadings.some((text) => text.includes('자료'))) addFinding(report, 'medium', 'basis_specific_heading_missing', { basis: api.basis_specific_nutrition_basis, headings: ui.subheadings })
  for (const item of ui.facts) {
    const clipped = item.scrollWidth > item.clientWidth + 1 || item.scrollHeight > item.clientHeight + 1
    checks.clipping.push({ label: item.label, clipped, clientWidth: item.clientWidth, scrollWidth: item.scrollWidth, clientHeight: item.clientHeight, scrollHeight: item.scrollHeight })
    if (clipped) addFinding(report, 'medium', 'nutrition_fact_clipped', { label: item.label, item })
  }
  return checks
}

function reviewIngredients(api, ui, report) {
  const checks = { rawMatches: [], normalizedCounts: [], evidence: ui.evidence, completeness: api?.completeness_status ?? null, note: ui.note, clipping: [] }
  if (!api) {
    if (!ui.empty.includes('현재 확인된 원재료 목록이 없습니다')) addFinding(report, 'high', 'ingredients_missing_state_ambiguous', { empty: ui.empty })
    return checks
  }
  if (!ui.evidence.length) addFinding(report, 'medium', 'ingredient_evidence_context_missing', {})
  if (api.market_code === 'KR' && !ui.evidence.some((text) => text.includes('한국 확인'))) addFinding(report, 'medium', 'ingredient_market_context_missing', { evidence: ui.evidence })
  const primaryRaw = norm(api.raw_text)
  const primaryNames = array(api.ingredient_names)
  if (primaryRaw) {
    const matched = ui.copies.some((copy) => copy.text === primaryRaw)
    checks.rawMatches.push({ kind: 'primary', expectedLength: primaryRaw.length, matched })
    if (!matched) addFinding(report, 'high', 'primary_ingredient_raw_api_ui_mismatch', { expectedLength: primaryRaw.length, copyLengths: ui.copies.map((copy) => copy.text.length) })
  }
  if (primaryNames.length) {
    const firstList = ui.lists[0]?.items ?? []
    checks.normalizedCounts.push({ kind: 'primary', api: primaryNames.length, ui: firstList.length })
    if (firstList.length !== primaryNames.length) addFinding(report, 'high', 'normalized_ingredient_count_mismatch', { api: primaryNames.length, ui: firstList.length })
  }
  const supplementalRaw = norm(api.supplemental_full_raw_text)
  const supplementalNames = array(api.supplemental_full_ingredient_names)
  if (supplementalRaw) {
    const matched = ui.copies.some((copy) => copy.text === supplementalRaw)
    checks.rawMatches.push({ kind: 'supplemental', expectedLength: supplementalRaw.length, matched })
    if (!matched) addFinding(report, 'high', 'supplemental_ingredient_raw_api_ui_mismatch', { expectedLength: supplementalRaw.length })
  }
  if (supplementalNames.length) {
    const list = ui.lists.at(-1)?.items ?? []
    checks.normalizedCounts.push({ kind: 'supplemental', api: supplementalNames.length, ui: list.length })
    if (list.length !== supplementalNames.length) addFinding(report, 'high', 'supplemental_normalized_count_mismatch', { api: supplementalNames.length, ui: list.length })
  }
  if ((primaryRaw || supplementalRaw) && primaryNames.length && !(ui.copies.length && ui.lists.length)) addFinding(report, 'medium', 'raw_and_normalized_not_visually_separated', { copies: ui.copies.length, lists: ui.lists.length })
  if (api.completeness_status === 'partial' && !ui.evidence.some((text) => text.includes('일부 목록'))) addFinding(report, 'high', 'partial_list_label_missing', { evidence: ui.evidence })
  if (api.completeness_status === 'partial' && !ui.note.includes('들어 있지 않다는 뜻은 아닙니다')) addFinding(report, 'high', 'partial_list_caution_missing', { note: ui.note })
  for (const copy of ui.copies) {
    const clipped = copy.scrollWidth > copy.clientWidth + 1 || copy.scrollHeight > copy.clientHeight + 1
    checks.clipping.push({ kind: 'raw', clipped, clientWidth: copy.clientWidth, scrollWidth: copy.scrollWidth, clientHeight: copy.clientHeight, scrollHeight: copy.scrollHeight, whiteSpace: copy.whiteSpace })
    if (clipped) addFinding(report, 'medium', 'ingredient_raw_clipped', { copy })
  }
  for (const list of ui.lists) {
    const clipped = list.scrollWidth > list.clientWidth + 1 || list.scrollHeight > list.clientHeight + 1
    checks.clipping.push({ kind: 'normalized', clipped, clientWidth: list.clientWidth, scrollWidth: list.scrollWidth, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight })
    if (clipped) addFinding(report, 'medium', 'ingredient_list_clipped', { list })
  }
  return checks
}

async function detectScrollOwner(c) {
  const candidates = await c.eval(`(()=>{const section=document.querySelector('.detail-body>.detail-section');if(!section)return [];const out=[];let n=section;while(n){const s=getComputedStyle(n),r=n.getBoundingClientRect();out.push({tag:n.tagName,className:n.className||'',id:n.id||'',overflowY:s.overflowY,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,scrollTop:n.scrollTop,rect:[r.left,r.top,r.width,r.height,r.right,r.bottom]});n=n.parentElement}const d=document.scrollingElement,s=getComputedStyle(d),r=d.getBoundingClientRect();out.push({tag:'DOCUMENT',className:d.className||'',id:d.id||'',overflowY:s.overflowY,clientHeight:d.clientHeight,scrollHeight:d.scrollHeight,scrollTop:d.scrollTop,rect:[r.left,r.top,r.width,r.height,r.right,r.bottom]});return out})()`)
  const eligible = candidates.find((item) => item.tag !== 'DOCUMENT' && item.scrollHeight > item.clientHeight + 2 && /(auto|scroll|overlay)/.test(item.overflowY))
  if (!eligible) throw new Error(`no internal detail scroll owner found: ${JSON.stringify(candidates)}`)
  const marked = await c.eval(`(()=>{const section=document.querySelector('.detail-body>.detail-section');let n=section;while(n){const s=getComputedStyle(n);if(n.scrollHeight>n.clientHeight+2&&/(auto|scroll|overlay)/.test(s.overflowY)){document.querySelectorAll('[data-qa-scroll-owner]').forEach(x=>x.removeAttribute('data-qa-scroll-owner'));n.setAttribute('data-qa-scroll-owner','true');return true}n=n.parentElement}return false})()`)
  assert.equal(marked, true, 'failed to mark detail scroll owner')
  await c.eval(`document.querySelector('[data-qa-scroll-owner]').scrollTop=0`)
  const before = await c.eval(`document.querySelector('[data-qa-scroll-owner]').scrollTop`)
  const ownerRect = await c.eval(`(()=>{const n=document.querySelector('[data-qa-scroll-owner]'),r=n.getBoundingClientRect();return[r.left,r.top,r.width,r.height]})()`)
  const x = Math.max(1, Math.min(ownerRect[0] + ownerRect[2] / 2, (await c.eval('innerWidth')) - 2))
  const y = Math.max(120, Math.min(ownerRect[1] + ownerRect[3] * 0.7, (await c.eval('innerHeight')) - 2))
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 420 })
  await sleep(180)
  const after = await c.eval(`document.querySelector('[data-qa-scroll-owner]').scrollTop`)
  if (!(after > before)) throw new Error(`wheel did not move detected scroll owner: before=${before}, after=${after}, candidates=${JSON.stringify(candidates)}`)
  await c.eval(`document.querySelector('[data-qa-scroll-owner]').scrollTop=0`)
  return { candidates, detected: eligible, wheelProbe: { before, after, delta: after - before, x, y } }
}

async function scrollOwnerTo(c, target) {
  let stagnant = 0
  for (let index = 0; index < 60; index++) {
    const state = await c.eval(`(()=>{const n=document.querySelector('[data-qa-scroll-owner]'),r=n.getBoundingClientRect();return{scrollTop:n.scrollTop,max:Math.max(0,n.scrollHeight-n.clientHeight),rect:[r.left,r.top,r.width,r.height]}})()`)
    const wanted = Math.max(0, Math.min(Number(target), Number(state.max)))
    const delta = wanted - state.scrollTop
    if (Math.abs(delta) <= 4) return { ...state, target: wanted, achieved: state.scrollTop }
    const x = Math.max(2, Math.min(state.rect[0] + state.rect[2] / 2, (await c.eval('innerWidth')) - 2))
    const y = Math.max(130, Math.min(state.rect[1] + state.rect[3] * 0.72, (await c.eval('innerHeight')) - 2))
    const before = state.scrollTop
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Math.sign(delta) * Math.min(620, Math.abs(delta)) })
    await sleep(110)
    const now = await c.eval(`document.querySelector('[data-qa-scroll-owner]').scrollTop`)
    stagnant = Math.abs(now - before) < 1 ? stagnant + 1 : 0
    if (stagnant >= 3) throw new Error(`scroll owner stopped before target ${wanted}: current=${now}, max=${state.max}`)
  }
  throw new Error(`scroll owner did not reach target ${target}`)
}

async function activeMetrics(c, tab) {
  return c.eval(`(()=>{const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,scrollTop:n.scrollTop,overflowX:s.overflowX,overflowY:s.overflowY,position:s.position,zIndex:s.zIndex}},owner=rect(document.querySelector('[data-qa-scroll-owner]')),top=rect(document.querySelector('.detail-topbar')),tabs=rect(document.querySelector('.detail-tabs')),section=rect(document.querySelector('.detail-body>.detail-section')),heading=rect(document.querySelector('.detail-body>.detail-section .detail-section-heading')),blocks=[...document.querySelectorAll('.detail-body>.detail-section .detail-evidence-context,.detail-body>.detail-section .detail-nutrition-grid,.detail-body>.detail-section .detail-nutrition-status,.detail-body>.detail-section .detail-ingredient-copy,.detail-body>.detail-section .detail-ingredient-list,.detail-body>.detail-section .detail-note,.detail-body>.detail-section .detail-empty')].map(n=>({className:n.className,...rect(n)})),last=blocks.at(-1)??null,stickyBottom=tabs?.rect?.[5]??0;return{tab:${js(tab)},windowScrollY:scrollY,owner,topbar:top,tabs,section,heading,blocks,last,stickyBottom,headingOccluded:Boolean(heading&&(heading.rect[1]<stickyBottom&&heading.rect[5]>0)),lastVisible:Boolean(last&&owner&&last.rect[5]>Math.max(stickyBottom,owner.rect[1])&&last.rect[1]<owner.rect[5]),horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,viewport:[innerWidth,innerHeight]}})()`)
}

async function capturePositions(c, prefix, tab, report) {
  const geometry = await c.eval(`(()=>{const owner=document.querySelector('[data-qa-scroll-owner]'),section=document.querySelector('.detail-body>.detail-section'),tabs=document.querySelector('.detail-tabs');if(!owner||!section)return null;const or=owner.getBoundingClientRect(),sr=section.getBoundingClientRect(),tr=tabs?.getBoundingClientRect(),sectionTop=owner.scrollTop+(sr.top-or.top),overlay=Math.max(0,(tr?.bottom??or.top)-or.top),max=Math.max(0,owner.scrollHeight-owner.clientHeight),start=Math.max(0,Math.min(max,sectionTop-overlay-8));return{start,mid:(start+max)/2,bottom:max,max,overlay,sectionTop,ownerClientHeight:owner.clientHeight,ownerScrollHeight:owner.scrollHeight}})()`)
  assert.ok(geometry, `missing active section ${tab}`)
  const result = { targets: geometry, captures: {} }
  let previous = null
  for (const [position, target] of [['top', geometry.start], ['mid', geometry.mid], ['bottom', geometry.bottom]]) {
    const scroll = await scrollOwnerTo(c, target)
    const metric = await activeMetrics(c, tab)
    const file = `${OUT}/${prefix}-${tab}-${position}.png`
    await c.shot(file)
    result.captures[position] = { file, scroll, metric }
    if (previous != null && geometry.max > 40 && Math.abs(scroll.achieved - previous) < 4) addFinding(report, 'medium', 'capture_positions_not_distinct', { tab, position, previous, achieved: scroll.achieved, geometry })
    previous = scroll.achieved
  }
  const top = result.captures.top.metric
  const bottom = result.captures.bottom.metric
  if (top.headingOccluded) addFinding(report, 'medium', 'sticky_header_occludes_tab_start', { tab, heading: top.heading, stickyBottom: top.stickyBottom })
  if (!bottom.lastVisible) addFinding(report, 'high', 'last_tab_content_not_reached_at_bottom', { tab, last: bottom.last, owner: bottom.owner, stickyBottom: bottom.stickyBottom })
  if (bottom.horizontalOverflow) addFinding(report, 'medium', 'detail_horizontal_overflow', { tab, viewport: bottom.viewport })
  return result
}

async function runProduct(c, viewport, product, report) {
  const prefix = `${viewport.width}x${viewport.height}-${product.kind}-${product.productId}`
  const selector = `.research-result-card[data-product-id="${product.productId}"]`
  try {
    const lookupUrl = `${PROD}?view=workspace&mode=lookup&q=${encodeURIComponent(product.query)}`
    await c.nav(lookupUrl)
    await waitChecked(c, `document.querySelector('.lookup-input')`, 'lookup input rendered')
    await waitChecked(c, `document.querySelector('.lookup-input')?.value===${js(product.query)}`, 'q parameter reflected in lookup input')
    await waitChecked(c, `document.querySelector(${js(selector)})`, `lookup result ${product.productId}`)
    const lookupState = await c.eval(`(()=>({url:location.href,input:document.querySelector('.lookup-input')?.value??null,cardCount:document.querySelectorAll('.research-result-card').length,exactCardCount:document.querySelectorAll(${js(selector)}).length}))()`)
    const cardMetric = await pointer(c, selector)
    await waitChecked(c, `document.querySelector('.research-quick-view')`, 'quick view')
    const quickView = await c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim();return{title:nrm(document.querySelector('.quick-view-identity h1')?.textContent),brand:nrm(document.querySelector('.quick-view-identity>div span')?.textContent),url:location.href}})()`)
    if (quickView.brand !== product.expectedBrand) addFinding(report, 'medium', 'quick_view_brand_unexpected', { expected: product.expectedBrand, actual: quickView.brand })
    const detailMark = c.responseMark()
    await pointer(c, '.quick-view-actions button', '상세 보기')
    await waitChecked(c, `document.querySelector('.detail-stage')`, 'detail stage')
    const api = await waitDetailResources(c, product.productId, detailMark)
    const scrollOwner = await detectScrollOwner(c)
    const fonts = await c.fonts('.detail-stage')

    await pointer(c, '#detail-tab-nutrition')
    await waitChecked(c, `document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected')==='true'`, 'nutrition tab active')
    const nutritionState = await nutritionUI(c)
    if (nutritionState.loading.length) throw new Error(`nutrition still loading: ${JSON.stringify(nutritionState.loading)}`)
    if (nutritionState.errors.length) addFinding(report, 'high', 'nutrition_ui_load_error', { errors: nutritionState.errors, responseStatus: api.responseStatus.nutrition })
    const nutritionReview = reviewNutrition(api.nutrition, nutritionState, report)
    const nutritionPositions = await capturePositions(c, prefix, 'nutrition', report)

    const beforeSwitch = await activeMetrics(c, 'nutrition')
    const scrollTopBeforeSwitch = beforeSwitch.owner?.scrollTop ?? null
    await pointer(c, '#detail-tab-ingredients')
    await waitChecked(c, `document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected')==='true'`, 'ingredients tab active')
    await sleep(180)
    const afterSwitch = await activeMetrics(c, 'ingredients')
    const scrollTopAfterSwitch = afterSwitch.owner?.scrollTop ?? null
    const switchStartMissed = Boolean(afterSwitch.heading && afterSwitch.heading.rect[5] <= afterSwitch.stickyBottom)
    if (switchStartMissed) addFinding(report, 'medium', 'tab_switch_lands_past_content_start', { from: 'nutrition-bottom', to: 'ingredients', scrollTopBeforeSwitch, scrollTopAfterSwitch, heading: afterSwitch.heading, stickyBottom: afterSwitch.stickyBottom })
    const transitionFile = `${OUT}/${prefix}-nutrition-to-ingredients-transition.png`
    await c.shot(transitionFile)

    const ingredientsState = await ingredientUI(c)
    if (ingredientsState.loading.length) throw new Error(`ingredients still loading: ${JSON.stringify(ingredientsState.loading)}`)
    if (ingredientsState.errors.length) addFinding(report, 'high', 'ingredients_ui_load_error', { errors: ingredientsState.errors, responseStatus: api.responseStatus.ingredients })
    const ingredientsReview = reviewIngredients(api.ingredients, ingredientsState, report)
    const ingredientsPositions = await capturePositions(c, prefix, 'ingredients', report)

    const backBefore = await info(c, '.detail-topbar > button', '돌아가기')
    if (!backBefore?.inViewport || !backBefore?.centerHit) addFinding(report, 'high', 'back_button_not_accessible_at_detail_bottom', { backBefore })
    await pointer(c, '.detail-topbar > button', '돌아가기')
    await waitChecked(c, `!document.querySelector('.detail-stage')&&document.querySelector('.research-quick-view')`, 'return to quick view parent')
    const returned = await c.eval(`(()=>({url:location.href,selected:new URLSearchParams(location.search).get('selected'),q:new URLSearchParams(location.search).get('q'),quickView:document.querySelector('.quick-view-identity h1')?.textContent?.trim()??null}))()`)
    if (returned.selected !== product.productId || returned.q !== product.query) addFinding(report, 'high', 'detail_back_did_not_restore_parent_state', { returned, expected: { selected: product.productId, q: product.query } })
    const net = await network(c)
    if (net.sentAnalytics.length) addFinding(report, 'high', 'analytics_request_escaped_blocker', { count: net.sentAnalytics.length })
    if (net.sentWrites.length) addFinding(report, 'high', 'production_write_request_observed', { count: net.sentWrites.length })

    return {
      viewport,
      product,
      lookup: { method: 'public q= URL navigation; search-input typing not tested', lookupUrl, state: lookupState, selector, cardMetric },
      quickView,
      api: {
        responseStatus: api.responseStatus,
        nutrition: api.nutrition ? { product_id: api.nutrition.product_id, variant_id: api.nutrition.variant_id, observation_scope: api.nutrition.observation_scope, market_code: api.nutrition.market_code, panel_type: api.nutrition.panel_type, protein_pct: api.nutrition.protein_pct, protein_qualifier: api.nutrition.protein_qualifier, fat_pct: api.nutrition.fat_pct, fat_qualifier: api.nutrition.fat_qualifier, fiber_pct: api.nutrition.fiber_pct, fiber_qualifier: api.nutrition.fiber_qualifier, moisture_pct: api.nutrition.moisture_pct, moisture_qualifier: api.nutrition.moisture_qualifier, ash_pct: api.nutrition.ash_pct, ash_qualifier: api.nutrition.ash_qualifier, kcal_per_kg: api.nutrition.kcal_per_kg, kcal_per_100g: api.nutrition.kcal_per_100g, supplemental_nutrition_fields: api.nutrition.supplemental_nutrition_fields, supplemental_observation_scope: api.nutrition.supplemental_observation_scope, supplemental_market_code: api.nutrition.supplemental_market_code, basis_specific_nutrition_basis: api.nutrition.basis_specific_nutrition_basis, basis_specific_nutrition_values: api.nutrition.basis_specific_nutrition_values } : null,
        ingredients: api.ingredients ? { product_id: api.ingredients.product_id, variant_id: api.ingredients.variant_id, observation_scope: api.ingredients.observation_scope, market_code: api.ingredients.market_code, completeness_status: api.ingredients.completeness_status, raw_text_length: norm(api.ingredients.raw_text).length, ingredient_count: array(api.ingredients.ingredient_names).length, supplemental_full_raw_text_length: norm(api.ingredients.supplemental_full_raw_text).length, supplemental_full_ingredient_count: array(api.ingredients.supplemental_full_ingredient_names).length } : null,
      },
      displayBasis: { nutritionEvidence: nutritionState.evidence, nutritionSubheadings: nutritionState.subheadings, ingredientEvidence: ingredientsState.evidence },
      scrollOwner,
      nutrition: { review: nutritionReview, positions: nutritionPositions },
      tabTransition: { before: beforeSwitch, after: afterSwitch, scrollTopBeforeSwitch, scrollTopAfterSwitch, startMissed: switchStartMissed, file: transitionFile },
      ingredients: { review: ingredientsReview, positions: ingredientsPositions },
      back: { before: backBefore, returned },
      fonts,
      network: net,
    }
  } catch (error) {
    const failure = await failureSnapshot(c, prefix, selector, error)
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { qaFailure: failure })
  }
}

const report = {
  status: 'running',
  mode: FULL ? 'full' : 'smoke',
  targetSha: TARGET_SHA,
  pagesUrl: PROD,
  startedAt: new Date().toISOString(),
  products: PRODUCTS,
  viewports: FULL ? VIEWPORTS : [VIEWPORTS[0]],
  runs: [],
  findings: [],
  failures: [],
  limitations: ['Physical mobile device not tested.', 'External manufacturer data accuracy was intentionally not reviewed.', 'Search input manipulation was not tested; LOOKUP was entered through the public q= navigation contract.', 'Existing full regression QA was not repeated.'],
}

const combinations = FULL
  ? VIEWPORTS.flatMap((viewport) => PRODUCTS.map((product) => ({ viewport, product })))
  : [{ viewport: VIEWPORTS[0], product: PRODUCTS[0] }]

for (const { viewport, product } of combinations) {
  const launched = await launch(viewport.width, viewport.height)
  try {
    const run = await runProduct(launched.c, viewport, product, report)
    report.runs.push({ ...run, chrome: launched.version })
  } catch (error) {
    report.failures.push({ viewport, product, error: String(error?.stack || error), qaFailure: error?.qaFailure ?? null })
    report.status = 'harness_failure'
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
    cleanup(launched.proc, launched.dir, launched.c)
    throw error
  }
  cleanup(launched.proc, launched.dir, launched.c)
  await sleep(350)
}

report.status = report.findings.some((item) => item.severity === 'high') ? 'completed_with_high_findings' : report.findings.length ? 'completed_with_findings' : 'pass'
report.completedAt = new Date().toISOString()
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ status: report.status, mode: report.mode, runCount: report.runs.length, findingCount: report.findings.length, findings: report.findings }, null, 2))
