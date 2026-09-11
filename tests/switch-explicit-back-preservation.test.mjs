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
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch
let app, root, temp

function product(id, name, overrides = {}) {
  return {
    product_id: id,
    brand: 'Test Brand',
    canonical_name: name,
    feed_type: '건식',
    life_stage: 'adult',
    display_image_url: null,
    representative_variant_id: null,
    representative_package_size_text: null,
    representative_package_weight_g: null,
    representative_units_per_sale: null,
    representative_sale_total_weight_g: null,
    variant_count: 0,
    has_variants: false,
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

function variant(productId, variantId, size, rank) {
  return {
    product_id: productId,
    variant_id: variantId,
    package_size_text: size,
    package_weight_g: size === '1 kg' ? 1000 : 2000,
    units_per_sale: 1,
    sale_total_weight_g: size === '1 kg' ? 1000 : 2000,
    sales_bundle_status: null,
    display_rank: rank,
    variant_count: 2,
    formula_evidence_status: 'confirmed',
    recipe_families: ['poultry'],
    recipe_details: ['chicken'],
    official_recipe_traits: [],
    ingredient_term_result_count: 1,
    confirmed_present_ingredient_terms: ['chicken'],
    direct_evidence_ingredient_terms: ['chicken'],
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
  }
}

const current = product('product_current_back', '현재 건식 사료', {
  brand: '현재브랜드',
  feed_type: '건식',
  life_stage: 'adult',
  variant_count: 2,
  has_variants: true,
  official_targets: ['indoor'],
  features: ['digestive'],
  recipe_families: ['poultry'],
  recipe_details: ['chicken'],
  confirmed_present_ingredient_terms: ['chicken'],
  direct_evidence_ingredient_terms: ['chicken'],
})
const candidate = product('product_candidate_back', '전환 습식 사료', {
  brand: '새브랜드',
  feed_type: '습식',
  life_stage: 'adult',
  official_targets: ['indoor'],
  features: ['digestive'],
  recipe_families: ['fish'],
  recipe_details: ['salmon'],
  reviewed_not_found_ingredient_terms: ['chicken'],
})
const variants = [
  variant(current.product_id, 'variant_current_back_1', '1 kg', 1),
  variant(current.product_id, 'variant_current_back_2', '2 kg', 2),
]

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
  const file = resolve(temp, 'switch-explicit-back-preservation.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-switch-explicit-back-'))
  app = await bundle()
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  sessionStorage.clear()
  window.history.replaceState(null, '', `${BASE}?view=workspace&mode=switch`)
  document.body.innerHTML = '<div id="root"></div>'
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.origin, 'https://api.test')
    if (url.pathname.endsWith('/effective_product_catalog_summary')) return Response.json([current, candidate])
    if (url.pathname.endsWith('/switch_current_variant_options')) {
      const filter = url.searchParams.get('product_id')
      if (filter === `eq.${current.product_id}`) return Response.json(variants)
      return Response.json(variants.map((row) => ({
        product_id: row.product_id,
        variant_id: row.variant_id,
        package_size_text: row.package_size_text,
        package_weight_g: row.package_weight_g,
        units_per_sale: row.units_per_sale,
        sale_total_weight_g: row.sale_total_weight_g,
        display_rank: row.display_rank,
      })))
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

const all = (selector) => [...document.querySelectorAll(selector)]
const exactButton = (text) => all('button').find((node) => node.textContent.trim() === text)
const button = (text) => all('button').find((node) => node.textContent.includes(text))
const skuButton = (size) => all('.switch-sku-option').find((node) => node.textContent.includes(size))

async function click(target) {
  const node = typeof target === 'string' ? button(target) : target
  assert.ok(node, `missing button: ${target}`)
  assert.equal(node.disabled, false, `disabled button: ${node.textContent}`)
  await act(async () => node.click())
}

async function inputValue(element, value) {
  assert.ok(element)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function waitForUi(predicate, message, timeoutMs = 2500) {
  if (predicate()) return
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      observer.disconnect()
      window.removeEventListener('popstate', check)
      window.clearTimeout(timeout)
      error ? rejectPromise(error) : resolvePromise()
    }
    const check = () => {
      try { if (predicate()) finish() } catch (error) { finish(error) }
    }
    const observer = new window.MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    window.addEventListener('popstate', check)
    const timeout = window.setTimeout(() => finish(new Error(`UI condition not reached: ${message}\n${document.body.textContent.slice(0, 1200)}`)), timeoutMs)
    check()
  })
}

