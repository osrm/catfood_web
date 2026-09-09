import assert from 'node:assert/strict'
import { after, before, beforeEach, afterEach, test } from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'

// Set up the DOM before importing React DOM so its event support is detected correctly.
const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
let root, app, devApp, temp, requests, products, packageOptions, packageFailureOffset
const nativeFetch = globalThis.fetch

function catalog(count) {
  return Array.from({ length: count }, (_, index) => ({
    product_id: `product_${String(index).padStart(16, '0')}`,
    brand: 'Test Brand', canonical_name: `Product ${String(index).padStart(3, '0')}`,
    feed_type: '건식', life_stage: 'adult', display_image_url: null,
    representative_variant_id: null, representative_package_size_text: null,
    representative_package_weight_g: null, variant_count: 0, has_variants: false,
    ingredient_declaration_count: 0, full_ingredient_declaration_count: 0,
    has_ingredient_details: false, has_full_ingredient_declaration: false,
    nutrition_panel_count: 0, has_nutrition_details: false,
    manufacturing_observation_count: 0, has_manufacturing_details: false,
    market_observation_count: 0, has_market_details: false, ingredient_term_result_count: 0,
    ...Object.fromEntries([
      'manufacturing_country_codes', 'assessed_market_country_codes', 'current_market_country_codes',
      'formula_match_market_country_codes', 'confirmed_present_ingredient_terms',
      'direct_evidence_ingredient_terms', 'flavor_associated_ingredient_terms',
      'reviewed_not_found_ingredient_terms', 'insufficient_evidence_ingredient_terms',
      'official_targets', 'features', 'recipe_families', 'recipe_details', 'official_recipe_traits',
    ].map((key) => [key, []])),
  }))
}

async function bundle(dev) {
  const result = await build({
    configFile: false, logLevel: 'silent',
    define: {
      'import.meta.env.DEV': JSON.stringify(dev),
      'import.meta.env.VITE_DECISION_INTAKE_ENABLED': '"true"',
      'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"',
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
    },
    build: { ssr: 'tests/entry.ts', write: false, minify: false },
  })
  const chunk = result.output.find((item) => item.type === 'chunk' && item.isEntry)
  const file = resolve(temp, dev ? 'dev.mjs' : 'production.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-tests-'))
  app = await bundle(false)
  devApp = await bundle(true)
})
after(async () => { globalThis.fetch = nativeFetch; dom.window.close(); await rm(temp, { recursive: true }) })

beforeEach(() => {
  dom.reconfigure({ url: 'https://catfood.test/' })
  sessionStorage.clear()
  products = catalog(85)
  packageOptions = []
  packageFailureOffset = null
  requests = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.origin, 'https://api.test', 'tests must never contact production')
    requests.push({ path: url.pathname, query: url.search, body: init.body ? JSON.parse(init.body) : null })
    if (url.pathname.endsWith('/search-runs')) {
      return Response.json({ search_run_id: `run-${searchRuns().length}` })
    }
    if (url.pathname.endsWith('/considerations')) return Response.json({ ok: true })
    if (url.pathname.endsWith('/effective_product_catalog_summary')) return Response.json(products)
    if (url.pathname.endsWith('/switch_current_variant_options')) {
      const offset = Number(url.searchParams.get('offset') ?? 0)
      if (offset === packageFailureOffset) return new Response('Temporary failure', { status: 503 })
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 1000)
      return Response.json(packageOptions.slice(offset, offset + limit))
    }
    return Response.json([])
  }
  window.fetch = globalThis.fetch
  root = createRoot(document.getElementById('root'))
})
afterEach(async () => { await act(async () => root.unmount()) })

