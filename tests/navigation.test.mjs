import assert from 'node:assert/strict'
import { after, before, afterEach, test } from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/catfood_web/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch
let temp, app, root

function product(id, name) {
  return {
    product_id: id, brand: 'Test Brand', canonical_name: name, feed_type: '건식', life_stage: 'adult', display_image_url: null,
    representative_variant_id: null, representative_package_size_text: '1 kg', representative_package_weight_g: 1000,
    representative_units_per_sale: 1, representative_sale_total_weight_g: 1000, variant_count: 1, has_variants: true,
    ingredient_declaration_count: 0, full_ingredient_declaration_count: 0, has_ingredient_details: false, has_full_ingredient_declaration: false,
    nutrition_panel_count: 0, has_nutrition_details: false, manufacturing_observation_count: 0, has_manufacturing_details: false,
    market_observation_count: 0, has_market_details: false, ingredient_term_result_count: 0,
    manufacturing_country_codes: [], assessed_market_country_codes: [], current_market_country_codes: [], formula_match_market_country_codes: [],
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [], insufficient_evidence_ingredient_terms: [],
    official_targets: [], features: [], recipe_families: [], recipe_details: [], official_recipe_traits: [],
  }
}
const products = Array.from({ length: 130 }, (_, index) => product(`product_${String(index).padStart(16, '0')}`, `Product ${String(index).padStart(3, '0')}`))

async function bundle() {
  const result = await build({
    configFile: false, logLevel: 'silent',
    define: {
      'import.meta.env.DEV': 'false', 'import.meta.env.VITE_DECISION_INTAKE_ENABLED': '"false"',
      'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"', 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
    },
    build: { ssr: 'tests/entry.ts', write: false, minify: false },
  })
  const chunk = result.output.find((item) => item.type === 'chunk' && item.isEntry)
  const file = resolve(temp, 'navigation.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-navigation-tests-'))
  app = await bundle()
})
after(async () => { globalThis.fetch = nativeFetch; dom.window.close(); await rm(temp, { recursive: true }) })
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null }
  window.history.replaceState(null, '', 'https://catfood.test/catfood_web/')
})

function installFetch() {
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/effective_product_catalog_summary')) return Response.json(products)
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    return Response.json([])
  }
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
async function renderApp(url) {
  dom.reconfigure({ url })
  installFetch()
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(
    () => !document.body.textContent.includes('제품 데이터를 불러오는 중입니다.')
      && (document.querySelector('.detail-stage') !== null || document.querySelector('.compare-stage') !== null || document.querySelector('.research-results') !== null || document.querySelector('.home-shell') !== null),
    'catalog-backed screen rendered',
  )
}
async function click(text) {
  const button = [...document.querySelectorAll('button')].find((element) => element.textContent.includes(text))
  assert.ok(button, `missing button: ${text}`)
  await act(async () => button.click())
}
async function inputValue(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function selectValue(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(element, value)
    element.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

test('URL parser rejects unknown filters and tabs, deduplicates compare IDs, caps compare at five, and keeps Home round-trippable', () => {
  const state = app.parseNavigationState('?view=workspace&mode=wat&feed=invalid&age=nope&targets=indoor,bad,indoor&features=hairball,bad&recipes=fish,bad&detailTab=nope&compareTab=nope&compare=a,a,b,c,d,e,f&compareOpen=1')
  assert.equal(state.mode, 'explore')
  assert.equal(state.search.feedType, '')
  assert.equal(state.search.lifeStage, '')
  assert.deepEqual(state.search.officialTargets, ['indoor'])
  assert.deepEqual(state.search.features, ['hairball'])
  assert.deepEqual(state.search.recipeFamilies, ['fish'])
  assert.equal(state.detailTab, 'overview')
  assert.equal(state.compareTab, 'overview')
  assert.deepEqual(state.compareIds, ['a', 'b', 'c', 'd', 'e'])
  const clean = app.sanitizeProductNavigation({ ...state, detailProductId: 'bad', selectedId: 'a' }, new Set(['a', 'c']))
  assert.equal(clean.detailProductId, null)
  assert.equal(clean.selectedId, 'a')
  assert.deepEqual(clean.compareIds, ['a', 'c'])
  const lookupSearch = app.navigationSearch({
    ...state,
    screen: 'workspace',
    mode: 'lookup',
    lookupQuery: 'Product',
    comparisonCriteriaApplied: true,
    editingConditions: false,
    search: { ...state.search, feedType: '건식', lifeStage: 'adult' },
  })
  const restoredLookup = app.parseNavigationState(lookupSearch)
  assert.equal(restoredLookup.mode, 'lookup')
  assert.equal(restoredLookup.lookupQuery, 'Product')
  assert.equal(restoredLookup.search.feedType, '건식')
  assert.equal(restoredLookup.search.lifeStage, 'adult')
  assert.equal(restoredLookup.comparisonCriteriaApplied, true)
  assert.equal(restoredLookup.editingConditions, false)
  assert.equal(new URLSearchParams(lookupSearch).get('criteria'), '1')
  assert.equal(new URLSearchParams(lookupSearch).get('applied'), null)

  const pureLookupSearch = app.navigationSearch({
    ...state,
    screen: 'workspace',
    mode: 'lookup',
    lookupQuery: 'Product',
    comparisonCriteriaApplied: false,
    search: { ...state.search, feedType: '건식', lifeStage: 'adult' },
  })
  const pureLookupParams = new URLSearchParams(pureLookupSearch)
  assert.equal(pureLookupParams.get('criteria'), null)
  assert.equal(pureLookupParams.get('feed'), null)
  assert.equal(pureLookupParams.get('age'), null)

  const legacyLookup = app.parseNavigationState('?view=workspace&mode=lookup&q=Product&applied=1&feed=건식&age=adult')
  assert.equal(legacyLookup.comparisonCriteriaApplied, true)
  assert.equal(legacyLookup.search.lifeStage, 'adult')

  const homeSearch = app.navigationSearch({ ...state, screen: 'home' })
  assert.equal(homeSearch, '')
  assert.equal(app.parseNavigationState(homeSearch).screen, 'home')
})

test('Home navigation clears workspace query state so refresh remains Home', async () => {
  await renderApp('https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product&compare=product_0000000000000000')
  await click('FELINE ARCHIVE')
  assert.equal(window.location.search, '')
  assert.equal(app.parseNavigationState(window.location.search).screen, 'home')
})

test('direct detail URL restores the selected tab and still provides a way back to the product list', async () => {
  const id = products[2].product_id
  await renderApp(`https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product&detail=${id}&detailTab=nutrition`)
  assert.match(document.body.textContent, /Product 002/)
  const nutritionTab = document.getElementById('detail-tab-nutrition')
  assert.equal(nutritionTab?.getAttribute('aria-selected'), 'true')
  assert.equal(nutritionTab?.getAttribute('aria-controls'), 'detail-panel-nutrition')
  assert.equal(document.querySelector('[role="tabpanel"]:not([hidden])')?.getAttribute('aria-labelledby'), 'detail-tab-nutrition')
  await click('제품 목록')
  assert.equal(document.querySelector('.detail-stage'), null)
  assert.ok(document.querySelector('.research-results'))
})

test('direct list compare stays separate from quick view and persists across EXPLORE and LOOKUP', async () => {
  const first = products[0]
  await renderApp('https://catfood.test/catfood_web/?view=workspace&mode=explore&applied=1&feed=건식&age=adult')

  const scroller = document.querySelector('.research-results-scroll')
  scroller.scrollTop = 91
  const direct = document.querySelector(`[data-compare-product-id="${first.product_id}"]`)
  assert.ok(direct)
  direct.focus()
  await act(async () => direct.click())

  assert.equal(document.activeElement, direct, 'direct compare keeps keyboard focus on the compare control')
  assert.equal(scroller.scrollTop, 91, 'direct compare does not move the result list')
  assert.equal(direct.getAttribute('aria-pressed'), 'true')
  assert.ok(direct.closest('.research-result-row').classList.contains('is-compared'))
  assert.equal(document.querySelector('.research-quick-view'), null, 'direct compare must not open quick view')
  assert.equal(document.querySelector('.detail-stage'), null, 'direct compare must not open detail')
  assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 1\/5/)

  const preview = document.querySelector(`[data-product-id="${first.product_id}"]`)
  await act(async () => preview.click())
  await waitForUi(() => document.querySelector('.research-quick-view') !== null, 'quick view opens independently')
  assert.match(document.querySelector('.quick-view-actions').textContent, /비교에서 제거/)
  await click('닫기 ×')

  await click('제품 찾기')
  assert.equal(new URL(window.location.href).searchParams.get('compare'), first.product_id)
  assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 1\/5/)

  const input = document.querySelector('.lookup-input')
  await inputValue(input, first.canonical_name)
  await waitForUi(() => document.querySelector(`[data-product-id="${first.product_id}"]`) !== null, 'compared product visible in lookup')
  const lookupDirect = document.querySelector(`[data-compare-product-id="${first.product_id}"]`)
  assert.equal(lookupDirect.getAttribute('aria-pressed'), 'true', 'compared state survives EXPLORE to LOOKUP')
  assert.ok(lookupDirect.closest('.research-result-row').classList.contains('is-compared'))

  lookupDirect.focus()
  await act(async () => lookupDirect.click())
  assert.equal(document.activeElement, lookupDirect)
  assert.equal(lookupDirect.getAttribute('aria-pressed'), 'false')
  assert.equal(document.querySelector('.research-quick-view'), null)
  assert.equal(document.querySelector('.switch-compare-dock'), null)
})


