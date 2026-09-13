import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
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
let temp, app, root
const requests = []

const products = Array.from({ length: 45 }, (_, index) => ({
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
  manufacturing_country_codes: [], assessed_market_country_codes: [], current_market_country_codes: [],
  formula_match_market_country_codes: [], confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [],
  flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [], insufficient_evidence_ingredient_terms: [],
  official_targets: [], features: [], recipe_families: [], recipe_details: [], official_recipe_traits: [],
}))

async function bundle() {
  const result = await build({
    configFile: false, logLevel: 'silent',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_DECISION_INTAKE_ENABLED': '"true"',
      'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"',
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
    },
    build: { ssr: 'tests/entry.ts', write: false, minify: false },
  })
  const chunk = result.output.find((item) => item.type === 'chunk' && item.isEntry)
  const file = resolve(temp, 'restored-explore.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

function installFetch() {
  globalThis.fetch = window.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/effective_product_catalog_summary')) return Response.json(products)
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    if (url.pathname.endsWith('/search-runs')) {
      const body = JSON.parse(init.body)
      requests.push({ kind: 'search-run', body })
      window.dispatchEvent(new window.Event('analyticsrequest'))
      return Response.json({ search_run_id: `run-${requests.filter((request) => request.kind === 'search-run').length}` })
    }
    if (url.pathname.endsWith('/considerations')) {
      requests.push({ kind: 'consideration', body: JSON.parse(init.body) })
      window.dispatchEvent(new window.Event('analyticsrequest'))
      return Response.json({ ok: true })
    }
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
      window.removeEventListener('popstate', check)
      window.removeEventListener('analyticsrequest', check)
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
    window.addEventListener('popstate', check)
    window.addEventListener('analyticsrequest', check)
    const timeout = window.setTimeout(() => finish(new Error(`UI condition not reached: ${message}`)), 1500)
    check()
  })
}

const searchRuns = () => requests.filter((request) => request.kind === 'search-run')
const buttons = () => [...document.querySelectorAll('button')]
const button = (text) => buttons().find((element) => element.textContent.includes(text))
async function click(target) {
  const element = typeof target === 'string' ? button(target) : target
  assert.ok(element, `missing button: ${target}`)
  assert.equal(element.disabled, false)
  await act(async () => element.click())
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-restored-explore-'))
  app = await bundle()
})
beforeEach(() => {
  sessionStorage.clear()
  requests.length = 0
  installFetch()
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  root = null
})
after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

test('direct and popstate-restored applied explore results create analytics runs', async () => {
  dom.reconfigure({ url: 'https://catfood.test/?view=workspace&applied=1' })
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(
    () => document.querySelectorAll('.research-result-card').length === 40
      && searchRuns().length === 1,
    'direct applied explore results and first search run',
  )

  const firstRun = searchRuns()[0]
  assert.equal(firstRun.body.mode, 'explore')
  assert.equal(firstRun.body.candidate_count, 45)
  assert.equal(firstRun.body.initial_presented_product_ids.length, 40)

  const firstCard = document.querySelector('.research-result-card')
  await act(async () => firstCard.click())
  await waitForUi(
    () => requests.filter((request) => request.kind === 'consideration').length === 1,
    'restored explore consideration recorded',
  )
  assert.equal(requests.find((request) => request.kind === 'consideration').body.search_run_id, 'run-1')

  const lookupMode = button('제품 찾기')
  assert.ok(lookupMode)
  await act(async () => lookupMode.click())
  await waitForUi(() => document.querySelector('.lookup-input') !== null, 'lookup mode opened')

  await act(async () => {
    window.history.back()
    await waitForUi(
      () => document.querySelectorAll('.research-result-card').length === 40
        && searchRuns().length === 2,
      'applied explore results and new search run restored by popstate',
    )
  })
  const runs = searchRuns()
  assert.equal(runs.length, 2)
  assert.equal(runs[1].body.mode, 'explore')
  assert.equal(runs[1].body.candidate_count, 45)
})

test('EXPLORE additional disclosure keeps draft state separate from applied search state', async () => {
  dom.reconfigure({ url: 'https://catfood.test/?view=workspace' })
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => document.querySelector('.mobile-additional-toggle') !== null, 'condition editor rendered')

  const toggle = document.querySelector('.mobile-additional-toggle')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'new editor starts with additional conditions collapsed')
  assert.match(document.querySelector('.condition-draft-count').textContent, /선택한 조건 0개/)
  assert.match(toggle.textContent, /선택 없음/)
  assert.equal(searchRuns().length, 0)

  const editingUrl = window.location.href
  await click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(window.location.href, editingUrl, 'disclosure alone does not change navigation')
  assert.equal(searchRuns().length, 0, 'disclosure alone does not create a search run')

  await click('실내묘')
  assert.match(document.querySelector('.condition-draft-count').textContent, /선택한 조건 1개/)
  assert.match(toggle.textContent, /1개 선택/)
  assert.match(document.querySelector('.mobile-additional-summary').textContent, /실내묘/)
  assert.equal(searchRuns().length, 0)

  await click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.match(document.querySelector('.mobile-additional-summary').textContent, /실내묘/, 'collapsed summary keeps selected labels visible')
  assert.equal(button('실내묘').getAttribute('aria-pressed'), 'true', 'collapsing does not clear the selected value')

  await click('이 조건으로 찾기')
  await waitForUi(() => searchRuns().length === 1 && document.querySelectorAll('.research-result-card').length === 40, 'additional condition applied')
  const applied = new URL(window.location.href)
  assert.equal(applied.searchParams.get('applied'), '1')
  assert.equal(applied.searchParams.get('targets'), 'indoor')
  assert.ok(searchRuns()[0].body.criteria_snapshot.some((criterion) => criterion.axis === 'official_target' && criterion.value === 'indoor'))

  await click('조건 수정')
  const restoredToggle = document.querySelector('.mobile-additional-toggle')
  assert.equal(restoredToggle.getAttribute('aria-expanded'), 'true', 'editing an applied additional condition starts expanded')
  assert.equal(button('실내묘').getAttribute('aria-pressed'), 'true')
  assert.match(document.querySelector('.condition-draft-count').textContent, /선택한 조건 1개/)
  assert.equal(new URL(window.location.href).searchParams.get('targets'), 'indoor')

  const runsBeforeReset = searchRuns().length
  await click('초기화')
  assert.equal(restoredToggle.getAttribute('aria-expanded'), 'true', 'reset does not change disclosure state')
  assert.equal(button('실내묘').getAttribute('aria-pressed'), 'false')
  assert.match(document.querySelector('.condition-draft-count').textContent, /선택한 조건 0개/)
  assert.match(restoredToggle.textContent, /선택 없음/)
  assert.equal(new URL(window.location.href).searchParams.get('targets'), 'indoor', 'reset leaves the applied URL untouched until apply')
  assert.equal(searchRuns().length, runsBeforeReset, 'reset and disclosure do not create search runs')
})
