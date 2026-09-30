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
let failCurrentNutrition = false
let failCurrentVariants = false
let currentNutritionScope = 'variant'

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
    nutrition_panel_count: 1,
    has_nutrition_details: true,
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

const current = product('product_current', 'AATU', '연어', {
  representative_variant_id: 'variant_current_1kg',
  available_package_labels: ['1 kg', '3 kg'],
})
const candidates = Array.from({ length: 5 }, (_, index) =>
  product(`product_candidate_${index + 1}`, index === 0 ? 'GO! SOLUTIONS' : `후보브랜드${index + 1}`, index === 0 ? 'LID 오리' : `후보 ${index + 1}`)
)
const items = candidates.map((value) => ({ product: value }))

function nutritionRow(productId, overrides = {}) {
  return {
    product_id: productId,
    variant_id: `variant_${productId}`,
    observation_scope: 'variant',
    market_code: 'KR',
    panel_type: 'source_declaration',
    protein_pct: 31,
    protein_qualifier: 'min',
    fat_pct: 15,
    fat_qualifier: 'min',
    fiber_pct: 3.5,
    fiber_qualifier: 'max',
    moisture_pct: 10,
    moisture_qualifier: 'max',
    ash_pct: 7.5,
    ash_qualifier: 'max',
    kcal_per_kg: null,
    kcal_per_100g: 422,
    energy_basis: 'direct_label',
    is_korea_market_observation: true,
    is_current_resolved_formula: false,
    additional_nutrients: [],
    additional_nutrient_count: 0,
    supplemental_nutrition_fields: [],
    supplemental_observation_scope: null,
    supplemental_market_code: null,
    supplemental_is_current_resolved_formula: false,
    basis_specific_nutrition_basis: null,
    basis_specific_nutrition_values: [],
    ...overrides,
  }
}

const currentNutrition = nutritionRow(current.product_id, {
  variant_id: 'variant_current_3kg',
  protein_pct: 33,
  fat_pct: 20,
  fiber_pct: 2,
  moisture_pct: 7,
  ash_pct: 9.5,
  kcal_per_100g: 370,
  additional_nutrients: [{ nutrient_key: 'calcium', raw_name: 'Calcium', amount: 1.6, unit: '%', qualifier: 'min' }],
  additional_nutrient_count: 1,
  supplemental_nutrition_fields: ['protein', 'fat', 'fiber', 'moisture', 'ash', 'additional_nutrients'],
  supplemental_observation_scope: 'product',
  supplemental_market_code: 'KR',
})
const candidateRows = candidates.map((value, index) => nutritionRow(value.product_id, {
  variant_id: index === 0 ? 'variant_candidate_7_26kg' : `variant_candidate_${index + 1}`,
  ash_pct: index === 0 ? null : 7.5,
}))

const currentVariants = [
  {
    product_id: current.product_id,
    variant_id: 'variant_current_1kg',
    package_size_text: '1 kg',
    package_weight_g: 1000,
    units_per_sale: 1,
    sale_total_weight_g: 1000,
    sales_bundle_status: 'not_a_bundle',
    display_rank: 1,
    variant_count: 2,
    formula_evidence_status: 'not_observed',
    recipe_families: [],
    recipe_details: [],
    official_recipe_traits: [],
    ingredient_term_result_count: 0,
    confirmed_present_ingredient_terms: [],
    direct_evidence_ingredient_terms: [],
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
  },
  {
    product_id: current.product_id,
    variant_id: 'variant_current_3kg',
    package_size_text: '3 kg',
    package_weight_g: 3000,
    units_per_sale: 1,
    sale_total_weight_g: 3000,
    sales_bundle_status: 'not_a_bundle',
    display_rank: 2,
    variant_count: 2,
    formula_evidence_status: 'confirmed',
    recipe_families: [],
    recipe_details: [],
    official_recipe_traits: [],
    ingredient_term_result_count: 0,
    confirmed_present_ingredient_terms: [],
    direct_evidence_ingredient_terms: [],
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
  },
]
const candidateVariants = Object.fromEntries(candidates.map((value, index) => [value.product_id, [{
  ...currentVariants[0],
  product_id: value.product_id,
  variant_id: index === 0 ? 'variant_candidate_7_26kg' : `variant_candidate_${index + 1}`,
  package_size_text: index === 0 ? '7.26 kg' : '1 kg',
  package_weight_g: index === 0 ? 7260 : 1000,
  variant_count: 1,
  formula_evidence_status: 'confirmed',
}]]))

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
  const file = resolve(temp, 'switch-nutrition-comparison.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-switch-nutrition-tests-'))
  app = await bundle()
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  requests = []
  failCurrentNutrition = false
  failCurrentVariants = false
  currentNutritionScope = 'variant'
  document.body.innerHTML = '<div id="root"></div>'
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push(url)
    assert.equal(url.origin, 'https://api.test')
    const filter = url.searchParams.get('product_id') ?? ''
    if (url.pathname.endsWith('/compare_product_nutrition')) {
      if (filter === `in.(${current.product_id})`) {
        if (failCurrentNutrition) return new Response('current failed', { status: 500 })
        const row = currentNutritionScope === 'variant'
          ? currentNutrition
          : {
              ...currentNutrition,
              observation_scope: currentNutritionScope,
              variant_id: null,
              is_current_resolved_formula: currentNutritionScope === 'formula' ? false : currentNutrition.is_current_resolved_formula,
            }
        return Response.json([row])
      }
      if (filter === `in.(${candidates.map((value) => value.product_id).join(',')})`) return Response.json(candidateRows)
      if (filter.includes('product_general_')) return Response.json(candidateRows.slice(0, 2))
      return Response.json([])
    }
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([])
    if (url.pathname.endsWith('/switch_current_variant_options')) {
      const id = filter.replace(/^eq\./, '')
      if (id === current.product_id) {
        if (failCurrentVariants) return new Response('variant failed', { status: 500 })
        return Response.json(currentVariants)
      }
      return Response.json(candidateVariants[id] ?? [])
    }
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
  await act(async () => { await new Promise((resolvePromise) => setTimeout(resolvePromise, 50)) })
}

