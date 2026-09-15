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

  const productFilters = requests.map((url) => url.searchParams.get('product_id')).filter(Boolean)
  assert.ok(productFilters.length >= 4, `expected compare and variant requests, got ${requests.length}`)
  assert.equal(productFilters.some((value) => value.includes(current.product_id)), false, `current product leaked into API filters: ${productFilters.join(' | ')}`)
  assert.ok(productFilters.some((value) => value === 'in.(product_candidate_a,product_candidate_b)'))
})

test('mobile candidate picker identifies same-brand products, preserves order, and falls back after selected removal', async () => {
  const { removed, detailed, baseProps } = await renderCompare()
  const pickerButtons = [...document.querySelectorAll('.compare-mobile-candidate-picker button')]
  assert.deepEqual(pickerButtons.map((node) => node.textContent.trim()), [
    '같은후보브랜드 · 첫 번째 후보 제품',
    '같은후보브랜드 · 두 번째 후보 제품 이름이 조금 더 깁니다',
  ])
  assert.deepEqual(pickerButtons.map((node) => node.dataset.productId), [candidateA.product_id, candidateB.product_id])
  assert.match(document.querySelector('.compare-mobile-product-head.is-candidate').textContent, /같은후보브랜드.*첫 번째 후보 제품/s)

  await click(pickerButtons[1])
  assert.match(document.querySelector('.compare-mobile-product-head.is-candidate').textContent, /같은후보브랜드.*두 번째 후보 제품 이름이 조금 더 깁니다/s)

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

test('nutrition and non-SWITCH compare keep candidate-only scope', async () => {
  await renderCompare()
  const nutritionTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '영양')
  await click(nutritionTab)
  await settle()
  assert.match(document.querySelector('.compare-header p').textContent, /담아둔 2개 후보의 영양 정보를 비교합니다.*현재 사료는 포함하지 않습니다/s)
  assert.equal(document.querySelector('.compare-scope-note'), null)
  assert.equal(document.querySelector('.compare-current-product-head'), null)
  assert.equal(document.querySelectorAll('.compare-product-head').length, 2)

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
