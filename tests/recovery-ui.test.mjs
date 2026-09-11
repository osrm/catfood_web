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
let app, root, temp, requestHandler

function deferred() {
  let resolvePromise, rejectPromise
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

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

function variant(productId, variantId, label) {
  return {
    product_id: productId,
    variant_id: variantId,
    package_size_text: label,
    package_weight_g: 1000,
    units_per_sale: 1,
    sale_total_weight_g: 1000,
    sales_bundle_status: null,
    display_rank: 1,
    variant_count: 1,
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
  }
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
  const file = resolve(temp, 'recovery-ui.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-recovery-tests-'))
  app = await bundle()
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  dom.reconfigure({ url: 'https://catfood.test/' })
  sessionStorage.clear()
  document.getElementById('root').replaceChildren()
  requestHandler = async (url) => {
    if (url.pathname.endsWith('/search-runs')) return Response.json({ search_run_id: 'run-test' })
    if (url.pathname.endsWith('/considerations')) return Response.json({ ok: true })
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    return Response.json([])
  }
  globalThis.fetch = window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.origin, 'https://api.test')
    return requestHandler(url, init)
  }
  root = createRoot(document.getElementById('root'))
})

afterEach(async () => {
  await act(async () => root.unmount())
})

const all = (selector) => [...document.querySelectorAll(selector)]
const button = (text) => all('button').find((node) => node.textContent.includes(text))

async function click(target) {
  const node = typeof target === 'string' ? button(target) : target
  assert.ok(node, `missing button: ${target}`)
  assert.equal(node.disabled, false)
  await act(async () => node.click())
}

async function setInput(node, value) {
  assert.ok(node, 'missing input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value)
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

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
      try {
        if (predicate()) finish()
      } catch (error) {
        finish(error)
      }
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    check()
  })
}

function catalogRoute(rows, { firstFailure = false, retryDeferred = null } = {}) {
  let calls = 0
  requestHandler = async (url) => {
    if (url.pathname.endsWith('/search-runs')) return Response.json({ search_run_id: 'run-test' })
    if (url.pathname.endsWith('/considerations')) return Response.json({ ok: true })
    if (url.pathname.endsWith('/effective_product_catalog_summary')) {
      calls += 1
      if (firstFailure && calls === 1) return new Response('temporary catalog failure', { status: 503 })
      if (retryDeferred && calls === 2) return retryDeferred.promise
      return Response.json(rows)
    }
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    return Response.json([])
  }
  return () => calls
}

test('catalog 503 retries once, preserves LOOKUP query, and opens quick view', async () => {
  const retry = deferred()
  const rows = [
    product('product_000000000001', 'Needle Product'),
    product('product_000000000002', 'Other Product'),
  ]
  const catalogCalls = catalogRoute(rows, { firstFailure: true, retryDeferred: retry })

  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => !document.body.textContent.includes('불러오는 중'), 'initial catalog failure')

  const homeSearch = document.querySelector('input[type="search"]')
  await setInput(homeSearch, 'Needle')
  await act(async () => homeSearch.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  await waitForUi(() => document.querySelector('[role="alert"]'), 'lookup catalog error')

  const retryButton = button('다시 시도')
  await act(async () => {
    retryButton.click()
    retryButton.click()
  })
  assert.equal(catalogCalls(), 2, 'duplicate retry must not create another catalog request')
  assert.match(document.body.textContent, /제품 데이터를 불러오는 중입니다/)

  retry.resolve(Response.json(rows))
  await waitForUi(() => all('.research-result-card').length === 1, 'lookup retry success')
  assert.equal(catalogCalls(), 2)
  assert.equal(document.querySelector('.lookup-input').value, 'Needle')
  assert.equal(button('제품 찾기').getAttribute('aria-current'), 'page')
  assert.match(all('.research-result-card')[0].textContent, /빠른 보기 →/)

  await click(all('.research-result-card')[0])
  assert.ok(document.querySelector('.research-quick-view'))
  assert.match(document.querySelector('.quick-view-topline').textContent, /빠른 보기/)
})

