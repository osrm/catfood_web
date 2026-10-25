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
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const originalFetch = globalThis.fetch
let app, disabled, root, temp, calls, handler
const id = 'product_0000000000000001'
const row = (field = 'energy', productId = id, url = 'https://example.com/energy') => ({ product_id: productId, field, source_url: url, publisher: 'Unverified brand label', checked_at: '2026-08-13T00:00:00Z' })
async function bundle(enabled) {
  const result = await build({ configFile: false, logLevel: 'silent', define: {
    'import.meta.env.DEV': 'false', 'import.meta.env.VITE_PUBLIC_SOURCE_LINKS_ENABLED': JSON.stringify(String(enabled)),
    'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"', 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
  }, build: { ssr: 'tests/entry.ts', write: false, minify: false } })
  const file = resolve(temp, `sources-${enabled}.mjs`)
  await writeFile(file, result.output.find((x) => x.type === 'chunk' && x.isEntry).code)
  return import(pathToFileURL(file).href)
}
before(async () => { await mkdir('node_modules/.cache', { recursive: true }); temp = await mkdtemp(resolve('node_modules/.cache/source-links-')); app = await bundle(true); disabled = await bundle(false) })
after(async () => { globalThis.fetch = originalFetch; dom.window.close(); await rm(temp, { recursive: true }) })
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root')); calls = []; handler = async () => Response.json([row()])
  globalThis.fetch = async (url, init) => { calls.push({ url: new URL(url), init }); return handler(new URL(url), init) }
})
afterEach(async () => { await act(async () => root.unmount()) })
async function render(productId = id, resource = 'nutrition', module = app) { await act(async () => root.render(createElement('details', null, createElement('summary', null, '원래 표기 보기'), createElement(module.SourceLinks, { productId, resource })))) }
async function toggle(open) { await act(async () => { const details = document.querySelector('details'); details.open = open; details.dispatchEvent(new dom.window.Event('toggle')); await Promise.resolve() }) }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }

