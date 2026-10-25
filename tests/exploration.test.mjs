import { collectionFixtureFetch, activateCollectionFixture } from './collection-fixture.mjs'
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
// jsdom has no layout scrolling; actual visibility and fixed-dock clearance are checked in Chrome.
window.HTMLElement.prototype.scrollIntoView = () => {}
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
let root, app, devApp, temp, requests, products, packageOptions, packageFailureOffset, catalogFailure, energyData, energyFailure, energyDeferred
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

beforeEach(async () => {
  dom.reconfigure({ url: 'https://catfood.test/' })
  sessionStorage.clear()
  products = catalog(85)
  packageOptions = []
  packageFailureOffset = null
  catalogFailure = false
  energyData = []; energyFailure = false; energyDeferred = null
  requests = []
  globalThis.fetch = collectionFixtureFetch(app, async (input, init = {}) => {
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
    if (url.pathname.endsWith('/catalog_package_options')) {
      const offset = Number(url.searchParams.get('offset') ?? 0)
      if (offset === packageFailureOffset) return new Response('Temporary failure', { status: 503 })
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 1000)
      return Response.json(packageOptions.slice(offset, offset + limit))
    }
    if (url.pathname.endsWith('/compare_product_nutrition') && url.searchParams.get('limit') === '1000') {
      if (energyDeferred) return energyDeferred
      if (energyFailure) return new Response('Private source detail must stay hidden', {status:503})
      const offset=Number(url.searchParams.get('offset') ?? 0)
      return Response.json(energyData.slice(offset,offset+1000))
    }
    return Response.json([])
  })
  window.fetch = globalThis.fetch
  await activateCollectionFixture(app)
  root = createRoot(document.getElementById('root'))
})
afterEach(async () => { await act(async () => root.unmount()) })

