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
let root, app, devApp, temp, requests, products, packageOptions, packageFailureOffset, catalogFailure
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
  catalogFailure = false
  requests = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.origin, 'https://api.test', 'tests must never contact production')
    requests.push({ path: url.pathname, query: url.search, body: init.body ? JSON.parse(init.body) : null })
    if (url.pathname.endsWith('/search-runs')) {
      return Response.json({ search_run_id: `run-${searchRuns().length}` })
    }
    if (url.pathname.endsWith('/considerations')) return Response.json({ ok: true })
    if (url.pathname.endsWith('/effective_product_catalog_summary')) {
      if (catalogFailure) return new Response('Data API 503: internal provenance should never be shown', { status: 503 })
      return Response.json(products)
    }
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

test('comparison criteria keeps unknown policy and OR recipe meaning without changing search eligibility', () => {
  const product = products[0]
  product.life_stage = 'all_life_stages'
  product.features = []
  product.recipe_details = ['chicken']

  const search = {
    feedType: '건식',
    lifeStage: 'adult',
    officialTargets: [],
    features: ['hairball'],
    recipeFamilies: [],
    grainFree: false,
  }
  const refine = { recipeDetails: ['duck', 'salmon'] }
  const relation = app.evaluateComparisonCriteria(product, search, refine)

  assert.deepEqual(relation.confirmedMatches, ['형태:건식'])
  assert.deepEqual(relation.unknowns, ['기능:hairball'])
  assert.deepEqual(relation.differences, [
    { kind: 'lifeStage', selectedValues: ['adult'], productValues: ['all_life_stages'] },
    { kind: 'recipeDetails', selectedValues: ['duck', 'salmon'], productValues: ['chicken'] },
  ])

  product.life_stage = null
  product.recipe_details = []
  const unknownRelation = app.evaluateComparisonCriteria(product, search, refine)
  assert.match(unknownRelation.unknowns.join(' · '), /제품 표기 생애주기/)
  assert.match(unknownRelation.unknowns.join(' · '), /주요 레시피/)
  assert.equal(unknownRelation.differences.length, 0)

  product.life_stage = 'adult'
  product.recipe_details = ['salmon']
  const orRelation = app.evaluateComparisonCriteria(product, search, refine)
  assert.match(orRelation.confirmedMatches.join(' · '), /세부:salmon/)
  assert.equal(orRelation.differences.some((item) => item.kind === 'recipeDetails'), false, 'one selected recipe match satisfies the OR refine relation')
})

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
  assert.doesNotMatch(document.body.textContent, /제조 업체와 공장 정보는 확인하지 못했습니다/)
  assert.equal([...document.querySelectorAll('summary')].some((node) => node.textContent.trim() === '추가 제조 정보 보기'), false)
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
  await click('조건 고르기')
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
  test(`${mode}: reach every candidate, compare later products, preserve unchanged reapply, and keep V1 tracking at 40`, async () => {
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
    if (mode === 'explore') {
      const closeDetailButton = button('돌아가기')
      assert.ok(closeDetailButton)
      await act(async () => {
        closeDetailButton.click()
        await waitForUi(
          () => document.querySelector('.detail-stage') === null
            && rows(selector).length === 80
            && document.activeElement?.dataset.productId === products[40].product_id,
          'expanded explore list and focused product restored after detail history back',
        )
      })
      assert.equal(rows(selector).length, 80, 'history restoration must finish before pagination becomes interactive')
      assert.equal(document.activeElement?.dataset.productId, products[40].product_id, 'focus returns to the product that opened detail')
    } else {
      await click('돌아가기')
    }
    await click('제품 더 보기')
    assert.equal(rows(selector).length, 85, 'pagination after restoration must not be overwritten by late history state')
    assert.equal(button('제품 더 보기'), undefined)
    assert.equal(searchRuns().length, 1, 'pagination is not a new search run')
    await click(rows(selector)[84])
    await click('비교에 추가')
    await click('비교 보기')
    assert.match(document.querySelector('.compare-stage').textContent, /Product 0(84|85)/)
    if (mode === 'explore') {
      const closeCompareButton = button('제품 목록으로')
      assert.ok(closeCompareButton)
      await act(async () => {
        closeCompareButton.click()
        await waitForUi(
          () => document.querySelector('.compare-stage') === null && rows(selector).length === 85,
          'expanded explore list restored after compare history back',
        )
      })
    } else {
      await click('제품 목록으로')
    }
    assert.equal(rows(selector).length, 85, 'returning from compare retains expanded results')
    assert.equal(considerations().length, 1)
    await click('조건 수정')
    if (mode === 'switch') await click('다음 →')
    await click(mode === 'explore' ? '이 조건으로 찾기' : '후보 제품 보기')
    assert.equal(rows(selector).length, 40)
    if (mode === 'explore') {
      assert.match(document.querySelector('.switch-compare-dock')?.textContent ?? '', /비교 2\/5/, 'unchanged EXPLORE reapply preserves the queued general comparison')
    } else {
      assert.match(document.querySelector('.switch-compare-dock')?.textContent ?? '', /비교 2\/5/, 'unchanged SWITCH reapply also preserves its independent comparison')
    }
    assert.equal(searchRuns().length, 2)
    assert.deepEqual(searchRuns()[1].body.initial_presented_product_ids, initialIds)
  })
}



