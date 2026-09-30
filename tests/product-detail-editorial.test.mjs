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
  official_recipe_traits: ['grain_free'],
}

const variants = [
  {
    product_id: target.product_id,
    variant_id: 'variant_bundle',
    package_size_text: '85 g × 6',
    package_weight_g: 85,
    units_per_sale: 6,
    sale_total_weight_g: 510,
    sales_bundle_status: 'official_sales_bundle',
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
  assert.match(document.body.textContent, /습식 · 전연령/)
  assert.equal([...document.querySelectorAll('.detail-fact')].filter((node) => /사료 형태|대상 연령|레시피 종류|주요 레시피/.test(node.textContent)).length, 0)
  assert.match(document.body.textContent, /제품 특징소화/)
  assert.match(document.body.textContent, /제품 표기 대상실내묘/)
  assert.match(document.body.textContent, /직접 확인 원료닭/)
  assert.match(document.body.textContent, /향미 연관 원료참치/)
  assert.match(document.body.textContent, /일부 목록 · 2개/)
  assert.match(document.querySelector('.detail-summary-meta')?.textContent ?? '', /일부 목록 · 2개/)
  assert.match(document.body.textContent, /Grain-Free제품에 표기됨/)
  assert.match(document.body.textContent, /원재료 보기 →/)
  assert.doesNotMatch(document.body.textContent, /원재료와 출처 원문 →|전체 원재료와 출처 원문 →/)
  const packageDisclosure = [...document.querySelectorAll('summary')].find((node) => node.textContent.includes('판매 단위와 총중량'))
  assert.ok(packageDisclosure)
  packageDisclosure.parentElement.open = true
  assert.match(packageDisclosure.parentElement.textContent, /6개/)
  assert.match(packageDisclosure.parentElement.textContent, /510 g/)
  assert.match(packageDisclosure.parentElement.textContent, /미확인/)

  await click('원재료')
  const text = document.body.textContent
  assert.match(text, /목록에 없는 원료도 포함될 수 있습니다/)
  assert.match(document.querySelector('.detail-ingredient-list-compact')?.textContent ?? '', /참치닭고기/)
  assert.doesNotMatch(text, /정규화 목록|출처 원문|보조 전체 목록/)
  const summaries = [...document.querySelectorAll('summary')].map((node) => node.textContent)
  assert.deepEqual(summaries.filter((value) => /원문 보기|확인 원료 정보|다른 자료의 전체 원재료/.test(value)), [
    '원문 보기',
    '확인 원료 정보',
    '다른 자료의 전체 원재료',
  ])
  const source = [...document.querySelectorAll('summary')].find((node) => node.textContent === '원문 보기')
  assert.equal(source.parentElement.open, false)
  source.parentElement.open = true
  assert.match(source.parentElement.textContent, /참치, 닭고기, 기타 원료/)
  const evidence = [...document.querySelectorAll('summary')].find((node) => node.textContent === '확인 원료 정보')
  evidence.parentElement.open = true
  assert.match(evidence.parentElement.textContent, /직접 확인 원료닭/)
  assert.match(evidence.parentElement.textContent, /향미 연관 원료참치/)
  const supplemental = [...document.querySelectorAll('summary')].find((node) => node.textContent === '다른 자료의 전체 원재료')
  supplemental.parentElement.open = true
  assert.match(supplemental.parentElement.textContent, /일본 확인 · 현재 확인 배합 기준 · 전체 목록/)
  assert.match(supplemental.parentElement.textContent, /Tuna, chicken, broth, vitamins and minerals/)
})