const searchRuns = () => requests.filter((request) => request.path.endsWith('/search-runs'))
const considerations = () => requests.filter((request) => request.path.endsWith('/considerations'))
const rows = (selector) => [...document.querySelectorAll(selector)]
const button = (text) => rows('button').find((element) => element.textContent.trim() === text) ?? rows('button').find((element) => element.textContent.includes(text))
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
    feedType: ['건식'],
    lifeStage: ['adult'],
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
    if (url.pathname.endsWith('/compare_product_ingredients_scoped')) {
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
    if (url.pathname.endsWith('/compare_product_ingredients_scoped')) {
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
    if (new URL(String(input)).pathname.endsWith('/compare_product_nutrition_scoped')) {
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
  await click('사용 규격을 모르겠어요')
  await click('특별히 바꾸고 싶은 점 없음')
  await click('후보 제품 보기')
}

for (const mode of ['explore', 'switch']) {
  test(`${mode}: reach every candidate, compare later products, preserve unchanged reapply, and report bounded V2 interaction context beyond 40`, async () => {
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
    assert.ok(considerations().some((entry) => entry.body.product_id === products[mode === 'switch' ? 41 : 40].product_id && entry.body.context_kind === 'load_more'), '41st product has bounded additional context')
    if (mode === 'explore') {
      const closeDetailButton = button('돌아가기')
      assert.ok(closeDetailButton)
      await act(async () => {
        closeDetailButton.click()
        await waitForUi(
          () => document.querySelector('.detail-stage') === null
            && rows(selector).length === 80
            && document.activeElement === document.querySelector('.quick-view-topline button'),
          'expanded explore list and quick view focus restored after detail history back',
        )
      })
      assert.equal(rows(selector).length, 80, 'history restoration must finish before pagination becomes interactive')
      await click('닫기 ×')
      await waitForUi(() => document.activeElement?.dataset.productId === products[40].product_id, 'closing quick view returns focus to the product that opened detail')
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
    await click(mode === 'switch' ? '현재 사료와 비교' : '비교 보기')
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
      await click('후보 목록으로')
    }
    assert.equal(rows(selector).length, 85, 'returning from compare retains expanded results')
    assert.ok(considerations().some((entry) => entry.body.signal_type === 'compare_view'))
    await click('조건 수정')
    await click(mode === 'explore' ? '이 조건으로 찾기' : '후보 제품 보기')
    assert.equal(rows(selector).length, 40)
    if (mode === 'explore') {
      assert.match(document.querySelector('.switch-compare-dock')?.textContent ?? '', /비교 2\/5/, 'unchanged EXPLORE reapply preserves the queued general comparison')
    } else {
      assert.match(document.querySelector('.switch-compare-dock')?.textContent ?? '', /담은 후보 2\/5/, 'unchanged SWITCH reapply also preserves its independent comparison')
    }
    assert.equal(searchRuns().length, 1, 'unchanged reapply reconnects the same valid run')
    assert.deepEqual(searchRuns()[0].body.initial_presented_product_ids, initialIds)
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
  assert.match(document.querySelector('.result-priority-note').textContent, /고른 조건이 더 많이 확인된 제품부터/)
  assert.match(document.querySelector('.result-priority-note').textContent, /표기가 없는 제품도 함께 봅니다/)
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
  assert.doesNotMatch(document.body.textContent, /명백히 충돌하는 제품만 제외/)

  await click('조건 고르기')
  const editorText = document.body.textContent
  assert.match(editorText, /필요한 항목만 골라주세요\./)
  assert.equal((editorText.match(/여러 개 고르면 그중 하나에 해당하는 제품을 찾습니다\. 표기가 없는 제품도 함께 봅니다\./g) ?? []).length, 1)
  assert.doesNotMatch(editorText, /명백히 충돌하는 제품만 제외|미확인은 남겨둡니다|조건 정보가 없는 제품도 결과에 포함됩니다/)
  assert.doesNotMatch(editorText, /제품에 표기된 연령 구분을 기준으로 합니다\./)
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
  assert.match(document.body.textContent, /여러 개 고르면 그중 하나에 해당하는 제품을 찾습니다\. 표기가 없는 제품도 함께 봅니다\./)
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
  assert.equal(considerations().filter((entry) => entry.body.signal_type === 'compare_add').length, 5, 'only the five explicit additions are collected')
  assert.ok(considerations().every((entry) => entry.body.presented_product_ids.length <= 40))
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
  const queries = requests.filter((request) => request.path.endsWith('/catalog_package_options'))
  assert.deepEqual(queries.map((request) => new URLSearchParams(request.query).get('offset')), ['0', '1000'])
  assert.ok(queries.every((request) => new URLSearchParams(request.query).get('select') === 'product_id,variant_id,package_size_text,package_weight_g,units_per_sale,sale_total_weight_g,display_rank'))
  assert.equal(requests.some((request) => request.path.endsWith('/switch_current_variant_options')), false, 'catalog packaging must not use the full SWITCH view')
  packageFailureOffset = 1000
  const fallback = await app.fetchCatalog()
  assert.equal(fallback.length, 599, 'package failure must not hide the catalog')
  assert.ok(fallback.every((product) => product.available_package_labels.length === 0), 'partial pages must not appear to be a complete package list')
  assert.equal(requests.some((request) => request.path.endsWith('/switch_current_variant_options')), false, 'failed package requests must not retry the full SWITCH view')
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


test('reviewed bilingual brand searches find every product even when product names contain no brand', () => {
  const cases = [
    ['내추럴발란스', 'natural balance'],
    ['로얄캐닌', 'royal canin'],
    ['몬지', 'monge'],
    ['쉐지애', 'schesir'],
    ['아카나', 'acana'],
    ['오리젠', 'orijen'],
    ['지위픽', 'ZIWI Peak'],
    ['파미나', 'farmina'],
    ['퓨리나', 'purina'],
    ['힐스', "Hill's"],
    ['AATU', '아투'],
    ['Addiction', '어딕션'],
    ['Advance', '어드밴스'],
    ['AIXIA', '아이시아'],
    ['Alleva', '알레바'],
    ['Almo Nature', '알모네이쳐'],
    ['AvoDerm', '아보덤'],
    ['Best Breed', '베스트브리드'],
    ['Blackwood', '블랙우드'],
    ['Boreal', '보레알'],
    ['Brit', '브릿'],
    ['Canada Fresh', '캐나다프레쉬'],
    ['Carna4', '카르나4'],
    ['Carnilove', '카니러브'],
    ['Caru', '카루'],
    ["Cat's Taste", '캣츠테이스트'],
    ['Catit', '캣잇'],
    ['Earthborn Holistic', '어스본홀리스틱'],
    ['Element Series', '엘레멘트'],
    ['Feline Natural', '필라인 내추럴'],
    ['Gather', '게더'],
    ['GO! SOLUTIONS', '고 솔루션'],
    ['Husse', '후새'],
    ['INABA / CIAO', '이나바'],
    ['Instinct', '인스팅트'],
    ['iti', '이티'],
    ['Josera', '요세라'],
    ['KONGO', '콩고'],
    ['LEONARDO', '레오나르도'],
    ['Lotus', '로투스'],
    ['Lucy Pet', '루시펫'],
    ['Miamor', '미아모아'],
    ['Natural Greatness', '내추럴그레이트니스'],
    ['NOW FRESH', '나우프레쉬'],
    ['Nulo', '뉴로'],
    ['NurturePRO', '너처프로'],
    ['Nutrience', '뉴트리언스'],
    ['NutriSource', '뉴트리소스'],
    ['Nutro', '뉴트로'],
    ['Open Farm', '오픈팜'],
    ['Pro-Nutrition', '프로뉴트리션'],
    ['PureVita', '퓨어비타'],
    ['Purina Cat Chow', '퓨리나 캣차우'],
    ['Purina Pro Plan', '퓨리나 프로플랜'],
    ['RANOVA', '라노바'],
    ['RAWZ', '로우즈'],
    ['SHEBA', '쉬바'],
    ['Signature7', '시그니처7'],
    ['Snappy Tom', '스내피톰'],
    ["Stella & Chewy's", '스텔라앤츄이스'],
    ['Taste of the Wild', '테이스트 오브 더 와일드'],
    ['Terra Felis', '테라펠리스'],
    ['The Honest Kitchen', '디어니스트키친'],
    ['Thrive', '쓰라이브'],
    ['Vital Essentials', '바이탈에센셜'],
    ['Wellness', '웰니스'],
    ['Weruva', '웨루바'],
    ['WHISKAS', '위스카스'],
    ['Wishbone', '위시본'],
    ['Zealandia', '질란디아'],
  ]
  const fixture = catalog(cases.length * 2)
  for (const [index, [brand]] of cases.entries()) {
    Object.assign(fixture[index * 2], { brand, canonical_name: 'Recipe A' })
    Object.assign(fixture[index * 2 + 1], { brand, canonical_name: 'Recipe B' })
  }
  const identitiesBefore = structuredClone(fixture)
  for (const [brand, query] of cases) {
    const expected = fixture.filter(product => product.brand === brand || (brand === '퓨리나' && product.brand.startsWith('Purina '))).map(product => product.product_id)
    const found = app.lookupCatalog(fixture, query).map(product => product.product_id)
    assert.deepEqual(found, expected, query)
    assert.deepEqual(app.lookupCatalog(fixture, query + ' Recipe A').map(product => product.product_id), expected.filter((_, index) => index % 2 === 0), query + ' with product name')
  }
  assert.deepEqual(fixture, identitiesBefore, 'search aliases never rewrite catalog identity or facts')
})

test('Purina parent searches include its lines while line and sibling-brand searches remain separate', () => {
  const fixture = catalog(8)
  const brands = ['퓨리나', 'Purina Cat Chow', 'Purina Pro Plan', 'GO! SOLUTIONS', 'NOW FRESH', 'NutriSource', 'PureVita', 'Element Series']
  fixture.forEach((product, index) => Object.assign(product, { brand: brands[index], canonical_name: 'Recipe' }))
  const ids = query => app.lookupCatalog(fixture, query).map(product => product.product_id)
  for (const query of ['퓨리나', 'Purina', 'PURINA']) assert.deepEqual(ids(query), fixture.slice(0, 3).map(product => product.product_id))
  for (const query of ['퓨리나 캣차우', 'purina cat chow', '캣차우']) assert.deepEqual(ids(query), [fixture[1].product_id])
  for (const query of ['퓨리나 프로플랜', 'Purina Pro Plan', '프로플랜']) assert.deepEqual(ids(query), [fixture[2].product_id])
  for (const [query, index] of [['고솔루션', 3], ['Go Solutions', 3], ['나우프레쉬', 4], ['뉴트리소스', 5], ['퓨어비타', 6], ['엘레멘트', 7]]) assert.deepEqual(ids(query), [fixture[index].product_id], query)
})

test('brand punctuation variants are explicit and unconfirmed phonetic spellings stay unregistered', () => {
  const fixture = catalog(4)
  fixture.forEach(product => { product.canonical_name = 'Recipe' })
  Object.assign(fixture[0], { brand: "Stella & Chewy's" })
  Object.assign(fixture[1], { brand: "Cat's Taste" })
  Object.assign(fixture[2], { brand: 'Pro-Nutrition' })
  Object.assign(fixture[3], { brand: 'Naturo' })
  for (const query of ['Stella and Chewys', 'Stella & Chewy’s', '스텔라 앤 츄이스']) assert.deepEqual(app.lookupCatalog(fixture, query).map(product => product.product_id), [fixture[0].product_id])
  for (const query of ['Cats Taste', 'Cat’s Taste']) assert.deepEqual(app.lookupCatalog(fixture, query).map(product => product.product_id), [fixture[1].product_id])
  assert.deepEqual(app.lookupCatalog(fixture, 'Pro Nutrition Recipe').map(product => product.product_id), [fixture[2].product_id])
  assert.deepEqual(app.lookupCatalog(fixture, '나투로'), [], 'unverified Korean spelling is not guessed')
  assert.deepEqual(app.lookupCatalog(fixture, 'Naturo').map(product => product.product_id), [fixture[3].product_id])
})


test('EXPLORE previews additional choices and explains their real effect without removing unknown products', async () => {
  products = catalog(3)
  products[2].features = ['weight_management']
  await act(async () => root.render(createElement(app.App)))
  await click('조건 고르기')
  const toggle = document.querySelector('.mobile-additional-toggle')
  assert.match(toggle.textContent, /실내묘 · 중성화묘 · 헤어볼 · 체중 관리/)
  assert.match(toggle.textContent, /펼치기/)
  await click(toggle)
  await click('체중 관리')
  const beforeApply = window.location.href
  await click(toggle)
  assert.match(document.querySelector('.mobile-additional-summary').textContent, /체중 관리/)
  assert.equal(window.location.href, beforeApply, 'draft disclosure does not apply criteria')
  await click('이 조건으로 찾기')
  assert.equal(rows('.research-result-card').length, 3)
  assert.equal(rows('.research-result-card')[0].dataset.productId, products[2].product_id)
  assert.match(document.querySelector('.result-priority-note').textContent, /체중 관리 표기가 있는 제품부터/)
  assert.match(document.querySelector('.result-priority-note').textContent, /표기가 없는 제품도 함께 봅니다/)
})

test('EXPLORE recipe shortlist, full list and name search preserve the existing OR refine and basket', async () => {
  products = catalog(4)
  products[0].recipe_details = ['duck', 'turkey', 'lamb', 'beef', 'rabbit', 'tuna', 'herring', 'cod', 'mackerel', 'trout']
  products[1].recipe_details = ['salmon']
  products[3].recipe_details = ['chicken']
  await explore()
  await click(rows('.research-result-compare')[0])
  const beforeBrowse = window.location.href
  assert.equal(rows('.recipe-detail-grid:not(.brand-refine-grid) .choice').length, 8)
  await click('레시피 전체 보기')
  assert.equal(rows('.recipe-detail-grid:not(.brand-refine-grid) .choice').length, 12)
  assert.equal(window.location.href, beforeBrowse, 'opening the complete list changes no search or basket state')
  const input = document.querySelector('.recipe-search:not(.brand-search)')
  async function type(value) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  await type('존재하지않는레시피')
  assert.equal(rows('.recipe-detail-grid:not(.brand-refine-grid) .choice').length, 0)
  assert.match(document.querySelector('[role="status"]').textContent, /이 이름으로 확인된 레시피가 없습니다/)
  assert.equal(window.location.href, beforeBrowse)
  await type('연어')
  assert.equal(rows('.recipe-detail-grid:not(.brand-refine-grid) .choice').length, 1)
  await click(document.querySelector('.recipe-detail-grid:not(.brand-refine-grid) .choice'))
  assert.deepEqual(rows('.research-result-card').map(node => node.dataset.productId), [products[1].product_id])
  await type('대구')
  await click([...document.querySelectorAll('.recipe-detail-grid:not(.brand-refine-grid) .choice')].find(node => node.textContent === '대구'))
  assert.equal(rows('.research-result-card').length, 2, 'either selected recipe satisfies the existing refine')
  assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 1\/5/)
  assert.equal(new URL(window.location.href).searchParams.get('recipeDetails'), 'salmon,cod')
})

test('ingredient exclusion keeps reviewed and unknown products, excludes confirmed direct or flavor evidence, and preserves positive ordering', () => {
  const [direct, flavor, reviewed, unknown, other] = products.slice(0, 5)
  direct.confirmed_present_ingredient_terms = ['chicken']
  direct.direct_evidence_ingredient_terms = ['chicken']
  flavor.confirmed_present_ingredient_terms = ['chicken']
  flavor.flavor_associated_ingredient_terms = ['chicken']
  reviewed.reviewed_not_found_ingredient_terms = ['chicken', 'duck']
  unknown.insufficient_evidence_ingredient_terms = ['chicken']
  unknown.reviewed_not_found_ingredient_terms = ['duck']
  other.confirmed_present_ingredient_terms = ['duck']
  reviewed.features = ['hairball']
  const source = [direct, flavor, reviewed, unknown, other]
  const before = JSON.stringify(source)
  const search = { ...app.INITIAL_SEARCH, ingredientAvoidTerms: ['chicken'], features: ['hairball'] }
  const result = app.evaluateCatalog(source, search)
  assert.deepEqual(result.map(item => item.product.product_id), [reviewed.product_id, unknown.product_id, other.product_id])
  assert.deepEqual(result[0].ingredientReviewedNotFound, ['chicken'])
  assert.deepEqual(result[1].ingredientInsufficient, ['chicken'])
  assert.equal(result[0].matchCount, 1, 'not-found is not a positive match or quality score')
  assert.equal(result[1].matchCount, 0)
  assert.equal(JSON.stringify(source), before, 'API rows remain untouched')
  const multiple = app.evaluateCatalog(source, { ...search, ingredientAvoidTerms: ['chicken', 'duck'] })
  assert.deepEqual(multiple.map(item => item.product.product_id), [reviewed.product_id, unknown.product_id])
  assert.deepEqual(multiple[1].ingredientReviewedNotFound, ['duck'])
  assert.deepEqual(multiple[1].ingredientInsufficient, ['chicken'])
  assert.equal(app.evaluateCatalog(source, { ...app.INITIAL_SEARCH }).length, 5)
  assert.equal(app.evaluateCatalog(source, { ...search, ingredientAvoidTerms: ['poultry'] }).length, 5, 'unsupported families are not expanded into chicken')
})

test('comparison evaluates excluded ingredients without deleting manual products or declaring absence', () => {
  const product = products[0]
  product.confirmed_present_ingredient_terms = ['chicken']
  product.flavor_associated_ingredient_terms = ['chicken']
  product.reviewed_not_found_ingredient_terms = ['duck']
  const search = { ...app.INITIAL_SEARCH, ingredientAvoidTerms: ['chicken', 'duck', 'egg'] }
  const relation = app.evaluateComparisonCriteria(product, search)
  assert.deepEqual(relation.ingredientConflicts, ['chicken'])
  assert.deepEqual(relation.ingredientReviewedNotFound, ['duck'])
  assert.deepEqual(relation.ingredientInsufficient, ['egg'], 'missing assertion stays unknown')
  assert.deepEqual(relation.confirmedMatches, [])
  assert.deepEqual(relation.differences, [], 'ingredient presence is not a product-label difference')
  assert.equal(app.evaluateCatalog([product], search).length, 0)
  assert.equal(app.INGREDIENT_AVOID_OPTIONS.length, 23)
})

test('ingredient editor, applied summary, results, and analytics preserve the three evidence states without detail requests', async () => {
  products = products.slice(0, 4)
  products[0].confirmed_present_ingredient_terms = ['chicken']
  products[0].direct_evidence_ingredient_terms = ['chicken']
  products[1].reviewed_not_found_ingredient_terms = ['chicken']
  products[2].insufficient_evidence_ingredient_terms = ['chicken']
  products[3].reviewed_not_found_ingredient_terms = ['chicken']
  dom.reconfigure({ url: 'https://catfood.test/?view=workspace&mode=explore' })
  await act(async () => root.render(createElement(app.App)))
  assert.equal(document.querySelector('#explore-additional-conditions').hidden, true)
  const section = rows('.filter-section').find(node => node.textContent.includes('피하고 싶은 원료'))
  assert.ok(section)
  assert.equal(section.querySelectorAll('.choice').length, 8)
  await click([...section.querySelectorAll('.choice')].find(node => node.textContent === '닭'))
  await click('원료 전체 보기')
  const boar = [...section.querySelectorAll('.choice')].find(node => node.textContent === '멧돼지')
  await click(boar)
  await click('원료 접어두기')
  assert.ok([...section.querySelectorAll('.choice')].some(node => node.textContent === '멧돼지' && node.getAttribute('aria-pressed') === 'true'), 'selected extra ingredient remains visible')
  await click([...section.querySelectorAll('.choice')].find(node => node.textContent === '멧돼지'))
  await click('이 조건으로 찾기')
  const result = document.querySelector('.research-results')
  assert.match(result.textContent, /검토 자료에서 못 찾음/)
  assert.match(result.textContent, /원료 미확인/)
  assert.equal(rows('.research-result-card').length, 3)
  assert.equal(document.querySelector('.result-priority-note'), null, 'exclude-only search is not described as positive sorting')
  assert.match(window.location.search, /avoidIngredients=chicken/)
  await click(document.querySelector('.research-result-card[data-product-id="' + products[1].product_id + '"]'))
  assert.match(document.querySelector('.research-quick-view').textContent, /검토 자료에서 못 찾음/)
  assert.equal(document.querySelector('.research-quick-view').textContent.includes('확인된 항목 없음'), false)
  await click('닫기 ×')
  await click(document.querySelector('.research-result-card[data-product-id="' + products[2].product_id + '"]'))
  assert.match(document.querySelector('.research-quick-view').textContent, /원료 미확인/)
  await click('닫기 ×')
  assert.equal(requests.some(request => /compare_product_(nutrition|ingredients)/.test(request.path)), false)
  const criteria = searchRuns().at(-1).body.criteria_snapshot
  assert.ok(criteria.some(item => item.axis === 'ingredient' && item.value === 'chicken' && item.role === 'ingredient_avoid'))
  await click('조건 수정')
  await click('초기화')
  assert.equal(window.location.search.includes('avoidIngredients=chicken'), true, 'draft reset does not overwrite last applied criteria')
  await click('이 조건으로 찾기')
  assert.equal(rows('.research-result-card').length, 4)
  assert.equal(window.location.search.includes('avoidIngredients'), false)
})

test('brand refine uses exact OR identities, intersects other filters and does not change positive ordering', () => {
  const [a,b,c] = catalog(3)
  a.brand='Purina'; b.brand='Purina Pro Plan'; c.brand='로얄캐닌'
  a.recipe_details=['salmon']; b.recipe_details=['duck']; c.recipe_details=['salmon']
  b.features=['hairball']; c.confirmed_present_ingredient_terms=['chicken']
  const search={...app.INITIAL_SEARCH, features:['hairball']}
  const ids=(search,refine)=>app.evaluateCatalog([a,b,c],search,refine).map(x=>x.product.product_id)
  assert.deepEqual(ids(search,{recipeDetails:[],brands:['Purina','Purina Pro Plan']}),[b.product_id,a.product_id])
  assert.deepEqual(ids(search,{recipeDetails:[],brands:['Purina']}),[a.product_id], 'parent alias is not product identity')
  assert.deepEqual(ids(search,{recipeDetails:['salmon'],brands:['Purina','Purina Pro Plan']}),[a.product_id])
  assert.deepEqual(ids({...search,ingredientAvoidTerms:['chicken']},{recipeDetails:[],brands:['로얄캐닌']}),[])
  assert.deepEqual(ids(search,{recipeDetails:[],brands:[]}),ids(search,{recipeDetails:[]}))
  const relation=app.evaluateComparisonCriteria(c,search,{recipeDetails:[],brands:['Purina']})
  assert.deepEqual(relation.differences,[{kind:'brand',selectedValues:['Purina'],productValues:['로얄캐닌']}])
  assert.equal(app.matchesBrandQuery('로얄캐닌','Royal Canin'),true)
  assert.equal(app.matchesBrandQuery('파미나','farmina'),true)
  assert.equal(app.matchesBrandQuery('로얄캐닌','전혀다른브랜드'),false)
})

test('brand selector search, multiple selection, zero-result recovery and condition reapply preserve basket and avoid new reads', async () => {
  products=catalog(3)
  products[0].brand='로얄캐닌'; products[1].brand='파미나'; products[2].brand='AATU'
  products[0].recipe_details=['salmon']; products[1].recipe_details=['duck']
  await explore()
  await click(rows('.research-result-compare')[0])
  const basket=app.parseNavigationState(window.location.search).compareIds
  const dataReads=()=>requests.filter(r=>r.path.startsWith('/rest/')).length
  const initialReads=dataReads()
  const input=document.querySelector('.brand-search')
  async function type(value) {
    await act(async()=>{
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value)
      input.dispatchEvent(new window.Event('input',{bubbles:true}))
    })
  }
  await type('royal canin')
  assert.equal(rows('.brand-refine-grid .choice').length,1)
  await click(document.querySelector('.brand-refine-grid .choice'))
  assert.deepEqual(rows('.research-result-card').map(n=>n.dataset.productId),[products[0].product_id])
  await type('farmina'); await click(document.querySelector('.brand-refine-grid .choice'))
  assert.equal(rows('.research-result-card').length,2)
  assert.equal(document.querySelectorAll('.selected-refinements button[aria-label$="선택 해제"]').length,2)
  await type('없는브랜드')
  assert.equal(rows('.brand-refine-grid .choice').length,0)
  assert.equal(rows('.research-result-card').length,2,'searching selector labels does not apply a filter')
  assert.deepEqual(app.parseNavigationState(window.location.search).compareIds,basket)
  await click('조건 수정'); await click('이 조건으로 찾기')
  assert.deepEqual(app.parseNavigationState(window.location.search).refine.brands,['로얄캐닌','파미나'])
  assert.deepEqual(app.parseNavigationState(window.location.search).compareIds,basket)
  await click([...document.querySelectorAll('.selected-refinements button')].find(n=>n.getAttribute('aria-label')==='로얄캐닌 선택 해제'))
  await click([...document.querySelectorAll('.recipe-detail-grid:not(.brand-refine-grid) .choice')].find(n=>n.textContent==='연어'))
  assert.equal(rows('.research-result-card').length,0)
  await click(document.querySelector('.state-message .state-retry'))
  assert.equal(rows('.research-result-card').length,1,'clear brands preserves recipe refinement')
  assert.deepEqual(app.parseNavigationState(window.location.search).refine.recipeDetails,['salmon'])
  assert.deepEqual(app.parseNavigationState(window.location.search).compareIds,basket)
  assert.equal(dataReads(),initialReads)
  await click('조건 수정'); await click('습식'); await click('이 조건으로 찾기')
  assert.deepEqual(app.parseNavigationState(window.location.search).refine.brands,[])
  assert.deepEqual(app.parseNavigationState(window.location.search).compareIds,[])
})

const energyReads = () => requests.filter(r => r.path.endsWith('/compare_product_nutrition') && new URLSearchParams(r.query).get('limit') === '1000')
const energyFixture = (index, value, extra={}) => ({product_id:products[index]?.product_id ?? 'energy_'+index, observation_scope:'product', kcal_per_100g:value, kcal_per_kg:null, supplemental_nutrition_fields:[], is_current_resolved_formula:false, ...extra})
async function energyInput(value) {
 const input=document.querySelector('#energy-max')
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}))})
}
async function energyExplore() {
 dom.reconfigure({url:'https://catfood.test/?view=workspace&applied=1&feed='+encodeURIComponent('건식')+'&features=weight_management'})
 await act(async()=>root.render(createElement(app.App)))
}

