import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch
let app, root, temp, route

const product = {
  product_id: 'product_editorial0001',
  brand: '테스트 브랜드',
  canonical_name: '아주 긴 이름도 줄이지 않는 테스트 고양이 사료',
  feed_type: '건식',
  life_stage: 'adult',
  display_image_url: null,
  representative_variant_id: null,
  representative_package_size_text: null,
  representative_package_weight_g: null,
  representative_units_per_sale: null,
  representative_sale_total_weight_g: null,
  variant_count: 2,
  has_variants: true,
  ingredient_declaration_count: 1,
  full_ingredient_declaration_count: 0,
  has_ingredient_details: true,
  has_full_ingredient_declaration: false,
  nutrition_panel_count: 1,
  has_nutrition_details: true,
  manufacturing_observation_count: 1,
  has_manufacturing_details: true,
  market_observation_count: 1,
  has_market_details: true,
  ingredient_term_result_count: 2,
  manufacturing_country_codes: ['IT'],
  assessed_market_country_codes: ['US'],
  current_market_country_codes: ['US'],
  formula_match_market_country_codes: [],
  confirmed_present_ingredient_terms: ['chicken', 'salmon'],
  direct_evidence_ingredient_terms: ['chicken'],
  flavor_associated_ingredient_terms: ['salmon'],
  reviewed_not_found_ingredient_terms: [],
  insufficient_evidence_ingredient_terms: [],
  official_targets: ['indoor'],
  features: ['hairball'],
  recipe_families: ['poultry'],
  recipe_details: ['chicken'],
  official_recipe_traits: ['grain_free'],
}

const variants = [
  {
    product_id: product.product_id, variant_id: 'variant_a', package_size_text: '1.5 kg', package_weight_g: 1500,
    units_per_sale: 1, sale_total_weight_g: 1500, sales_bundle_status: null, display_rank: 1, variant_count: 2,
    formula_evidence_status: 'confirmed', recipe_families: [], recipe_details: [], official_recipe_traits: [],
    ingredient_term_result_count: 0, confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [],
    flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [], insufficient_evidence_ingredient_terms: [],
  },
  {
    product_id: product.product_id, variant_id: 'variant_b', package_size_text: '80 g × 6', package_weight_g: 80,
    units_per_sale: 6, sale_total_weight_g: 480, sales_bundle_status: 'bundle', display_rank: 2, variant_count: 2,
    formula_evidence_status: 'confirmed', recipe_families: [], recipe_details: [], official_recipe_traits: [],
    ingredient_term_result_count: 0, confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [],
    flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [], insufficient_evidence_ingredient_terms: [],
  },
]

const ingredients = {
  product_id: product.product_id,
  variant_id: null,
  observation_scope: 'product',
  market_code: 'KR',
  is_current_resolved_formula: true,
  completeness_status: 'partial',
  raw_text: '신선한 닭고기, 연어 오일 외',
  ingredient_names: ['신선한 닭고기', '연어 오일'],
  ingredient_count: 2,
  supplemental_full_raw_text: 'chicken, salmon oil, rice',
  supplemental_full_ingredient_names: ['chicken', 'salmon oil', 'rice'],
  supplemental_full_ingredient_count: 3,
  supplemental_market_code: 'US',
  supplemental_observation_scope: 'formula',
  supplemental_is_current_resolved_formula: true,
}

const nutrition = {
  product_id: product.product_id,
  variant_id: null,
  observation_scope: 'product',
  market_code: 'KR',
  is_current_resolved_formula: true,
  protein_pct: null, protein_qualifier: null,
  fat_pct: 12, fat_qualifier: 'min',
  fiber_pct: 3.5, fiber_qualifier: 'max',
  moisture_pct: null, moisture_qualifier: null,
  ash_pct: null, ash_qualifier: null,
  kcal_per_kg: null,
  kcal_per_100g: 410,
  additional_nutrients: [{ nutrient_key: 'magnesium', raw_name: 'Magnesium', amount: 0.1, unit: '%', qualifier: 'max' }],
  supplemental_nutrition_fields: ['energy'],
  supplemental_is_current_resolved_formula: true,
  basis_specific_nutrition_basis: 'dry_matter',
  basis_specific_nutrition_values: [{ nutrient_key: 'protein', raw_name: 'Protein', amount: 40, unit: '%', qualifier: 'reported' }],
}

async function bundle() {
  const result = await build({
    configFile: false, logLevel: 'silent',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_DECISION_INTAKE_ENABLED': '"false"',
      'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"',
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
    },
    build: { ssr: 'tests/entry.ts', write: false, minify: false },
  })
  const chunk = result.output.find((item) => item.type === 'chunk' && item.isEntry)
  const file = resolve(temp, 'product-detail-editorial.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-detail-editorial-tests-'))
  app = await bundle()
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  document.getElementById('root').replaceChildren()
  route = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_nutrition')) return Response.json([nutrition])
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([ingredients])
    if (url.pathname.endsWith('/product_detail_manufacturing')) return Response.json([])
    if (url.pathname.endsWith('/product_detail_markets')) return Response.json([])
    return Response.json([])
  }
  globalThis.fetch = window.fetch = async (input) => route(new URL(input instanceof Request ? input.url : String(input)))
  root = createRoot(document.getElementById('root'))
})

afterEach(async () => {
  await act(async () => root.unmount())
})