test('ingredient tab applies only reviewed exact reading-help names while preserving raw source and order', async () => {
  const sourceNames = [
    'De-boned duck', 'duck meal', 'whole dried egg', 'peas', 'lentils', 'pea flour', 'tapioca', 'chickpeas',
    'chicken fat (preserved with mixed tocopherols)', 'flaxseed', 'natural flavour', 'salt', 'calcium carbonate',
    'dried chicory root', 'phosphoric acid', 'choline chloride', 'potassium chloride', 'vitamins', 'minerals', 'taurine', 'dried rosemary',
  ]
  const expectedDisplay = [
    '뼈를 제거한 오리', 'duck meal', '건조 전란', '완두콩', '렌틸콩', '완두콩 가루', '타피오카', '병아리콩',
    '닭 지방(혼합 토코페롤로 보존)', '아마씨', 'natural flavour', '소금', '탄산칼슘',
    '말린 치커리 뿌리', '인산', '염화콜린', '염화칼륨', '비타민', '미네랄', '타우린', '말린 로즈마리',
  ]
  const rawText = sourceNames.join(', ')
  handler = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([{
      ...ingredients,
      variant_id: null,
      observation_scope: 'formula',
      market_code: null,
      completeness_status: 'full',
      raw_text: rawText,
      ingredient_names: sourceNames,
      ingredient_count: sourceNames.length,
      is_korea_market_observation: false,
      is_current_resolved_formula: true,
      supplemental_full_raw_text: null,
      supplemental_full_ingredient_names: [],
      supplemental_full_ingredient_count: 0,
    }])
    return Response.json([])
  }
  await act(async () => {
    root.render(createElement(app.ProductDetail, { key: 'ingredients-reading-help', product: target, onClose() {}, initialTab: 'ingredients' }))
    await Promise.resolve()
  })

  const list = document.querySelector('.detail-ingredient-list-compact')
  assert.ok(list)
  const displayed = [...list.querySelectorAll('span')].map((node) => node.textContent)
  assert.deepEqual(displayed, expectedDisplay)
  assert.equal(displayed.length, sourceNames.length)
  assert.equal(displayed[1], 'duck meal')
  assert.equal(displayed[10], 'natural flavour')
  assert.equal(document.querySelector('.detail-ingredient-reading-help')?.textContent, '한국어 읽기 도움')
  assert.doesNotMatch(document.body.textContent, /검토용/)

  const source = [...document.querySelectorAll('summary')].find((node) => node.textContent === '원문 보기')
  assert.ok(source)
  assert.equal(source.parentElement.open, false)
  source.parentElement.open = true
  assert.equal(source.parentElement.querySelector('.detail-ingredient-copy')?.textContent, rawText)
})

test('ingredient reading help never translates partial string matches', async () => {
  const sourceNames = ['chicken fat', 'pea flour concentrate', 'natural flavour']
  handler = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([{
      ...ingredients,
      completeness_status: 'full',
      raw_text: sourceNames.join(', '),
      ingredient_names: sourceNames,
      ingredient_count: sourceNames.length,
      supplemental_full_raw_text: null,
      supplemental_full_ingredient_names: [],
      supplemental_full_ingredient_count: 0,
    }])
    return Response.json([])
  }
  await act(async () => {
    root.render(createElement(app.ProductDetail, { key: 'ingredients-exact-only', product: target, onClose() {}, initialTab: 'ingredients' }))
    await Promise.resolve()
  })
  const displayed = [...document.querySelectorAll('.detail-ingredient-list-compact span')].map((node) => node.textContent)
  assert.deepEqual(displayed, sourceNames)
  assert.equal(document.querySelector('.detail-ingredient-reading-help'), null)
})

test('ingredient tab uses normalized names as the primary body when source raw text is absent', async () => {
  handler = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([{
      ...ingredients,
      completeness_status: 'full',
      raw_text: null,
      ingredient_names: ['De-boned duck', 'duck meal', 'natural flavour'],
      supplemental_full_raw_text: null,
      supplemental_full_ingredient_names: [],
      supplemental_full_ingredient_count: 0,
    }])
    return Response.json([])
  }
  await act(async () => {
    root.render(createElement(app.ProductDetail, { key: 'ingredients-no-raw', product: target, onClose() {}, initialTab: 'ingredients' }))
    await Promise.resolve()
  })
  assert.equal(document.querySelector('.detail-ingredient-list-compact')?.textContent ?? '', 'De-boned duckduck mealnatural flavour')
  assert.equal(document.querySelector('.detail-ingredient-reading-help'), null)
  assert.equal([...document.querySelectorAll('summary')].some((node) => node.textContent === '원문 보기'), false)
  assert.doesNotMatch(document.body.textContent, /출처 원문/)
})