test('general comparison carries applied EXPLORE criteria through LOOKUP, known differences, detail, history, and refresh', async () => {
  const third = products[2]
  const originalLifeStage = third.life_stage
  third.life_stage = 'all_life_stages'
  try {
    await renderApp('https://catfood.test/catfood_web/?view=workspace&mode=explore&applied=1&feed=건식&age=adult')
    const firstTwo = [...document.querySelectorAll('.research-result-compare')].slice(0, 2)
    assert.equal(firstTwo.length, 2)
    for (const control of firstTwo) await act(async () => control.click())
    assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 2\/5/)

    await click('제품 찾기')
    let params = new URL(window.location.href).searchParams
    assert.equal(params.get('criteria'), '1')
    assert.equal(params.get('feed'), '건식')
    assert.equal(params.get('age'), 'adult')
    assert.equal(params.get('applied'), null)

    const input = document.querySelector('.lookup-input')
    await inputValue(input, third.canonical_name)
    const thirdCompare = document.querySelector(`[data-compare-product-id="${third.product_id}"]`)
    assert.ok(thirdCompare, 'hard-conflict product remains available to LOOKUP')
    await act(async () => thirdCompare.click())
    assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 3\/5/)
    await click('비교 보기')

    const criteria = document.querySelector('.compare-applied-criteria')
    assert.ok(criteria)
    assert.match(criteria.textContent, /적용 조건/)
    assert.match(criteria.textContent, /사료 형태 · 건식/)
    assert.match(criteria.textContent, /연령 · 성묘/)

    const relationRow = [...document.querySelectorAll('.compare-row')].find((row) => row.querySelector('.compare-row-label')?.textContent.includes('선택한 조건과 비교'))
    assert.ok(relationRow)
    const relationCells = [...relationRow.querySelectorAll('.compare-cell')]
    assert.equal(relationCells.length, 3)
    assert.match(relationCells[0].textContent, /확인됨/)
    assert.match(relationCells[2].textContent, /제품 표기 다름/)
    assert.match(relationCells[2].textContent, /대상 연령 · 제품 표기 전연령 · 선택 성묘/)
    assert.doesNotMatch(relationCells[2].textContent, /비교할 검색 조건 없음|부적합|급여 불가|안전/)

    const thirdHead = [...document.querySelectorAll('.compare-product-head')].find((head) => head.textContent.includes(third.canonical_name))
    assert.ok(thirdHead)
    await act(async () => thirdHead.querySelector('.compare-detail-link').click())
    assert.ok(document.querySelector('.detail-stage'))
    await click('비교로 돌아가기')
    await waitForUi(() => document.querySelector('.compare-stage') !== null, 'detail returns to comparison')
    assert.match(document.querySelector('.compare-applied-criteria').textContent, /연령 · 성묘/)

    await click('제품 목록으로')
    await waitForUi(() => document.querySelector('.research-results') !== null, 'comparison returns to lookup list')
    assert.equal(document.querySelector('.lookup-input').value, third.canonical_name)

    await act(async () => {
      window.history.forward()
      await waitForUi(() => document.querySelector('.compare-stage') !== null, 'history forward restores comparison')
    })
    assert.match(document.querySelector('.compare-applied-criteria').textContent, /연령 · 성묘/)
    const refreshUrl = window.location.href

    await act(async () => {
      window.history.back()
      await waitForUi(() => document.querySelector('.research-results') !== null && document.querySelector('.compare-stage') === null, 'history returns to a stable lookup list')
    })

    await act(async () => root.unmount())
    root = null
    await renderApp(refreshUrl)
    assert.ok(document.querySelector('.compare-stage'))
    assert.match(document.querySelector('.compare-applied-criteria').textContent, /사료 형태 · 건식/)
    assert.match(document.querySelector('.compare-stage').textContent, /제품 표기 다름/)
    params = new URL(window.location.href).searchParams
    assert.equal(params.get('criteria'), '1')
    assert.equal(params.get('age'), 'adult')

    await click('제품 목록으로')
    await waitForUi(() => document.querySelector('.research-results') !== null && document.querySelector('.compare-stage') === null, 'refresh scenario finishes on a stable lookup list')
  } finally {
    third.life_stage = originalLifeStage
  }
})

