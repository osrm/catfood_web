import assert from 'node:assert/strict'
import { after, before, beforeEach, afterEach, test } from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
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
let root, app, temp, requests
const nativeFetch = globalThis.fetch

function product(product_id, canonical_name) {
  return {
    product_id,
    brand: 'Test Brand',
    canonical_name,
    feed_type: '건식',
    life_stage: 'senior',
    display_image_url: null,
    representative_variant_id: null,
    representative_package_size_text: '1.58kg',
    representative_package_weight_g: 1580,
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
    market_observation_count: 0,
    has_market_details: false,
    ingredient_term_result_count: 0,
    manufacturing_country_codes: [],
    assessed_market_country_codes: [],
    current_market_country_codes: [],
    formula_match_market_country_codes: [],
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
  }
}

const targetProduct = product('product_target00000001', 'Dry Matter Target')
const unrelatedProduct = product('product_other000000001', 'Other Missing')

const dryMatterRow = {
  product_id: targetProduct.product_id,
  variant_id: 'variant_target',
  observation_scope: 'variant',
  market_code: 'KR',
  panel_type: 'source_declaration',
  protein_pct: null,
  protein_qualifier: null,
  fat_pct: null,
  fat_qualifier: null,
  fiber_pct: null,
  fiber_qualifier: null,
  moisture_pct: null,
  moisture_qualifier: null,
  ash_pct: null,
  ash_qualifier: null,
  kcal_per_kg: 3772,
  kcal_per_100g: null,
  energy_basis: 'direct_label',
  is_korea_market_observation: true,
  is_current_resolved_formula: false,
  additional_nutrients: [],
  supplemental_nutrition_fields: [],
  basis_specific_nutrition_basis: 'dry_matter',
  basis_specific_nutrition_values: [
    { nutrient_key: 'protein', raw_name: '단백질', amount: 34.3, unit: '%', qualifier: 'reported' },
    { nutrient_key: 'fat', raw_name: '지방', amount: 20.4, unit: '%', qualifier: 'reported' },
    { nutrient_key: 'fiber', raw_name: '조섬유', amount: 8.6, unit: '%', qualifier: 'reported' },
  ],
}

const unrelatedRow = {
  ...dryMatterRow,
  product_id: unrelatedProduct.product_id,
  variant_id: null,
  kcal_per_kg: 3500,
  basis_specific_nutrition_basis: null,
  basis_specific_nutrition_values: [],
}

async function bundle() {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_DECISION_INTAKE_ENABLED': '"true"',
      'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"',
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
    },
    build: { ssr: 'tests/entry.ts', write: false, minify: false },
  })
  const chunk = result.output.find((item) => item.type === 'chunk' && item.isEntry)
  const file = resolve(temp, 'nutrition-basis.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-basis-tests-'))
  app = await bundle()
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  requests = []
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    if (url.pathname.endsWith('/compare_product_nutrition')) {
      const rows = []
      if (url.search.includes(targetProduct.product_id)) rows.push(dryMatterRow)
      if (url.search.includes(unrelatedProduct.product_id)) rows.push(unrelatedRow)
      return Response.json(rows)
    }
    if (url.pathname.endsWith('/switch_current_variant_options')) {
      if (url.search.includes(targetProduct.product_id)) return Response.json([{
        product_id: targetProduct.product_id,
        variant_id: 'variant_target',
        package_size_text: '1.58kg',
        package_weight_g: 1580,
        units_per_sale: 1,
        sale_total_weight_g: 1580,
        sales_bundle_status: null,
        display_rank: 1,
        variant_count: 1,
        formula_evidence_status: 'unresolved',
        recipe_families: [], recipe_details: [], official_recipe_traits: [],
        ingredient_term_result_count: 0,
        confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [],
        flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
        insufficient_evidence_ingredient_terms: [],
      }])
      return Response.json([])
    }
    return Response.json([])
  }
  root = createRoot(document.getElementById('root'))
})

afterEach(async () => {
  await act(async () => root.unmount())
})

async function click(text) {
  const button = [...document.querySelectorAll('button')].find((element) => element.textContent.includes(text))
  assert.ok(button, `missing button: ${text}`)
  await act(async () => button.click())
}

test('detail separates dry-matter evidence from standard nutrition and leaves true missing values unknown', async () => {
  await act(async () => root.render(createElement(app.ProductDetail, { product: targetProduct, onClose() {} })))
  await click('영양')
  const text = document.body.textContent
  assert.match(text, /3,772 kcal\/kg/)
  assert.match(text, /건물 기준 자료만 확인/)
  assert.match(text, /수분을 제거한 기준의 영양자료만 확인됐습니다/)
  assert.match(text, /단백질 · 건물 기준\(Dry Matter\)34\.3%/)
  assert.match(text, /지방 · 건물 기준\(Dry Matter\)20\.4%/)
  assert.match(text, /조섬유 · 건물 기준\(Dry Matter\)8\.6%/)
  assert.match(text, /수분미확인/)
  assert.match(text, /조회분미확인/)
  const nutritionRequest = requests.find((url) => url.pathname.endsWith('/compare_product_nutrition'))
  assert.match(nutritionRequest.searchParams.get('select'), /basis_specific_nutrition_basis/)
  assert.match(nutritionRequest.searchParams.get('select'), /basis_specific_nutrition_values/)
})

test('comparison keeps unrelated missing nutrition as unknown while explaining basis mismatch', async () => {
  await act(async () => root.render(createElement(app.CompareView, {
    items: [{ product: targetProduct }, { product: unrelatedProduct }],
    onClose() {},
    onRemove() {},
  })))
  await click('영양')
  const text = document.body.textContent
  assert.match(text, /건물 기준 자료만 확인/)
  assert.match(text, /건물 기준\(Dry Matter\) · 단백질 34\.3% · 지방 20\.4% · 조섬유 8\.6%/)
  assert.match(text, /Other Missing/)
  const proteinRow = [...document.querySelectorAll('.compare-row')].find((row) => row.querySelector('.compare-row-label')?.textContent === '조단백질')
  assert.ok(proteinRow)
  const cells = [...proteinRow.querySelectorAll('.compare-cell')].map((cell) => cell.textContent.trim())
  assert.deepEqual(cells, ['건물 기준 자료만 확인', '미확인'])
})
