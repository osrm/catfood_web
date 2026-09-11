import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'

const BASE = 'https://catfood.test/catfood_web/'
const dom = new JSDOM('<div id="root"></div>', { url: BASE })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch
let app, root, temp
let catalogProducts = []
let variantsByProduct = new Map()
let failCatalogCount = 0
let searchRuns = []
let considerations = []

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

function variant(productId, variantId, size = '1 kg', rank = 1) {
  return {
    product_id: productId,
    variant_id: variantId,
    package_size_text: size,
    package_weight_g: size === '1 kg' ? 1000 : 2000,
    units_per_sale: 1,
    sale_total_weight_g: size === '1 kg' ? 1000 : 2000,
    sales_bundle_status: null,
    display_rank: rank,
    variant_count: 2,
    formula_evidence_status: 'confirmed',
    recipe_families: ['poultry'],
    recipe_details: ['chicken'],
    official_recipe_traits: [],
    ingredient_term_result_count: 1,
    confirmed_present_ingredient_terms: ['chicken'],
    direct_evidence_ingredient_terms: ['chicken'],
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
  }
}

const current = product('product_current', '현재 건식 사료', {
  brand: '현재브랜드', feed_type: '건식', life_stage: 'adult', variant_count: 2, has_variants: true,
  official_targets: ['indoor'], features: ['digestive'], recipe_families: ['poultry'], recipe_details: ['chicken'],
  confirmed_present_ingredient_terms: ['chicken'], direct_evidence_ingredient_terms: ['chicken'],
})
const candidateA = product('product_candidate_a', '전환 습식 A', {
  brand: '새브랜드A', feed_type: '습식', life_stage: 'adult', variant_count: 1, has_variants: true,
  official_targets: ['indoor'], features: ['digestive'], recipe_families: ['fish'], recipe_details: ['salmon'],
  reviewed_not_found_ingredient_terms: ['chicken'],
})
const candidateB = product('product_candidate_b', '전환 습식 B', {
  brand: '새브랜드B', feed_type: '습식', life_stage: 'adult', variant_count: 1, has_variants: true,
  official_targets: ['indoor'], features: ['digestive'], recipe_families: ['fish'], recipe_details: ['tuna'],
  reviewed_not_found_ingredient_terms: ['chicken'],
})
const singleSku = product('product_single', '단일 규격 건식', {
  brand: '단일브랜드', feed_type: '건식', life_stage: 'adult', variant_count: 1, has_variants: true,
  official_targets: ['indoor'], recipe_families: ['poultry'], confirmed_present_ingredient_terms: ['chicken'],
})

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
  const file = resolve(temp, 'switch-session-navigation.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-switch-session-tests-'))
  app = await bundle()
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  catalogProducts = [current, candidateA, candidateB, singleSku]
  variantsByProduct = new Map([
    [current.product_id, [variant(current.product_id, 'variant_current_1', '1 kg', 1), variant(current.product_id, 'variant_current_2', '2 kg', 2)]],
    [singleSku.product_id, [variant(singleSku.product_id, 'variant_single_1', '1 kg', 1)]],
    [candidateA.product_id, [variant(candidateA.product_id, 'variant_candidate_a', '85 g', 1)]],
    [candidateB.product_id, [variant(candidateB.product_id, 'variant_candidate_b', '85 g', 1)]],
  ])
  failCatalogCount = 0
  searchRuns = []
  considerations = []
  sessionStorage.clear()
  window.history.replaceState(null, '', `${BASE}?view=workspace&mode=switch`)
  document.body.innerHTML = '<div id="root"></div>'
  installFetch()
})

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = null
  }
})

function installFetch() {
  globalThis.fetch = window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.origin, 'https://api.test')
    if (url.pathname.endsWith('/effective_product_catalog_summary')) {
      if (failCatalogCount > 0) {
        failCatalogCount -= 1
        return new Response('temporary catalog failure', { status: 503 })
      }
      return Response.json(catalogProducts)
    }
    if (url.pathname.endsWith('/switch_current_variant_options')) {
      const productFilter = url.searchParams.get('product_id')
      if (productFilter?.startsWith('eq.')) return Response.json(variantsByProduct.get(productFilter.slice(3)) ?? [])
      return Response.json([...variantsByProduct.values()].flat().map((row) => ({
        product_id: row.product_id,
        variant_id: row.variant_id,
        package_size_text: row.package_size_text,
        package_weight_g: row.package_weight_g,
        units_per_sale: row.units_per_sale,
        sale_total_weight_g: row.sale_total_weight_g,
        display_rank: row.display_rank,
      })))
    }
    if (url.pathname.endsWith('/search-runs')) {
      searchRuns.push(JSON.parse(init.body))
      return Response.json({ search_run_id: `run-${searchRuns.length}` })
    }
    if (url.pathname.endsWith('/considerations')) {
      considerations.push(JSON.parse(init.body))
      return Response.json({ ok: true })
    }
    if (url.pathname.includes('/compare_product_') || url.pathname.includes('/product_')) return Response.json([])
    return Response.json([])
  }
}