test('general comparison distinguishes unknown facts and does not invent criteria for pure name search', async () => {
  const unknownProduct = products[3]
  const originalLifeStage = unknownProduct.life_stage
  unknownProduct.life_stage = null
  try {
    const contextual = new URL('https://catfood.test/catfood_web/')
    contextual.searchParams.set('view', 'workspace')
    contextual.searchParams.set('mode', 'lookup')
    contextual.searchParams.set('q', unknownProduct.canonical_name)
    contextual.searchParams.set('criteria', '1')
    contextual.searchParams.set('feed', '건식')
    contextual.searchParams.set('age', 'adult')
    contextual.searchParams.set('compare', unknownProduct.product_id)
    contextual.searchParams.set('compareOpen', '1')
    await renderApp(contextual.href)

    assert.match(document.querySelector('.compare-applied-criteria').textContent, /연령 · 성묘/)
    const contextualText = document.querySelector('.compare-stage').textContent
    assert.match(contextualText, /미확인/)
    assert.match(contextualText, /제품 표기 연령/)
    assert.doesNotMatch(contextualText, /제품 표기 다름.*대상 연령/)

    const pure = new URL('https://catfood.test/catfood_web/')
    pure.searchParams.set('view', 'workspace')
    pure.searchParams.set('mode', 'lookup')
    pure.searchParams.set('q', unknownProduct.canonical_name)
    pure.searchParams.set('compare', unknownProduct.product_id)
    pure.searchParams.set('compareOpen', '1')
    await act(async () => root.unmount())
    root = null
    await renderApp(pure.href)

    assert.equal(document.querySelector('.compare-applied-criteria'), null)
    assert.doesNotMatch(document.querySelector('.compare-stage').textContent, /선택한 조건과 비교|비교할 검색 조건 없음/)
  } finally {
    unknownProduct.life_stage = originalLifeStage
  }
})

test('unapplied condition edits keep the last applied comparison basis when moving to LOOKUP', async () => {
  const product = products[4]
  const originalLifeStage = product.life_stage
  product.life_stage = 'all_life_stages'
  try {
    await renderApp('https://catfood.test/catfood_web/?view=workspace&mode=explore&applied=1&feed=건식&age=adult')
    await click('조건 수정')
    await click('키튼')
    assert.match(document.querySelector('.condition-draft-count').textContent, /2개/)

    await click('제품 찾기')
    const params = new URL(window.location.href).searchParams
    assert.equal(params.get('criteria'), '1')
    assert.equal(params.get('age'), 'adult', 'LOOKUP serializes the last applied age, not the unapplied draft')
    assert.equal(params.get('applied'), null)

    const input = document.querySelector('.lookup-input')
    await inputValue(input, product.canonical_name)
    const compare = document.querySelector(`[data-compare-product-id="${product.product_id}"]`)
    await act(async () => compare.click())
    await click('비교 보기')
    const compareText = document.querySelector('.compare-stage').textContent
    assert.match(compareText, /연령 · 성묘/)
    assert.match(compareText, /제품 표기 전연령 · 선택 성묘/)
    assert.doesNotMatch(compareText, /선택 키튼|연령 · 키튼/)
  } finally {
    product.life_stage = originalLifeStage
  }
})

test('starting a new lookup from Home clears prior applied comparison criteria', async () => {
  await renderApp('https://catfood.test/catfood_web/?view=workspace&mode=explore&applied=1&feed=건식&age=adult')
  await click('FELINE ARCHIVE')
  assert.equal(window.location.search, '')

  const homeInput = document.querySelector('.home-entry-search input')
  await inputValue(homeInput, products[5].canonical_name)
  await act(async () => homeInput.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  await waitForUi(() => document.querySelector(`[data-product-id="${products[5].product_id}"]`) !== null, 'fresh Home lookup result')

  const params = new URL(window.location.href).searchParams
  assert.equal(params.get('criteria'), null)
  assert.equal(params.get('feed'), null)
  assert.equal(params.get('age'), null)

  const compare = document.querySelector(`[data-compare-product-id="${products[5].product_id}"]`)
  await act(async () => compare.click())
  await click('비교 보기')
  assert.equal(document.querySelector('.compare-applied-criteria'), null)
  assert.doesNotMatch(document.querySelector('.compare-stage').textContent, /선택한 조건과 비교|비교할 검색 조건 없음/)
})

test('direct list compare caps additions at five while keeping selected products removable', async () => {
  await renderApp('https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product')
  const controls = [...document.querySelectorAll('.research-result-compare')]
  assert.ok(controls.length >= 6)

  for (let index = 0; index < 5; index += 1) {
    await act(async () => controls[index].click())
    assert.equal(controls[index].getAttribute('aria-pressed'), 'true')
  }
  assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 5\/5/)
  assert.equal(controls[5].disabled, true, 'sixth unselected product is disabled at the cap')
  assert.equal(controls[0].disabled, false, 'already compared product remains removable at the cap')

  controls[0].focus()
  await act(async () => controls[0].click())
  assert.equal(document.activeElement, controls[0])
  assert.equal(controls[0].getAttribute('aria-pressed'), 'false')
  assert.equal(controls[5].disabled, false, 'removing one product re-enables another candidate')
  assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 4\/5/)
})

test('typing a lookup query replaces URL state instead of adding history entries', async () => {
  await renderApp('https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product')
  const input = document.querySelector('.lookup-input')
  assert.ok(input)
  const before = window.history.length
  await inputValue(input, 'Product 0')
  await inputValue(input, 'Product 00')
  assert.equal(window.history.length, before)
  assert.equal(new URL(window.location.href).searchParams.get('q'), 'Product 00')
})


test('list expansion, detail navigation, and browser back restore the expanded result list and focus', async () => {
  await renderApp('https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product')
  assert.equal(document.querySelectorAll('.research-result-card').length, 120)
  await click('제품 더 보기')
  assert.equal(document.querySelectorAll('.research-result-card').length, 130)
  const cards = [...document.querySelectorAll('.research-result-card')]
  await act(async () => cards[125].click())
  await click('상세 보기')
  assert.ok(document.querySelector('.detail-stage'))
  await act(async () => {
    window.history.back()
    await waitForUi(
      () => document.querySelector('.detail-stage') === null
        && document.querySelectorAll('.research-result-card').length === 130
        && document.activeElement?.dataset.productId === products[125].product_id,
      'expanded lookup list and focused product restored after browser back',
    )
  })
  assert.equal(document.querySelectorAll('.research-result-card').length, 130)
  assert.equal(document.activeElement?.dataset.productId, products[125].product_id)
  assert.equal(new URL(window.location.href).searchParams.get('visible'), '240')
})

