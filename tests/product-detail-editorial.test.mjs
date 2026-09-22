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
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch
let app, root, temp, handler

const target = {
  product_id: 'product_editorial0001',
  brand: 'Test Brand',
  canonical_name: '아주 긴 제품 이름도 줄임표 없이 모두 보여 주는 테스트용 고양이 사료',
  feed_type: '습식',
  life_stage: 'all_life_stages',
  display_image_url: null,
  representative_variant_id: null,
  representative_package_size_text: null,
  representative_package_weight_g: null,
  representative_units_per_sale: null,
  representative_sale_total_weight_g: null,
  variant_count: 2,
  has_variants: true,
  ingredient_declaration_count: 1,
  full_ingredient_declaration_count: 1,
  has_ingredient_details: true,
  has_full_ingredient_declaration: true,
  nutrition_panel_count: 1,
  has_nutrition_details: true,
  manufacturing_observation_count: 1,
  has_manufacturing_details: true,
  manufacturing_country_codes: ['TH'],
  market_observation_count: 1,
  has_market_details: true,
  assessed_market_country_codes: ['JP'],
  current_market_country_codes: ['JP'],
  formula_match_market_country_codes: [],
  ingredient_term_result_count: 2,
  confirmed_present_ingredient_terms: ['chicken'],
  direct_evidence_ingredient_terms: ['chicken'],
  flavor_associated_ingredient_terms: ['tuna'],
  reviewed_not_found_ingredient_terms: [],
  insufficient_evidence_ingredient_terms: [],
  official_targets: ['indoor'],
  features: ['digestive'],
  recipe_families: ['fish'],
  recipe_details: ['tuna'],
  official_recipe_traits: [],
}

const variants = [
  {
    product_id: target.product_id,
    variant_id: 'variant_bundle',
    package_size_text: '85 g × 6',
    package_weight_g: 85,
    units_per_sale: 6,
    sale_total_weight_g: 510,
    sales_bundle_status: 'bundle',
    display_rank: 1,
    variant_count: 2,
    formula_evidence_status: 'confirmed',
    recipe_families: [], recipe_details: [], official_recipe_traits: [],
    ingredient_term_result_count: 0,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [],
    flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
  },
  {
    product_id: target.product_id,
    variant_id: 'variant_unknown',
    package_size_text: null,
    package_weight_g: null,
    units_per_sale: null,
    sale_total_weight_g: null,
    sales_bundle_status: null,
    display_rank: 2,
    variant_count: 2,
    formula_evidence_status: 'unresolved',
    recipe_families: [], recipe_details: [], official_recipe_traits: [],
    ingredient_term_result_count: 0,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [],
    flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
  },
]

const nutrition = {
  product_id: target.product_id,
  variant_id: 'variant_bundle',
  observation_scope: 'variant',
  market_code: 'KR',
  panel_type: 'source_declaration',
  protein_pct: 10,
  protein_qualifier: 'min',
  fat_pct: 4.5,
  fat_qualifier: 'min',
  fiber_pct: 1,
  fiber_qualifier: 'max',
  moisture_pct: 80,
  moisture_qualifier: 'max',
  ash_pct: null,
  ash_qualifier: null,
  kcal_per_kg: null,
  kcal_per_100g: 97,
  energy_basis: 'direct_label',
  is_korea_market_observation: true,
  is_current_resolved_formula: false,
  additional_nutrients: [
    { nutrient_key: 'taurine', raw_name: '타우린', amount: 800, unit: 'mg/kg', qualifier: 'typical' },
  ],
  supplemental_nutrition_fields: ['ash'],
  supplemental_is_current_resolved_formula: true,
  basis_specific_nutrition_basis: null,
  basis_specific_nutrition_values: [],
}

const ingredients = {
  product_id: target.product_id,
  variant_id: 'variant_bundle',
  observation_scope: 'variant',
  market_code: 'KR',
  completeness_status: 'partial',
  raw_text: '참치, 닭고기, 기타 원료',
  ingredient_names: ['참치', '닭고기'],
  ingredient_count: 2,
  is_korea_market_observation: true,
  is_current_resolved_formula: false,
  supplemental_full_raw_text: 'Tuna, chicken, broth, vitamins and minerals',
  supplemental_full_ingredient_names: ['참치', '닭고기', '육수', '비타민·미네랄'],
  supplemental_full_ingredient_count: 4,
  supplemental_market_code: 'JP',
  supplemental_observation_scope: 'formula',
  supplemental_is_current_resolved_formula: true,
}