test('disabled and unopened disclosures perform no source reads', async () => {
  await render(id, 'nutrition', disabled); await toggle(true); assert.equal(calls.length, 0); assert.equal(document.querySelector('.source-links'), null)
  assert.deepEqual(await disabled.fetchPublicSources(id, 'nutrition'), [])
  await toggle(false); await render(); await settle(); assert.equal(calls.length, 0)
})
test('opening requests only this product/resource by GET and reuses loaded data on close/reopen', async () => {
  await render(); await toggle(true); await settle(); assert.equal(calls.length, 1)
  assert.match(calls[0].url.pathname, /compare_product_nutrition_sources_scoped$/)
  assert.equal(calls[0].url.searchParams.get('p_product_ids'), `{"${id}"}`)
  assert.equal(calls[0].init.method ?? 'GET', 'GET'); assert.equal(calls[0].init.body, undefined)
  assert.equal(calls[0].url.searchParams.get('select'), 'product_id,field,source_url,publisher,checked_at')
  assert.equal(document.querySelector('a').hostname, 'example.com'); assert.equal(document.querySelector('a').textContent.trim(), 'example.com ↗')
  assert.ok(!document.body.textContent.includes('Unverified brand label'))
  assert.equal(document.querySelector('a').rel, 'noopener noreferrer'); assert.equal(document.querySelector('a').target, '_blank')
  await toggle(false); await toggle(true); await settle(); assert.equal(calls.length, 1)
})
test('one URL/date groups fields while missing source rows do not fabricate references', async () => {
  handler = async () => Response.json([row('fat'), row('protein')])
  await render(); await toggle(true); await settle(); assert.equal(document.querySelectorAll('a').length, 1)
  assert.match(document.querySelector('.source-links').textContent, /조단백질 · 조지방/)
  assert.ok(!document.querySelector('.source-links').textContent.includes('열량'))
  assert.equal(document.querySelector('time').dateTime, '2026-08-13')
})
test('a successful empty public response adds no absent/unverified-value warning', async () => {
  handler = async () => Response.json([]); await render(); await toggle(true); await settle()
  assert.equal(document.querySelectorAll('.source-links a, .source-links p, .source-links button').length, 0)
  assert.ok(!document.body.textContent.includes('미확인')); assert.ok(!document.body.textContent.includes('자료 없음'))
})
test('failure is not empty evidence and retry restores focus to the stable disclosure control', async () => {
  handler = async () => new Response('private server detail', { status: 500 }); await render(); await toggle(true); await settle()
  const button = document.querySelector('.source-links button'); assert.ok(button); assert.ok(!document.body.textContent.includes('private server detail'))
  handler = async () => Response.json([row()]); button.focus(); await act(async () => button.click()); await settle()
  assert.equal(document.activeElement, document.querySelector('summary')); assert.equal(calls.length, 2); assert.equal(document.querySelectorAll('a').length, 1)
})
test('closing aborts an unfinished read; late old-product results never replace the active product', async () => {
  let resolveOld; handler = () => new Promise((resolve) => { resolveOld = resolve })
  await render(); await toggle(true); const oldSignal = calls[0].init.signal; await toggle(false); assert.equal(oldSignal.aborted, true)
  const next = 'product_0000000000000002'; handler = async () => Response.json([row('energy', next, 'https://example.com/new')])
  await render(next); await settle(); assert.equal(calls.length, 1, 'closed replacement does not prefetch')
  await toggle(true); await settle(); await act(async () => resolveOld(Response.json([row()]))); await settle()
  assert.equal(document.querySelector('a').getAttribute('href'), 'https://example.com/new')
})
test('ingredient resources use their own scoped endpoint and preserve applicable list parts', async () => {
  handler = async () => Response.json([row('ingredients'), row('supplemental_ingredients', id, 'https://example.com/full')])
  await render(id, 'ingredients'); await toggle(true); await settle()
  assert.match(calls[0].url.pathname, /compare_product_ingredients_sources_scoped$/); assert.equal(document.querySelectorAll('a').length, 2)
  assert.match(document.querySelector('.source-links').textContent, /다른 자료의 전체 원재료/)
})
test('response validation rejects a wrong product, duplicate field, invalid date and unsafe URLs', async () => {
  for (const data of [[row('energy', 'other')], [row(), row()], [{ ...row(), checked_at: 'not a date' }], [row('unexpected')], ...['javascript:alert(1)', 'http://example.com/x', 'https://user:pass@example.com/x', 'https://127.0.0.1/x', 'https://host.internal/x', 'https://example.com/x?token=secret', 'https://example.com/x#secret', 'https://example.com/x%0d'].map((url) => [row('energy', id, url)])]) {
    handler = async () => Response.json(data); await assert.rejects(app.fetchPublicSources(id, 'nutrition'))
  }
  handler = async () => Response.json([{ ...row(), source_url: 'https://example.com/item?product_no=187', private_note: 'DO_NOT_EXPORT' }])
  const clean = await app.fetchPublicSources(id, 'nutrition'); assert.equal(clean[0].private_note, undefined)
})

