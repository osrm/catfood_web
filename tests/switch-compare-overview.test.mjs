import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'

const BASE = 'https://catfood.test/catfood_web/'
const dom = new JSDOM('<div id="root"></div>', { url: BASE })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle)
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch
let app, root, temp
let requests = []

function product(id, brand, name, overrides = {}) {
  return {
    product_id: id,
    brand,
    canonical_name: name,
    feed_type: '건식',
    life_stage: 'adult',
    display_image_url: null,
    representative_variant_id: null,
    representative_package_size_text: '1 kg',
    representative_package_weight_g: 1000,
    representative_units_per_sale: 1,
    representative_sale_total_weight_g: 1000,
    available_package_labels: ['1 kg'],
    variant_count: 1,
    has_variants: true,
    ingredient_declaration_count: 0,
    full_ingredient_declaration_count: 0,
    has_ingredient_details: false,
    has_full_ingredient_declaration: false,
    nutrition_panel_count: 0,
    has_nutrition_details: false,
    manufacturing_observation_count: 0,
    has_manufacturing_details: false,
    manufacturing_country_codes: [],
    market_observation_count: 0,
    has_market_details: false,
    assessed_market_country_codes: [],
    current_market_country_codes: [],
    formula_match_market_country_codes: [],
    ingredient_term_result_count: 0,
    confirmed_present_ingredient_terms: [],
    direct_evidence_ingredient_terms: [],
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
    official_targets: [],
    features: [],
    recipe_families: [],
    recipe_details: [],
    official_recipe_traits: [],
    ...overrides,
  }
}

const current = product('product_current', '현재브랜드', '현재 사료 이름 전체', {
  available_package_labels: ['1 kg', '2 kg'],
  official_targets: ['indoor'],
  features: ['digestive'],
  recipe_families: ['poultry'],
  recipe_details: ['chicken'],
  manufacturing_country_codes: ['KR'],
})
const candidateA = product('product_candidate_a', '같은후보브랜드', '첫 번째 후보 제품', {
  feed_type: '습식',
  life_stage: null,
  available_package_labels: ['85 g'],
  recipe_families: ['fish'],
  recipe_details: ['salmon'],
})
const candidateB = product('product_candidate_b', '같은후보브랜드', '두 번째 후보 제품 이름이 조금 더 깁니다', {
  feed_type: '습식',
  available_package_labels: ['70 g', '140 g'],
  official_targets: ['indoor'],
  features: ['digestive'],
  recipe_families: ['fish'],
  recipe_details: ['tuna'],
})
const items = [
  { product: candidateA, changeMatches: ['습식'], unknowns: ['제품 표기 대상 · 실내묘'] },
  { product: candidateB, changeMatches: ['습식'], keepMatches: ['실내묘'] },
]

async function bundle() {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"',
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
    },
    build: { ssr: 'tests/entry.ts', write: false, minify: false },
  })
  const chunk = result.output.find((item) => item.type === 'chunk' && item.isEntry)
  const file = resolve(temp, 'switch-compare-overview.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-switch-compare-tests-'))
  app = await bundle()
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  requests = []
  document.body.innerHTML = '<div id="root"></div>'
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push(url)
    assert.equal(url.origin, 'https://api.test')
    return Response.json([])
  }
})

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = null
  }
})

async function settle() {
  await act(async () => { await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)) })
}

async function renderCompare(props = {}) {
  const removed = []
  const detailed = []
  root = createRoot(document.getElementById('root'))
  const baseProps = {
    items,
    currentProduct: current,
    currentVariantText: '1 kg',
    onClose() {},
    onRemove(productId) { removed.push(productId) },
    onDetailOpen(productId) { detailed.push(productId) },
    ...props,
  }
  await act(async () => root.render(createElement(app.CompareView, baseProps)))
  await settle()
  return { removed, detailed, baseProps }
}

async function click(node) {
  assert.ok(node)
  await act(async () => node.click())
  await settle()
}

test('selected avoidance rows distinguish confirmed, reviewed-not-found and unknown before the ingredient list', async () => {
  await renderCompare({
    initialTab: 'ingredients', ingredientAvoidTerms: ['salmon', 'chicken'],
    currentProduct: { ...current, confirmed_present_ingredient_terms: ['salmon'] },
    items: [
      { product: { ...candidateA, reviewed_not_found_ingredient_terms: ['salmon'], confirmed_present_ingredient_terms: ['chicken'] } },
      { product: { ...candidateB, canonical_name: '연어 이름은 판정 근거가 아님', direct_evidence_ingredient_terms: [], insufficient_evidence_ingredient_terms: ['salmon'] } },
    ],
  })
  const table = document.querySelector('.compare-ingredient-wide')
  const rows = [...table.querySelectorAll('.compare-switch-overview-row')]
  assert.equal(rows[0].querySelector('.compare-row-label').textContent, '연어 확인 결과')
  assert.deepEqual([...rows[0].querySelectorAll('[data-evidence-state]')].map(node => node.dataset.evidenceState), ['present', 'reviewed-not-found', 'unknown'])
  assert.deepEqual([...rows[0].querySelectorAll('.compare-ingredient-verdict > strong')].map(node => node.textContent), ['확인됨', '확인 자료에 연어 표기 없음', '현재 자료로는 포함 여부를 알기 어려워요.'])
  assert.match(rows[0].querySelector('[data-evidence-state="reviewed-not-found"]').textContent, /확인 자료에 연어 표기 없음/)
  assert.match(rows[0].querySelector('[data-evidence-state="unknown"]').textContent, /현재 자료로는 포함 여부를 알기 어려워요/)
  assert.match(rows[0].querySelector('[data-evidence-state="reviewed-not-found"]').textContent, /이 표기만으로는 포함 여부를 알기 어려워요/)
  assert.equal(rows[1].querySelector('.compare-row-label').textContent, '닭 확인 결과')
  assert.deepEqual([...rows[1].querySelectorAll('[data-evidence-state]')].map(node => node.dataset.evidenceState), ['unknown', 'present', 'unknown'])
  assert.equal(rows[2].querySelector('.compare-row-label').textContent, '목록 상태')
  assert.doesNotMatch(rows[0].textContent, /연어 없음|안전|적합|추천/)
  const mobile = document.querySelector('.compare-ingredient-pair-summary')
  const values = () => [...mobile.querySelectorAll('.compare-ingredient-avoidance > div:first-child [data-evidence-state]')].map(node => node.dataset.evidenceState)
  assert.deepEqual(values(), ['present', 'reviewed-not-found'])
  await click(document.querySelector('.compare-ingredient-mobile-summary .compare-mobile-candidate-toggle'))
  await click(document.querySelector(`.compare-ingredient-mobile-summary [data-product-id="${candidateB.product_id}"]`))
  assert.deepEqual(values(), ['present', 'unknown'])
  assert.doesNotMatch(mobile.textContent, /표기 없음|없다는 보장/)
})