test('energy units, scope and URL parsing do not turn unknown or a different formula into a matching value',()=>{
 assert.equal(app.energyAmount(energyFixture(0,400,{kcal_per_kg:3485})),348.5)
 assert.equal(app.energyAmount(energyFixture(0,422)),422)
 for(const value of [null,0,-1,NaN,Infinity]) assert.equal(app.energyAmount(energyFixture(0,value)),null)
 assert.equal(app.usableEnergy(energyFixture(0,400,{observation_scope:'formula'})),null)
 assert.equal(app.usableEnergy(energyFixture(0,400,{observation_scope:'formula',is_current_resolved_formula:true})),400)
 assert.equal(app.usableEnergy(energyFixture(0,400,{observation_scope:'variant',supplemental_nutrition_fields:['energy'],supplemental_observation_scope:'formula',supplemental_is_current_resolved_formula:false})),null)
 assert.equal(app.usableEnergy(energyFixture(0,400,{observation_scope:'formula',supplemental_nutrition_fields:['energy'],supplemental_observation_scope:'product'})),400)
 for(const value of ['', '0','-1','Infinity','12x','1e3']) assert.equal(app.parseEnergyMax(value),undefined)
 const valid=app.parseNavigationState('?view=workspace&applied=1&feed='+encodeURIComponent('건식')+'&features=weight_management&energyMax=348.5')
 assert.equal(valid.refine.energyMax,348.5)
 assert.equal(app.parseNavigationState(app.navigationSearch({...valid,mode:'lookup'})).refine.energyMax,348.5)
 for(const suffix of ['mode=switch&feed=건식&features=weight_management','feed=건식','features=weight_management','feed=건식&features=dental']) assert.equal(app.parseNavigationState('?view=workspace&'+suffix+'&energyMax=350').refine.energyMax,undefined)
 assert.equal(app.navigationSearch({...valid,mode:'switch'}).includes('energyMax'),false)
})