const all = (selector) => [...document.querySelectorAll(selector)]
const exactButton = (text) => all('button').find((node) => node.textContent.trim() === text)
const variantButton = (text) => all('button').find((node) => node.textContent.includes(text) && node.textContent.includes('단일 판매'))
const button = (text) => all('button').find((node) => node.textContent.includes(text))

async function click(target) {
  const node = typeof target === 'string' ? button(target) : target
  assert.ok(node, `missing button: ${target}`)
  assert.equal(node.disabled, false, `disabled button: ${node.textContent}`)
  await act(async () => node.click())
}

async function inputValue(element, value) {
  assert.ok(element)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function waitForUi(predicate, message, timeoutMs = 2500) {
  if (predicate()) return
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      observer.disconnect()
      window.removeEventListener('popstate', check)
      window.clearTimeout(timeout)
      error ? rejectPromise(error) : resolvePromise()
    }
    const check = () => {
      try { if (predicate()) finish() } catch (error) { finish(error) }
    }
    const observer = new window.MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    window.addEventListener('popstate', check)
    const timeout = window.setTimeout(() => finish(new Error(`UI condition not reached: ${message}\n${document.body.textContent.slice(0, 1200)}`)), timeoutMs)
    check()
  })
}

async function renderApp({ preserveHistory = false } = {}) {
  if (!preserveHistory) window.history.replaceState(null, '', `${BASE}?view=workspace&mode=switch`)
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => document.body.textContent.includes('데이터 연결됨') || document.body.textContent.includes('연결 오류'), 'catalog settles')
}

async function remountApp() {
  await act(async () => root.unmount())
  root = null
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => document.body.textContent.includes('데이터 연결됨') || document.body.textContent.includes('연결 오류'), 'remounted catalog settles')
}

async function chooseCurrent(productName = current.canonical_name) {
  const input = document.querySelector('.switch-find-search input')
  await inputValue(input, productName)
  await waitForUi(() => all('.switch-find-result').some((node) => node.textContent.includes(productName)), 'current product search result')
  await click(all('.switch-find-result').find((node) => node.textContent.includes(productName)))
  await click('이 제품을 현재 사료로 선택')
  await waitForUi(() => document.body.textContent.includes('현재 먹이는 규격을 골라주세요'), 'SKU step')
}

async function reachResultsWithConditions({ variantMode = 'variant' } = {}) {
  await chooseCurrent()
  if (variantMode === 'variant') {
    await waitForUi(() => variantButton('1 kg') !== undefined, 'variant option')
    await click(variantButton('1 kg'))
    await click(exactButton('다음 →'))
  } else {
    await click('사용 규격을 모르겠어요')
  }
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'CHANGE step')
  await click(exactButton('습식'))
  const ingredient = document.querySelector('.switch-current-ingredients button')
  if (ingredient) await click(ingredient)
  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 그대로 유지할까요?'), 'KEEP step')
  if (exactButton('실내묘')) await click(exactButton('실내묘'))
  await click('후보 제품 보기')
  await waitForUi(() => document.querySelector('.switch-results-stage'), 'results step')
}

async function selectCandidate(name = candidateA.canonical_name) {
  const row = all('.switch-candidate-row').find((node) => node.textContent.includes(name))
  assert.ok(row, `missing candidate ${name}`)
  await click(row)
  await waitForUi(() => document.querySelector('.switch-candidate-inspector'), 'candidate inspector')
}

async function browserBack(predicate, message) {
  await act(async () => {
    window.history.back()
    await waitForUi(predicate, message)
  })
}

async function browserForward(predicate, message) {
  await act(async () => {
    window.history.forward()
    await waitForUi(predicate, message)
  })
}