test('complete raw ingredient lists and a failed source read cannot turn unknown into reviewed-not-found', async () => {
  globalThis.fetch = window.fetch = async input => {
    const url = new URL(String(input))
    requests.push(url)
    if (url.pathname.endsWith('/compare_product_ingredients_scoped')) {
      const ids = (url.searchParams.get('product_id') ?? '').slice(4, -1).split(',')
      return Response.json(ids.map(product_id => ({ product_id, completeness_status: 'full', raw_text: '닭고기, 어유', ingredient_names: ['닭고기', '어유'] })))
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ initialTab: 'ingredients', ingredientAvoidTerms: ['salmon'] })
  const verdicts = () => [...document.querySelectorAll('.compare-ingredient-wide [data-evidence-state]')]
  assert.deepEqual(verdicts().map(node => node.dataset.evidenceState), ['unknown', 'unknown', 'unknown'])
  assert.match(document.querySelector('.compare-ingredient-wide').textContent, /전체 목록 확인/)
  globalThis.fetch = window.fetch = async () => new Response('', { status: 503 })
  await act(async () => root.render(createElement(app.CompareView, {
    ...baseProps, items: [{ product: product('product_failed_source', '후보', '원문 조회 실패 제품', { reviewed_not_found_ingredient_terms: ['salmon'] }) }],
  })))
  await settle()
  const candidate = verdicts().at(-1)
  assert.equal(candidate.dataset.evidenceState, 'reviewed-not-found')
  assert.match(candidate.textContent, /포함 여부를 알기 어려워요/)
  assert.match(document.body.textContent, /불러오지 못했습니다/)
})

test('ingredient facts loading and failure stay separate from an unknown verdict and retry is available', async () => {
  let retries = 0
  const missing = { ...candidateA, confirmed_present_ingredient_terms: null, reviewed_not_found_ingredient_terms: null }
  const load = { status: 'loading', onRequest() {}, onRetry() { retries++ } }
  const { baseProps } = await renderCompare({ initialTab: 'ingredients', currentProduct: null, ingredientAvoidTerms: ['salmon'], items: [{ product: missing }], ingredientLoad: load })
  const states = () => [...document.querySelectorAll('.compare-ingredient-verdict')].map(node => node.dataset.evidenceState)
  assert.deepEqual(states(), ['loading', 'loading'])
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, ingredientLoad: { ...load, status: 'error' } })))
  await settle()
  assert.deepEqual(states(), ['error', 'error'])
  assert.doesNotMatch(document.querySelector('.compare-ingredient-pair-summary').textContent, /포함 여부를 알기 어려워요|표기 없음/)
  await click(document.querySelector('.compare-ingredient-mobile-summary .catalog-inline-state button'))
  assert.equal(retries, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, ingredientLoad: { ...load, status: 'loaded' }, items: [{ product: candidateA }] })))
  await settle()
  assert.deepEqual(states(), ['unknown', 'unknown'])
})