test('comparison removals survive returning to the list history entry', async () => {
  await renderApp('https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product')
  const cards = [...document.querySelectorAll('.research-result-card')]
  await act(async () => cards[0].click())
  await click('비교에 추가')
  await act(async () => cards[1].click())
  await click('비교에 추가')
  await click('비교 보기')
  assert.ok(document.querySelector('.compare-stage'))
  const removeFirst = document.querySelector(`button[aria-label="${products[0].canonical_name} 비교에서 제거"]`)
  assert.ok(removeFirst)
  await act(async () => removeFirst.click())
  await act(async () => {
    const close = [...document.querySelectorAll('button')].find((element) => element.textContent.includes('제품 목록으로'))
    assert.ok(close)
    close.click()
    await waitForUi(
      () => document.querySelector('.compare-stage') === null && document.querySelector('.switch-compare-dock') !== null,
      'comparison closes to list with updated selection',
    )
  })
  const dockText = document.querySelector('.switch-compare-dock')?.textContent ?? ''
  assert.doesNotMatch(dockText, /Product 000/)
  assert.match(dockText, /Product 001/)
  assert.equal(new URL(window.location.href).searchParams.get('compare'), products[1].product_id)
})


test('two-product overview exposes paired mobile structure and removal falls back to existing layouts', async () => {
  const first = products[0], second = products[1]
  await renderApp(`https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product&compare=${first.product_id}%2C${second.product_id}&compareOpen=1`)

  const mobile = document.querySelector('.compare-mobile-two-product-overview')
  assert.ok(mobile)
  assert.equal(mobile.querySelectorAll('.compare-mobile-two-product-head').length, 2)
  assert.match(mobile.textContent, /Product 000/)
  assert.match(mobile.textContent, /Product 001/)
  assert.doesNotMatch(mobile.textContent, /선택한 조건과 비교/)
  assert.equal(mobile.querySelectorAll('.compare-mobile-two-product-actions button').length, 4)
  assert.ok(mobile.querySelector(`button[aria-label="Test Brand Product 000 상세 보기"]`))
  assert.ok(mobile.querySelector(`button[aria-label="Test Brand Product 001 비교에서 제거"]`))

  const productHeaders = [...mobile.querySelectorAll('.compare-mobile-two-product-key th[scope="col"]')]
  assert.equal(productHeaders.length, 2)
  assert.match(productHeaders[0].textContent, /Test Brand/)
  assert.match(productHeaders[0].textContent, /Product 000/)
  assert.match(productHeaders[1].textContent, /Test Brand/)
  assert.match(productHeaders[1].textContent, /Product 001/)

  const packageHeader = mobile.querySelector('#compare-mobile-two-row-packages')
  assert.ok(packageHeader)
  const packageValues = [...packageHeader.closest('tbody').querySelectorAll('td')]
  assert.equal(packageValues.length, 2)
  assert.ok(packageValues.every((cell) => /1 kg/.test(cell.textContent)))
  assert.ok(packageValues[0].getAttribute('headers').includes('compare-mobile-two-row-packages'))
  assert.ok(packageValues[0].getAttribute('headers').includes('compare-mobile-two-product-column-1-'))
  assert.ok(packageValues[1].getAttribute('headers').includes('compare-mobile-two-product-column-2-'))

  const feedHeader = mobile.querySelector('#compare-mobile-two-row-feed-type')
  assert.ok(feedHeader)
  assert.equal(feedHeader.getAttribute('scope'), 'rowgroup')
  assert.ok(productHeaders.every((header) => header.getAttribute('scope') === 'col'))
  const feedValues = [...feedHeader.closest('tbody').querySelectorAll('td')]
  assert.equal(feedValues.length, 2)
  assert.ok(feedValues[0].getAttribute('headers').includes(feedHeader.id))
  assert.ok(feedValues[1].getAttribute('headers').includes(feedHeader.id))

  const removeFirst = mobile.querySelector(`button[aria-label="Test Brand Product 000 비교에서 제거"]`)
  await act(async () => removeFirst.click())
  assert.equal(document.querySelector('.compare-mobile-two-product-overview'), null)
  assert.ok(document.querySelector('.compare-table'), 'one product returns to the existing comparison table')

  const removeLast = document.querySelector(`button[aria-label="Product 001 비교에서 제거"]`)
  assert.ok(removeLast)
  await act(async () => removeLast.click())
  assert.equal(document.querySelector('.compare-stage'), null)
  assert.ok(document.querySelector('.research-results'))
})

test('paired mobile comparison preserves EXPLORE relation semantics and extends from two to three products', async () => {
  const first = products[0], second = products[1], third = products[2]
  await renderApp(`https://catfood.test/catfood_web/?view=workspace&mode=explore&applied=1&feed=%EA%B1%B4%EC%8B%9D&compare=${first.product_id}%2C${second.product_id}&compareOpen=1`)
  let mobile = document.querySelector('.compare-mobile-two-product-overview')
  assert.ok(mobile)
  assert.match(mobile.textContent, /선택한 조건과 비교/)
  assert.match(mobile.textContent, /확인됨/)
  assert.match(mobile.textContent, /건식/)

  await click('영양')
  assert.equal(document.querySelector('.compare-mobile-two-product-overview'), null)
  assert.ok(document.querySelector('.compare-mobile-two-product-nutrition'))
  assert.ok(document.querySelector('.compare-two-product-nutrition-desktop'))

  await renderApp(`https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product&compare=${first.product_id}%2C${second.product_id}%2C${third.product_id}&compareOpen=1&compareTab=nutrition`)
  const picker = document.querySelector('.compare-mobile-general-pair-picker')
  mobile = document.querySelector('.compare-mobile-two-product-nutrition')
  assert.ok(picker)
  assert.match(picker.textContent, /담은 제품 3개 · 현재 2개 표시/)
  assert.ok(mobile)
  assert.match(mobile.textContent, /Product 000/)
  assert.match(mobile.textContent, /Product 001/)
  assert.doesNotMatch(mobile.textContent, /Product 002/)
  assert.ok(document.querySelector('.compare-two-product-nutrition-desktop'))
})