test('energy is lazy, keeps unknowns and unofficial weight features, preserves basket, and reuses the read',async()=>{
 products=catalog(4);products[0].features=['weight_management']
 energyData=[energyFixture(0,400,{kcal_per_kg:3485}),energyFixture(1,422),energyFixture(2,null),energyFixture(3,500,{observation_scope:'formula',is_current_resolved_formula:false})]
 await energyExplore()
 assert.equal(energyReads().length,0)
 await click(rows('.research-result-compare')[1])
 const basket=app.parseNavigationState(window.location.search).compareIds
 await click(document.querySelector('.energy-refine button'));assert.equal(energyReads().length,1)
 await energyInput('350');await click('이 열량 이하로 보기')
 assert.deepEqual(rows('.research-result-card').map(n=>n.dataset.productId),[products[0],products[2],products[3]].map(p=>p.product_id))
 assert.deepEqual(app.parseNavigationState(window.location.search).compareIds,basket)
 assert.match(document.body.textContent,/348.5 kcal\/100g/)
 assert.match(document.body.textContent,/열량 미확인/)
 const runs=searchRuns().length, signals=considerations().length
 await click(rows('.research-result-compare')[0])
 assert.equal(searchRuns().length,runs);assert.equal(considerations().length,signals,'no energy action attached to prior intake run')
 await click('비교 보기')
 assert.match(document.querySelector('.compare-stage').textContent,/422 kcal\/100g \(선택 350 kcal\/100g 이하\)/)
 await act(async()=>{button('제품 목록으로').click();await waitForUi(()=>!document.querySelector('.compare-stage') && document.querySelector('.research-results'),'comparison history return')})
 await click('조건 수정');await click('이 조건으로 찾기')
 assert.equal(app.parseNavigationState(window.location.search).refine.energyMax,350)
 assert.equal(energyReads().length,1)
 await click('열량 조건 지우기')
 assert.equal(rows('.research-result-card').length,4)
 assert.equal(energyReads().length,1)
})