test('avoidance shows only relevant generic terms from applicable full labels', async () => {
  const partial = product('product_partial', '후보', '일부 원료표 제품')
  const sources = [
    { product_id: current.product_id, observation_scope: 'variant', variant_id: 'variant_other', raw_text: '어분', is_manufacturer_source: true },
    { product_id: candidateA.product_id, observation_scope: 'product', raw_text: '쌀, 어유', is_manufacturer_source: true },
    { product_id: candidateB.product_id, observation_scope: 'product', raw_text: 'Fish Oil (Tilapia), Salmon, 가금류 지방' },
    { product_id: partial.product_id, observation_scope: 'product', completeness_status: 'partial', raw_text: '어유', is_manufacturer_source: true },
  ].map(row => ({ market_code: 'KR', completeness_status: 'full', ingredient_names: [], ...row }))
  const fetchDefault = globalThis.fetch
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith('/compare_product_ingredients_scoped')) return fetchDefault(input)
    const requested = url.searchParams.get('p_product_ids')
    return Response.json(sources.filter(row => requested.includes(row.product_id)))
  }

  await renderCompare({
    initialTab: 'ingredients', ingredientAvoidTerms: ['herring', 'chicken', 'salmon', 'beef'],
    currentVariantId: 'variant_selected',
    items: [
      { product: { ...candidateA, reviewed_not_found_ingredient_terms: ['salmon'] } },
      { product: { ...candidateB, confirmed_present_ingredient_terms: ['salmon'] } },
      { product: partial },
    ],
  })
  const rows = [...document.querySelectorAll('.compare-ingredient-wide .compare-switch-overview-row')]
  const reasons = row => [...row.querySelectorAll('.compare-ingredient-verdict strong')].map(node => node.textContent)
  const originalLabel = '제조사 원료표에 어종 표시 없음 · ‘어유’ 표기'
  const fallback = '현재 자료로는 포함 여부를 알기 어려워요.'
  const partialLabel = '원료표 일부만 확인'
  assert.deepEqual(reasons(rows[0]), [fallback, originalLabel, fallback, partialLabel])
  assert.deepEqual(reasons(rows[1]), [fallback, fallback, '확인한 원료표에 동물 종류 표시 없음 · ‘가금류 지방’ 표기', partialLabel])
  assert.deepEqual(reasons(rows[2]), [fallback, originalLabel, '확인됨', partialLabel])
  assert.equal(rows[2].querySelectorAll('.compare-ingredient-verdict')[1].dataset.evidenceState, 'reviewed-not-found')
  assert.deepEqual(reasons(rows[3]), [fallback, fallback, fallback, partialLabel])
  const mobileCandidate = document.querySelector('.compare-ingredient-pair > div:nth-child(2)')
  assert.equal(mobileCandidate.querySelector('.compare-ingredient-verdict strong').textContent, originalLabel)
})

test('selected current package uses its own ingredient evidence and qualifies an unmatched formula label', async () => {
  const variant = (id, status, terms) => ({
    product_id: current.product_id, variant_id: id, formula_evidence_status: status,
    confirmed_present_ingredient_terms: terms, direct_evidence_ingredient_terms: terms,
    flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: terms.length ? [] : ['egg', 'salmon'],
  })
  const linked = variant('variant_linked', 'confirmed', ['egg', 'salmon'])
  const unlinked = variant('variant_unlinked', 'not_observed', [])
  const source = {
    product_id: current.product_id, variant_id: null, observation_scope: 'formula', completeness_status: 'full',
    is_current_resolved_formula: true, raw_text: 'Whole egg, salmon oil', ingredient_names: ['Whole egg', 'salmon oil'],
  }
  const fetchDefault = globalThis.fetch
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/switch_current_variant_options') && url.searchParams.get('product_id') === `eq.${current.product_id}`) {
      return Response.json([linked, unlinked])
    }
    if (url.pathname.endsWith('/compare_product_ingredients_scoped') && url.searchParams.get('p_product_ids').includes(current.product_id)) {
      return Response.json([source])
    }
    return fetchDefault(input)
  }

  const { baseProps } = await renderCompare({
    initialTab: 'ingredients', ingredientAvoidTerms: ['egg', 'salmon'], currentVariantId: unlinked.variant_id,
    currentProduct: { ...current, confirmed_present_ingredient_terms: ['egg', 'salmon'], direct_evidence_ingredient_terms: ['egg', 'salmon'] },
  })
  const desktop = () => [...document.querySelectorAll('.compare-ingredient-wide .is-current .compare-ingredient-verdict')]
  const mobile = () => [...document.querySelectorAll('.compare-ingredient-pair > div:first-child .compare-ingredient-verdict')]
  const states = nodes => nodes.map(node => node.dataset.evidenceState)
  assert.deepEqual(states(desktop()), ['unknown', 'unknown'])
  assert.deepEqual(states(mobile()), ['unknown', 'unknown'])
  assert.match(desktop()[0].textContent, /선택한 포장 원료표 확인 필요/)
  const mobileTerms = () => document.querySelector('.compare-ingredient-pair > div:first-child .compare-ingredient-summary-values').textContent
  assert.equal(mobileTerms(), '')
  const scope = () => [...document.querySelectorAll('.ingredient-source-scope')].map(node => node.textContent)
  assert.ok(scope().some(value => value.includes('선택한 포장 적용 여부 확인 필요')))

  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentVariantId: linked.variant_id })))
  await settle()
  assert.deepEqual(states(desktop()), ['present', 'present'])
  assert.deepEqual(states(mobile()), ['present', 'present'])
  assert.match(mobileTerms(), /계란.*연어/)
  assert.ok(!scope().some(value => value.includes('선택한 포장 적용 여부 확인 필요')))
})

test('avoidance result rows are absent without selected terms and confirmed presence takes precedence', async () => {
  const { baseProps } = await renderCompare({ initialTab: 'ingredients' })
  assert.equal(document.querySelector('.compare-ingredient-verdict'), null)
  await act(async () => root.render(createElement(app.CompareView, {
    ...baseProps, currentProduct: null, ingredientAvoidTerms: ['salmon'],
    items: [{ product: { ...candidateA, confirmed_present_ingredient_terms: ['salmon'], reviewed_not_found_ingredient_terms: ['salmon'] } }],
  })))
  await settle()
  assert.deepEqual([...document.querySelectorAll('.compare-ingredient-verdict')].map(node => node.dataset.evidenceState), ['present', 'present'])
  assert.doesNotMatch(document.querySelector('.compare-ingredient-pair-summary').textContent, /찾지 못함/)
})