test('ingredient tab falls back to source text when structured ingredient names are absent', async () => {
  handler = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([{
      ...ingredients,
      completeness_status: 'full',
      raw_text: '참치 70% (원문 한정 표현), 미네랄',
      ingredient_names: [],
      supplemental_full_raw_text: null,
      supplemental_full_ingredient_names: [],
      supplemental_full_ingredient_count: 0,
    }])
    return Response.json([])
  }
  await act(async () => {
    root.render(createElement(app.ProductDetail, { key: 'ingredients-raw-only', product: target, onClose() {}, initialTab: 'ingredients' }))
    await Promise.resolve()
  })
  assert.match(document.querySelector('.detail-ingredient-copy')?.textContent ?? '', /참치 70% \(원문 한정 표현\), 미네랄/)
  assert.equal([...document.querySelectorAll('summary')].some((node) => node.textContent === '원문 보기'), false)
})

test('overview omits repeated package facts for a confirmed single unit and omits an empty optional fact section', async () => {
  const single = {
    ...target,
    official_targets: [],
    features: [],
    official_recipe_traits: [],
  }
  handler = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([{
      ...variants[0],
      variant_id: 'variant_single',
      package_size_text: '80 g',
      package_weight_g: 80,
      units_per_sale: 1,
      sale_total_weight_g: 80,
      sales_bundle_status: 'not_a_bundle',
    }])
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([{ ...ingredients, completeness_status: 'full' }])
    return Response.json([])
  }
  await act(async () => {
    root.render(createElement(app.ProductDetail, { product: single, onClose() {} }))
    await Promise.resolve()
  })
  assert.match(document.body.textContent, /80 g/)
  assert.equal([...document.querySelectorAll('summary')].some((node) => node.textContent.includes('판매 단위와 총중량')), false)
  assert.equal(document.querySelector('.detail-section-overview-facts'), null)
  assert.equal(document.querySelector('.detail-summary-meta'), null)
  assert.match(document.body.textContent, /직접 확인 원료닭/)
  assert.match(document.body.textContent, /향미 연관 원료참치/)
})

test('overview keeps package details unless the API confirms a matching single unit', async () => {
  const cases = [
    { key: 'bundle', package_size_text: '81 g × 6', sales_bundle_status: 'official_sales_bundle', package_weight_g: 81, units_per_sale: 6, sale_total_weight_g: 486 },
    { key: 'unknown-status', package_size_text: '82 g', sales_bundle_status: null, package_weight_g: 82, units_per_sale: 1, sale_total_weight_g: 82 },
    { key: 'unknown-weight', package_size_text: '83 g', sales_bundle_status: 'not_a_bundle', package_weight_g: null, units_per_sale: 1, sale_total_weight_g: 83 },
    { key: 'mismatched-weight', package_size_text: '84 g', sales_bundle_status: 'not_a_bundle', package_weight_g: 84, units_per_sale: 1, sale_total_weight_g: 94 },
  ]
  for (const values of cases) {
    handler = async (url) => {
      if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([{ ...variants[0], ...values, variant_id: `variant_${values.key}` }])
      return Response.json([])
    }
    await act(async () => {
      root.render(createElement(app.ProductDetail, { key: values.key, product: target, onClose() {} }))
      await Promise.resolve()
    })
    assert.match(document.querySelector('.detail-size-list')?.textContent ?? '', new RegExp(values.package_size_text.replace(' × ', ' × ')))
    assert.ok([...document.querySelectorAll('summary')].some((node) => node.textContent.includes('판매 단위와 총중량')))
  }
})