test('deep-link energy pending and failure stay distinct from empty results; manual retry retains bound and basket',async()=>{
 products=catalog(2);energyFailure=true
 dom.reconfigure({url:'https://catfood.test/?view=workspace&applied=1&feed=건식&features=weight_management&energyMax=350&compare='+products[0].product_id})
 await act(async()=>root.render(createElement(app.App)))
 assert.equal(energyReads().length,1)
 assert.match(document.querySelector('.research-results').textContent,/열량을 불러오지 못했습니다/)
 assert.doesNotMatch(document.querySelector('.research-results').textContent,/조건에 맞는 제품이 없습니다|0개의 제품|Private source/)
 assert.equal(app.parseNavigationState(window.location.search).refine.energyMax,350)
 energyFailure=false;energyData=[energyFixture(0,340),energyFixture(1,400)]
 await click('열량 다시 불러오기')
 assert.equal(energyReads().length,2);assert.equal(rows('.research-result-card').length,1)
 assert.deepEqual(app.parseNavigationState(window.location.search).compareIds,[products[0].product_id])
})

test('late energy response cannot revive a condition after Home new start',async()=>{
 products=catalog(2)
 let resolveEnergy
 energyDeferred=new Promise(resolve=>{resolveEnergy=resolve})
 await energyExplore();await click(document.querySelector('.energy-refine button'))
 assert.match(document.body.textContent,/열량을 불러오는 중/)
 await click(document.querySelector('.site-wordmark'))
 await click('조건 고르기');await click('이 조건으로 찾기')
 await act(async()=>resolveEnergy(Response.json([energyFixture(0,100)])))
 assert.equal(document.querySelector('.energy-refine'),null)
 assert.equal(app.parseNavigationState(window.location.search).refine.energyMax,undefined)
 assert.equal(rows('.research-result-card').length,2)
})