const searchRuns = () => requests.filter((request) => request.path.endsWith('/search-runs'))
const considerations = () => requests.filter((request) => request.path.endsWith('/considerations'))
const rows = (selector) => [...document.querySelectorAll(selector)]
const button = (text) => rows('button').find((element) => element.textContent.includes(text))
async function click(target) {
  const element = typeof target === 'string' ? button(target) : target
  assert.ok(element, `missing button: ${target}`)
  assert.equal(element.disabled, false)
  await act(async () => element.click())
}
async function waitForUi(predicate, message) {
  if (predicate()) return
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      observer.disconnect()
      document.removeEventListener('focusin', check)
      window.removeEventListener('popstate', check)
      window.clearTimeout(timeout)
      if (error) rejectPromise(error)
      else resolvePromise()
    }
    const check = () => {
      try {
        if (predicate()) finish()
      } catch (error) {
        finish(error)
      }
    }
    const observer = new window.MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    document.addEventListener('focusin', check)
    window.addEventListener('popstate', check)
    const timeout = window.setTimeout(() => finish(new Error(`UI condition not reached: ${message}`)), 1500)
    check()
  })
}

test('detail preserves supplemental raw ingredients without parsed names', async () => {
  const fallbackFetch = globalThis.fetch
  globalThis.fetch = window.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/compare_product_ingredients')) {
      return Response.json([{
        product_id: products[0].product_id, ingredient_names: [], ingredient_count: 0,
        completeness_status: 'partial', raw_text: 'Primary declaration',
        supplemental_full_raw_text: 'Full source declaration preserved',
        supplemental_full_ingredient_names: [], supplemental_full_ingredient_count: null,
      }])
    }
    return fallbackFetch(input, init)
  }
  await act(async () => root.render(createElement(app.ProductDetail, { product: products[0], onClose() {} })))
  assert.match(document.body.textContent, /출처 원문 확인/)
  await click('원재료')
  assert.match(document.body.textContent, /Full source declaration preserved/)
  assert.match(document.body.textContent, /Primary declaration/)
})

test('detail distinguishes a timeout from missing facts and retries successfully', async () => {
  const fallbackFetch = globalThis.fetch
  let failing = true
  globalThis.fetch = window.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/compare_product_ingredients')) {
      if (failing) return Response.json({ code: '57014', message: 'canceling statement due to statement timeout' }, { status: 500 })
      return Response.json([{ product_id: products[0].product_id, ingredient_names: ['Test ingredient'], ingredient_count: 1, completeness_status: 'full', raw_text: 'Recovered ingredient declaration' }])
    }
    if (url.pathname.endsWith('/product_detail_manufacturing')) {
      return Response.json([{ product_id: products[0].product_id, observation_scope: 'variant', country_code: 'FR', manufacturer: null, plant: null, is_current_resolved_formula: false }])
    }
    return fallbackFetch(input, init)
  }
  await act(async () => root.render(createElement(app.ProductDetail, { product: products[0], onClose() {} })))
  assert.match(document.querySelector('[role="alert"]').textContent, /다시 시도/)
  assert.doesNotMatch(document.body.textContent, /57014|Data API|statement timeout|현재 공개 화면에서 확인할 수 있는 원재료 목록이 없습니다/)
  failing = false
  await click('다시 시도')
  await click('원재료')
  assert.match(document.body.textContent, /Recovered ingredient declaration/)
  assert.equal(document.querySelector('[role="alert"]'), null)
  await click('제조 · 유통')
  assert.match(document.body.textContent, /프랑스/)
  assert.match(document.body.textContent, /제조 업체와 공장 정보는 확인하지 못했습니다/)
  assert.doesNotMatch(document.body.textContent, /실제 제조사|공장 미확인|확인 범위|규격 기준/)
})