test('SWITCH overview keeps current food as a non-removable baseline and excludes it from compare API requests', async () => {
  await renderCompare()
  const currentHead = document.querySelector('.compare-current-product-head')
  assert.ok(currentHead)
  assert.match(currentHead.textContent, /현재 사료 · 기준/)
  assert.match(currentHead.textContent, /현재브랜드/)
  assert.match(currentHead.textContent, /현재 사료 이름 전체/)
  assert.match(currentHead.textContent, /사용 규격 · 1 kg/)
  assert.match(currentHead.textContent, /판매 규격 · 1 kg · 2 kg/)
  assert.equal(currentHead.querySelector('.compare-remove'), null)
  assert.equal(document.querySelectorAll('.compare-switch-overview-desktop .compare-remove').length, 2)
  assert.equal(document.querySelectorAll('.compare-switch-overview-desktop .compare-column-role').length, 3)
  assert.equal(document.querySelector('.compare-scope-note'), null)
  assert.match(document.querySelector('.compare-header p').textContent, /현재 사료와 2개 후보의 제품 정보를 같은 항목으로 비교합니다/)

  assert.equal(requests.length, 0, 'overview must not start compare nutrition, ingredients, or variant reads')
})

test('highlights put selected differences first and never turn a missing value into a product difference', async () => {
  await renderCompare({ criteriaLabels: ['바꿀 점 · 습식'] })
  const summary = document.querySelector('.compare-highlights-desktop .comparison-highlights')
  assert.match(summary.textContent, /내가 고른 조건 · 바꿀 점 · 습식/)
  assert.match(summary.textContent, /후보 모두에서 확인 · 바꿀 조건 확인 · 습식/)
  const card = summary.querySelector(`[data-product-id="${candidateA.product_id}"]`)
  assert.match(card.textContent, /조건 미확인 · 제품 표기 대상 · 실내묘/)
  const facts = card.querySelectorAll(':scope > ul > li')
  assert.equal(facts[0].textContent, '사료 형태: 건식 → 습식')
  assert.match(card.textContent, /대상 연령 · 자료 확인 차이: 성묘 → 미확인/)
  assert.equal(requests.length, 0, 'highlights reuse existing data and preserve lazy reads')
})

test('overview starts with differences and explicitly reveals the complete comparison without additional reads', async () => {
  await renderCompare()
  const toggle = document.querySelector('.compare-full-record-toggle')
  const record = document.querySelector('.compare-full-record')
  assert.equal(record.hidden, true)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.ok(document.querySelector('.compare-highlights-desktop .highlight-product-actions button'))
  await click(toggle)
  assert.equal(record.hidden, false)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.match(record.textContent, /판매 규격/)
  assert.equal(requests.length, 0)
})

test('mobile highlights follow the selected candidate and candidate removal', async () => {
  const { baseProps } = await renderCompare()
  const summary = () => document.querySelector('.compare-highlights-mobile .comparison-highlights')
  assert.match(summary().textContent, /첫 번째 후보 제품/)
  assert.doesNotMatch(summary().textContent, /두 번째 후보 제품/)
  await click(document.querySelector('.compare-mobile-candidate-toggle'))
  await click(document.querySelector(`.compare-mobile-candidate-options [data-product-id="${candidateB.product_id}"]`))
  assert.match(summary().textContent, /두 번째 후보 제품/)
  assert.doesNotMatch(summary().textContent, /첫 번째 후보 제품/)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, items: [items[0]] })))
  await settle()
  assert.match(summary().textContent, /첫 번째 후보 제품/)
  assert.doesNotMatch(summary().textContent, /두 번째 후보 제품/)
})

