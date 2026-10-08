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


test('SWITCH overview collapses target and feature rows only when current food and every candidate are empty', async () => {
  const emptyCurrent = product('product_current_empty', '현재브랜드', '빈 현재 사료')
  const emptyItems = [
    { product: product('product_empty_a', '후보A', '빈 후보 A') },
    { product: product('product_empty_b', '후보B', '빈 후보 B') },
  ]
  await renderCompare({ currentProduct: emptyCurrent, items: emptyItems })

  const desktopDisclosure = document.querySelector('.compare-switch-overview-desktop > .compare-overview-extra')
  const mobileDisclosure = document.querySelector('.compare-switch-mobile-overview > .compare-overview-extra')
  assert.ok(desktopDisclosure)
  assert.ok(mobileDisclosure)
  assert.equal(desktopDisclosure.open, false)
  assert.equal(mobileDisclosure.open, false)
  assert.equal(desktopDisclosure.querySelector('summary').textContent.trim(), '추가 정보 보기')
  assert.match(desktopDisclosure.textContent, /제품 표기 대상/)
  assert.match(desktopDisclosure.textContent, /제품 특징/)
  assert.match(desktopDisclosure.textContent, /확인된 값 없음/)
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
  assert.match(targetMobileRow.textContent, /확인된 값 없음/)
})


test('comparison tabs load only active data and reuse successful candidate variants within the mount', async () => {
  await renderCompare()
  assert.equal(requests.length, 0)

  const nutritionTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '영양')
  const ingredientsTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '원재료')
  const overviewTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '개요')

  await click(nutritionTab)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 2, 'SWITCH nutrition keeps candidate and current reads separate')
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients')).length, 0)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/switch_current_variant_options')).length, 3, 'two candidates plus current variant lookup')

  const afterNutrition = requests.length
  await click(overviewTab)
  assert.equal(requests.length, afterNutrition, 'overview must not start hidden reads after nutrition')

  await click(ingredientsTab)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients')).length, 1)
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
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients')).length, 1)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 0)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/switch_current_variant_options')).length, 2)
  const afterIngredients = requests.length
  await click(nutritionTab)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 1)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/switch_current_variant_options')).length, 2, 'variants stay reused across candidate tabs')
  const afterNutrition = requests.length
  await click(ingredientsTab)
  assert.equal(requests.length, afterNutrition)
  assert.ok(afterNutrition > afterIngredients)
})

test('deep-linked comparison tab starts only its required reads', async () => {
  await renderCompare({ initialTab: 'ingredients' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients')).length, 1)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 0)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/switch_current_variant_options')).length, 2)
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
    if (url.pathname.endsWith('/compare_product_nutrition')) {
      const filter = url.searchParams.get('product_id')
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
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 2)
  const retry = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '후보 다시 시도')
  assert.ok(retry)
  await click(retry)
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 3)
  assert.match(document.body.textContent, /422 kcal\/100g/)
})

test('candidate nutrition failure belongs to the old product key and does not block a replacement product set', async () => {
  const replacement = product('product_replacement', '교체브랜드', '교체 후보')
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_nutrition')) {
      const filter = url.searchParams.get('product_id')
      if (filter === 'in.(product_candidate_a)') return new Response('old failed', { status: 503 })
      if (filter === 'in.(product_replacement)') return Response.json([nutritionFixture(replacement.product_id, 522)])
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ currentProduct: null, items: [items[0]], initialTab: 'nutrition' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentProduct: null, items: [{ product: replacement }], initialTab: 'nutrition' })))
  await settle()
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition')).length, 2)
  assert.match(document.body.textContent, /522 kcal\/100g/)
})

test('current nutrition failure belongs to the old current product and does not block a replacement current food', async () => {
  const replacementCurrent = product('product_current_replacement', '새현재브랜드', '새 현재 사료')
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_nutrition')) {
      const filter = url.searchParams.get('product_id')
      if (filter === 'in.(product_current)') return new Response('current failed', { status: 503 })
      if (filter === 'in.(product_current_replacement)') return Response.json([nutritionFixture(replacementCurrent.product_id, 401)])
      return Response.json([])
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ initialTab: 'nutrition' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition') && url.searchParams.get('product_id') === 'in.(product_current)').length, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentProduct: replacementCurrent, initialTab: 'nutrition' })))
  await settle()
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_nutrition') && url.searchParams.get('product_id') === 'in.(product_current_replacement)').length, 1)
  assert.match(document.body.textContent, /401 kcal\/100g/)
})

test('ingredients failure belongs to the old product key and does not block a replacement product set', async () => {
  const replacement = product('product_ingredient_replacement', '교체브랜드', '새 원재료 후보')
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    if (url.pathname.endsWith('/compare_product_ingredients')) {
      const filter = url.searchParams.get('product_id')
      if (filter === 'in.(product_candidate_a)') return new Response('ingredient failed', { status: 503 })
      if (filter === 'in.(product_ingredient_replacement)') return Response.json([ingredientFixture(replacement.product_id)])
    }
    return Response.json([])
  }
  const { baseProps } = await renderCompare({ currentProduct: null, items: [items[0]], initialTab: 'ingredients' })
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients')).length, 1)
  await act(async () => root.render(createElement(app.CompareView, { ...baseProps, currentProduct: null, items: [{ product: replacement }], initialTab: 'ingredients' })))
  await settle()
  assert.equal(requests.filter((url) => url.pathname.endsWith('/compare_product_ingredients')).length, 2)
  assert.match(document.body.textContent, /오리/)
})