test('comparison hides server diagnostics and retries nutrition', async () => {
  const fallbackFetch = globalThis.fetch
  let failing = true
  globalThis.fetch = window.fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/compare_product_nutrition')) {
      if (failing) return Response.json({ code: '57014', message: 'canceling statement due to statement timeout' }, { status: 500 })
      return Response.json([{ product_id: products[0].product_id, protein_pct: 38, protein_qualifier: 'reported', additional_nutrients: [] }])
    }
    return fallbackFetch(input, init)
  }
  await act(async () => root.render(createElement(app.CompareView, { items: [{ product: products[0] }], onClose() {}, onRemove() {} })))
  await click('영양')
  assert.match(document.querySelector('[role="alert"]').textContent, /다시 시도/)
  assert.doesNotMatch(document.body.textContent, /57014|Data API|statement timeout/)
  failing = false
  await click('다시 시도')
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.match(document.body.textContent, /38%/)
})
async function explore() {
  await act(async () => root.render(createElement(app.App)))
  await click('조건으로 찾기')
  await click('이 조건으로 찾기')
}
async function switchResults() {
  await act(async () => root.render(createElement(app.SwitchFlow, {
    products, loading: false, error: null, initialQuery: 'Product 000',
    onHome() {}, onModeChange() {},
  })))
  await click(document.querySelector('.switch-find-result'))
  await click('이 제품을 현재 사료로 선택')
  await click('사용 규격을 모르겠어요')
  await click('특별히 바꾸고 싶은 점 없음')
  await click('다음 →')
  await click('후보 제품 보기')
}

for (const mode of ['explore', 'switch']) {
  test(`${mode}: reach every candidate, compare later products, reset, and keep V1 tracking at 40`, async () => {
    if (mode === 'switch') products = catalog(86) // one current product + 85 candidates
    await (mode === 'explore' ? explore() : switchResults())
    const selector = mode === 'explore' ? '.research-result-card' : '.switch-candidate-row'
    assert.equal(rows(selector).length, 40)
    assert.equal(searchRuns().length, 1)
    const initialIds = searchRuns()[0].body.initial_presented_product_ids
    assert.equal(initialIds.length, 40)
    assert.equal(searchRuns()[0].body.candidate_count, 85)
    await click(rows(selector)[39])
    assert.equal(considerations().length, 1, '40th product remains tracked')
    await click('제품 더 보기')
    assert.equal(rows(selector).length, 80)
    await click(rows(selector)[40])
    await click('비교에 추가')
    await click('상세 보기')
    assert.equal(considerations().length, 1, '41st product detail and compare must not be sent')
    await click('돌아가기')
    if (mode === 'explore') {
      await waitForUi(
        () => document.querySelector('.detail-stage') === null
          && rows(selector).length === 80
          && document.activeElement?.dataset.productId === products[40].product_id,
        'expanded explore list and focused product restored after detail history back',
      )
      assert.equal(rows(selector).length, 80, 'history restoration must finish before pagination becomes interactive')
      assert.equal(document.activeElement?.dataset.productId, products[40].product_id, 'focus returns to the product that opened detail')
    }
    await click('제품 더 보기')
    assert.equal(rows(selector).length, 85, 'pagination after restoration must not be overwritten by late history state')
    assert.equal(button('제품 더 보기'), undefined)
    assert.equal(searchRuns().length, 1, 'pagination is not a new search run')
    await click(rows(selector)[84])
    await click('비교에 추가')
    await click('비교 보기')
    assert.match(document.querySelector('.compare-stage').textContent, /Product 0(84|85)/)
    await click('제품 목록으로')
    assert.equal(rows(selector).length, 85, 'returning from compare retains expanded results')
    assert.equal(considerations().length, 1)
    await click('조건 수정')
    if (mode === 'switch') await click('다음 →')
    await click(mode === 'explore' ? '이 조건으로 찾기' : '후보 제품 보기')
    assert.equal(rows(selector).length, 40)
    assert.equal(document.querySelector('.switch-compare-dock'), null)
    assert.equal(searchRuns().length, 2)
    assert.deepEqual(searchRuns()[1].body.initial_presented_product_ids, initialIds)
  })
}

test('EXPLORE: exactly 40 and zero candidates do not offer more; unknowns are retained', async () => {
  products = catalog(40)
  products[0].feed_type = null
  await explore()
  assert.equal(rows('.research-result-card').length, 40)
  assert.equal(button('제품 더 보기'), undefined)
  await click('조건 수정')
  await click('습식')
  await click('이 조건으로 찾기')
  assert.equal(rows('.research-result-card').length, 1, 'unknown feed type remains a candidate')
  await click('조건 수정')
  await click('키튼')
  await click('이 조건으로 찾기')
  assert.equal(rows('.research-result-card').length, 0)
  assert.equal(button('제품 더 보기'), undefined)
})