test('general mobile highlights follow its chosen pair without retaining the original reference', async () => {
  const candidateC = product('product_candidate_c', '셋째브랜드', '세 번째 후보', { feed_type: '동결건조' })
  await renderCompare({ currentProduct: null, items: [...items, { product: candidateC }] })
  const selects = document.querySelectorAll('.compare-mobile-general-pair-picker select')
  assert.equal(selects.length, 2)
  await act(async () => {
    selects[0].value = candidateC.product_id
    selects[0].dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await settle()
  const summary = document.querySelector('.compare-highlights-mobile .comparison-highlights')
  assert.match(summary.textContent, /비교 기준 · 셋째브랜드 세 번째 후보/)
  assert.match(summary.textContent, /사료 형태: 동결건조 → 습식/)
  assert.doesNotMatch(summary.textContent, /첫 번째 후보 제품/)
})

test('fact comparison omits shared and mutually unknown values while prioritizing chosen facts', () => {
  const baseline = [
    { key: 'feed', value: '건식', known: true },
    { key: 'unknown', value: '미확인', known: false },
    { key: 'recipe', value: '닭', known: true },
    { key: 'age', value: '성묘', known: true, priority: true },
  ]
  const compared = app.differentFacts(baseline, [
    { key: 'feed', value: '건식', known: true },
    { key: 'unknown', value: '미확인', known: false },
    { key: 'recipe', value: '생선', known: true },
    { key: 'age', value: '미확인', known: false },
  ])
  assert.deepEqual(compared.map(value => [value.key, value.bothKnown]), [['age', false], ['recipe', true]])
})

test('energy highlights follow the energy field source and exclude unresolved foreign and supplemental sources', () => {
  const row = { observation_scope: 'product', market_code: 'KR', kcal_per_kg: 3700, is_current_resolved_formula: false }
  assert.equal(app.highlightEnergy(row), 370)
  assert.equal(app.highlightEnergy({ ...row, observation_scope: 'formula' }), null)
  assert.equal(app.highlightEnergy({ ...row, market_code: 'US' }), null)
  assert.equal(app.highlightEnergy({ ...row, market_code: null }), null)
  assert.equal(app.highlightEnergy({ ...row, market_code: null, observation_scope: 'formula', is_current_resolved_formula: true }), 370)
  const supplemented = { ...row, supplemental_nutrition_fields: ['energy'], supplemental_observation_scope: 'formula', supplemental_market_code: 'US', supplemental_is_current_resolved_formula: false }
  assert.equal(app.highlightEnergy(supplemented), null)
  assert.equal(app.highlightEnergy({ ...supplemented, supplemental_is_current_resolved_formula: true }), 370)
  assert.equal(app.highlightEnergy({ ...row, kcal_per_kg: -10 }), null)
})

test('ingredient wording stays source-specific and preserves partial and foreign scope', () => {
  const generic = { raw_text: '닭고기, 어유', completeness_status: 'full', observation_scope: 'product', market_code: 'KR', supplemental_full_raw_text: 'fish oil (herring)' }
  const named = { raw_text: 'chicken, fish oil (herring)', completeness_status: 'full', observation_scope: 'formula', market_code: null, is_current_resolved_formula: true }
  const partial = { raw_text: '닭고기', completeness_status: 'summary', observation_scope: 'formula', market_code: 'US', is_current_resolved_formula: false }
  assert.deepEqual(app.ingredientWordingExamples(generic), ['어유 — 세부 어종 미표기'])
  assert.match(app.ingredientWordingExamples(named)[0], /fish oil \(herring\).*청어를 명시한 오일/)
  assert.deepEqual(app.ingredientWordingExamples(partial), [])
  assert.match(app.ingredientDisclosureSummary(partial), /일부 원료표 확인/)
  assert.equal(app.ingredientSourceScope(partial).needsCheck, true)
})

test('mobile candidate disclosure opens, selects a candidate, closes, and restores toggle focus', async () => {
  await renderCompare()
  const toggle = document.querySelector('.compare-mobile-candidate-toggle')
  const options = document.querySelector('.compare-mobile-candidate-options')
  assert.ok(toggle)
  assert.ok(options)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(options.hidden, true)
  assert.match(toggle.textContent, /후보 2개 · 1\/2/)
  assert.match(toggle.textContent, /같은후보브랜드.*첫 번째 후보 제품/s)

  await click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(options.hidden, false)
  const optionButtons = [...options.querySelectorAll('button[data-product-id]')]
  assert.deepEqual(optionButtons.map((node) => node.dataset.productId), [candidateA.product_id, candidateB.product_id])
  assert.deepEqual(optionButtons.map((node) => node.getAttribute('aria-pressed')), ['true', 'false'])
  assert.deepEqual(optionButtons.map((node) => node.textContent.trim()), [
    '같은후보브랜드 · 첫 번째 후보 제품',
    '같은후보브랜드 · 두 번째 후보 제품 이름이 조금 더 깁니다',
  ])

  await click(optionButtons[1])
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(options.hidden, true)
  assert.match(document.querySelector('.compare-mobile-product-head.is-candidate').textContent, /같은후보브랜드.*두 번째 후보 제품 이름이 조금 더 깁니다/s)
  assert.match(toggle.textContent, /후보 2개 · 2\/2/)
  assert.equal(document.activeElement, toggle)
})

test('mobile candidate disclosure direct close keeps the selected candidate unchanged', async () => {
  await renderCompare()
  const toggle = document.querySelector('.compare-mobile-candidate-toggle')
  const before = document.querySelector('.compare-mobile-product-head.is-candidate').textContent
  await click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  await click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(document.querySelector('.compare-mobile-product-head.is-candidate').textContent, before)
  assert.match(toggle.textContent, /후보 2개 · 1\/2/)
})

test('mobile candidate removal falls back and omits the picker with one candidate', async () => {
  const { removed, detailed, baseProps } = await renderCompare()
  const toggle = document.querySelector('.compare-mobile-candidate-toggle')
  await click(toggle)
  const candidateBButton = document.querySelector(`.compare-mobile-candidate-options button[data-product-id="${candidateB.product_id}"]`)
  await click(candidateBButton)

  const detailButton = [...document.querySelectorAll('.compare-mobile-head-actions button')].find((node) => node.textContent.includes('상세 보기'))
  await click(detailButton)
  assert.deepEqual(detailed, [candidateB.product_id])

  const removeButton = [...document.querySelectorAll('.compare-mobile-head-actions button')].find((node) => node.textContent.includes('비교에서 제거'))
  await click(removeButton)
  assert.deepEqual(removed, [candidateB.product_id])

  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, items: [items[0]] })))
  await settle()
  assert.equal(document.querySelector('.compare-mobile-candidate-picker'), null, 'single candidate should not show a redundant picker')
  assert.match(document.querySelector('.compare-mobile-product-head.is-candidate').textContent, /같은후보브랜드.*첫 번째 후보 제품/s)

  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, items: [] })))
  await settle()
  assert.equal(document.querySelector('.compare-mobile-candidate-picker'), null)
  assert.equal(document.querySelector('.compare-mobile-product-head.is-candidate'), null)
})

