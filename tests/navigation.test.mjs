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
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null } })

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
    editingConditions: false,
    search: { ...state.search, feedType: '건식', lifeStage: 'adult' },
  })
  const restoredLookup = app.parseNavigationState(lookupSearch)
  assert.equal(restoredLookup.mode, 'lookup')
  assert.equal(restoredLookup.lookupQuery, 'Product')
  assert.equal(restoredLookup.search.feedType, '건식')
  assert.equal(restoredLookup.search.lifeStage, 'adult')
  assert.equal(restoredLookup.editingConditions, false)

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

test('two-product overview preserves EXPLORE relation semantics and stays scoped away from other tabs/counts', async () => {
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
  assert.equal(document.querySelector('.compare-mobile-two-product-overview'), null)
  assert.equal(document.querySelector('.compare-mobile-two-product-nutrition'), null)
  assert.ok(document.querySelector('.compare-table'))
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
  assert.match(scopes[0], /제공된 열량 3,485 kcal\/kg/)
  assert.match(scopes[1], /제공된 열량 370 kcal\/100g/)
  assert.match(scopes[2], /제공된 열량 4,100 kcal\/kg/)
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
    assert.equal(new URL(window.location.href).searchParams.get('applied'), '1')
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