test('mobile general comparison selects either side from five products, preserves the pair across tabs and detail, and repairs removal boundaries', async () => {
  const compared = products.slice(0, 5)
  const compareParam = compared.map((item) => item.product_id).join('%2C')
  await renderApp(`https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product&compare=${compareParam}&compareOpen=1`)

  let picker = document.querySelector('.compare-mobile-general-pair-picker')
  let mobile = document.querySelector('.compare-mobile-two-product-overview')
  assert.ok(picker)
  assert.ok(mobile)
  assert.match(picker.textContent, /담은 제품 5개 · 현재 2개 표시/)
  let selects = [...picker.querySelectorAll('select')]
  assert.equal(selects.length, 2)
  assert.equal(selects[0].value, compared[0].product_id)
  assert.equal(selects[1].value, compared[1].product_id)
  assert.equal(selects[0].querySelector(`option[value="${compared[1].product_id}"]`).disabled, true)
  assert.equal(selects[1].querySelector(`option[value="${compared[0].product_id}"]`).disabled, true)

  const originalCompare = new URL(window.location.href).searchParams.get('compare')
  await selectValue(selects[0], compared[2].product_id)
  picker = document.querySelector('.compare-mobile-general-pair-picker')
  mobile = document.querySelector('.compare-mobile-two-product-overview')
  selects = [...picker.querySelectorAll('select')]
  assert.equal(selects[0].value, compared[2].product_id)
  assert.equal(selects[1].value, compared[1].product_id)
  assert.match(mobile.textContent, /Product 002/)
  assert.match(mobile.textContent, /Product 001/)
  assert.doesNotMatch(mobile.textContent, /Product 000/)
  assert.equal(new URL(window.location.href).searchParams.get('compare'), originalCompare, 'display pair never rewrites the stored compare list')

  await click('영양')
  picker = document.querySelector('.compare-mobile-general-pair-picker')
  selects = [...picker.querySelectorAll('select')]
  assert.equal(selects[0].value, compared[2].product_id)
  assert.equal(selects[1].value, compared[1].product_id)
  assert.ok(document.querySelector('.compare-mobile-two-product-nutrition'))

  await click('개요')
  mobile = document.querySelector('.compare-mobile-two-product-overview')
  const detail = mobile.querySelector(`button[aria-label="Test Brand Product 002 상세 보기"]`)
  assert.ok(detail)
  await act(async () => detail.click())
  await waitForUi(() => document.querySelector('.detail-stage') !== null, 'selected pair detail opens')
  await click('비교로 돌아가기')
  await waitForUi(() => document.querySelector('.compare-mobile-general-pair-picker') !== null, 'pair picker returns after detail')
  picker = document.querySelector('.compare-mobile-general-pair-picker')
  selects = [...picker.querySelectorAll('select')]
  assert.equal(selects[0].value, compared[2].product_id)
  assert.equal(selects[1].value, compared[1].product_id)

  const reloadedUrl = window.location.href
  await act(async () => root.unmount())
  root = null
  await renderApp(reloadedUrl)
  picker = document.querySelector('.compare-mobile-general-pair-picker')
  selects = [...picker.querySelectorAll('select')]
  assert.equal(selects[0].value, compared[0].product_id, 'reload resets display pair to the first stored product')
  assert.equal(selects[1].value, compared[1].product_id, 'reload resets display pair to the second stored product')
  assert.equal(new URL(window.location.href).searchParams.get('compare'), originalCompare)

  await selectValue(selects[0], compared[2].product_id)
  mobile = document.querySelector('.compare-mobile-two-product-overview')
  const removeDisplayed = mobile.querySelector(`button[aria-label="Test Brand Product 002 비교에서 제거"]`)
  assert.ok(removeDisplayed)
  await act(async () => removeDisplayed.click())
  await waitForUi(
    () => document.querySelector('.compare-mobile-general-pair-picker')?.querySelector('select')?.value === compared[0].product_id,
    'removed visible product is replaced by a remaining product',
  )
  picker = document.querySelector('.compare-mobile-general-pair-picker')
  selects = [...picker.querySelectorAll('select')]
  assert.equal(selects[0].value, compared[0].product_id)
  assert.equal(selects[1].value, compared[1].product_id)
  assert.equal(document.activeElement, selects[0], 'focus moves to the repaired display slot after deleting a displayed product')

  const removeHidden = document.querySelector(`.compare-table button[aria-label="${compared[4].canonical_name} 비교에서 제거"]`)
  assert.ok(removeHidden)
  await act(async () => removeHidden.click())
  picker = document.querySelector('.compare-mobile-general-pair-picker')
  selects = [...picker.querySelectorAll('select')]
  assert.equal(selects[0].value, compared[0].product_id)
  assert.equal(selects[1].value, compared[1].product_id, 'removing a hidden product leaves the visible pair unchanged')

  mobile = document.querySelector('.compare-mobile-two-product-overview')
  await act(async () => mobile.querySelector(`button[aria-label="Test Brand Product 000 비교에서 제거"]`).click())
  await waitForUi(() => document.querySelector('.compare-mobile-general-pair-picker') === null, 'two-product boundary removes pair picker')
  mobile = document.querySelector('.compare-mobile-two-product-overview')
  assert.ok(mobile)
  assert.match(mobile.textContent, /Product 001/)
  assert.match(mobile.textContent, /Product 003/)
  assert.equal(document.activeElement, document.querySelector('.compare-table-wrap'), 'focus moves to the comparison panel when the picker disappears')

  await act(async () => mobile.querySelector(`button[aria-label="Test Brand Product 001 비교에서 제거"]`).click())
  assert.equal(document.querySelector('.compare-mobile-two-product-overview'), null)
  assert.ok(document.querySelector('.compare-table'), 'one product falls back to the existing single-product table')

  const removeLast = document.querySelector(`button[aria-label="${compared[3].canonical_name} 비교에서 제거"]`)
  assert.ok(removeLast)
  await act(async () => removeLast.click())
  assert.equal(document.querySelector('.compare-stage'), null)
  assert.ok(document.querySelector('.research-results'))
})