test('SWITCH overview presents product facts before candidate condition results without removing unknown meaning', async () => {
  await renderCompare()
  const mobileRows = [...document.querySelectorAll('.compare-switch-mobile-overview .compare-mobile-overview-row')]
  const desktopRows = [...document.querySelectorAll('.compare-switch-overview-desktop .compare-switch-overview-row')]
  assert.equal(mobileRows[0].querySelector('.compare-mobile-row-label').textContent.trim(), '사료 형태')
  assert.equal(desktopRows[0].querySelector('.compare-row-label').textContent.trim(), '사료 형태')
  assert.equal(mobileRows.at(-1).querySelector('.compare-mobile-row-label').textContent.trim(), '후보 조건 확인')
  assert.equal(desktopRows.at(-1).querySelector('.compare-row-label').textContent.trim(), '후보 조건 확인')
  assert.match(mobileRows.at(-1).textContent, /기준 제품/)
  assert.match(mobileRows.at(-1).textContent, /미확인/)
  assert.equal(document.body.textContent.includes('KEEP/CHANGE 조건 판정 대상이 아닙니다'), false)
  assert.equal([...document.querySelectorAll('.compare-section-row')].filter((node) => node.textContent.includes('조건 확인 결과는 후보에만 표시합니다.')).length, 2)
})

test('SWITCH nutrition adds the fixed current baseline while non-SWITCH comparison stays candidate-only', async () => {
  await renderCompare()
  const nutritionTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '영양')
  await click(nutritionTab)
  assert.match(document.querySelector('.compare-header p').textContent, /현재 사료를 기준으로 담아둔 2개 후보의 영양 정보를 같은 항목에서 비교합니다/)
  assert.equal(document.querySelector('.compare-scope-note'), null)
  assert.ok(document.querySelector('.compare-switch-nutrition-desktop .compare-current-product-head'))
  assert.equal(document.querySelectorAll('.compare-switch-nutrition-desktop .compare-product-head').length, 3)
  assert.ok(document.querySelector('.compare-switch-mobile-nutrition'))

  await act(async () => root.unmount())
  root = null
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.CompareView, {
    items,
    onClose() {},
    onRemove() {},
  })))
  await settle()
  assert.equal(document.querySelector('.compare-switch-mobile-overview'), null)
  assert.equal(document.querySelector('.compare-scope-note'), null)
  assert.equal(document.querySelectorAll('.compare-product-head').length, 2)
})


test('SWITCH overview omits target and feature rows when current food and every candidate are empty', async () => {
  const emptyCurrent = product('product_current_empty', '현재브랜드', '빈 현재 사료')
  const emptyItems = [
    { product: product('product_empty_a', '후보A', '빈 후보 A') },
    { product: product('product_empty_b', '후보B', '빈 후보 B') },
  ]
  await renderCompare({ currentProduct: emptyCurrent, items: emptyItems })

  const desktopDisclosure = document.querySelector('.compare-switch-overview-desktop > .compare-overview-extra')
  const mobileDisclosure = document.querySelector('.compare-switch-mobile-overview > .compare-overview-extra')
  assert.equal(desktopDisclosure, null)
  assert.equal(mobileDisclosure, null)
  assert.doesNotMatch(document.body.textContent, /확인된 값 없음/)
  const visibleDesktopLabels = [...document.querySelectorAll('.compare-switch-overview-desktop > .compare-switch-overview-row > .compare-row-label')].map((node) => node.textContent.trim())
  assert.equal(visibleDesktopLabels.includes('제품 표기 대상'), false)
  assert.equal(visibleDesktopLabels.includes('제품 특징'), false)
})

test('SWITCH overview keeps globally non-empty rows visible even when the selected mobile candidate is empty', async () => {
  const emptyCandidateItems = [
    { product: product('product_empty_a2', '후보A', '빈 후보 A') },
    { product: product('product_empty_b2', '후보B', '빈 후보 B') },
  ]
  await renderCompare({ currentProduct: current, items: emptyCandidateItems })

  assert.equal(document.querySelector('.compare-switch-overview-desktop > .compare-overview-extra'), null)
  assert.equal(document.querySelector('.compare-switch-mobile-overview > .compare-overview-extra'), null)
  const desktopLabels = [...document.querySelectorAll('.compare-switch-overview-desktop > .compare-switch-overview-row > .compare-row-label')].map((node) => node.textContent.trim())
  const mobileLabels = [...document.querySelectorAll('.compare-switch-mobile-overview > .compare-mobile-overview-row > .compare-mobile-row-label')].map((node) => node.textContent.trim())
  assert.ok(desktopLabels.includes('제품 표기 대상'))
  assert.ok(desktopLabels.includes('제품 특징'))
  assert.ok(mobileLabels.includes('제품 표기 대상'))
  assert.ok(mobileLabels.includes('제품 특징'))
  const targetMobileRow = [...document.querySelectorAll('.compare-switch-mobile-overview > .compare-mobile-overview-row')].find((row) => row.querySelector('.compare-mobile-row-label')?.textContent.trim() === '제품 표기 대상')
  assert.match(targetMobileRow.textContent, /실내묘/)
  assert.match(targetMobileRow.textContent, /후보—/)
})