test('EXPLORE keeps unknown candidates, orders confirmed conditions first, and explains result scope', async () => {
  products = catalog(3)
  products[0].features = ['hairball', 'digestive']
  products[1].features = ['hairball']
  products[2].features = []
  const params = new URLSearchParams({ view: 'workspace', mode: 'explore', applied: '1', features: 'hairball,digestive' })
  dom.reconfigure({ url: 'https://catfood.test/?' + params })
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => rows('.research-result-card').length === 3, 'ranked explore candidates rendered')
  assert.deepEqual(rows('.research-result-card').map((card) => card.dataset.productId), products.map((product) => product.product_id))
  const summary = document.querySelector('.research-results-heading span')?.textContent ?? ''
  assert.match(summary, /3개의 제품/)
  assert.match(summary, /확인된 조건이 많은 순/)
  assert.match(summary, /미확인 조건이 있는 제품도 포함/)
  assert.match(rows('.research-result-card')[2].textContent, /미확인 조건/)
})

test('catalog failure is visible on Home and EXPLORE condition entry, masks internal errors, and retries', async () => {
  catalogFailure = true
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => document.body.textContent.includes('제품 목록을 불러오지 못했습니다.'), 'home catalog failure')
  assert.match(document.querySelector('.home-catalog-status')?.textContent ?? '', /제품 목록 조회 실패/)
  assert.doesNotMatch(document.body.textContent, /Data API|503|internal provenance/)
  await click('조건 고르기')
  const conditionAlert = document.querySelector('.catalog-inline-state[role="alert"]')
  assert.ok(conditionAlert)
  assert.match(conditionAlert.textContent, /제품 목록을 불러오지 못했습니다/)
  assert.match(conditionAlert.textContent, /선택한 조건은 그대로 유지됩니다/)
  assert.doesNotMatch(conditionAlert.textContent, /Data API|503|internal provenance/)
  catalogFailure = false
  await click(conditionAlert.querySelector('button'))
  await waitForUi(() => document.querySelector('.catalog-inline-state[role="alert"]') === null && document.body.textContent.includes('제품 85개'), 'catalog retry succeeded')
  assert.equal(document.querySelector('.catalog-inline-state[role="alert"]'), null)
})

test('quick view moves focus to close and returns it to the opening product without changing list scroll', async () => {
  await explore()
  const scroller = document.querySelector('.research-results-scroll')
  const card = rows('.research-result-card')[12]
  scroller.scrollTop = 137
  card.focus()
  await click(card)
  await waitForUi(() => document.activeElement?.textContent.includes('닫기'), 'quick view close receives focus')
  assert.equal(document.activeElement?.closest('.research-quick-view') !== null, true)
  assert.equal(scroller.scrollTop, 137)
  await click(document.activeElement)
  await waitForUi(() => document.activeElement?.dataset.productId === products[12].product_id, 'focus returns to opening product')
  assert.equal(document.activeElement?.dataset.productId, products[12].product_id)
  assert.equal(scroller.scrollTop, 137)
})

