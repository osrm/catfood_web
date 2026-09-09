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
      && (document.querySelector('.detail-stage') !== null || document.querySelector('.research-results') !== null || document.querySelector('.home-shell') !== null),
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

test('URL parser rejects unknown filters and tabs, deduplicates compare IDs, and caps compare at five', () => {
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

test('detail tablist supports arrow-key focus movement', async () => {
  await renderApp(`https://catfood.test/catfood_web/?view=workspace&mode=lookup&q=Product&detail=${products[0].product_id}`)
  const overview = document.getElementById('detail-tab-overview')
  overview.focus()
  await act(async () => overview.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await waitForUi(() => document.activeElement?.id === 'detail-tab-nutrition', 'nutrition tab receives focus after ArrowRight')
  assert.equal(document.activeElement?.id, 'detail-tab-nutrition')
  assert.equal(document.activeElement?.getAttribute('aria-selected'), 'true')
})