async function renderApp() {
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => document.body.textContent.includes('데이터 연결됨'), 'catalog settles')
}

async function chooseCurrentAndReachChange() {
  const input = document.querySelector('.switch-find-search input')
  await inputValue(input, current.canonical_name)
  await waitForUi(() => all('.switch-find-result').some((node) => node.textContent.includes(current.canonical_name)), 'current search result')
  await click(all('.switch-find-result').find((node) => node.textContent.includes(current.canonical_name)))
  await click('이 제품을 현재 사료로 선택')
  await waitForUi(() => document.body.textContent.includes('현재 먹이는 규격을 골라주세요'), 'SKU step')
  await waitForUi(() => skuButton('1 kg'), '1 kg SKU')
  await click(skuButton('1 kg'))
  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'CHANGE step')
}

function session() {
  const value = app.readSwitchSession(sessionStorage)
  assert.ok(value, 'expected SWITCH session snapshot')
  return value
}

test('explicit KEEP to CHANGE back preserves the latest KEEP selection when history goes to its parent entry', async () => {
  await renderApp()
  await chooseCurrentAndReachChange()
  await click(exactButton('습식'))
  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 그대로 유지할까요?'), 'KEEP step')
  await click(exactButton('현재브랜드 유지'))
  assert.equal(session().keepBrand, true)

  await click('← 바꿀 것 수정')
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'explicit back to CHANGE')
  assert.equal(session().keepBrand, true, 'latest KEEP must survive explicit history back')

  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 그대로 유지할까요?'), 'KEEP re-entry')
  assert.equal(exactButton('현재브랜드 유지')?.getAttribute('aria-pressed'), 'true')
})

test('explicit CHANGE to SKU back preserves edited CHANGE, ingredient avoidance, and actual SKU', async () => {
  await renderApp()
  await chooseCurrentAndReachChange()
  await click(exactButton('습식'))
  const ingredient = document.querySelector('.switch-current-ingredients button')
  assert.ok(ingredient, 'expected current ingredient control')
  await click(ingredient)
  assert.equal(session().variantSelection.variantId, 'variant_current_back_1')
  assert.equal(session().change.feedType, '습식')
  assert.deepEqual(session().ingredientAvoidTerms, ['chicken'])

  await click('← 사용 규격')
  await waitForUi(() => document.body.textContent.includes('현재 먹이는 규격을 골라주세요'), 'explicit back to SKU')
  assert.equal(session().variantSelection.variantId, 'variant_current_back_1')
  assert.equal(skuButton('1 kg')?.getAttribute('aria-pressed'), null)
  assert.match(skuButton('1 kg')?.textContent ?? '', /선택됨/)

  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'CHANGE re-entry')
  assert.equal(session().change.feedType, '습식')
  assert.deepEqual(session().ingredientAvoidTerms, ['chicken'])
  assert.equal(exactButton('습식')?.getAttribute('aria-pressed'), 'true')
  assert.match(document.querySelector('.switch-ingredient-selected')?.textContent ?? '', /닭/)
})

test('preserved KEEP still obeys PR21 conflict clearing only on the matching CHANGE axis', async () => {
  await renderApp()
  await chooseCurrentAndReachChange()
  await click('특별히 바꾸고 싶은 점 없음')
  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 그대로 유지할까요?'), 'KEEP step')
  await click(exactButton('현재브랜드 유지'))
  await click(exactButton('실내묘'))
  assert.equal(session().keepBrand, true)
  assert.deepEqual(session().keep.officialTargets, ['indoor'])

  await click('← 바꿀 것 수정')
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'back to CHANGE with KEEP')
  assert.equal(session().keepBrand, true)
  assert.deepEqual(session().keep.officialTargets, ['indoor'])

  await click(exactButton('다른 브랜드로 보기'))
  assert.equal(session().keepBrand, false, 'same-axis brand KEEP must clear')
  assert.deepEqual(session().keep.officialTargets, ['indoor'], 'unrelated KEEP must remain')
  assert.match(document.body.textContent, /브랜드 유지 조건을 해제했습니다/)

  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 그대로 유지할까요?'), 'KEEP after conflict resolution')
  assert.equal(exactButton('현재브랜드 유지'), undefined)
  assert.equal(exactButton('실내묘')?.getAttribute('aria-pressed'), 'true')
})