test('EXPLORE guidance keeps the unknown policy in one place and labels recipe refine separately', async () => {
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => document.body.textContent.includes('현재 확인된 제품 85개'), 'home catalog count')
  assert.match(document.body.textContent, /사료 형태·연령과 원하는 조건으로\./)
  assert.doesNotMatch(document.body.textContent, /명백히 충돌하는 제품만 제외/)

  await click('조건 고르기')
  const editorText = document.body.textContent
  assert.match(editorText, /사료 형태와 연령, 원하는 조건을 골라주세요\./)
  assert.equal((editorText.match(/선택한 조건 정보가 없는 제품도 결과에 남습니다\./g) ?? []).length, 1)
  assert.doesNotMatch(editorText, /명백히 충돌하는 제품만 제외|미확인은 남겨둡니다|조건 정보가 없는 제품도 결과에 포함됩니다/)
  assert.match(editorText, /제품에 표기된 연령 구분을 기준으로 합니다\./)
  assert.match(editorText, /Grain-Free 표기가 없다고 해서 곡물이 들어 있다고 판단하지 않습니다\./)

  await click('이 조건으로 찾기')
  const refineText = document.body.textContent
  assert.match(refineText, /주요 레시피/)
  assert.match(refineText, /선택한 레시피 중 하나 이상이 확인된 제품만 봅니다\./)
  assert.doesNotMatch(refineText, /명백히 충돌하는 제품만 제외/)
})

test('LOOKUP empty result points back to the existing search input without changing search behavior', async () => {
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => document.body.textContent.includes('현재 확인된 제품 85개'), 'home catalog count')
  const homeInput = document.querySelector('.home-entry-search input')
  assert.ok(homeInput)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(homeInput, 'does-not-exist')
    homeInput.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => homeInput.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  await waitForUi(() => document.body.textContent.includes('검색 결과가 없습니다.'), 'lookup empty state')
  const empty = document.querySelector('.state-message')
  assert.match(empty.textContent, /검색어를 바꾸거나 제품명을 더 짧게 입력해 보세요\./)
  assert.doesNotMatch(document.body.textContent, /데이터 연결됨/)
  const edit = [...empty.querySelectorAll('button')].find((node) => node.textContent.includes('검색어 수정'))
  await click(edit)
  assert.equal(document.activeElement?.classList.contains('lookup-input'), true)
})

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
  const empty = document.querySelector('.state-message')
  assert.match(empty.textContent, /조건에 맞는 제품이 없습니다\.조건을 바꾸어 다시 찾아보세요\./)
  assert.doesNotMatch(empty.textContent, /임의로 완화/)
  const edit = [...empty.querySelectorAll('button')].find((node) => node.textContent.includes('조건 수정'))
  await click(edit)
  assert.match(document.body.textContent, /선택한 조건 정보가 없는 제품도 결과에 남습니다\./)
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

test('lookup search ignores spacing, preserves and/& behavior, and supports confirmed brand aliases without changing identity', () => {
  const lookupProducts = catalog(9)
  Object.assign(lookupProducts[0], { brand: '로얄캐닌', canonical_name: '인도어' })
  Object.assign(lookupProducts[1], { brand: '카니보', canonical_name: '송어 & 연어' })
  Object.assign(lookupProducts[2], { brand: 'Test', canonical_name: 'Sea Bass & Sea Bream' })
  Object.assign(lookupProducts[3], { brand: 'Test', canonical_name: 'Candy Mix' })
  Object.assign(lookupProducts[4], { brand: 'Test', canonical_name: 'Alpha One' })
  Object.assign(lookupProducts[5], { brand: 'Test', canonical_name: 'Alpha Two' })
  Object.assign(lookupProducts[6], { brand: 'Other', canonical_name: 'Standard Recipe' })
  Object.assign(lookupProducts[7], { brand: 'AATU', canonical_name: 'Salmon' })
  Object.assign(lookupProducts[8], { brand: "Hill's", canonical_name: 'Adult Chicken' })

  assert.deepEqual(app.lookupCatalog(lookupProducts, '로얄 캐닌').map((product) => product.product_id), [lookupProducts[0].product_id])
  assert.deepEqual(app.lookupCatalog(lookupProducts, '로얄캐닌').map((product) => product.product_id), [lookupProducts[0].product_id])
  assert.deepEqual(app.lookupCatalog(lookupProducts, '카니보송어&연어').map((product) => product.product_id), [lookupProducts[1].product_id])

  assert.deepEqual(app.lookupCatalog(lookupProducts, '아투').map((product) => product.product_id), [lookupProducts[7].product_id])
  for (const query of ['힐스', 'Hills', 'Hill’s']) {
    assert.deepEqual(app.lookupCatalog(lookupProducts, query).map((product) => product.product_id), [lookupProducts[8].product_id])
  }
  assert.equal(lookupProducts[7].brand, 'AATU')
  assert.equal(lookupProducts[8].brand, "Hill's")
  assert.deepEqual(app.lookupCatalog(lookupProducts, '힐즈'), [], 'unconfirmed similar spellings are not added as fuzzy aliases')

  for (const query of ['Sea Bass & Sea Bream', 'Sea Bass&Sea Bream', 'Sea Bass and Sea Bream', 'sea bass AND SEA bream']) {
    assert.deepEqual(app.lookupCatalog(lookupProducts, query).map((product) => product.product_id), [lookupProducts[2].product_id])
  }

  assert.deepEqual(app.lookupCatalog(lookupProducts, '   '), [])
  assert.deepEqual(app.lookupCatalog(lookupProducts, 'c&y'), [], 'and inside a word must not normalize to &')
  assert.deepEqual(
    app.lookupCatalog([lookupProducts[3], lookupProducts[6]], 'and').map((product) => product.product_id),
    [lookupProducts[3].product_id, lookupProducts[6].product_id],
    'existing substring matches for and inside words stay available in input order',
  )
  assert.deepEqual(
    app.lookupCatalog(lookupProducts, 'alpha').map((product) => product.product_id),
    [lookupProducts[4].product_id, lookupProducts[5].product_id],
    'existing substring matching and input order stay unchanged',
  )
})