test('returning to overview aligns its actual first content and reselecting overview preserves scroll', async () => {
  await render()
  const stage = document.querySelector('.detail-stage')
  const topbar = document.querySelector('.detail-topbar')
  const tabs = document.querySelector('.detail-tabs')
  Object.defineProperties(stage, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 600, configurable: true } })
  stage.getBoundingClientRect = () => ({ top: 0, height: 600 })
  topbar.getBoundingClientRect = () => ({ top: 0, height: 40 })
  tabs.getBoundingClientRect = () => ({ top: 40, height: 40 })
  const nativeComputedStyle = window.getComputedStyle
  window.getComputedStyle = (node) => node === topbar ? { top: '0px' } : node === tabs ? { top: '40px' } : nativeComputedStyle(node)

  const nativeRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === stage) return { top: 0, height: 600 }
    if (this === topbar) return { top: 0, height: 40 }
    if (this === tabs) return { top: 40, height: 40 }
    if (this.classList?.contains('detail-section-heading')) return { top: 300 }
    if (this.classList?.contains('detail-section')) return { top: 240 }
    return nativeRect.call(this)
  }

  await click('영양')
  stage.scrollTop = 120
  await click('개요')
  assert.equal(stage.scrollTop, 280)

  stage.scrollTop = 333
  await click('개요')
  assert.equal(stage.scrollTop, 333)
  window.getComputedStyle = nativeComputedStyle
  window.HTMLElement.prototype.getBoundingClientRect = nativeRect
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
  assert.equal((text.match(/한국 확인 · 85 g × 6 제품에서 확인/g) ?? []).length, 1)
  assert.equal((text.match(/조회분 · 현재 확인 배합 기준으로 보완/g) ?? []).length, 1)
  assert.doesNotMatch(text, /자료 기준과 보완 범위|최소·최대·평균 등 출처의 한정자/)
  assert.equal(document.querySelector('#detail-panel-nutrition details'), null)
})

test('nutrition describes dry matter only for the dry-matter basis', async () => {
  const cases = [
    {
      key: 'dry',
      basis: 'dry_matter',
      expected: /수분을 제거한 건물 기준 자료입니다/,
      absent: /일반 표시값과 다른 기준의 자료입니다/,
    },
    {
      key: 'other',
      basis: 'as_fed_reference',
      expected: /일반 표시값과 다른 기준의 자료입니다/,
      absent: /수분을 제거한 건물 기준 자료입니다/,
    },
  ]

  for (const item of cases) {
    handler = async (url) => {
      if (url.pathname.endsWith('/compare_product_nutrition')) return Response.json([{
        ...nutrition,
        supplemental_nutrition_fields: [],
        basis_specific_nutrition_basis: item.basis,
        basis_specific_nutrition_values: [{ nutrient_key: 'protein', raw_name: null, amount: 42, unit: '%', qualifier: 'reported' }],
      }])
      if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
      if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([ingredients])
      return Response.json([])
    }
    await act(async () => {
      root.render(createElement(app.ProductDetail, { key: item.key, product: target, onClose() {}, initialTab: 'nutrition' }))
      await Promise.resolve()
    })
    const text = document.querySelector('#detail-panel-nutrition')?.textContent ?? ''
    assert.match(text, item.expected)
    assert.doesNotMatch(text, item.absent)
    assert.match(text, /단백질42%/)
  }
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


test('comparison keeps supplemental nutrition and ingredient source layers behind non-empty disclosures', async () => {
  const nutritionWithBasis = {
    ...nutrition,
    basis_specific_nutrition_basis: 'dry_matter',
    basis_specific_nutrition_values: [
      { nutrient_key: 'protein', raw_name: '단백질', amount: 42, unit: '%', qualifier: 'min' },
    ],
  }
  handler = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_nutrition')) return Response.json([nutritionWithBasis])
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([ingredients])
    return Response.json([])
  }

  await act(async () => {
    root.render(createElement(app.CompareView, {
      items: [{ product: target }],
      onClose() {},
      onRemove() {},
    }))
    await Promise.resolve()
  })

  const nutritionTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '영양')
  await act(async () => {
    nutritionTab.click()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  })

  assert.match(document.body.textContent, /10% 이상/)
  assert.match(document.body.textContent, /4\.5% 이상/)
  assert.match(document.body.textContent, /1% 이하/)
  assert.match(document.body.textContent, /800 mg\/kg 평균값/)
  assert.match(document.body.textContent, /보완 자료 포함/)
  const nutritionDisclosure = [...document.querySelectorAll('.compare-evidence-disclosure')].find((node) => node.querySelector('summary')?.textContent.trim() === '자료 기준 보기')
  assert.ok(nutritionDisclosure)
  assert.equal(nutritionDisclosure.open, false)
  nutritionDisclosure.open = true
  assert.match(nutritionDisclosure.textContent, /보완 항목조회분/)
  assert.match(nutritionDisclosure.textContent, /보완 근거현재 확인 배합 자료로 보완/)
  assert.match(document.body.textContent, /건물 기준\(Dry Matter\) · 단백질 42% 이상/)

  const ingredientsTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '원재료')
  await act(async () => {
    ingredientsTab.click()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  })

  assert.match(document.body.textContent, /일부 목록 · 전체 목록 보완 있음/)
  const scopeRow = [...document.querySelectorAll('.compare-row')].find((row) => row.querySelector('.compare-row-label')?.textContent.trim() === '적용 범위')
  assert.match(scopeRow.textContent, /한국 판매 제품 자료/)
  assert.match(scopeRow.textContent, /85 g × 6 제품에서 확인/)
  assert.match(scopeRow.textContent, /현재 확인 배합 전체 목록 보완/)
  const sourceDisclosure = [...document.querySelectorAll('.compare-evidence-disclosure')].find((node) => node.querySelector('summary')?.textContent.trim() === '출처 원문 보기')
  assert.ok(sourceDisclosure)
  assert.equal(sourceDisclosure.open, false)
  sourceDisclosure.open = true
  assert.match(sourceDisclosure.textContent, /대표 확인 자료 · 출처 원문참치, 닭고기, 기타 원료/)
  assert.match(sourceDisclosure.textContent, /현재 확인 배합 전체 목록 · 출처 원문Tuna, chicken, broth, vitamins and minerals/)
})