test('LOOKUP retains its 120-row batch and does not collect decisions', async () => {
  products = catalog(121)
  await act(async () => root.render(createElement(app.App)))
  const input = document.querySelector('input[type="search"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Product')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => input.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(rows('.research-result-card').length, 120)
  await click('제품 더 보기')
  assert.equal(rows('.research-result-card').length, 121)
  assert.equal(button('제품 더 보기'), undefined)
  await click(rows('.research-result-card')[120])
  await click('비교에 추가')
  assert.equal(searchRuns().length, 0)
  assert.equal(considerations().length, 0)
})

test('later candidates still respect the five-product comparison limit', async () => {
  await explore()
  await click('제품 더 보기')
  for (let index = 40; index < 45; index += 1) {
    await click(rows('.research-result-card')[index])
    await click('비교에 추가')
  }
  await click(rows('.research-result-card')[45])
  assert.equal(button('비교는 최대 5개까지 가능합니다').disabled, true)
  assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 5\/5/)
  assert.equal(considerations().length, 0)
})

test('production preview queries cannot replace fetch; dev fixtures never emit analytics', async () => {
  const fixtureInstallers = {
    demo: devApp.installDemoPreviewFetch,
    realpreview: devApp.installRealVisualPreviewFetch,
    stresspreview: devApp.installStressPreviewFetch,
  }
  for (const query of ['demo', 'realpreview', 'stresspreview']) {
    dom.reconfigure({ url: `https://catfood.test/?${query}=1` })
    const beforeFetch = window.fetch
    app.installDemoPreviewFetch()
    app.installRealVisualPreviewFetch()
    app.installStressPreviewFetch()
    assert.equal(app.isPreviewDataEnabled(), false)
    assert.equal(window.fetch, beforeFetch)
    assert.equal(devApp.isPreviewDataEnabled(), true)
    await devApp.createDecisionSearchRun({})
    await devApp.recordProductConsideration('run', products[0].product_id, 'detail_open')
    assert.equal(requests.length, 0, 'fixture mode must never send decision data')
    fixtureInstallers[query]()
    const response = await window.fetch('https://api.test/rest/v1/effective_product_catalog_summary')
    const fixtureRows = await response.json()
    assert.ok(fixtureRows.length > 0 && fixtureRows.length < 85, 'local fixtures remain usable')
    assert.equal(requests.length, 0, 'fixture catalog is served without external requests')
    window.fetch = beforeFetch
  }
})

test('production client bundle excludes fixture modules', async () => {
  const result = await build({ logLevel: 'silent', build: { write: false } })
  const modules = result.output.filter((item) => item.type === 'chunk').flatMap((item) => Object.keys(item.modules))
  assert.ok(modules.some((id) => id.endsWith('/src/main.tsx')))
  assert.equal(modules.some((id) => /\/(demo-data|demo-preview|real-visual-preview|stress-preview)\.ts$/.test(id)), false)
})

test('catalog loads all package options despite the API 1000-row cap', async () => {
  products = catalog(599)
  packageOptions = products.flatMap((product) => [100, 200].map((weight) => ({
    product_id: product.product_id, variant_id: `${product.product_id}_${weight}`,
    package_size_text: `${weight} g`, package_weight_g: weight, units_per_sale: 1,
  })))
  const loaded = await app.fetchCatalog()
  assert.equal(packageOptions.length, 1198)
  assert.equal(loaded.length, 599)
  assert.ok(loaded.every((product) => product.available_package_labels.length === 2))
  const queries = requests.filter((request) => request.path.endsWith('/switch_current_variant_options'))
  assert.deepEqual(queries.map((request) => new URLSearchParams(request.query).get('offset')), ['0', '1000'])
  packageFailureOffset = 1000
  const fallback = await app.fetchCatalog()
  assert.equal(fallback.length, 599, 'package failure must not hide the catalog')
  assert.ok(fallback.every((product) => product.available_package_labels.length === 0), 'partial pages must not appear to be a complete package list')
})