async function renderSwitch(overrides = {}) {
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.CompareView, {
    items,
    currentProduct: current,
    currentVariantId: 'variant_current_1kg',
    currentVariantText: '1 kg',
    initialTab: 'nutrition',
    onClose() {},
    onRemove() {},
    ...overrides,
  })))
  await settle()
}

function mobileCurrentMetric(label) {
  const row = [...document.querySelectorAll('.compare-switch-mobile-nutrition .compare-mobile-two-product-field.is-metric')]
    .find((node) => node.querySelector('.compare-mobile-two-product-row-label')?.textContent.trim() === label)
  assert.ok(row, `mobile metric row missing: ${label}`)
  return row.querySelector('.compare-mobile-two-product-value.is-current')
}

function desktopCurrentMetric(label) {
  const row = [...document.querySelectorAll('.compare-switch-nutrition-desktop .compare-row.is-metric')]
    .find((node) => node.querySelector('.compare-row-label')?.textContent.trim() === label)
  assert.ok(row, `desktop metric row missing: ${label}`)
  return row.querySelector('.compare-cell.is-current')
}

test('SWITCH nutrition keeps current separate from five candidate reads and preserves package/evidence semantics', async () => {
  await renderSwitch()

  const nutritionFilters = requests
    .filter((url) => url.pathname.endsWith('/compare_product_nutrition'))
    .map((url) => url.searchParams.get('product_id'))
  assert.ok(nutritionFilters.includes(`in.(${current.product_id})`))
  assert.ok(nutritionFilters.includes(`in.(${candidates.map((value) => value.product_id).join(',')})`))
  assert.equal(nutritionFilters.some((filter) => filter?.includes(current.product_id) && filter?.includes(candidates[0].product_id)), false)

  const mobile = document.querySelector('.compare-switch-mobile-nutrition')
  assert.ok(mobile)
  assert.match(mobile.textContent, /370 kcal\/100g/)
  assert.match(mobile.textContent, /422 kcal\/100g/)
  assert.match(mobile.textContent, /33% 이상/)
  assert.match(mobile.textContent, /31% 이상/)
  assert.match(mobile.textContent, /미확인/)
  assert.match(mobile.querySelector('.compare-mobile-switch-use-package').textContent, /사용 규격 · 1 kg/)
  assert.match(mobile.querySelector('.compare-current-nutrition-evidence').textContent, /대표 영양 자료 · 3 kg · 사용 규격과 다른 포장/)
  assert.match(mobile.textContent, /한국 판매 제품 자료 · 3 kg 제품에서 확인 · 보완 자료 포함/)
  assert.match(mobile.textContent, /한국 판매 제품 자료 · 7.26 kg 제품에서 확인/)
  assert.match(mobile.textContent, /자료 기준 보기/)
  assert.match(mobile.textContent, /칼슘/)
  assert.match(mobile.textContent, /1.6% 이상/)

  const energy = mobileCurrentMetric('열량')
  assert.match(energy.textContent, /370 kcal\/100g/)
  assert.match(energy.textContent, /3 kg 자료 · 다른 포장/)
  assert.equal(energy.textContent.includes('제품 단위 보완 자료'), false)

  for (const label of ['조단백질', '조지방', '조섬유', '수분', '조회분', '칼슘']) {
    const metric = mobileCurrentMetric(label)
    assert.match(metric.textContent, /제품 단위 보완 자료/)
    assert.equal(metric.textContent.includes('3 kg 자료'), false, `${label} must not inherit representative variant evidence`)
    assert.equal(metric.textContent.includes('다른 포장'), false, `${label} must not inherit representative package mismatch`)
  }

  const desktop = document.querySelector('.compare-switch-nutrition-desktop')
  assert.ok(desktop)
  assert.equal(desktop.querySelectorAll('.compare-product-head').length, 6)
  assert.match(desktop.querySelector('.compare-current-product-head').textContent, /현재 사료 · 기준/)
  assert.match(desktop.querySelector('.compare-current-nutrition-evidence').textContent, /대표 영양 자료 · 3 kg · 사용 규격과 다른 포장/)
  assert.match(desktopCurrentMetric('열량').textContent, /3 kg 자료 · 다른 포장/)
  assert.match(desktopCurrentMetric('조단백질').textContent, /제품 단위 보완 자료/)
  assert.equal(desktopCurrentMetric('조단백질').textContent.includes('다른 포장'), false)
  assert.equal(desktop.querySelectorAll('.compare-remove').length, 5)
})