test('energy helper paginates beyond 1000 and rejects overlapping pages instead of silently losing products',async()=>{
 energyData=Array.from({length:1001},(_,i)=>({...energyFixture(i,100),product_id:'energy_'+String(i).padStart(5,'0')}))
 const result=await app.fetchExploreEnergy()
 assert.equal(result.length,1001);assert.equal(energyReads().length,2)
 assert.deepEqual(energyReads().map(r=>new URLSearchParams(r.query).get('offset')),['0','1000'])
 energyData[1000].product_id=energyData[0].product_id
 await assert.rejects(()=>app.fetchExploreEnergy(),/Incomplete energy response/)
})
test('restored bound stays pending until energy arrives without claiming zero results',async()=>{
 products=catalog(2)
 let resolveEnergy
 energyDeferred=new Promise(resolve=>{resolveEnergy=resolve})
 dom.reconfigure({url:'https://catfood.test/?view=workspace&applied=1&feed=건식&features=weight_management&energyMax=350'})
 await act(async()=>root.render(createElement(app.App)))
 assert.equal(rows('.research-result-card').length,0)
 assert.match(document.querySelector('.research-results').textContent,/열량을 확인하고 있습니다/)
 assert.doesNotMatch(document.querySelector('.research-results-heading').textContent,/0개의 제품/)
 assert.equal(searchRuns().length,0)
 await act(async()=>resolveEnergy(Response.json([energyFixture(0,340),energyFixture(1,400)])))
 assert.equal(rows('.research-result-card').length,1)
 assert.equal(app.parseNavigationState(window.location.search).refine.energyMax,350)
})