test('catalog retry preserves applied EXPLORE conditions', async () => {
  const rows = [
    product('product_000000000011', 'Wet Product', { feed_type: '습식' }),
    product('product_000000000012', 'Dry Product', { feed_type: '건식' }),
  ]
  const catalogCalls = catalogRoute(rows, { firstFailure: true })

  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => !document.body.textContent.includes('불러오는 중'), 'initial catalog failure')
  await click('조건으로 찾기')
  await click('습식')
  await click('이 조건으로 찾기')
  await waitForUi(() => document.querySelector('[role="alert"]'), 'explore catalog error')
  await click('다시 시도')
  await waitForUi(() => all('.research-result-card').length === 1, 'explore retry success')

  assert.equal(catalogCalls(), 2)
  assert.match(document.querySelector('.criteria-chips').textContent, /습식/)
  assert.match(all('.research-result-card')[0].textContent, /Wet Product/)
  assert.doesNotMatch(document.body.textContent, /Dry Product/)
})

test('SWITCH catalog error exposes the same retry action without changing query', async () => {
  let retries = 0
  const rows = [product('product_000000000021', 'Switch Needle')]
  await act(async () => root.render(createElement(app.SwitchFlow, {
    products: rows,
    loading: false,
    error: '인터넷 연결을 확인한 뒤 잠시 후 다시 시도해 주세요.',
    initialQuery: 'Needle',
    onHome() {},
    onModeChange() {},
    onRetryCatalog() { retries += 1 },
  })))

  assert.equal(document.querySelector('.switch-find-search input').value, 'Needle')
  assert.ok(document.querySelector('[role="alert"]'))
  await click('다시 시도')
  assert.equal(retries, 1)
  assert.equal(document.querySelector('.switch-find-search input').value, 'Needle')
})