test('mobile nutrition derives rows and basis evidence only from the displayed pair', async () => {
  const first = products[0], second = products[1], third = products[2]
  const row = (productId, energy, additional = [], basis = []) => ({
    product_id: productId, variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'reported',
    protein_pct: 30, protein_qualifier: 'min', fat_pct: 12, fat_qualifier: 'min', fiber_pct: 3, fiber_qualifier: 'max',
    moisture_pct: 10, moisture_qualifier: 'max', ash_pct: 7, ash_qualifier: 'reported',
    kcal_per_kg: energy, kcal_per_100g: null, energy_basis: 'direct_label', is_korea_market_observation: true, is_current_resolved_formula: false,
    additional_nutrients: additional, additional_nutrient_count: additional.length, supplemental_nutrition_fields: [],
    supplemental_observation_scope: null, supplemental_market_code: null, supplemental_is_current_resolved_formula: false,
    basis_specific_nutrition_basis: basis.length ? 'dry_matter' : null, basis_specific_nutrition_values: basis,
  })
  const nutritionRows = [
    row(first.product_id, 4100, [{ nutrient_key: 'calcium', raw_name: 'Calcium', amount: 1.2, unit: '%', qualifier: 'min' }]),
    row(second.product_id, 3800),
    row(third.product_id, 3600, [{ nutrient_key: 'taurine', raw_name: 'Taurine', amount: 0.12, unit: '%', qualifier: 'min' }], [
      { nutrient_key: 'protein', raw_name: 'Protein', amount: 34, unit: '%', qualifier: 'reported' },
    ]),
  ]

  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/compare_product_nutrition')) return Response.json(nutritionRows)
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([])
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    return Response.json([])
  }

  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.CompareView, {
    items: [{ product: first }, { product: second }, { product: third }],
    onClose() {},
    onRemove() {},
    initialTab: 'nutrition',
  })))
  await waitForUi(() => document.querySelector('.compare-mobile-two-product-nutrition')?.textContent.includes('410 kcal/100g'), 'three-product paired nutrition rendered')

  let mobile = document.querySelector('.compare-mobile-two-product-nutrition')
  let picker = document.querySelector('.compare-mobile-general-pair-picker')
  assert.ok(mobile)
  assert.ok(picker)
  assert.match(mobile.textContent, /Product 000/)
  assert.match(mobile.textContent, /Product 001/)
  assert.doesNotMatch(mobile.textContent, /Product 002/)
  assert.ok(mobile.querySelector('#compare-mobile-two-row-nutrition-additional-calcium'))
  assert.equal(mobile.querySelector('#compare-mobile-two-row-nutrition-additional-taurine'), null, 'hidden product does not create an empty additional-nutrient row')
  assert.equal(mobile.querySelector('#compare-mobile-two-row-nutrition-basis-specific'), null, 'hidden product does not create basis evidence')

  let selects = [...picker.querySelectorAll('select')]
  await selectValue(selects[1], third.product_id)
  await waitForUi(() => document.querySelector('.compare-mobile-two-product-nutrition')?.textContent.includes('360 kcal/100g'), 'selected hidden product nutrition becomes visible')
  mobile = document.querySelector('.compare-mobile-two-product-nutrition')
  picker = document.querySelector('.compare-mobile-general-pair-picker')
  selects = [...picker.querySelectorAll('select')]
  assert.equal(selects[0].value, first.product_id)
  assert.equal(selects[1].value, third.product_id)
  assert.match(mobile.textContent, /Product 000/)
  assert.match(mobile.textContent, /Product 002/)
  assert.doesNotMatch(mobile.textContent, /Product 001/)
  assert.ok(mobile.querySelector('#compare-mobile-two-row-nutrition-additional-taurine'))
  const taurineValues = [...mobile.querySelector('#compare-mobile-two-row-nutrition-additional-taurine').closest('tbody').querySelectorAll('.compare-mobile-two-product-value')].map((cell) => cell.textContent.trim())
  assert.deepEqual(taurineValues, ['미확인', '0.12% 이상'])
  assert.match(mobile.querySelector('#compare-mobile-two-row-nutrition-basis-specific').closest('tbody').textContent, /건물 기준\(Dry Matter\).*단백질 34%/)

  installFetch()
})


test('two-product mobile nutrition preserves values, qualifiers, unknowns, and per-product scope', async () => {
  const first = products[0], second = products[1]
  const nutritionRows = [
    {
      product_id: first.product_id, variant_id: 'variant_first', observation_scope: 'variant', market_code: 'KR', panel_type: 'guaranteed',
      protein_pct: 32, protein_qualifier: 'min', fat_pct: 15, fat_qualifier: 'min', fiber_pct: 3, fiber_qualifier: 'max',
      moisture_pct: 10, moisture_qualifier: 'max', ash_pct: null, ash_qualifier: null,
      kcal_per_kg: 4100, kcal_per_100g: null, energy_basis: 'as_fed', is_korea_market_observation: true, is_current_resolved_formula: true,
      additional_nutrients: [{ nutrient_key: 'calcium', raw_name: 'Calcium', amount: 1.2, unit: '%', qualifier: 'min' }],
      additional_nutrient_count: 1, supplemental_nutrition_fields: ['ash'], supplemental_observation_scope: 'formula',
      supplemental_market_code: 'KR', supplemental_is_current_resolved_formula: true, basis_specific_nutrition_basis: null, basis_specific_nutrition_values: [],
    },
    {
      product_id: second.product_id, variant_id: 'variant_second', observation_scope: 'variant', market_code: 'KR', panel_type: 'guaranteed',
      protein_pct: 30, protein_qualifier: 'max', fat_pct: null, fat_qualifier: null, fiber_pct: 4, fiber_qualifier: 'max',
      moisture_pct: 12, moisture_qualifier: 'max', ash_pct: 8, ash_qualifier: 'reported',
      kcal_per_kg: null, kcal_per_100g: 380, energy_basis: 'as_fed', is_korea_market_observation: true, is_current_resolved_formula: true,
      additional_nutrients: [], additional_nutrient_count: 0, supplemental_nutrition_fields: [], supplemental_observation_scope: null,
      supplemental_market_code: null, supplemental_is_current_resolved_formula: false, basis_specific_nutrition_basis: null, basis_specific_nutrition_values: [],
    },
  ]
  const variant = (productId, variantId, size, weight) => ({
    product_id: productId, variant_id: variantId, package_size_text: size, package_weight_g: weight, units_per_sale: 1,
    sale_total_weight_g: weight, sales_bundle_status: null, display_rank: 1, variant_count: 1, formula_evidence_status: 'confirmed',
    recipe_families: [], recipe_details: [], official_recipe_traits: [], ingredient_term_result_count: 0,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [], insufficient_evidence_ingredient_terms: [],
  })

  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/compare_product_nutrition')) return Response.json(nutritionRows)
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([])
    if (url.pathname.endsWith('/switch_current_variant_options')) {
      const filter = url.searchParams.get('product_id') ?? ''
      if (filter.includes(first.product_id)) return Response.json([variant(first.product_id, 'variant_first', '3 kg', 3000)])
      if (filter.includes(second.product_id)) return Response.json([variant(second.product_id, 'variant_second', '7.26 kg', 7260)])
      return Response.json([])
    }
    return Response.json([])
  }

  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.CompareView, {
    items: [{ product: first }, { product: second }],
    onClose() {},
    onRemove() {},
    initialTab: 'nutrition',
  })))
  await waitForUi(
    () => document.querySelector('.compare-mobile-two-product-nutrition')?.textContent.includes('7.26 kg 제품에서 확인'),
    'two-product mobile nutrition with package scopes rendered',
  )

  const mobile = document.querySelector('.compare-mobile-two-product-nutrition')
  assert.ok(mobile)
  assert.equal(mobile.querySelectorAll('.compare-mobile-two-product-head').length, 2)
  assert.equal(document.querySelector('.compare-mobile-two-product-overview'), null)
  assert.ok(document.querySelector('.compare-two-product-nutrition-desktop'))

  const valuesFor = (id) => [...mobile.querySelector(id).closest('tbody').querySelectorAll('.compare-mobile-two-product-value')].map((cell) => cell.textContent.trim())
  assert.deepEqual(valuesFor('#compare-mobile-two-row-nutrition-energy'), ['410 kcal/100g', '380 kcal/100g'])
  assert.deepEqual(valuesFor('#compare-mobile-two-row-nutrition-protein'), ['32% 이상', '30% 이하'])
  assert.deepEqual(valuesFor('#compare-mobile-two-row-nutrition-fat'), ['15% 이상', '미확인'])
  assert.deepEqual(valuesFor('#compare-mobile-two-row-nutrition-ash'), ['미확인', '8%'])

  const calciumValues = valuesFor('#compare-mobile-two-row-nutrition-additional-calcium')
  assert.deepEqual(calciumValues, ['1.2% 이상', '미확인'])

  const scopeValues = valuesFor('#compare-mobile-two-row-nutrition-scope')
  assert.match(scopeValues[0], /한국 판매 제품 자료.*3 kg 제품에서 확인.*보완 자료 포함/)
  assert.match(scopeValues[0], /자료 기준 보기/)
  assert.match(scopeValues[0], /제공된 열량.*4,100 kcal\/kg/)
  assert.match(scopeValues[1], /한국 판매 제품 자료.*7\.26 kg 제품에서 확인/)
  assert.match(scopeValues[1], /자료 기준 보기/)
  assert.match(scopeValues[1], /제공된 열량.*380 kcal\/100g/)
  assert.doesNotMatch(scopeValues[1], /보완 자료 포함/)

  const proteinHeader = mobile.querySelector('#compare-mobile-two-row-nutrition-protein')
  const proteinCells = [...proteinHeader.closest('tbody').querySelectorAll('td')]
  assert.ok(proteinCells[0].getAttribute('headers').includes(proteinHeader.id))
  assert.ok(proteinCells[0].getAttribute('headers').includes('compare-mobile-two-product-column-1-'))
  assert.ok(proteinCells[1].getAttribute('headers').includes('compare-mobile-two-product-column-2-'))

  installFetch()
})


