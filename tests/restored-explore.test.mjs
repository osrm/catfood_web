import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/?view=workspace&applied=1' })
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

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-restored-explore-'))
  app = await bundle()
  installFetch()
})
after(async () => {
  if (root) await act(async () => root.unmount())
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

test('direct and popstate-restored applied explore results create analytics runs', async () => {
  sessionStorage.clear()
  requests.length = 0
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(
    () => document.querySelectorAll('.research-result-card').length === 40
      && requests.filter((request) => request.kind === 'search-run').length === 1,
    'direct applied explore results and first search run',
  )

  const firstRun = requests.find((request) => request.kind === 'search-run')
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

  const lookupMode = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('제품 찾기'))
  assert.ok(lookupMode)
  await act(async () => lookupMode.click())
  await waitForUi(() => document.querySelector('.lookup-input') !== null, 'lookup mode opened')

  await act(async () => {
    window.history.back()
    await waitForUi(
      () => document.querySelectorAll('.research-result-card').length === 40
        && requests.filter((request) => request.kind === 'search-run').length === 2,
      'applied explore results and new search run restored by popstate',
    )
  })
  const runs = requests.filter((request) => request.kind === 'search-run')
  assert.equal(runs.length, 2)
  assert.equal(runs[1].body.mode, 'explore')
  assert.equal(runs[1].body.candidate_count, 45)
}