async function waitForUi(predicate, message) {
  if (predicate()) return
  await new Promise((resolvePromise, rejectPromise) => {
    const observer = new window.MutationObserver(check)
    const timeout = window.setTimeout(() => finish(new Error(`UI condition not reached: ${message}`)), 1800)
    let settled = false
    function finish(error) {
      if (settled) return
      settled = true
      observer.disconnect()
      window.clearTimeout(timeout)
      error ? rejectPromise(error) : resolvePromise()
    }
    function check() {
      try { if (predicate()) finish() } catch (error) { finish(error) }
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    check()
  })
}

async function render(props = {}) {
  await act(async () => root.render(createElement(app.ProductDetail, { product, onClose() {}, ...props })))
  await waitForUi(() => !document.body.textContent.includes('불러오는 중입니다.'), 'detail resources settle')
}

async function click(text) {
  const node = [...document.querySelectorAll('button')].find((item) => item.textContent.includes(text))
  assert.ok(node, `missing button: ${text}`)
  await act(async () => node.click())
}

test('overview keeps full identity, bundle sale facts, partial coverage, and source navigation', async () => {
  await render()
  assert.equal(document.querySelector('.detail-identity h1')?.textContent, product.canonical_name)
  assert.match(document.body.textContent, /이미지 없음/)
  assert.match(document.body.textContent, /1\.5 kg/)
  assert.match(document.body.textContent, /80 g × 6/)
  assert.match(document.body.textContent, /6개 · 총 480 g/)
  assert.match(document.body.textContent, /일부 목록 · 2개/)
  assert.match(document.body.textContent, /직접 확인 원료닭/)
  assert.match(document.body.textContent, /향미 연관 원료연어/)
  assert.match(document.body.textContent, /목록에 없는 원료도 포함될 수 있습니다/)
  assert.match(document.body.textContent, /보조 전체 목록 · 3개 확인/)

  await click('확인된 원재료와 출처 원문')
  await waitForUi(() => document.getElementById('detail-tab-ingredients')?.getAttribute('aria-selected') === 'true', 'ingredients selected')
  const text = document.body.textContent
  assert.match(text, /출처 원문/)
  assert.match(text, /신선한 닭고기, 연어 오일 외/)
  assert.match(text, /정규화 원재료 목록 2개/)
  assert.match(text, /보조 전체 목록/)
  assert.match(text, /보조 출처 원문/)
  assert.match(text, /chicken, salmon oil, rice/)
  assert.match(text, /보조 정규화 목록 3개/)
})

test('nutrition preserves kcal per 100g, qualifiers, basis-only status, and additional units', async () => {
  await render({ initialTab: 'nutrition' })
  const text = document.body.textContent
  assert.match(text, /410 kcal\/100g/)
  assert.match(text, /조단백질건물 기준 자료만 확인/)
  assert.match(text, /조지방12% 이상/)
  assert.match(text, /조섬유3\.5% 이하/)
  assert.match(text, /마그네슘0\.1% 이하/)
  assert.match(text, /건물 기준\(Dry Matter\)/)
  assert.match(text, /일반 표시값과 기준이 달라 별도로 표시합니다/)
  assert.match(text, /단백질40%/)
  assert.match(text, /열량 · 현재 확인 배합 기준 자료로 보완/)
  assert.match(text, /최소·최대·평균과 단위를 출처 표기대로 보존합니다/)
})

test('nutrition error is distinct from empty and retry still reloads every detail resource', async () => {
  const calls = new Map()
  let nutritionCalls = 0
  route = async (url) => {
    const key = url.pathname.split('/').pop()
    calls.set(key, (calls.get(key) ?? 0) + 1)
    if (url.pathname.endsWith('/compare_product_nutrition')) {
      nutritionCalls += 1
      if (nutritionCalls === 1) return new Response('temporary', { status: 503 })
      return Response.json([nutrition])
    }
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([ingredients])
    if (url.pathname.endsWith('/product_detail_manufacturing')) return Response.json([])
    if (url.pathname.endsWith('/product_detail_markets')) return Response.json([])
    return Response.json([])
  }

  await act(async () => root.render(createElement(app.ProductDetail, { product, onClose() {}, initialTab: 'nutrition' })))
  await waitForUi(() => document.querySelector('[role="alert"]') !== null, 'nutrition error')
  const alert = document.querySelector('[role="alert"]')
  assert.equal(alert.querySelector('p')?.textContent, '영양 정보를 불러오지 못했습니다.')
  assert.doesNotMatch(alert.textContent, /잠시 후/)
  await click('다시 시도')
  await waitForUi(() => document.body.textContent.includes('410 kcal/100g'), 'retry success')

  for (const key of ['switch_current_variant_options', 'compare_product_nutrition', 'compare_product_ingredients', 'product_detail_manufacturing', 'product_detail_markets']) {
    assert.equal(calls.get(key), 2, `${key} must be reloaded by the existing retry scope`)
  }
})

test('successful empty nutrition response stays a normal empty state without retry', async () => {
  route = async (url) => {
    if (url.pathname.endsWith('/compare_product_nutrition')) return Response.json([])
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([])
    if (url.pathname.endsWith('/product_detail_manufacturing')) return Response.json([])
    if (url.pathname.endsWith('/product_detail_markets')) return Response.json([])
    return Response.json([])
  }
  await render({ initialTab: 'nutrition' })
  assert.match(document.body.textContent, /확인된 영양 정보가 없습니다/)
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.equal([...document.querySelectorAll('button')].some((node) => node.textContent.includes('다시 시도')), false)
})