async function bundle() {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
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
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-detail-editorial-'))
  app = await bundle()
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  handler = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_nutrition')) return Response.json([nutrition])
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([ingredients])
    if (url.pathname.endsWith('/product_detail_manufacturing')) return Response.json([{
      product_id: target.product_id,
      observation_scope: 'variant',
      country_code: 'TH',
      manufacturer: null,
      plant: 'Test Plant',
    }])
    if (url.pathname.endsWith('/product_detail_markets')) return Response.json([{
      product_id: target.product_id,
      country_code: 'JP',
      distribution_status: 'current_product_confirmed',
      formula_correspondence_status: 'different_generation',
      counterpart_name: 'Local Full Name',
      assessed_at: '2026-09-01',
      display_rank: 1,
    }])
    return Response.json([])
  }
  globalThis.fetch = window.fetch = async (input) => handler(new URL(input instanceof Request ? input.url : String(input)))
  root = createRoot(document.getElementById('root'))
})

afterEach(async () => {
  await act(async () => root.unmount())
})

async function render() {
  await act(async () => {
    root.render(createElement(app.ProductDetail, { product: target, onClose() {} }))
    await Promise.resolve()
  })
}

async function click(text) {
  const node = [...document.querySelectorAll('button')].find((item) => item.textContent.includes(text))
  assert.ok(node, `missing button: ${text}`)
  await act(async () => {
    node.click()
    await Promise.resolve()
  })
}

test('editorial detail preserves long identity, bundle SKU facts, partial ingredients and source layers', async () => {
  await render()
  assert.match(document.querySelector('.detail-identity h1').textContent, /아주 긴 제품 이름도 줄임표 없이 모두 보여 주는 테스트용 고양이 사료/)
  assert.match(document.body.textContent, /이미지 없음/)
  assert.match(document.body.textContent, /85 g × 6/)
  const packageDisclosure = [...document.querySelectorAll('summary')].find((node) => node.textContent.includes('판매 단위와 총중량'))
  assert.ok(packageDisclosure)
  packageDisclosure.parentElement.open = true
  assert.match(packageDisclosure.parentElement.textContent, /6개/)
  assert.match(packageDisclosure.parentElement.textContent, /510 g/)
  assert.match(packageDisclosure.parentElement.textContent, /미확인/)

  await click('원재료')
  const text = document.body.textContent
  assert.match(text, /직접 확인 원료닭/)
  assert.match(text, /향미 연관 원료참치/)
  assert.match(text, /목록에 없는 원료도 포함될 수 있습니다/)
  assert.match(text, /정규화 목록 · 2개/)
  assert.match(text, /출처 원문/)
  assert.match(text, /참치, 닭고기, 기타 원료/)
  assert.match(text, /보조 전체 목록/)
  assert.match(text, /정규화 목록 · 4개/)
  assert.match(text, /Tuna, chicken, broth, vitamins and minerals/)
})

test('nutrition keeps kcal per 100g, qualifiers, units and true unknowns', async () => {
  await render()
  await click('영양')
  const text = document.body.textContent
  assert.match(text, /97 kcal\/100g/)
  assert.match(text, /조단백질10% 이상/)
  assert.match(text, /조지방4\.5% 이상/)
  assert.match(text, /조섬유1% 이하/)
  assert.match(text, /수분80% 이하/)
  assert.match(text, /조회분미확인/)
  assert.match(text, /타우린800 mg\/kg 평균값/)
  assert.match(text, /자료 기준과 보완 범위/)
})

test('detail distinguishes request failure from an empty 200 response and retries the existing resource group', async () => {
  const calls = new Map()
  let failNutrition = true
  handler = async (url) => {
    const key = url.pathname.split('/').at(-1)
    calls.set(key, (calls.get(key) ?? 0) + 1)
    if (key === 'compare_product_nutrition' && failNutrition) {
      return new Response('temporary', { status: 503 })
    }
    return Response.json([])
  }

  await render()
  await click('영양')
  assert.ok(document.querySelector('[role="alert"]'))
  assert.match(document.querySelector('[role="alert"]').textContent, /영양 정보를 불러오지 못했습니다\.다시 시도/)
  assert.doesNotMatch(document.body.textContent, /확인된 영양 정보가 없습니다/)

  failNutrition = false
  await click('다시 시도')
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.match(document.body.textContent, /확인된 영양 정보가 없습니다/)
  for (const key of [
    'switch_current_variant_options',
    'compare_product_nutrition',
    'compare_product_ingredients',
    'product_detail_manufacturing',
    'product_detail_markets',
  ]) assert.equal(calls.get(key), 2, `${key} is retried with the existing grouped policy`)
})