test('comparison energy normalizes kg-only, preserves 100g-only, keeps kg priority when both exist, and preserves decimals', async () => {
  const first = products[0], second = products[1], third = products[2], fourth = products[3]
  const rows = [
    {
      product_id: first.product_id, variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'reported',
      protein_pct: null, protein_qualifier: null, fat_pct: null, fat_qualifier: null, fiber_pct: null, fiber_qualifier: null,
      moisture_pct: null, moisture_qualifier: null, ash_pct: null, ash_qualifier: null,
      kcal_per_kg: 3485, kcal_per_100g: null, energy_basis: 'direct_label', is_korea_market_observation: true, is_current_resolved_formula: false,
      additional_nutrients: [], additional_nutrient_count: 0, supplemental_nutrition_fields: [], supplemental_observation_scope: null,
      supplemental_market_code: null, supplemental_is_current_resolved_formula: false, basis_specific_nutrition_basis: null, basis_specific_nutrition_values: [],
    },
    {
      product_id: second.product_id, variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'reported',
      protein_pct: null, protein_qualifier: null, fat_pct: null, fat_qualifier: null, fiber_pct: null, fiber_qualifier: null,
      moisture_pct: null, moisture_qualifier: null, ash_pct: null, ash_qualifier: null,
      kcal_per_kg: null, kcal_per_100g: 370, energy_basis: 'direct_label', is_korea_market_observation: true, is_current_resolved_formula: false,
      additional_nutrients: [], additional_nutrient_count: 0, supplemental_nutrition_fields: [], supplemental_observation_scope: null,
      supplemental_market_code: null, supplemental_is_current_resolved_formula: false, basis_specific_nutrition_basis: null, basis_specific_nutrition_values: [],
    },
    {
      product_id: third.product_id, variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'reported',
      protein_pct: null, protein_qualifier: null, fat_pct: null, fat_qualifier: null, fiber_pct: null, fiber_qualifier: null,
      moisture_pct: null, moisture_qualifier: null, ash_pct: null, ash_qualifier: null,
      kcal_per_kg: 4100, kcal_per_100g: 999, energy_basis: 'calculated', is_korea_market_observation: true, is_current_resolved_formula: false,
      additional_nutrients: [], additional_nutrient_count: 0, supplemental_nutrition_fields: [], supplemental_observation_scope: null,
      supplemental_market_code: null, supplemental_is_current_resolved_formula: false, basis_specific_nutrition_basis: null, basis_specific_nutrition_values: [],
    },
    {
      product_id: fourth.product_id, variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'reported',
      protein_pct: null, protein_qualifier: null, fat_pct: null, fat_qualifier: null, fiber_pct: null, fiber_qualifier: null,
      moisture_pct: null, moisture_qualifier: null, ash_pct: null, ash_qualifier: null,
      kcal_per_kg: null, kcal_per_100g: null, energy_basis: null, is_korea_market_observation: true, is_current_resolved_formula: false,
      additional_nutrients: [], additional_nutrient_count: 0, supplemental_nutrition_fields: [], supplemental_observation_scope: null,
      supplemental_market_code: null, supplemental_is_current_resolved_formula: false, basis_specific_nutrition_basis: null, basis_specific_nutrition_values: [],
    },
  ]
  globalThis.fetch = window.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/compare_product_nutrition')) return Response.json(rows)
    if (url.pathname.endsWith('/compare_product_ingredients')) return Response.json([])
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    return Response.json([])
  }

  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.CompareView, {
    items: [first, second, third, fourth].map((product) => ({ product })),
    onClose() {},
    onRemove() {},
    initialTab: 'nutrition',
  })))
  await waitForUi(() => document.querySelector('.compare-table')?.textContent.includes('348.5 kcal/100g'), 'normalized comparison energy rendered')

  const energyRow = [...document.querySelectorAll('.compare-table > .compare-row')].find((row) => row.querySelector('.compare-row-label')?.textContent.trim() === '열량')
  assert.ok(energyRow)
  assert.deepEqual([...energyRow.querySelectorAll('.compare-cell')].map((cell) => cell.textContent.trim()), [
    '348.5 kcal/100g',
    '370 kcal/100g',
    '410 kcal/100g',
    '미확인',
  ])

  const scopeRow = [...document.querySelectorAll('.compare-table > .compare-row')].find((row) => row.querySelector('.compare-row-label')?.textContent.trim() === '적용 범위')
  assert.ok(scopeRow)
  const scopes = [...scopeRow.querySelectorAll('.compare-cell')].map((cell) => cell.textContent.replace(/\s+/g, ' ').trim())
  assert.match(scopes[0], /제공된 열량.*3,485 kcal\/kg/)
  assert.match(scopes[1], /제공된 열량.*370 kcal\/100g/)
  assert.match(scopes[2], /제공된 열량.*4,100 kcal\/kg/)
  assert.doesNotMatch(scopes[2], /999 kcal\/100g/, 'kg remains the selected provided value when both fields exist')
  assert.doesNotMatch(scopes[3], /자료 기준 보기/, 'missing energy alone does not invent provided-value disclosure')

  installFetch()
})