test('empty-result recipe recovery clears only recipes and preserves primary conditions, brands, energy and basket without new reads', async () => {
  products = catalog(2)
  products.forEach(p => { p.feed_type='건식'; p.life_stage='adult'; p.brand='AATU'; p.features=['weight_management']; p.recipe_details=['salmon'] })
  energyData=[energyFixture(0,370),energyFixture(1,380)]
  const params=new URLSearchParams({view:'workspace',applied:'1',feed:'건식',age:'adult',features:'weight_management',brands:'AATU',recipeDetails:'beef,duck',energyMax:'400',compare:products[0].product_id})
  dom.reconfigure({url:'https://catfood.test/?'+params})
  await act(async()=>root.render(createElement(app.App)))
  await waitForUi(()=>document.querySelector('.state-message')?.textContent.includes('조건에 맞는 제품이 없습니다.'),'empty result after energy load')
  const before=app.parseNavigationState(window.location.search)
  const recipeInput=document.querySelector('.recipe-detail-search')
  recipeInput.getClientRects=()=>[{}]
  document.querySelector('#energy-max').getClientRects=()=>[{}]
  const reads=requests.filter(r=>r.path.startsWith('/rest/')).length
  assert.equal(rows('.research-result-card').length,0)
  const clear=rows('.state-message button').find(n=>n.textContent==='레시피 선택 지우기')
  clear.focus()
  await click(clear)
  await waitForUi(()=>document.activeElement===recipeInput,'focus returns to recipe search rather than the visible energy input')
  const after=app.parseNavigationState(window.location.search)
  assert.deepEqual(after.search,before.search)
  assert.deepEqual(after.refine,{...before.refine,recipeDetails:[]})
  assert.deepEqual(after.compareIds,before.compareIds)
  assert.equal(rows('.research-result-card').length,2)
  assert.equal(rows('.state-message button').some(n=>n.textContent==='레시피 선택 지우기'),false)
  assert.equal(requests.filter(r=>r.path.startsWith('/rest/')).length,reads)
})