test('comparison labels non-current supplemental ingredient sources as supporting material outside and inside disclosure', async () => {
  handler = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([{
      ...ingredients,
      supplemental_is_current_resolved_formula: false,
    }])
    return Response.json([])
  }

  await act(async () => {
    root.render(createElement(app.CompareView, {
      items: [{ product: target }],
      onClose() {},
      onRemove() {},
      initialTab: 'ingredients',
    }))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  })

  const scopeRow = [...document.querySelectorAll('.compare-row')].find((row) => row.querySelector('.compare-row-label')?.textContent.trim() === '적용 범위')
  assert.match(scopeRow.textContent, /보조 전체 목록 보완/)
  assert.doesNotMatch(scopeRow.textContent, /현재 확인 배합 전체 목록 보완/)
  const sourceDisclosure = [...document.querySelectorAll('.compare-evidence-disclosure')].find((node) => node.querySelector('summary')?.textContent.trim() === '출처 원문 보기')
  assert.ok(sourceDisclosure)
  sourceDisclosure.open = true
  assert.match(sourceDisclosure.textContent, /보조 전체 목록 · 출처 원문Tuna, chicken, broth, vitamins and minerals/)
  assert.doesNotMatch(sourceDisclosure.textContent, /현재 확인 배합 전체 목록 · 출처 원문/)
})

test('comparison does not render empty nutrition or source disclosures', async () => {
  const noSupplementNutrition = { ...nutrition, supplemental_nutrition_fields: [] }
  const noSourceIngredients = {
    ...ingredients,
    raw_text: null,
    ingredient_names: [],
    supplemental_full_raw_text: null,
    supplemental_full_ingredient_names: [],
    supplemental_full_ingredient_count: 0,
  }
  handler = async (url) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json(variants)
    if (url.pathname.endsWith('/compare_product_nutrition')) return Response.json([noSupplementNutrition])
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([noSourceIngredients])
    return Response.json([])
  }

  await act(async () => {
    root.render(createElement(app.CompareView, {
      items: [{ product: target }],
      onClose() {},
      onRemove() {},
      initialTab: 'nutrition',
    }))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  })
  assert.equal([...document.querySelectorAll('summary')].some((node) => node.textContent.trim() === '자료 기준 보기'), false)

  const ingredientsTab = [...document.querySelectorAll('.compare-tabs button')].find((node) => node.textContent.trim() === '원재료')
  await act(async () => {
    ingredientsTab.click()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  })
  assert.equal([...document.querySelectorAll('summary')].some((node) => node.textContent.trim() === '출처 원문 보기'), false)
  assert.match(document.body.textContent, /확인된 목록 없음/)
})