test('current nutrition failure keeps candidate values visible and offers an isolated retry', async () => {
  failCurrentNutrition = true
  await renderSwitch()
  const alert = document.querySelector('.compare-switch-nutrition-notices [role="alert"]')
  assert.ok(alert)
  assert.match(alert.textContent, /현재 사료 영양 정보를 불러오지 못했습니다/)
  assert.match(alert.textContent, /후보 영양값은 계속 표시합니다/)
  assert.match(document.querySelector('.compare-switch-mobile-nutrition').textContent, /422 kcal\/100g/)
  assert.match(document.querySelector('.compare-switch-mobile-nutrition').textContent, /조회 실패/)
  const retry = [...alert.querySelectorAll('button')].find((button) => button.textContent.includes('현재 사료 다시 시도'))
  assert.ok(retry)
})

test('unknown current package stays unknown without inventing a package mismatch', async () => {
  await renderSwitch({ currentVariantId: null, currentVariantText: '사용 규격 모름' })
  const mobile = document.querySelector('.compare-switch-mobile-nutrition')
  assert.match(mobile.querySelector('.compare-mobile-switch-use-package').textContent, /사용 규격 · 모름/)
  assert.match(mobile.querySelector('.compare-current-nutrition-evidence').textContent, /대표 영양 자료 · 3 kg · 사용 규격과 일치 여부 미확인/)
  const energy = mobileCurrentMetric('열량')
  assert.match(energy.textContent, /3 kg 자료/)
  assert.equal(energy.textContent.includes('다른 포장'), false)
  assert.match(mobileCurrentMetric('조단백질').textContent, /제품 단위 보완 자료/)
})


test('current variant lookup failure affects representative variant evidence but not product supplemental metrics', async () => {
  failCurrentVariants = true
  await renderSwitch()
  const mobile = document.querySelector('.compare-switch-mobile-nutrition')
  assert.match(mobile.querySelector('.compare-current-nutrition-evidence').textContent, /대표 영양 자료 포장 · 조회 실패 · 사용 규격과 다른 포장/)
  const energy = mobileCurrentMetric('열량')
  assert.match(energy.textContent, /370 kcal\/100g/)
  assert.match(energy.textContent, /포장 자료 · 조회 실패 · 다른 포장/)
  assert.equal(energy.textContent.includes('미확인'), false)
  const protein = mobileCurrentMetric('조단백질')
  assert.match(protein.textContent, /제품 단위 보완 자료/)
  assert.equal(protein.textContent.includes('조회 실패'), false)
  assert.equal(protein.textContent.includes('다른 포장'), false)
})

test('product-scope representative nutrition stays distinct from product supplemental evidence', async () => {
  currentNutritionScope = 'product'
  await renderSwitch()
  const mobile = document.querySelector('.compare-switch-mobile-nutrition')
  assert.match(mobile.querySelector('.compare-current-nutrition-evidence').textContent, /대표 영양 자료 · 제품 단위 · 사용 포장과 직접 연결되지 않음/)
  assert.match(mobileCurrentMetric('열량').textContent, /제품 단위 자료/)
  assert.match(mobileCurrentMetric('조단백질').textContent, /제품 단위 보완 자료/)
  assert.equal(mobileCurrentMetric('열량').textContent.includes('다른 포장'), false)
})

test('formula-scope representative nutrition does not overwrite product supplemental evidence', async () => {
  currentNutritionScope = 'formula'
  await renderSwitch()
  const mobile = document.querySelector('.compare-switch-mobile-nutrition')
  assert.match(mobile.querySelector('.compare-current-nutrition-evidence').textContent, /대표 영양 자료 · 배합 단위 · 사용 포장과 직접 연결되지 않음/)
  assert.match(mobileCurrentMetric('열량').textContent, /배합 단위 자료/)
  assert.match(mobileCurrentMetric('조단백질').textContent, /제품 단위 보완 자료/)
  assert.equal(mobileCurrentMetric('조단백질').textContent.includes('배합 단위'), false)
})

test('general two-product nutrition comparison keeps the existing non-SWITCH structure', async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = '<div id="root"></div>'
  const generalItems = items.slice(0, 2)
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.CompareView, {
    items: generalItems,
    initialTab: 'nutrition',
    onClose() {},
    onRemove() {},
  })))
  await settle()
  assert.ok(document.querySelector('.compare-mobile-two-product-nutrition'))
  assert.equal(document.querySelector('.compare-switch-mobile-nutrition'), null)
  assert.equal(document.querySelector('.compare-current-product-head'), null)
  const currentRead = requests.find((url) => url.pathname.endsWith('/compare_product_nutrition') && url.searchParams.get('product_id') === `in.(${current.product_id})`)
  assert.equal(currentRead, undefined)
})