test('removing a recipe chip returns focus to visible recipe search while preserving the remaining OR recipe, search text and basket', async () => {
  products=catalog(2)
  products[0].recipe_details=['salmon'];products[1].recipe_details=['duck']
  const params=new URLSearchParams({view:'workspace',applied:'1',recipeDetails:'salmon,duck',compare:products[0].product_id})
  dom.reconfigure({url:'https://catfood.test/?'+params})
  await act(async()=>root.render(createElement(app.App)))
  await waitForUi(()=>rows('.research-result-card').length===2,'both OR recipes rendered')
  const input=document.querySelector('.recipe-detail-search')
  input.getClientRects=()=>[{}]
  await act(async()=>{
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'존재하지않는레시피')
    input.dispatchEvent(new window.Event('input',{bubbles:true}))
  })
  const chip=document.querySelector('button[aria-label="연어 선택 해제"]')
  chip.focus();await click(chip)
  await waitForUi(()=>document.activeElement===input,'recipe search gets focus after chip disappears')
  assert.equal(input.value,'존재하지않는레시피')
  assert.deepEqual(app.parseNavigationState(window.location.search).refine.recipeDetails,['duck'])
  assert.deepEqual(app.parseNavigationState(window.location.search).compareIds,[products[0].product_id])
  assert.deepEqual(rows('.research-result-card').map(n=>n.dataset.productId),[products[1].product_id])
})

test('basic alternatives use OR within form/age and AND across axes without inferring unknown facts', () => {
  const source=catalog(7)
  source[1].feed_type='습식';source[1].life_stage='senior'
  source[2].feed_type='동결건조';source[2].life_stage='senior'
  source[3].life_stage='kitten'
  source[4].feed_type=null
  source[5].feed_type='습식';source[5].life_stage=null
  source[6].feed_type=null;source[6].life_stage=null
  const search={...app.INITIAL_SEARCH,feedType:['건식','습식'],lifeStage:['adult','senior']}
  const result=app.evaluateCatalog(source,search)
  assert.deepEqual(result.map(x=>x.product.product_id),[source[0],source[1],source[4],source[5],source[6]].map(x=>x.product_id))
  assert.equal(result[0].matchCount,2,'alternatives are not separate ranking requirements')
  assert.deepEqual(result[0].confirmedMatches,['형태:건식','생애주기:adult'])
  assert.deepEqual(result.at(-1).unknowns,['사료 형태','제품 표기 생애주기'])
  assert.equal(app.evaluateComparisonCriteria(source[1],search).differences.length,0)
  assert.deepEqual(app.evaluateComparisonCriteria(source[2],search).differences[0],{kind:'feedType',selectedValues:['건식','습식'],productValues:['동결건조']})
  assert.deepEqual(app.evaluateComparisonCriteria(source[3],search).differences[0],{kind:'lifeStage',selectedValues:['adult','senior'],productValues:['kitten']})
  assert.equal(app.canRefineEnergy({...search,features:['weight_management']}),false)
  assert.equal(app.canRefineEnergy({...search,feedType:['건식'],features:['weight_management']}),true)
})

test('multiple basic choices toggle independently, preserve unchanged sets and clear on actual applied changes', async () => {
  products=catalog(3);products[1].feed_type='습식';products[1].life_stage='senior';products[2].feed_type='동결건조';products[2].life_stage='kitten'
  dom.reconfigure({url:'https://catfood.test/?view=workspace'})
  await act(async()=>root.render(createElement(app.App)))
  await click('건식');await click('습식');await click('성묘');await click('시니어')
  assert.match(document.querySelector('.condition-draft-count').textContent,/4개/)
  assert.equal(rows('.condition-basics button[aria-pressed="true"]').length,4)
  await click('이 조건으로 찾기')
  assert.deepEqual(rows('.research-result-card').map(x=>x.dataset.productId),[products[0].product_id,products[1].product_id])
  await click(document.querySelector('.research-result-compare'))
  const basket=app.parseNavigationState(window.location.search).compareIds
  await click('조건 수정');await click('건식');await click('건식');await click('이 조건으로 찾기')
  assert.deepEqual(app.parseNavigationState(window.location.search).compareIds,basket,'same set in a different selection order preserves basket')
  await click('조건 수정');await click('습식');await click('이 조건으로 찾기')
  assert.deepEqual(app.parseNavigationState(window.location.search).search.feedType,['건식'])
  assert.deepEqual(app.parseNavigationState(window.location.search).compareIds,[])
  await click('조건 수정');await click('초기화')
  assert.equal(rows('.condition-basics button[aria-pressed="true"]').length,0)
})