test('SKU 503 is distinct from empty data and same-product retry is de-duplicated', async () => {
  const current = product('product_000000000031', 'Alpha Food')
  let variantCalls = 0
  const retry = deferred()
  requestHandler = async (url) => {
    if (!url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    variantCalls += 1
    if (variantCalls === 1) return new Response('temporary variant failure', { status: 503 })
    if (variantCalls === 2) return retry.promise
    return Response.json([])
  }

  await act(async () => root.render(createElement(app.SwitchFlow, {
    products: [current], loading: false, error: null, initialQuery: 'Alpha',
    onHome() {}, onModeChange() {}, onRetryCatalog() {},
  })))
  await click(all('.switch-find-result')[0])
  await click('이 제품을 현재 사료로 선택')
  await waitForUi(() => document.querySelector('[role="alert"]'), 'variant error')

  assert.match(document.querySelector('[role="alert"]').textContent, /판매 규격을 불러오지 못했습니다/)
  assert.doesNotMatch(document.body.textContent, /선택할 수 있는 판매 규격을 확인하지 못했습니다/)
  assert.ok(button('사용 규격을 모르겠어요'), 'unknown-size choice remains independent')

  const retryButton = button('다시 시도')
  await act(async () => {
    retryButton.click()
    retryButton.click()
  })
  assert.equal(variantCalls, 2, 'duplicate SKU retry must not create another request')
  assert.match(document.body.textContent, /판매 규격을 불러오는 중입니다/)

  retry.resolve(Response.json([variant(current.product_id, 'variant_alpha', '1 kg')]))
  await waitForUi(() => document.body.textContent.includes('1 kg'), 'variant retry success')
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.doesNotMatch(document.body.textContent, /선택할 수 있는 판매 규격을 확인하지 못했습니다/)
})

test('changing current product aborts stale SKU state and a 200 empty response stays non-error', async () => {
  const alpha = product('product_000000000041', 'Alpha Food')
  const beta = product('product_000000000042', 'Beta Food')
  const gamma = product('product_000000000043', 'Gamma Food')
  const alphaResponse = deferred()
  const calls = []
  requestHandler = async (url) => {
    if (!url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    const filter = url.searchParams.get('product_id') ?? ''
    const productId = filter.replace(/^eq\./, '')
    calls.push(productId)
    if (productId === alpha.product_id) return alphaResponse.promise
    if (productId === beta.product_id) return Response.json([variant(beta.product_id, 'variant_beta', '2 kg')])
    if (productId === gamma.product_id) return Response.json([])
    return Response.json([])
  }

  await act(async () => root.render(createElement(app.SwitchFlow, {
    products: [alpha, beta, gamma], loading: false, error: null, initialQuery: 'Food',
    onHome() {}, onModeChange() {}, onRetryCatalog() {},
  })))

  await click(all('.switch-find-result').find((node) => node.textContent.includes('Alpha Food')))
  await click('이 제품을 현재 사료로 선택')
  await waitForUi(() => document.body.textContent.includes('판매 규격을 불러오는 중입니다'), 'alpha loading')
  await click('현재 사료 다시 선택')
  await click(all('.switch-find-result').find((node) => node.textContent.includes('Beta Food')))
  await click('이 제품을 현재 사료로 선택')
  await waitForUi(() => document.body.textContent.includes('2 kg'), 'beta variant loaded')

  alphaResponse.resolve(Response.json([variant(alpha.product_id, 'variant_alpha_stale', '9 kg')]))
  await act(async () => Promise.resolve())
  assert.match(document.body.textContent, /2 kg/)
  assert.doesNotMatch(document.body.textContent, /9 kg/)

  await click('현재 사료 다시 선택')
  await click(all('.switch-find-result').find((node) => node.textContent.includes('Gamma Food')))
  await click('이 제품을 현재 사료로 선택')
  await waitForUi(() => document.body.textContent.includes('선택할 수 있는 판매 규격을 확인하지 못했습니다'), 'empty variant response')
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.deepEqual(calls, [alpha.product_id, beta.product_id, gamma.product_id])
})

test('recipe choices expose every catalog value, sort by display label, and keep raw-key search', async () => {
  const recipeKeys = ['anchovy', 'beef', 'chicken', ...Array.from({ length: 39 }, (_, index) => `recipe_${String(index).padStart(2, '0')}`)]
  const rows = recipeKeys.map((recipe, index) => product(`product_${String(index).padStart(12, '0')}`, `Recipe Product ${index}`, { recipe_details: [recipe] }))
  catalogRoute(rows)

  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => document.body.textContent.includes('42 PRODUCTS'), 'catalog loaded')
  await click('조건으로 찾기')
  await click('이 조건으로 찾기')
  await waitForUi(() => all('.recipe-detail-grid .choice').length === recipeKeys.length, 'all recipe choices')

  const labelFor = (key) => ({ anchovy: '멸치', beef: '소', chicken: '닭' }[key] ?? key.replaceAll('_', ' '))
  const expected = recipeKeys.map(labelFor).sort((a, b) => a.localeCompare(b, 'ko-KR'))
  const rendered = all('.recipe-detail-grid .choice').map((node) => node.textContent.trim())
  assert.equal(rendered.length, 42, 'recipe list must not stop at 36')
  assert.deepEqual(rendered, expected)

  const search = document.querySelector('.recipe-search')
  await setInput(search, 'anchovy')
  assert.deepEqual(all('.recipe-detail-grid .choice').map((node) => node.textContent.trim()), ['멸치'])
  const anchovy = all('.recipe-detail-grid .choice')[0]
  await click(anchovy)
  assert.equal(anchovy.getAttribute('aria-pressed'), 'true')
  await click(anchovy)
  assert.equal(anchovy.getAttribute('aria-pressed'), 'false')
})