test('detail tablist supports arrow-key focus movement', async () => {
  await renderApp(`https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product&detail=${products[0].product_id}`)
  const overview = document.getElementById('detail-tab-overview')
  overview.focus()
  await act(async () => overview.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await waitForUi(() => document.activeElement?.id === 'detail-tab-nutrition', 'nutrition tab receives focus after ArrowRight')
  assert.equal(document.activeElement?.id, 'detail-tab-nutrition')
  assert.equal(document.activeElement?.getAttribute('aria-selected'), 'true')
})


test('non-SWITCH overview keeps a partly populated row visible and collapses only rows empty for every product', async () => {
  const first = { ...products[0], official_targets: ['indoor'], features: [] }
  const second = { ...products[1], official_targets: [], features: [] }
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.CompareView, {
    items: [{ product: first }, { product: second }],
    onClose() {},
    onRemove() {},
  })))
  await waitForUi(() => document.querySelector('.compare-stage') !== null, 'comparison rendered')

  const visibleRows = [...document.querySelectorAll('.compare-table > .compare-row')]
  const targetRow = visibleRows.find((row) => row.querySelector('.compare-row-label')?.textContent.trim() === '제품 표기 대상')
  assert.ok(targetRow)
  assert.deepEqual([...targetRow.querySelectorAll('.compare-cell')].map((cell) => cell.textContent.trim()), ['실내묘', '확인된 값 없음'])

  const disclosure = document.querySelector('.compare-table > .compare-overview-extra')
  assert.ok(disclosure)
  assert.equal(disclosure.open, false)
  assert.match(disclosure.textContent, /제품 특징/)
  assert.doesNotMatch(disclosure.textContent, /제품 표기 대상/)
})

for (const mode of ['lookup', 'explore']) {
  test(mode + ' comparison detail labels its actual parent and returns to the same comparison tab', async () => {
    const ids = products.slice(0, 2).map((product) => product.product_id)
    const params = new URLSearchParams({ view: 'workspace', mode, q: 'Product', applied: '1', compare: ids.join(','), compareOpen: '1', compareTab: 'nutrition' })
    await renderApp('https://catfood.test/catfood_web/?' + params)
    const comparisonUrl = window.location.href
    await click('상세 보기')
    const back = document.querySelector('.detail-topbar button')
    assert.equal(back.textContent, '← 비교로 돌아가기')
    await click('비교로 돌아가기')
    assert.equal(document.querySelector('.detail-stage'), null)
    assert.ok(document.querySelector('.compare-stage'))
    assert.equal(document.querySelector('.compare-tabs [aria-selected="true"]').textContent, '영양')
    assert.equal(document.querySelectorAll('.compare-product-head').length, 2)
    assert.equal(window.location.href, comparisonUrl)
  })
}

test('general comparison survives EXPLORE and LOOKUP roundtrip, zero lookup results, unchanged reapply, and history restoration', async () => {
  const first = products[0], second = products[1], third = products[2]
  const previousLifeStage = third.life_stage
  third.life_stage = 'senior'
  try {
    const params = new URLSearchParams({
      view: 'workspace',
      applied: '1',
      feed: '건식',
      age: 'adult',
      compare: [first.product_id, second.product_id].join(','),
    })
    await renderApp('https://catfood.test/catfood_web/?' + params)
    await waitForUi(() => document.querySelector('.switch-compare-dock') !== null, 'two-product EXPLORE comparison restored')
    assert.equal(new URL(window.location.href).searchParams.get('compare'), [first.product_id, second.product_id].join(','))
    assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 2\/5/)

    await click('제품 찾기')
    await waitForUi(() => document.querySelector('.lookup-input') !== null, 'LOOKUP opened from EXPLORE')
    assert.equal(new URL(window.location.href).searchParams.get('compare'), [first.product_id, second.product_id].join(','))
    assert.equal(new URL(window.location.href).searchParams.get('feed'), '건식')
    assert.equal(new URL(window.location.href).searchParams.get('age'), 'adult')
    assert.equal(new URL(window.location.href).searchParams.get('criteria'), '1')
    assert.equal(new URL(window.location.href).searchParams.get('applied'), null, 'LOOKUP keeps the applied comparison basis without pretending its condition editor is applied')
    assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 2\/5/)

    await inputValue(document.querySelector('.lookup-input'), third.canonical_name)
    await waitForUi(() => document.querySelector(`[data-product-id="${third.product_id}"]`) !== null, 'third product lookup result')
    await act(async () => document.querySelector(`[data-product-id="${third.product_id}"]`).click())
    await waitForUi(() => document.querySelector('.research-quick-view') !== null, 'third product quick view')
    await click('비교에 추가')
    const threeIds = [first.product_id, second.product_id, third.product_id]
    assert.equal(new URL(window.location.href).searchParams.get('compare'), threeIds.join(','))
    assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 3\/5/)

    await click('닫기 ×')
    await inputValue(document.querySelector('.lookup-input'), 'no-such-product-query')
    await waitForUi(() => /검색 결과가 없습니다/.test(document.querySelector('.state-message')?.textContent ?? ''), 'zero-result lookup state')
    assert.equal(document.querySelectorAll('.research-result-card').length, 0)
    assert.equal(new URL(window.location.href).searchParams.get('compare'), threeIds.join(','))
    assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 3\/5/)
    assert.ok([...document.querySelectorAll('.switch-compare-dock button')].some((node) => node.textContent.includes('비교 보기')))

    await click('조건으로 찾기')
    await waitForUi(() => document.querySelector('.condition-actions') !== null, 'EXPLORE condition editor reopened')
    assert.equal(document.querySelector('.switch-compare-dock'), null, 'compare dock stays hidden while editing conditions')
    assert.equal(new URL(window.location.href).searchParams.get('compare'), threeIds.join(','), 'mode re-entry keeps queued comparison in navigation state')

    await click('이 조건으로 찾기')
    await waitForUi(() => document.querySelector('.switch-compare-dock') !== null, 'unchanged EXPLORE conditions reapplied')
    assert.equal(new URL(window.location.href).searchParams.get('compare'), threeIds.join(','))
    assert.equal(new URL(window.location.href).searchParams.get('feed'), '건식')
    assert.equal(new URL(window.location.href).searchParams.get('age'), 'adult')
    assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 3\/5/)
    assert.equal(document.querySelector(`.research-result-card[data-product-id="${third.product_id}"]`), null, 'lookup-added senior product is not auto-treated as matching adult EXPLORE results')

    await click('조건 수정')
    await click('이 조건으로 찾기')
    await waitForUi(() => document.querySelector('.switch-compare-dock') !== null, 'same conditions reapplied from explicit editor')
    assert.equal(new URL(window.location.href).searchParams.get('compare'), threeIds.join(','))
    assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 3\/5/)

    await click('비교 보기')
    await waitForUi(() => document.querySelector('.compare-stage') !== null, 'three-product comparison opened')
    const heads = [...document.querySelectorAll('.compare-product-head')].map((node) => node.textContent)
    assert.equal(heads.length, 3)
    assert.match(heads[0], /Product 000/)
    assert.match(heads[1], /Product 001/)
    assert.match(heads[2], /Product 002/)
  } finally {
    third.life_stage = previousLifeStage
  }
})