test('ingredient pair summary follows the selected candidate and retains the fixed current food', async () => {
  const previousMedia = window.matchMedia
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  const displayed = []
  const first = { product: { ...candidateA, direct_evidence_ingredient_terms: ['salmon'] } }
  const second = { product: { ...candidateB, direct_evidence_ingredient_terms: ['tuna'] } }
  await renderCompare({ initialTab: 'ingredients', currentProduct: { ...current, direct_evidence_ingredient_terms: ['chicken'] }, items: [first, second], onDisplayedCandidates: ids => displayed.push(ids) })
  assert.deepEqual(displayed.at(-1), [candidateA.product_id], 'only the displayed candidate is observed')
  let summary = document.querySelector('.compare-ingredient-pair-summary')
  assert.match(summary.textContent, /현재브랜드현재 사료 이름 전체/)
  assert.deepEqual([...summary.querySelectorAll('.compare-ingredient-summary-values')].map(node => node.textContent), ['닭', '연어'])
  assert.match(summary.textContent, /첫 번째 후보 제품/)
  const picker = document.querySelector('.compare-ingredient-mobile-summary .compare-mobile-candidate-picker')
  assert.ok(picker)
  await click(picker.querySelector('button'))
  await click([...picker.querySelectorAll('button')].find(node => node.dataset.productId === candidateB.product_id))
  summary = document.querySelector('.compare-ingredient-pair-summary')
  assert.match(summary.textContent, /현재브랜드현재 사료 이름 전체/)
  assert.match(summary.textContent, /두 번째 후보 제품 이름이 조금 더 깁니다/)
  assert.deepEqual([...summary.querySelectorAll('.compare-ingredient-summary-values')].map(node => node.textContent), ['닭', '참치'])
  assert.doesNotMatch(summary.textContent, /첫 번째 후보 제품|연어|확인된 값 없음/)
  assert.deepEqual(displayed.at(-1), [candidateB.product_id])
  window.matchMedia = previousMedia
})


test('comparison tabs load only active data and reuse successful candidate variants within the mount', async () => {
  await renderCompare()
  assert.equal(requests.length, 0)

  const nutritionTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '영양')
  const ingredientsTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '원재료')
  const overviewTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '개요')

  await click(nutritionTab)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped')).length, 2, 'SWITCH nutrition keeps candidate and current reads separate')
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients_scoped')).length, 0)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/switch_current_variant_options')).length, 3, 'two candidates plus current variant lookup')

  const afterNutrition = requests.length
  await click(overviewTab)
  assert.equal(requests.length, afterNutrition, 'overview must not start hidden reads after nutrition')

  await click(ingredientsTab)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients_scoped')).length, 2, 'candidate batch and current are separate')
  assert.equal(requests.filter((url) => url.pathname.endsWith('/switch_current_variant_options')).length, 3, 'candidate variants are reused from nutrition')
  const afterIngredients = requests.length

  await click(nutritionTab)
  assert.equal(requests.length, afterIngredients, 'loaded nutrition/current/variant data are reused on tab round-trip')
})

test('general comparison overview is read-free and first active tab controls which comparison resource loads', async () => {
  await renderCompare({ currentProduct: null })
  assert.equal(requests.length, 0)
  const ingredientsTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '원재료')
  const nutritionTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '영양')
  await click(ingredientsTab)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients_scoped')).length, 1)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped')).length, 0)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/switch_current_variant_options')).length, 2)
  const afterIngredients = requests.length
  await click(nutritionTab)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped')).length, 1)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/switch_current_variant_options')).length, 2, 'variants stay reused across candidate tabs')
  const afterNutrition = requests.length
  await click(ingredientsTab)
  assert.equal(requests.length, afterNutrition)
  assert.ok(afterNutrition > afterIngredients)
})

test('deep-linked comparison tab starts only its required reads', async () => {
  await renderCompare({ initialTab: 'ingredients' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients_scoped')).length, 2)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped')).length, 0)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/switch_current_variant_options')).length, 3)
})


function nutritionFixture(productId, kcalPer100g = 422) {
  return {
    product_id: productId, variant_id: null, observation_scope: 'product', market_code: null, panel_type: null,
    protein_pct: null, protein_qualifier: null, fat_pct: null, fat_qualifier: null, fiber_pct: null, fiber_qualifier: null,
    moisture_pct: null, moisture_qualifier: null, ash_pct: null, ash_qualifier: null, kcal_per_kg: null,
    kcal_per_100g: kcalPer100g, energy_basis: null, is_korea_market_observation: false, is_current_resolved_formula: true,
    additional_nutrients: [], supplemental_nutrition_fields: [], basis_specific_nutrition_values: [],
  }
}

function ingredientFixture(productId) {
  return {
    product_id: productId, variant_id: null, observation_scope: 'product', market_code: null, declaration_scope: 'full',
    completeness_status: 'full', raw_text: '오리', ingredient_names: ['오리'], ingredient_count: 1,
    is_korea_market_observation: false, is_current_resolved_formula: true,
  }
}

test('SWITCH candidate nutrition manual retry clears the failed request key and reloads only candidate nutrition', async () => {
  let candidateAttempts = 0
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_nutrition_scoped')) {
      const filter = productFilter(url)
      if (filter === 'in.(product_candidate_a,product_candidate_b)') {
        candidateAttempts += 1
        if (candidateAttempts === 1) return new Response('candidate failed', { status: 503 })
        return Response.json([nutritionFixture(candidateA.product_id, 422), nutritionFixture(candidateB.product_id, 348)])
      }
      if (filter === 'in.(product_current)') return Response.json([nutritionFixture(current.product_id, 370)])
    }
    return Response.json([])
  }
  await renderCompare({ initialTab: 'nutrition' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped')).length, 2)
  const retry = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '후보 다시 시도')
  assert.ok(retry)
  await click(retry)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped')).length, 3)
  assert.match(document.body.textContent, /422 kcal\/100g/)
})

test('candidate nutrition failure belongs to the old product key and does not block a replacement product set', async () => {
  const replacement = product('product_replacement', '교체브랜드', '교체 후보')
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_nutrition_scoped')) {
      const filter = productFilter(url)
      if (filter === 'in.(product_candidate_a)') return new Response('old failed', { status: 503 })
      if (filter === 'in.(product_replacement)') return Response.json([nutritionFixture(replacement.product_id, 522)])
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ currentProduct: null, items: [items[0]], initialTab: 'nutrition' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped')).length, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentProduct: null, items: [{ product: replacement }], initialTab: 'nutrition' })))
  await settle()
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped')).length, 2)
  assert.match(document.body.textContent, /522 kcal\/100g/)
})