function session() {
  const value = app.readSwitchSession(sessionStorage)
  assert.ok(value, 'expected SWITCH session snapshot')
  return value
}

test('versioned SWITCH snapshot rejects corrupt/unknown data and storage failures stay non-fatal', () => {
  sessionStorage.setItem('catfood.switch-session.v1', '{not json')
  assert.equal(app.readSwitchSession(sessionStorage), null)
  sessionStorage.setItem('catfood.switch-session.v1', JSON.stringify({ version: 999, state: {} }))
  assert.equal(app.readSwitchSession(sessionStorage), null)
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  assert.equal(app.readSwitchSession(blocked), null)
  assert.doesNotThrow(() => app.writeSwitchSession(app.createInitialSwitchSession('보존'), blocked))
})

test('refresh restores an actual SKU and explicit unknown SKU is not replaced by a single available variant', async () => {
  await renderApp()
  await chooseCurrent()
  await waitForUi(() => variantButton('1 kg') !== undefined, 'actual SKU')
  await click(variantButton('1 kg'))
  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'change before refresh')
  assert.equal(session().variantSelection.variantId, 'variant_current_1')
  await remountApp()
  assert.match(document.body.textContent, /무엇을 바꾸고 싶나요/)
  assert.match(document.body.textContent, /현재 규격1 kg/)
  assert.equal(session().variantSelection.variantId, 'variant_current_1')

  await click('현재 사료 다시 선택')
  await waitForUi(() => document.body.textContent.includes('현재 먹이는 사료를 찾으세요'), 'current reset')
  await chooseCurrent(singleSku.canonical_name)
  await waitForUi(() => variantButton('1 kg') !== undefined, 'single SKU auto available')
  await click('사용 규격을 모르겠어요')
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'unknown SKU change')
  assert.equal(session().variantSelection.kind, 'unknown')
  await remountApp()
  assert.match(document.body.textContent, /무엇을 바꾸고 싶나요/)
  assert.match(document.body.textContent, /현재 규격사용 규격 모름/)
  assert.equal(session().variantSelection.kind, 'unknown')
})

test('CHANGE KEEP ingredient avoidance and compare selection survive LOOKUP roundtrip and remount without replaying analytics', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await selectCandidate(candidateA.canonical_name)
  await click('비교에 추가')
  assert.deepEqual(session().compareIds, [candidateA.product_id])
  await click(exactButton('제품 찾기'))
  await waitForUi(() => document.querySelector('.lookup-input'), 'LOOKUP mode')
  assert.equal(new URL(window.location.href).searchParams.get('mode'), 'lookup')
  await click(exactButton('현재 사료'))
  await waitForUi(() => document.querySelector('.switch-results-stage'), 'SWITCH results after mode roundtrip')
  const summary = document.querySelector('.switch-session-bar').textContent
  assert.match(summary, /CHANGE.*습식.*피함 · 닭/s)
  assert.match(summary, /KEEP.*실내묘/s)
  assert.match(document.querySelector('.switch-compare-dock').textContent, /전환 습식 A/)
  const runsBeforeRemount = searchRuns.length
  await remountApp()
  assert.ok(document.querySelector('.switch-results-stage'))
  assert.match(document.querySelector('.switch-session-bar').textContent, /CHANGE.*습식.*피함 · 닭/s)
  assert.equal(searchRuns.length, runsBeforeRemount, 'restoration must not replay an old analytics search run')
})

test('browser back/forward restores SWITCH candidate detail and compare detail entries', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await selectCandidate(candidateA.canonical_name)
  await click('상세 보기')
  await waitForUi(() => document.querySelector('.detail-stage'), 'candidate detail')
  await browserBack(() => document.querySelector('.switch-candidate-inspector') && !document.querySelector('.detail-stage'), 'back to candidate parent')
  assert.match(document.querySelector('.switch-candidate-inspector').textContent, /전환 습식 A/)
  await browserForward(() => document.querySelector('.detail-stage'), 'forward to candidate detail')
  await browserBack(() => document.querySelector('.switch-candidate-inspector'), 'back to candidate again')

  await click('비교에 추가')
  await selectCandidate(candidateB.canonical_name)
  await click('비교에 추가')
  await click('비교 보기')
  await waitForUi(() => document.querySelector('.compare-stage'), 'compare page')
  const compareDetail = all('.compare-detail-link').find((node) => node.closest('.compare-product-head')?.textContent.includes(candidateA.canonical_name))
  await click(compareDetail)
  await waitForUi(() => document.querySelector('.detail-stage'), 'detail inside compare')
  await browserBack(() => document.querySelector('.compare-stage') && !document.querySelector('.detail-stage'), 'back from compare detail')
  assert.match(document.querySelector('.compare-stage').textContent, /전환 습식 A/)
  assert.match(document.querySelector('.compare-stage').textContent, /전환 습식 B/)
})