test('EXPLORE direct list compare records compare_add without opening quick view or creating a new search run', async () => {
  await explore()
  const direct = rows('.research-result-compare')[0]
  assert.ok(direct)
  const searchesBefore = searchRuns().length

  direct.focus()
  await click(direct)
  await waitForUi(() => considerations().length === 1, 'direct compare consideration recorded')

  assert.equal(document.activeElement, direct)
  assert.equal(document.querySelector('.research-quick-view'), null)
  assert.equal(document.querySelector('.detail-stage'), null)
  assert.equal(searchRuns().length, searchesBefore)
  assert.equal(considerations()[0].body.signal_type, 'compare_add')
  assert.equal(considerations()[0].body.product_id, products[0].product_id)

  await click(direct)
  assert.equal(considerations().length, 1, 'removing a compared product does not emit another compare_add')
  assert.equal(document.querySelector('.switch-compare-dock'), null)
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

for (const confirmedCount of [3, 4]) {
  for (const unknownCount of [2, 3]) {
    test('EXPLORE relation summary: ' + confirmedCount + ' confirmed and ' + unknownCount + ' unknown retains complete quick view', async () => {
      products = catalog(1)
      products[0].official_targets = ['indoor']
      products[0].features = confirmedCount === 4 ? ['hairball'] : []
      const missing = ['digestive', 'urinary', 'skin_coat'].slice(0, unknownCount)
      const features = [...products[0].features, ...missing]
      const params = new URLSearchParams({ view: 'workspace', mode: 'explore', applied: '1', feed: '건식', age: 'adult', targets: 'indoor', features: features.join(',') })
      dom.reconfigure({ url: 'https://catfood.test/?' + params })
      await act(async () => root.render(createElement(app.App)))
      await waitForUi(() => rows('.research-result-card').length === 1, 'candidate rendered')
      const card = document.querySelector('.research-result-card')
      const confirmed = card.querySelector('.is-confirmed strong').textContent
      const unknown = card.querySelector('.is-unknown strong').textContent
      assert.equal(confirmed, '건식 · 성묘 · 실내묘' + (confirmedCount === 4 ? ' 외 1개' : ''))
      assert.equal(unknown, '소화 · 요로' + (unknownCount === 3 ? ' 외 1개' : ''))
      await click(card)
      const relations = rows('.quick-view-section .definition')
      const fullConfirmed = relations.find((node) => node.querySelector('dt')?.textContent === '확인된 조건').querySelector('dd').textContent
      const fullUnknown = relations.find((node) => node.querySelector('dt')?.textContent === '미확인 조건').querySelector('dd').textContent
      assert.equal(fullConfirmed, '건식 · 성묘 · 실내묘' + (confirmedCount === 4 ? ' · 헤어볼' : ''))
      assert.equal(fullUnknown, '소화 · 요로' + (unknownCount === 3 ? ' · 피부·피모' : ''))
      assert.equal(new URL(window.location.href).searchParams.get('features'), features.join(','))
    })
  }
}