test('current nutrition failure belongs to the old current product and does not block a replacement current food', async () => {
  const replacementCurrent = product('product_current_replacement', '새현재브랜드', '새 현재 사료')
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_nutrition_scoped')) {
      const filter = productFilter(url)
      if (filter === 'in.(product_current)') return new Response('current failed', { status: 503 })
      if (filter === 'in.(product_current_replacement)') return Response.json([nutritionFixture(replacementCurrent.product_id, 401)])
      return Response.json([])
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ initialTab: 'nutrition' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped') && productFilter(url) === 'in.(product_current)').length, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentProduct: replacementCurrent, initialTab: 'nutrition' })))
  await settle()
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition_scoped') && productFilter(url) === 'in.(product_current_replacement)').length, 1)
  assert.match(document.body.textContent, /401 kcal\/100g/)
})

test('ingredients failure belongs to the old product key and does not block a replacement product set', async () => {
  const replacement = product('product_ingredient_replacement', '교체브랜드', '새 원재료 후보')
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_ingredients_scoped')) {
      const ids = JSON.parse(`[${url.searchParams.get('p_product_ids').slice(1, -1)}]`)
      if (ids[0] === 'product_candidate_a') return new Response('ingredient failed', { status: 503 })
      if (ids[0] === 'product_ingredient_replacement') return Response.json([ingredientFixture(replacement.product_id)])
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ currentProduct: null, items: [items[0]], initialTab: 'ingredients' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients_scoped')).length, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentProduct: null, items: [{ product: replacement }], initialTab: 'ingredients' })))
  await settle()
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients_scoped')).length, 2)
  assert.match(document.body.textContent, /오리/)
})

function productFilter(url) {
  const ids = url.searchParams.get('p_product_ids')
  return ids ? `in.(${JSON.parse(`[${ids.slice(1, -1)}]`).join(',')})` : url.searchParams.get('product_id')
}

test('SWITCH unknown recipes read a five-product composition batch plus current separately and reuse them on ingredients', async () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ product: product(`product_candidate_${i}`, '후보', `다섯 후보 ${i}`) }))
  let failCurrent = true
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_ingredients_scoped')) {
      const ids = JSON.parse(url.searchParams.get('p_product_ids').replace('{', '[').replace('}', ']'))
      if (ids.length === 1 && ids[0] === current.product_id && failCurrent) return new Response('', { status: 503 })
      return Response.json(ids.map((id) => ({ product_id: id, variant_id: null, observation_scope: 'product', completeness_status: 'full', ingredient_count: 1, ingredient_names: [id === current.product_id ? 'Current ingredient original' : 'Candidate ingredient original'], raw_text: id === current.product_id ? 'Current ingredient original' : 'Candidate ingredient original' })))
    }
    return Response.json([])
  }
  await renderCompare({ items: five })
  assert.equal(requests.length, 2, 'overview reads only the displayed source groups, without nutrition or variant prefetch')
  await click([...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent === '원재료'))
  const reads = requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients_scoped'))
  assert.equal(reads.length, 2)
  assert.equal(JSON.parse(reads[0].searchParams.get('p_product_ids').replace('{', '[').replace('}', ']')).length, 5)
  assert.deepEqual(JSON.parse(reads[1].searchParams.get('p_product_ids').replace('{', '[').replace('}', ']')), [current.product_id])
  assert.match(document.querySelector('.compare-stage').textContent, /현재 사료 원재료를 불러오지 못했습니다/)
  assert.match(document.querySelector('.compare-stage').textContent, /Candidate ingredient original/)
  assert.doesNotMatch(document.querySelector('.compare-stage').textContent, /Current ingredient original/)
  failCurrent = false
  await click([...document.querySelectorAll('button')].find((node) => node.textContent === '현재 사료 다시 시도'))
  await settle()
  assert.match(document.querySelector('.compare-stage').textContent, /Current ingredient original/)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients_scoped')).length, 3, 'manual current retry leaves successful candidate batch intact')
  const after = requests.length
  await click([...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent === '개요'))
  await click([...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent === '원재료'))
  assert.equal(requests.length, after, 'successful current/candidate source data are reused')
})

test('displayed consideration candidates follow the mobile pair and desktop columns on every comparison tab', async () => {
  const original = window.matchMedia
  const listeners = new Set()
  const media = { matches: true, addEventListener(_type, fn) { listeners.add(fn) }, removeEventListener(_type, fn) { listeners.delete(fn) } }
  window.matchMedia = (query) => { assert.equal(query, '(max-width: 760px)'); return media }
  const displayed = []
  try {
    await renderCompare({ onDisplayedCandidates: (ids) => displayed.push(ids) })
    assert.deepEqual(displayed.at(-1), [candidateA.product_id])
    await click([...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent === '원재료'))
    assert.deepEqual(displayed.at(-1), [candidateA.product_id])
    await click([...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent === '개요'))
    assert.deepEqual(displayed.at(-1), [candidateA.product_id])
    await act(async () => { media.matches = false; listeners.forEach((listener) => listener()) })
    assert.deepEqual(displayed.at(-1), [candidateA.product_id, candidateB.product_id])
    await click([...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent === '원재료'))
    assert.deepEqual(displayed.at(-1), [candidateA.product_id, candidateB.product_id])
  } finally { window.matchMedia = original }
})