test('comparison removal survives browser back to results and explicit current-food reselection clears dependents', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await selectCandidate(candidateA.canonical_name)
  await click('비교에 추가')
  await selectCandidate(candidateB.canonical_name)
  await click('비교에 추가')
  await click('비교 보기')
  await waitForUi(() => document.querySelector('.compare-stage'), 'compare before removal')
  const removeA = document.querySelector(`button[aria-label="${candidateA.canonical_name} 비교에서 제거"]`)
  await click(removeA)
  assert.deepEqual(session().compareIds, [candidateB.product_id])
  await browserBack(() => document.querySelector('.switch-results-stage') && !document.querySelector('.compare-stage'), 'browser back to SWITCH results')
  const dock = document.querySelector('.switch-compare-dock')?.textContent ?? ''
  assert.doesNotMatch(dock, /전환 습식 A/)
  assert.match(dock, /전환 습식 B/)

  await click('현재 사료 다시 선택')
  await waitForUi(() => document.body.textContent.includes('현재 먹이는 사료를 찾으세요'), 'explicit current-food reset')
  const reset = session()
  assert.equal(reset.currentProductId, null)
  assert.equal(reset.step, 'current')
  assert.equal(reset.change.feedType, '')
  assert.deepEqual(reset.keep.officialTargets, [])
  assert.deepEqual(reset.ingredientAvoidTerms, [])
  assert.deepEqual(reset.compareIds, [])
  assert.equal(reset.selectedCandidateId, null)
})

test('catalog failure preserves restored selection until retry, then deleted products and invalid variants are repaired only after successful reads', async () => {
  const restored = app.createInitialSwitchSession('현재')
  restored.currentProductId = current.product_id
  restored.variantSelection = { kind: 'variant', variantId: 'variant_current_1' }
  restored.change = { ...restored.change, feedType: '습식' }
  restored.step = 'results'
  app.writeSwitchSession(restored, sessionStorage)
  window.history.replaceState(null, '', `${BASE}?view=workspace&mode=switch`)
  failCatalogCount = 1
  await renderApp({ preserveHistory: true })
  assert.match(document.body.textContent, /인터넷 연결을 확인한 뒤 잠시 후 다시 시도해 주세요/)
  assert.equal(session().currentProductId, current.product_id, 'failed read must not clear restored current product')
  assert.equal(session().variantSelection.variantId, 'variant_current_1')
  await click('다시 시도')
  await waitForUi(() => document.querySelector('.switch-results-stage'), 'retry restores results')
  assert.equal(session().currentProductId, current.product_id)

  await act(async () => root.unmount()); root = null
  catalogProducts = catalogProducts.filter((item) => item.product_id !== current.product_id)
  window.history.replaceState(null, '', `${BASE}?view=workspace&mode=switch`)
  app.writeSwitchSession(restored, sessionStorage)
  await renderApp({ preserveHistory: true })
  await waitForUi(() => document.body.textContent.includes('현재 먹이는 사료를 찾으세요'), 'deleted product reset after successful catalog')
  assert.equal(session().currentProductId, null)

  await act(async () => root.unmount()); root = null
  catalogProducts = [current, candidateA, candidateB, singleSku]
  const invalidVariant = { ...restored, variantSelection: { kind: 'variant', variantId: 'deleted_variant' }, step: 'results' }
  window.history.replaceState(null, '', `${BASE}?view=workspace&mode=switch`)
  app.writeSwitchSession(invalidVariant, sessionStorage)
  await renderApp({ preserveHistory: true })
  await waitForUi(() => document.body.textContent.includes('현재 먹이는 규격을 골라주세요'), 'invalid variant returns to SKU step')
  assert.equal(session().currentProductId, current.product_id)
  assert.equal(session().variantSelection.kind, 'unselected')
  assert.equal(session().change.feedType, '습식', 'only invalid SKU choice is cleared')
})