function product(productId) {
  return { product_id: productId, brand: 'Fixture brand', canonical_name: '충분히 긴 식별 가능한 사료 이름 ' + productId, feed_type: '건식', life_stage: 'adult', display_image_url: null,
    representative_variant_id: null, representative_package_size_text: null, variant_count: 0, has_variants: false, has_ingredient_details: true, has_nutrition_details: true,
    manufacturing_country_codes: [], assessed_market_country_codes: [], current_market_country_codes: [], formula_match_market_country_codes: [],
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [], insufficient_evidence_ingredient_terms: [], official_targets: [], features: [], recipe_families: [], recipe_details: [], official_recipe_traits: [] }
}
function installProductReads() {
  handler = async (url) => {
    const ids = JSON.parse('[' + (url.searchParams.get('p_product_ids') ?? '{}').slice(1, -1) + ']')
    if (url.pathname.endsWith('_sources_scoped')) return Response.json([row(url.pathname.includes('ingredients') ? 'ingredients' : 'energy', ids[0])])
    if (url.pathname.endsWith('/compare_product_nutrition_scoped')) return Response.json(ids.map((productId) => ({ product_id: productId, observation_scope: 'product', market_code: 'KR', kcal_per_kg: 3700, kcal_per_100g: null, protein_pct: 33, protein_qualifier: 'min', fat_pct: 20, fat_qualifier: 'min', additional_nutrients: [], supplemental_nutrition_fields: [] })))
    if (url.pathname.endsWith('/compare_product_ingredients_scoped')) return Response.json(ids.map((productId) => ({ product_id: productId, observation_scope: 'product', market_code: 'KR', completeness_status: 'full', raw_text: 'Chicken, rice', ingredient_names: [], ingredient_count: 0, supplemental_full_ingredient_names: [] })))
    return Response.json([])
  }
}
const sourceCalls = () => calls.filter((c) => c.url.pathname.endsWith('_sources_scoped'))
async function openDetails(details) { assert.ok(details); await act(async () => { details.open = true; details.dispatchEvent(new dom.window.Event('toggle')) }); await settle() }
test('real ProductDetail exposes source context for raw-only ingredient data without prefetch', async () => {
  installProductReads(); await act(async () => root.render(createElement(app.ProductDetail, { product: product(id), initialTab: 'ingredients', onClose() {} }))); await settle()
  assert.equal(sourceCalls().length, 0); assert.match(document.body.textContent, /Chicken, rice/)
  await openDetails(document.querySelector('.detail-ingredient-evidence-disclosure'))
  assert.equal(sourceCalls().length, 1); assert.match(sourceCalls()[0].url.pathname, /ingredients_sources_scoped$/)
  assert.equal(document.querySelector('.source-links a').hostname, 'example.com')
})
test('unresolved foreign primary or supplemental ingredient identity stays outside the closed source disclosure', async () => {
  const cases = [{ market_code: 'JP', observation_scope: 'product', is_current_resolved_formula: false }, { supplemental_full_raw_text: 'Duck, rice', supplemental_full_ingredient_names: ['Duck', 'rice'], supplemental_full_ingredient_count: 2, supplemental_market_code: 'JP', supplemental_observation_scope: 'product', supplemental_is_current_resolved_formula: false }]
  for (let index = 0; index < cases.length; index++) {
    installProductReads(); const fallback = handler
    handler = async (url, init) => {
      const response = await fallback(url, init)
      if (!url.pathname.endsWith('/compare_product_ingredients_scoped')) return response
      return Response.json((await response.json()).map((r) => ({ ...r, ...cases[index] })))
    }
    await act(async () => root.render(createElement(app.ProductDetail, { key: index, product: product(id), initialTab: 'ingredients', onClose() {} }))); await settle()
    const warning = [...document.querySelectorAll('.detail-evidence-context')].find((node) => node.textContent.includes('同じ') || node.textContent.includes('같은 배합인지 확인되지 않은'))
    assert.ok(warning); assert.equal(warning.closest('details'), null)
    assert.equal(document.querySelector('.detail-ingredient-evidence-disclosure').open, false)
  }
  assert.equal(sourceCalls().length, 0)
})
test('general nutrition comparison waits for one chosen product disclosure', async () => {
  installProductReads(); const items = [product(id), product('product_0000000000000002')].map((product) => ({ product }))
  await act(async () => root.render(createElement(app.CompareView, { items, initialTab: 'nutrition', onClose() {}, onRemove() {} }))); await settle()
  assert.equal(sourceCalls().length, 0)
  await openDetails(document.querySelector('.compare-table .source-links')?.closest('details'))
  assert.equal(sourceCalls().length, 1); assert.equal(sourceCalls()[0].url.searchParams.get('p_product_ids'), `{"${id}"}`)
  assert.match(document.body.textContent, /370/)
})
test('SWITCH source reads keep the current product separate from five candidates', async () => {
  installProductReads(); const current = product('product_0000000000000099'), items = Array.from({ length: 5 }, (_, i) => ({ product: product(`product_${String(i + 1).padStart(16, '0')}`) }))
  await act(async () => root.render(createElement(app.CompareView, { currentProduct: current, currentVariantText: '1 kg', items, initialTab: 'nutrition', onClose() {}, onRemove() {} }))); await settle()
  assert.equal(sourceCalls().length, 0)
  const panels = [...document.querySelectorAll('.compare-switch-nutrition-desktop .source-links')]
  assert.equal(panels.length, 6)
  await openDetails(panels[0].closest('details')); await openDetails(panels.at(-1).closest('details'))
  assert.deepEqual(sourceCalls().map((c) => c.url.searchParams.get('p_product_ids')), [`{"${current.product_id}"}`, `{"${items.at(-1).product.product_id}"}`])
})
