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
let failVariantCount = 0
let searchRuns = []
let considerations = []
let decisions = []
let holdDecision = null
let failDecisionCount = 0

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
  reviewed_not_found_ingredient_terms: ['chicken'], manufacturing_country_codes: ['KR'], manufacturing_has_variant_scope: true,
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
  failVariantCount = 0
  searchRuns = []
  considerations = []
  decisions = []
  holdDecision = null
  failDecisionCount = 0
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
      if (productFilter?.startsWith('eq.')) {
        if (failVariantCount > 0) {
          failVariantCount -= 1
          return new Response('temporary variant failure', { status: 503 })
        }
        return Response.json(variantsByProduct.get(productFilter.slice(3)) ?? [])
      }
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
      return Response.json({ status: 'recorded' })
    }
    if (url.pathname.endsWith('/decisions')) {
      decisions.push(JSON.parse(init.body))
      if (failDecisionCount > 0) { failDecisionCount -= 1; return new Response('', { status: 503 }) }
      if (holdDecision) return holdDecision()
      return Response.json({ status: 'recorded' })
    }
    if (url.pathname.includes('/compare_product_') || url.pathname.includes('/product_')) return Response.json([])
    return Response.json([])
  }
}

const all = (selector) => [...document.querySelectorAll(selector)]
const exactButton = (text) => all('button').find((node) => node.textContent.trim() === text)
const variantButton = (text) => all('.switch-sku-option').find((node) => node.textContent.includes(text))
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
  await waitForUi(() => document.body.textContent.includes(`제품 ${catalogProducts.length}개`) || document.body.textContent.includes('연결 오류'), 'catalog settles')
}

async function remountApp() {
  await act(async () => root.unmount())
  root = null
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(app.App)))
  await waitForUi(() => document.body.textContent.includes(`제품 ${catalogProducts.length}개`) || document.body.textContent.includes('연결 오류'), 'remounted catalog settles')
}

async function chooseCurrent(productName = current.canonical_name) {
  const input = document.querySelector('.switch-find-search input')
  await inputValue(input, productName)
  await waitForUi(() => all('.switch-find-result').some((node) => node.textContent.includes(productName)), 'current product search result')
  await click(all('.switch-find-result').find((node) => node.textContent.includes(productName)))
  await waitForUi(() => document.querySelector('.switch-sku-list') !== null, 'SKU step')
}

async function reachResultsWithConditions({ variantMode = 'variant', avoidIngredient = true } = {}) {
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
  if (ingredient && avoidIngredient) await click(ingredient)
  await waitForUi(() => document.querySelector('.switch-inline-keep'), 'KEEP step')
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
    await new Promise((resolvePromise) => {
      window.addEventListener('popstate', resolvePromise, { once: true })
      window.history.back()
    })
  })
  await waitForUi(predicate, message)
}

async function browserForward(predicate, message) {
  await act(async () => {
    await new Promise((resolvePromise) => {
      window.addEventListener('popstate', resolvePromise, { once: true })
      window.history.forward()
    })
  })
  await waitForUi(predicate, message)
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
  assert.match(document.querySelector('.switch-context-product').textContent, /사용 규격 · 1 kg/)
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
  assert.match(document.querySelector('.switch-context-product').textContent, /사용 규격 · 사용 규격 모름/)
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
  assert.match(summary, /바꿀 점.*습식.*피함 · 닭/s)
  assert.match(summary, /유지할 점.*실내묘/s)
  assert.match(document.querySelector('.switch-compare-dock').textContent, /전환 습식 A/)
  const runsBeforeRemount = searchRuns.length
  await remountApp()
  assert.ok(document.querySelector('.switch-results-stage'))
  assert.match(document.querySelector('.switch-session-bar').textContent, /바꿀 점.*습식.*피함 · 닭/s)
  assert.equal(searchRuns.length, runsBeforeRemount, 'restoration must not replay an old analytics search run')
})

test('browser back/forward restores SWITCH candidate detail and compare detail entries', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await selectCandidate(candidateA.canonical_name)
  assert.match(document.querySelector('.switch-candidate-inspector').textContent, /한국 \(KR\) · 확인된 포장 기준/)
  assert.doesNotMatch(document.querySelector('.switch-candidate-inspector').textContent, /일부 포장 기준/)
  await click('상세 보기')
  await waitForUi(() => document.querySelector('.detail-stage'), 'candidate detail')
  await browserBack(() => document.querySelector('.switch-candidate-inspector') && !document.querySelector('.detail-stage'), 'back to candidate parent')
  assert.match(document.querySelector('.switch-candidate-inspector').textContent, /전환 습식 A/)
  await browserForward(() => document.querySelector('.detail-stage'), 'forward to candidate detail')
  await browserBack(() => document.querySelector('.switch-candidate-inspector'), 'back to candidate again')

  await click('비교에 추가')
  await selectCandidate(candidateB.canonical_name)
  await click('비교에 추가')
  await click('현재 사료와 비교')
  await waitForUi(() => document.querySelector('.compare-stage'), 'compare page')
  const compareDetail = all('.compare-detail-link').find((node) => node.closest('.compare-product-head')?.textContent.includes(candidateA.canonical_name))
  await click(compareDetail)
  await waitForUi(() => document.querySelector('.detail-stage'), 'detail inside compare')
  assert.equal(document.querySelector('.detail-return-action').textContent, '← 비교로 돌아가기')
  assert.equal(all('.site-header').length, 1)
  assert.ok(exactButton('처음부터 시작'))
  assert.ok(exactButton('제품 찾기'))
  await browserBack(() => document.querySelector('.compare-stage') && !document.querySelector('.detail-stage'), 'back from compare detail')
  assert.match(document.querySelector('.compare-stage').textContent, /전환 습식 A/)
  assert.match(document.querySelector('.compare-stage').textContent, /전환 습식 B/)
  await click(all('.compare-detail-link')[0])
  await click('비교로 돌아가기')
  await waitForUi(() => document.querySelector('.compare-stage') && !document.querySelector('.detail-stage'), 'explicit return to SWITCH compare')
  assert.deepEqual(session().compareIds, [candidateA.product_id, candidateB.product_id])
})

test('SWITCH candidate search scans the full evaluated pool and preserves comparison state, paging, and keyboard return focus', async () => {
  const bulk = Array.from({ length: 50 }, (_, index) => product(
    `product_search_${String(index).padStart(2, '0')}`,
    `검색 후보 ${String(index).padStart(2, '0')}`,
    {
      brand: '검색브랜드',
      feed_type: '습식',
      life_stage: 'adult',
      official_targets: ['indoor'],
      features: ['digestive'],
      recipe_families: ['fish'],
      recipe_details: ['salmon'],
      reviewed_not_found_ingredient_terms: ['chicken'],
    },
  ))
  const excluded = product('product_search_excluded', '조건 밖 검색 대상', {
    brand: '검색브랜드',
    feed_type: '건식',
    life_stage: 'adult',
    official_targets: ['indoor'],
    reviewed_not_found_ingredient_terms: ['chicken'],
  })
  catalogProducts = [current, candidateA, candidateB, singleSku, ...bulk, excluded]

  await renderApp()
  await reachResultsWithConditions()
  await act(async () => { await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)) })

  const searchInput = document.querySelector('input[aria-label="후보 제품 검색"]')
  assert.ok(searchInput)
  assert.equal(all('.switch-candidate-row').some((node) => node.textContent.includes('검색 후보 49')), false, 'late candidate must not be in the first page before searching')

  const runsBeforeSearch = searchRuns.length
  await inputValue(searchInput, '검색 후보 49')
  await waitForUi(() => all('.switch-candidate-row').some((node) => node.textContent.includes('검색 후보 49')), 'late candidate found across full evaluated pool')
  assert.equal(all('.switch-candidate-row').length, 1)
  assert.match(document.querySelector('.switch-candidate-heading').textContent, /검색 결과 1개/)
  assert.equal(searchRuns.length, runsBeforeSearch, 'candidate typing must not create a new decision search run')

  await inputValue(searchInput, '검색브랜드')
  await waitForUi(() => all('.switch-candidate-row').length === 40, 'candidate search first page')
  assert.match(document.querySelector('.load-more').textContent, /제품 더 보기 · 10개 남음/)
  assert.equal(session().visibleCandidateCount, 40, 'changing the search resets the visible page size')
  await click(document.querySelector('.load-more'))
  assert.equal(all('.switch-candidate-row').length, 50)
  assert.equal(document.querySelector('.load-more'), null)

  await inputValue(searchInput, '조건 밖 검색 대상')
  await waitForUi(() => document.querySelector('.switch-candidate-list .switch-state-message'), 'out-of-condition search stays excluded')
  const excludedState = document.querySelector('.switch-candidate-list .switch-state-message')
  assert.match(excludedState.textContent, /이름 검색 결과가 없습니다/)
  assert.doesNotMatch(document.body.textContent, /조건 밖 검색 대상/)
  assert.equal(searchRuns.length, runsBeforeSearch)

  await inputValue(searchInput, '검색 후보 49')
  const targetRow = await (async () => {
    await waitForUi(() => all('.switch-candidate-row').some((node) => node.textContent.includes('검색 후보 49')), 'target search result')
    return all('.switch-candidate-row').find((node) => node.textContent.includes('검색 후보 49'))
  })()
  await click(targetRow)
  await waitForUi(() => document.querySelector('.switch-candidate-inspector'), 'target inspector')
  await click('비교에 추가')
  assert.deepEqual(session().compareIds, ['product_search_49'])
  await click(document.querySelector('.switch-preview-topline button'))
  assert.equal(document.activeElement, targetRow, 'closing quick view restores focus to the searched result row')
  assert.equal(searchInput.value, '검색 후보 49')

  await inputValue(searchInput, '일치하지 않는 검색어')
  await waitForUi(() => /이름 검색 결과가 없습니다/.test(document.querySelector('.switch-candidate-list .switch-state-message')?.textContent ?? ''), 'zero-name-result state')
  assert.match(document.querySelector('.switch-compare-dock').textContent, /검색 후보 49/)
  assert.deepEqual(session().compareIds, ['product_search_49'])

  const clearControls = [...document.querySelectorAll('.switch-candidate-pane button')].filter((node) => node.textContent.trim() === '검색 지우기')
  assert.equal(clearControls.length, 1, 'one explicit clear action works in populated and zero-result search')
  assert.equal(searchInput.getAttribute('role'), 'searchbox')
  assert.equal(searchInput.type, 'text', 'avoid a second browser-native search cancel action')
  const clear = clearControls[0]
  await click(clear)
  assert.equal(searchInput.value, '')
  assert.equal(document.activeElement, searchInput, 'clear action returns focus to candidate search input')
  assert.match(document.querySelector('.switch-compare-dock').textContent, /검색 후보 49/)
  assert.equal(session().visibleCandidateCount, 40)

  await inputValue(searchInput, '검색 후보 49')
  await click(document.querySelector('.switch-compare-dock button'))
  await waitForUi(() => document.querySelector('.compare-stage'), 'compare opens from searched results')
  await click('후보 목록으로')
  await waitForUi(() => document.querySelector('.switch-results-stage') && !document.querySelector('.compare-stage'), 'return from compare')
  assert.equal(searchInput.value, '검색 후보 49', 'candidate search survives compare roundtrip')
  assert.equal(document.activeElement, document.querySelector('.switch-compare-dock button'), 'returning from compare restores keyboard focus to its trigger')
  assert.deepEqual(session().compareIds, ['product_search_49'])
  assert.equal(searchRuns.length, runsBeforeSearch)
})

test('closing a filtered-out SWITCH candidate inspector falls back to candidate search focus without clearing state', async () => {
  await renderApp()
  await reachResultsWithConditions()

  const searchInput = document.querySelector('input[aria-label="후보 제품 검색"]')
  assert.ok(searchInput)
  await inputValue(searchInput, candidateA.canonical_name)
  await waitForUi(() => all('.switch-candidate-row').some((node) => node.textContent.includes(candidateA.canonical_name)), 'candidate A search result')

  const candidateARow = all('.switch-candidate-row').find((node) => node.textContent.includes(candidateA.canonical_name))
  await click(candidateARow)
  await waitForUi(() => document.querySelector('.switch-candidate-inspector'), 'candidate A inspector')
  await click('비교에 추가')
  assert.deepEqual(session().compareIds, [candidateA.product_id])

  await inputValue(searchInput, '일치하지 않는 검색어')
  await waitForUi(() => /이름 검색 결과가 없습니다/.test(document.querySelector('.switch-candidate-list .switch-state-message')?.textContent ?? ''), 'candidate A filtered out')
  assert.equal(document.body.contains(candidateARow), false, 'candidate A button should no longer be rendered')
  assert.equal(searchInput.value, '일치하지 않는 검색어')
  assert.deepEqual(session().compareIds, [candidateA.product_id])

  const close = document.querySelector('.switch-preview-topline button')
  close.focus()
  assert.equal(document.activeElement, close)
  await click(close)
  assert.equal(document.querySelector('.switch-candidate-inspector'), null)
  assert.equal(document.activeElement, searchInput, 'filtered-out candidate close should fall back to candidate search input')
  assert.equal(searchInput.value, '일치하지 않는 검색어', 'focus fallback must not clear the active query')
  assert.deepEqual(session().compareIds, [candidateA.product_id], 'focus fallback must not clear compared candidates')
  assert.equal(session().currentProductId, current.product_id)
  assert.equal(session().variantSelection.variantId, 'variant_current_1')
  assert.equal(session().change.feedType, '습식')
  assert.deepEqual(session().keep.officialTargets, ['indoor'])
})

test('SWITCH list compare toggles directly, stays in sync with quick view/search, and excludes current food from the five-candidate cap', async () => {
  const directCandidates = Array.from({ length: 6 }, (_, index) => product(
    `product_direct_${index}`,
    `직접 비교 후보 ${index + 1}`,
    {
      brand: `직접브랜드${index + 1}`,
      feed_type: '습식',
      life_stage: 'adult',
      official_targets: ['indoor'],
      features: ['digestive'],
      recipe_families: ['fish'],
      recipe_details: ['salmon'],
      reviewed_not_found_ingredient_terms: ['chicken'],
    },
  ))
  catalogProducts = [current, ...directCandidates]

  await renderApp()
  await reachResultsWithConditions()
  const searchInput = document.querySelector('input[aria-label="후보 제품 검색"]')
  assert.ok(searchInput)

  let controls = all('.switch-candidate-compare')
  assert.equal(controls.length, 6)
  const first = controls[0]
  first.focus()
  await click(first)
  await waitForUi(() => considerations.length === 1, 'direct compare consideration recorded')

  assert.equal(document.activeElement, first, 'direct SWITCH compare keeps focus on its own control')
  assert.equal(document.querySelector('.switch-candidate-inspector'), null, 'direct compare does not open quick view')
  assert.equal(session().selectedCandidateId, null)
  assert.deepEqual(session().compareIds, [directCandidates[0].product_id])
  assert.equal(considerations[0].signal_type, 'compare_add')
  assert.equal(considerations[0].product_id, directCandidates[0].product_id)
  assert.equal(considerations.some((entry) => entry.signal_type === 'detail_open'), false)
  assert.equal(searchRuns.length, 1, 'direct compare does not create a new SWITCH search run')
  assert.equal(first.getAttribute('aria-pressed'), 'true')
  assert.ok(first.closest('.switch-candidate-item').classList.contains('is-compared'))

  const firstRow = all('.switch-candidate-row').find((node) => node.textContent.includes(directCandidates[0].canonical_name))
  await click(firstRow)
  await waitForUi(() => document.querySelector('.switch-candidate-inspector'), 'quick view opens separately')
  assert.match(document.querySelector('.switch-inspector-actions').textContent, /비교에서 제거/)
  await click(document.querySelector('.switch-preview-topline button'))

  await inputValue(searchInput, '일치하지 않는 검색어')
  await waitForUi(() => /이름 검색 결과가 없습니다/.test(document.querySelector('.switch-candidate-list .switch-state-message')?.textContent ?? ''), 'zero-result search')
  assert.deepEqual(session().compareIds, [directCandidates[0].product_id])
  assert.match(document.querySelector('.switch-compare-dock').textContent, /직접 비교 후보 1/)

  await click('검색 지우기')
  controls = all('.switch-candidate-compare')
  assert.equal(controls[0].getAttribute('aria-pressed'), 'true', 'compared state returns with the product after clearing search')

  for (let index = 1; index < 5; index += 1) await click(controls[index])
  assert.equal(session().compareIds.length, 5)
  assert.equal(session().compareIds.includes(current.product_id), false, 'current food is not counted as a candidate comparison')
  assert.match(document.querySelector('.switch-compare-dock').textContent, /담은 후보 5\/5/)
  assert.equal(controls[5].disabled, true, 'sixth unselected candidate is disabled at the cap')
  assert.equal(controls[0].disabled, false, 'already compared candidate remains removable at the cap')

  controls[0].focus()
  await click(controls[0])
  assert.equal(document.activeElement, controls[0])
  assert.equal(session().compareIds.length, 4)
  assert.equal(controls[0].getAttribute('aria-pressed'), 'false')
  assert.equal(controls[5].disabled, false)

  await click(controls[5])
  assert.equal(session().compareIds.length, 5)
  const selection = document.querySelector('.switch-compare-selection')
  selection.open = true
  assert.equal(selection.querySelectorAll('li').length, 5)
  assert.match(selection.textContent, /직접브랜드6.*직접 비교 후보 6/s)
  selection.querySelector('summary').focus()
  selection.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(selection.open, false)
  assert.equal(document.activeElement, selection.querySelector('summary'))
  await click(document.querySelector('.switch-compare-dock button'))
  await waitForUi(() => document.querySelector('.compare-stage'), 'SWITCH compare opens with direct-list selections')
  assert.match(document.querySelector('.compare-stage').textContent, /현재 건식 사료/)
  assert.match(document.querySelector('.compare-stage').textContent, /직접 비교 후보 6/)
  assert.equal(document.activeElement, document.querySelector('.compare-header h1'), 'keyboard compare entry lands on the new screen title')
  const remove = document.querySelector('.compare-mobile-product-head.is-candidate .compare-mobile-head-actions button:last-child')
  remove.focus()
  await click(remove)
  assert.equal(session().compareIds.length, 4)
  assert.equal(document.activeElement, document.querySelector('.compare-mobile-candidate-toggle'), 'SWITCH removal returns to its own candidate picker')
  while (session().compareIds.length > 1) {
    const nextRemove = document.querySelector('.compare-mobile-product-head.is-candidate .compare-mobile-head-actions button:last-child')
    nextRemove.focus()
    await click(nextRemove)
  }
  assert.equal(document.querySelector('.compare-mobile-candidate-toggle'), null)
  assert.equal(document.activeElement, document.querySelector('.compare-tabs [aria-selected="true"]'), 'one remaining candidate falls back to the active tab')
  assert.equal(session().currentProductId, current.product_id)

  assert.doesNotMatch(document.querySelector('.compare-stage').textContent, /직접 비교 후보 1/)
  const lastRemove = document.querySelector('.compare-mobile-product-head.is-candidate .compare-mobile-head-actions button:last-child')
  lastRemove.focus()
  await click(lastRemove)
  await waitForUi(() => document.querySelector('.switch-candidate-search input'), 'last candidate returns to results')
  assert.equal(session().compareIds.length, 0)
  assert.equal(document.querySelector('.switch-compare-dock'), null)
  assert.equal(document.activeElement, document.querySelector('.switch-candidate-search input'), 'empty basket returns focus to candidate search')
  assert.equal(session().currentProductId, current.product_id)

})

test('SWITCH empty candidates use an edit action and KEEP unset wording without relaxing conditions', async () => {
  catalogProducts = [current]
  await renderApp()
  await chooseCurrent()
  await waitForUi(() => variantButton('1 kg') !== undefined, 'variant option for empty candidate fixture')
  await click(variantButton('1 kg'))
  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'CHANGE step for empty candidate fixture')
  await click('특별히 바꾸고 싶은 점 없음')
  await waitForUi(() => document.querySelector('.switch-inline-keep'), 'KEEP step for empty candidate fixture')
  await click('후보 제품 보기')
  await waitForUi(() => document.querySelector('.switch-results-stage'), 'empty results step')

  assert.match(document.querySelector('.switch-session-bar').textContent, /유지할 점.*따로 고르지 않음/s)
  const empty = document.querySelector('.switch-candidate-list .switch-state-message')
  assert.ok(empty)
  assert.match(empty.textContent, /조건에 맞는 후보가 없습니다\.바꿀 점이나 유지할 점을 수정해 보세요\./)
  assert.doesNotMatch(empty.textContent, /임의로 완화|제약 없음/)
  const edit = [...empty.querySelectorAll('button')].find((node) => node.textContent.includes('조건 수정'))
  await click(edit)
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'empty result edit returns to CHANGE')
})

test('comparison removal survives browser back to results and explicit current-food reselection clears dependents', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await selectCandidate(candidateA.canonical_name)
  await click('비교에 추가')
  await selectCandidate(candidateB.canonical_name)
  await click('비교에 추가')
  await click('현재 사료와 비교')
  await waitForUi(() => document.querySelector('.compare-stage'), 'compare before removal')
  const removeA = document.querySelector(`button[aria-label="${candidateA.canonical_name} 비교에서 제거"]`)
  await click(removeA)
  assert.deepEqual(session().compareIds, [candidateB.product_id])
  await browserBack(() => document.querySelector('.switch-results-stage') && !document.querySelector('.compare-stage'), 'browser back to SWITCH results')
  const dock = document.querySelector('.switch-compare-dock')?.textContent ?? ''
  assert.doesNotMatch(dock, /전환 습식 A/)
  assert.match(dock, /전환 습식 B/)

  await click('조건 수정')
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'return to editable SWITCH conditions')
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
  assert.match(document.body.textContent, /잠시 후 다시 시도해 주세요/)
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
  await waitForUi(() => document.querySelector('.switch-sku-list') !== null, 'invalid variant returns to SKU step')
  assert.equal(session().currentProductId, current.product_id)
  assert.equal(session().variantSelection.kind, 'unselected')
  assert.equal(session().change.feedType, '습식', 'only invalid SKU choice is cleared')
})


test('explicit SWITCH previous-step buttons honor their displayed destinations after restored results', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await remountApp()
  assert.ok(document.querySelector('.switch-results-stage'))
  const before = session()

  await click('조건 수정')
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'restored results to CHANGE')
  await click('← 현재 사료와 포장')
  await waitForUi(() => document.querySelector('.switch-sku-list') !== null, 'explicit previous button reaches SKU')
  assert.equal(session().step, 'sku')
  assert.equal(session().variantSelection.variantId, before.variantSelection.variantId)
  assert.equal(session().change.feedType, before.change.feedType)
  assert.deepEqual(session().keep.officialTargets, before.keep.officialTargets)
  assert.deepEqual(session().ingredientAvoidTerms, before.ingredientAvoidTerms)
  assert.equal(document.querySelector('.switch-results-stage'), null)

  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'SKU to CHANGE again')
  await waitForUi(() => document.querySelector('.switch-inline-keep'), 'KEEP is available with CHANGE')
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'explicit previous button reaches CHANGE')
  assert.equal(session().step, 'change')
  assert.equal(session().variantSelection.variantId, before.variantSelection.variantId)
})

test('restored actual SKU reports variant API failure and retries without becoming explicit unknown', async () => {
  const restored = app.createInitialSwitchSession('현재')
  restored.currentProductId = current.product_id
  restored.variantSelection = { kind: 'variant', variantId: 'variant_current_1' }
  restored.change = { ...restored.change, feedType: '습식' }
  restored.keep = { ...restored.keep, officialTargets: ['indoor'] }
  restored.ingredientAvoidTerms = ['chicken']
  restored.compareIds = [candidateA.product_id]
  restored.step = 'results'
  app.writeSwitchSession(restored, sessionStorage)
  window.history.replaceState(null, '', `${BASE}?view=workspace&mode=switch`)
  failVariantCount = 1

  await renderApp({ preserveHistory: true })
  await waitForUi(() => document.querySelector('.switch-variant-status[role="alert"]'), 'restored variant error')
  const failedSummary = document.querySelector('.switch-session-bar')?.textContent ?? ''
  assert.match(failedSummary, /선택한 규격 확인 실패/)
  assert.doesNotMatch(failedSummary, /사용 규격 모름/)
  assert.equal(session().variantSelection.kind, 'variant')
  assert.equal(session().variantSelection.variantId, 'variant_current_1')
  assert.equal(session().change.feedType, '습식')
  assert.deepEqual(session().keep.officialTargets, ['indoor'])
  assert.deepEqual(session().ingredientAvoidTerms, ['chicken'])
  assert.deepEqual(session().compareIds, [candidateA.product_id])
  assert.match(document.querySelector('.switch-compare-dock')?.textContent ?? '', /전환 습식 A/)

  await click(document.querySelector('.switch-variant-status .state-retry'))
  await waitForUi(() => (document.querySelector('.switch-session-bar')?.textContent ?? '').includes('1 kg'), 'restored variant retry success')
  assert.equal(document.querySelector('.switch-variant-status[role="alert"]'), null)
  assert.equal(session().variantSelection.kind, 'variant')
  assert.equal(session().variantSelection.variantId, 'variant_current_1')
  assert.deepEqual(session().compareIds, [candidateA.product_id])
})


test('candidate list explains common matches once without losing inspector facts or closing focus', async () => {
  await renderApp()
  await reachResultsWithConditions({ avoidIngredient: false })
  const rows = all('.switch-candidate-row')
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.querySelector('.is-keep'), null)
    assert.equal(row.querySelector('.is-change'), null)
    assert.equal(row.querySelector('.switch-candidate-ingredients'), null)
  }
  assert.match(document.querySelector('.switch-prototype-criteria').textContent, /습식/)
  assert.match(document.querySelector('.switch-prototype-criteria').textContent, /실내묘/)
  await selectCandidate(candidateA.canonical_name)
  const inspector = document.querySelector('.switch-candidate-inspector')
  assert.match(inspector.textContent, /유지할 점.*실내묘/s)
  assert.match(inspector.textContent, /바꿀 점.*습식/s)
  assert.doesNotMatch(inspector.textContent, /규격 수|동일 배합 확인 시장|확인된 유통 시장/)
  assert.equal(all('.switch-inspector-decision dt').some(node => node.textContent === '미확인'), false)
  assert.match(inspector.textContent, /제조국.*확인된 포장 기준/s)
  await click(inspector.querySelector('.switch-preview-topline button'))
  assert.equal(document.activeElement, rows[0])
})

test('candidate-specific matches and requested unknowns stay visible while empty unrequested facts disappear', async () => {
  catalogProducts = [current, candidateA, { ...candidateB, official_targets: [], features: [] }, singleSku]
  await renderApp()
  await reachResultsWithConditions({ avoidIngredient: false })
  const known = all('.switch-candidate-row').find(node => node.textContent.includes(candidateA.canonical_name))
  const unknown = all('.switch-candidate-row').find(node => node.textContent.includes(candidateB.canonical_name))
  assert.match(known.querySelector('.is-keep').textContent, /실내묘/)
  assert.match(unknown.querySelector('.is-unknown').textContent, /실내묘/)
  assert.equal(unknown.querySelector('.is-change'), null, 'shared wet-food match is still shown in the common criteria')
  await selectCandidate(candidateB.canonical_name)
  const inspector = document.querySelector('.switch-candidate-inspector')
  assert.match(inspector.querySelector('.switch-inspector-decision').textContent, /미확인.*실내묘/s)
  const info = [...inspector.querySelectorAll('.switch-inspector-section')].find(node => node.textContent.includes('제품 정보 요약'))
  assert.doesNotMatch(info.textContent, /대상 표기|제품 특징|확인된 값 없음/)
  assert.match(info.textContent, /레시피 표기/)
})

test('browsing without chosen criteria does not invent an empty condition comparison', async () => {
  await renderApp()
  await chooseCurrent()
  await waitForUi(() => variantButton('1 kg') !== undefined, 'variant option')
  await click(variantButton('1 kg'))
  await click(exactButton('다음 →'))
  await click('특별히 바꾸고 싶은 점 없음')
  await click('후보 제품 보기')
  await selectCandidate(candidateA.canonical_name)
  assert.equal(document.querySelector('.switch-inspector-decision'), null)
  assert.match(document.querySelector('.switch-candidate-inspector').textContent, /제품 정보 요약/)
  assert.deepEqual(session().ingredientAvoidTerms, [])
})

test('candidate inspector keeps full relationships and closing restores selected-row focus', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await selectCandidate(candidateA.canonical_name)

  const selectedRow = all('.switch-candidate-row').find((node) => node.textContent.includes(candidateA.canonical_name))
  assert.ok(selectedRow.classList.contains('is-selected'))
  const inspector = document.querySelector('.switch-candidate-inspector')
  assert.ok(inspector)
  assert.match(inspector.textContent, /선택한 조건과 비교/)
  assert.match(inspector.textContent, /비교 기준.*현재브랜드.*현재 건식 사료.*1 kg/s)
  assert.match(inspector.textContent, /제품 정보 요약/)
  assert.match(selectedRow.closest('.switch-candidate-group').textContent, /선택한 원료를 찾지 못한 후보/)
  assert.equal(selectedRow.querySelector('.is-ingredient-reviewed'), null, 'shared reviewed result is explained once at group level')
  assert.match(inspector.textContent, /검토한 자료에서 닭 원료를 찾지 못했어요/)

  await click(inspector.querySelector('.switch-preview-topline button'))
  assert.equal(document.querySelector('.switch-candidate-inspector'), null)
  assert.equal(document.activeElement, selectedRow)
  assert.ok(selectedRow.classList.contains('is-selected') === false)
  assert.equal(session().selectedCandidateId, null)
})

test('selected ingredient evidence precedes detail tabs and survives comparison-detail navigation', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await selectCandidate()
  await click('상세 보기')
  const context = document.querySelector('.detail-selection-context')
  assert.ok(context)
  assert.match(context.textContent, /현재브랜드.*현재 건식 사료.*1 kg/s)
  assert.match(context.textContent, /피하고 싶은 원료.*닭/s)
  assert.match(context.textContent, /검토한 자료에서 닭 원료를 찾지 못했어요/)
  assert.match(context.textContent, /없다고 확정한 결과는 아니에요/)
  assert.ok(context.compareDocumentPosition(document.querySelector('.detail-tabs')) & window.Node.DOCUMENT_POSITION_FOLLOWING)
  const ingredientAction = context.querySelector('.primary-action')
  assert.match(ingredientAction.textContent, /원재료 확인/)
  assert.equal([...context.querySelectorAll('button')].find(node => node.textContent.includes('영양도 비교하기')).classList.contains('primary-action'), false)
  await click(ingredientAction)
  assert.equal(document.querySelector('#detail-tab-ingredients').getAttribute('aria-selected'), 'true')
  assert.equal(document.activeElement.id, 'detail-tab-ingredients')
  assert.match(document.querySelector('.detail-selection-context').textContent, /검토한 자료에서 닭 원료를 찾지 못했어요/)
  await click(exactButton('개요'))
  await click(exactButton('비교에 추가'))
  await click('돌아가기')
  await waitForUi(() => document.querySelector('.switch-candidate-inspector'), 'candidate after detail return')
  await click('현재 사료와 비교')
  await click(all('.compare-detail-link')[0])
  assert.match(document.querySelector('.detail-selection-context').textContent, /피하고 싶은 원료.*닭.*검토한 자료에서 닭 원료를 찾지 못했어요/s)
})

test('unknown ingredient and chicken in the name stay distinct from reviewed-not-found evidence', async () => {
  const uncertain = { ...candidateB, canonical_name: '닭고기 표기 예시', reviewed_not_found_ingredient_terms: [], insufficient_evidence_ingredient_terms: ['chicken'] }
  catalogProducts = [current, candidateA, uncertain, singleSku]
  await renderApp()
  await reachResultsWithConditions()
  const rows = all('.switch-candidate-row')
  assert.equal(rows.some(row => row.textContent.includes(singleSku.canonical_name)), false)
  const unknown = rows.find(row => row.textContent.includes(uncertain.canonical_name))
  assert.ok(unknown)
  assert.match(unknown.textContent, /닭 원료가 있는지 아직 확인하지 못했어요/)
  assert.match(unknown.textContent, /제품 이름에는 닭고기 표기가 있어요/)
  assert.equal(unknown.querySelector('[data-evidence-state="reviewed-not-found"]'), null)
  await selectCandidate(uncertain.canonical_name)
  await click('원재료부터 확인')
  const context = document.querySelector('.detail-selection-context')
  assert.match(context.textContent, /닭 원료가 있는지 아직 확인하지 못했어요/)
  assert.doesNotMatch(context.textContent, /찾지 못했어요|알레르기 안전|잘 맞아요/)
  assert.deepEqual(session().ingredientAvoidTerms, ['chicken'])
  assert.equal(document.querySelector('#detail-tab-ingredients').getAttribute('aria-selected'), 'true')
  assert.ok(context.compareDocumentPosition(document.querySelector('.detail-context-actions')) & window.Node.DOCUMENT_POSITION_FOLLOWING)
})


test('fixture: candidate relationship renders 3+ long ingredient evidence items without display truncation', async () => {
  const terms = [
    '닭고기와 닭고기 부산물을 포함한 매우 긴 원료 근거',
    '칠면조 단백질과 장문 원료 근거',
    '오리 단백질과 추가 확인 근거',
    '가수분해 동물성 단백질과 긴 확인 문구',
  ]
  catalogProducts = catalogProducts.map((item) => {
    if (item.product_id === current.product_id) return { ...item, confirmed_present_ingredient_terms: terms, direct_evidence_ingredient_terms: terms }
    if (item.product_id === candidateA.product_id) return { ...item, reviewed_not_found_ingredient_terms: terms }
    return item
  })
  variantsByProduct.set(current.product_id, [
    { ...variant(current.product_id, 'variant_current_1', '1 kg', 1), confirmed_present_ingredient_terms: terms, direct_evidence_ingredient_terms: terms },
    variant(current.product_id, 'variant_current_2', '2 kg', 2),
  ])

  await renderApp()
  await chooseCurrent()
  await waitForUi(() => variantButton('1 kg') !== undefined, 'fixture actual SKU')
  await click(variantButton('1 kg'))
  await click(exactButton('다음 →'))
  await waitForUi(() => document.body.textContent.includes('무엇을 바꾸고 싶나요?'), 'fixture CHANGE')
  await click(exactButton('습식'))
  const ingredientButtons = all('.switch-current-ingredients button')
  assert.ok(ingredientButtons.length >= 4)
  for (const ingredientButton of ingredientButtons) await click(ingredientButton)
  await waitForUi(() => document.querySelector('.switch-inline-keep'), 'fixture KEEP')
  await click('후보 제품 보기')
  await waitForUi(() => document.querySelector('.switch-results-stage'), 'fixture results')

  const row = all('.switch-candidate-row').find((node) => node.textContent.includes(candidateA.canonical_name))
  assert.ok(row)
  await selectCandidate(candidateA.canonical_name)
  const relationLines = [...document.querySelector('.switch-candidate-inspector').querySelectorAll('.switch-relation-line')]
  const rendered = relationLines.map((line) => line.textContent).join(' ')
  for (const term of terms) assert.match(rendered, new RegExp(term))
  const ingredientLine = relationLines.find((line) => line.textContent.includes('원료 확인'))
  assert.ok(ingredientLine)
  for (const term of terms) assert.ok(ingredientLine.querySelector('strong').textContent.includes(term))
})

test('ingredient groups retain exact batch order in search runs and load-more considerations', async () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({ ...candidateA, product_id: `product_group_${index}`, brand: `브랜드${String(index).padStart(2, '0')}`, canonical_name: `그룹 제품 ${index}`, reviewed_not_found_ingredient_terms: index % 2 ? [] : ['chicken'], insufficient_evidence_ingredient_terms: index % 2 ? ['chicken'] : [] }))
  catalogProducts = [current, ...rows]
  await renderApp(); await reachResultsWithConditions()
  await waitForUi(() => searchRuns.length === 1, 'grouped run recorded')
  const renderedIds = all('.switch-candidate-item').map(item => item.querySelector('[data-switch-compare-product-id]').dataset.switchCompareProductId)
  assert.equal(renderedIds.length, 40)
  assert.deepEqual(searchRuns[0].initial_presented_product_ids, renderedIds)
  assert.equal(all('.switch-candidate-group.is-reviewed .switch-candidate-row').length, 23)
  assert.equal(all('.switch-candidate-group.is-unresolved .switch-candidate-row').length, 17)
  await click('제품 더 보기')
  assert.equal(all('.switch-candidate-row').length, 45)
  const last = all('.switch-candidate-compare').at(-1)
  await click(last)
  await waitForUi(() => considerations.length === 1, 'load-more grouped consideration')
  const record = considerations[0]
  assert.equal(record.context_kind, 'load_more')
  assert.deepEqual(record.presented_product_ids, all('.switch-candidate-compare').slice(40).map(node => node.dataset.switchCompareProductId))
  assert.equal(record.presented_product_ids[record.position], last.dataset.switchCompareProductId)
})

test('detail without ingredient avoidance retains a direct current-food comparison action', async () => {
  await renderApp(); await reachResultsWithConditions({ avoidIngredient: false })
  await selectCandidate(candidateA.canonical_name); await click('상세 보기')
  const action = document.querySelector('.detail-selection-context .primary-action')
  assert.match(action.textContent, /현재 사료와 영양 비교/)
  assert.deepEqual(session().ingredientAvoidTerms, [])
  await click(action)
  assert.equal(session().compareTab, 'nutrition')
  assert.deepEqual(session().compareIds, [candidateA.product_id])
})

test('detail nutrition shortcut preserves comparison order and displays the explicitly requested candidate', async () => {
  await renderApp(); await reachResultsWithConditions()
  await click(all('.switch-candidate-compare')[0])
  await selectCandidate(candidateB.canonical_name); await click('상세 보기')
  await click('영양도 비교하기')
  await waitForUi(() => document.querySelector('.compare-stage'), 'nutrition comparison shortcut')
  assert.deepEqual(session().compareIds, [candidateA.product_id, candidateB.product_id])
  assert.equal(session().compareTab, 'nutrition')
  assert.equal(session().currentProductId, current.product_id)
  assert.equal(session().variantSelection.variantId, 'variant_current_1')
  assert.match(document.querySelector('.compare-mobile-candidate-picker>button').textContent, new RegExp(candidateB.canonical_name))
  await click('후보 목록으로')
  await waitForUi(() => document.querySelector('.switch-candidate-inspector'), 'return to candidate from shortcut')
  assert.deepEqual(session().ingredientAvoidTerms, ['chicken'])
})

test('detail nutrition shortcut respects the existing five-candidate limit', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ ...candidateA, product_id: `product_limit_${index}`, brand: `브랜드${index}`, canonical_name: `한도 제품 ${index}` }))
  catalogProducts = [current, ...rows]
  await renderApp(); await reachResultsWithConditions()
  for (const control of all('.switch-candidate-compare').slice(0, 5)) await click(control)
  const original = [...session().compareIds]
  await selectCandidate(rows[5].canonical_name); await click('상세 보기')
  const shortcut = button('영양도 비교하기')
  assert.equal(shortcut.disabled, true)
  assert.equal(document.querySelector('.detail-selection-context .primary-action').disabled, false, 'ingredient inspection is available even when comparison is full')
  assert.deepEqual(session().compareIds, original)
  assert.equal(session().compareOpen, false)
})

test('SWITCH candidate detail comparison changes survive browser and explicit return without changing current SKU or criteria', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await selectCandidate(candidateA.canonical_name)
  const before = session()
  await click('상세 보기')
  await waitForUi(() => document.querySelector('.detail-context-actions'), 'detail comparison action')
  await click('비교에 추가')
  await browserBack(() => document.querySelector('.switch-candidate-inspector') && !document.querySelector('.detail-stage'), 'candidate detail add return')
  assert.deepEqual(session().compareIds, [candidateA.product_id])
  assert.equal(session().currentProductId, before.currentProductId)
  assert.deepEqual(session().variantSelection, before.variantSelection)
  assert.deepEqual(session().change, before.change)
  assert.deepEqual(session().keep, before.keep)
  await click('상세 보기')
  await click('비교에서 제거')
  await click('돌아가기')
  await waitForUi(() => document.querySelector('.switch-candidate-inspector') && !document.querySelector('.detail-stage'), 'candidate detail remove return')
  assert.deepEqual(session().compareIds, [])
  assert.equal(session().currentProductId, before.currentProductId)
  assert.deepEqual(session().variantSelection, before.variantSelection)
})

test('candidate name search survives Home resume and refresh with the same SWITCH basket', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await click(all('.switch-candidate-compare')[0])
  const before = session()
  await inputValue(document.querySelector('.switch-candidate-search input'), '전환 습식 A')
  await click(exactButton('CATFOOD'))
  await waitForUi(() => document.querySelector('.home-shell'), 'Home with resumable task')
  assert.match(document.querySelector('.home-switch-actions').textContent, /이어서 찾기.*새로 찾기/s)
  assert.match(document.querySelector('.home-entry-route:last-child').textContent, /현재 건식 사료/)
  await click('이어서 찾기')
  await waitForUi(() => document.querySelector('.switch-results-stage'), 'resume candidates')
  assert.equal(document.querySelector('.switch-candidate-search input').value, '전환 습식 A')
  assert.deepEqual(session().compareIds, before.compareIds)
  await remountApp()
  await waitForUi(() => document.querySelector('.switch-results-stage'), 'refresh candidates')
  assert.equal(document.querySelector('.switch-candidate-search input').value, '전환 습식 A')
  assert.deepEqual(session().compareIds, before.compareIds)
})

test('unchanged SWITCH reapply keeps candidates and query; changed criteria clear them at application', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await click(all('.switch-candidate-compare')[0])
  await inputValue(document.querySelector('.switch-candidate-search input'), '전환')
  const before = session()
  await click('조건 수정')
  await click('후보 제품 보기')
  assert.deepEqual(session().compareIds, before.compareIds)
  assert.equal(session().candidateQuery, '전환')
  await click('조건 수정')
  await click(exactButton('습식'))
  await click('특별히 바꾸고 싶은 점 없음')
  await click('후보 제품 보기')
  assert.deepEqual(session().compareIds, [])
  assert.equal(session().candidateQuery, '')
})

test('explicit restart clears queries, choices, overlays and history restoration while ordinary reload still resumes', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await click(all('.switch-candidate-compare')[0])
  await inputValue(document.querySelector('.switch-candidate-search input'), '전환')
  const oldSnapshot = window.history.state
  await remountApp()
  assert.equal(session().currentProductId, current.product_id)
  await click('처음부터 시작')
  const restarted = session()
  assert.ok(restarted.restartId)
  assert.deepEqual(restarted, app.createInitialSwitchSession('', restarted.restartId))
  assert.equal(document.activeElement, document.querySelector('.switch-find-search input'))
  await remountApp()
  assert.deepEqual(session(), restarted)
  // A stale entry at first mount is also ignored in favor of the restarted session.
  window.history.replaceState(oldSnapshot, '', window.location.href)
  await remountApp()
  assert.deepEqual(session(), restarted)
  assert.equal(window.history.state.catfoodSwitchEntry, undefined)
  // A stale browser entry must not resurrect the task after an explicit restart.
  await act(async () => {
    window.history.replaceState(oldSnapshot, '', window.location.href)
    window.dispatchEvent(new window.PopStateEvent('popstate', { state: oldSnapshot }))
  })
  assert.deepEqual(session(), restarted)
  await remountApp()
  assert.deepEqual(session(), restarted)
  await browserBack(() => document.querySelector('.switch-find-search input'), 'back after restart')
  assert.deepEqual(session(), restarted)
})

test('Home new SWITCH task preserves the separate general comparison across mode changes and refresh', async () => {
  const generalUrl = BASE + '?view=workspace&mode=lookup&q=전환&criteria=1&feed=습식&age=adult&compare=product_candidate_a,product_candidate_b'
  window.history.replaceState(null, '', generalUrl)
  await renderApp({ preserveHistory: true })
  await waitForUi(() => document.querySelector('.switch-compare-dock'), 'initial general comparison')
  assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 2\/5/)
  await click(exactButton('현재 사료'))
  assert.equal(new URL(window.location.href).searchParams.has('compare'), false)
  await reachResultsWithConditions()
  await click(all('.switch-candidate-compare')[0])
  await remountApp()
  await click(exactButton('CATFOOD'))
  await click('새로 찾기')
  assert.equal(session().currentProductId, null)
  assert.equal(session().query, '')
  await remountApp()
  await click(exactButton('제품 찾기'))
  const restoredUrl = new URL(window.location.href).searchParams
  assert.equal(restoredUrl.get('q'), '전환')
  assert.equal(restoredUrl.get('feed'), '습식')
  assert.equal(restoredUrl.get('age'), 'adult')
  assert.equal(restoredUrl.get('criteria'), '1')
  assert.equal(restoredUrl.get('compare'), 'product_candidate_a,product_candidate_b')
  assert.match(document.querySelector('.switch-compare-dock').textContent, /비교 2\/5/)
})

test('legacy stored results acquire an applied selection without changing product or variant; key is order independent', () => {
  const legacy = app.createInitialSwitchSession('현재')
  legacy.currentProductId = current.product_id
  legacy.variantSelection = { kind: 'variant', variantId: 'variant_current_1' }
  legacy.step = 'results'
  legacy.change.officialTargets = ['indoor', 'sterilized']
  delete legacy.restartId
  delete legacy.candidateQuery
  delete legacy.appliedCriteriaKey
  const parsed = app.parseSwitchSessionSnapshot({ version: 1, state: legacy })
  assert.equal(parsed.restartId, '')
  assert.equal(parsed.candidateQuery, '')
  assert.equal(parsed.appliedCriteriaKey, app.switchSelectionKey(parsed))
  assert.equal(parsed.variantSelection.variantId, 'variant_current_1')
  assert.equal(app.switchSelectionKey(parsed), app.switchSelectionKey({
    ...parsed, change: { ...parsed.change, officialTargets: ['sterilized', 'indoor'] },
  }))
})

test('restart invalidates an in-flight SKU response and never auto-selects the old variant', async () => {
  const mockFetch = globalThis.fetch
  let releaseVariant
  let pendingSignal
  globalThis.fetch = window.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/switch_current_variant_options') && url.searchParams.get('product_id')?.startsWith('eq.')) {
      pendingSignal = init.signal
      return new Promise((resolvePromise) => { releaseVariant = () => resolvePromise(Response.json([variant(current.product_id, 'late_variant')])) })
    }
    return mockFetch(input, init)
  }
  await renderApp()
  await chooseCurrent()
  await waitForUi(() => releaseVariant !== undefined, 'SKU request in flight')
  await click('처음부터 시작')
  assert.equal(pendingSignal.aborted, true)
  await act(async () => { releaseVariant(); await Promise.resolve() })
  assert.equal(session().currentProductId, null)
  assert.equal(session().variantSelection.kind, 'unselected')
  assert.equal(document.querySelectorAll('.switch-sku-option').length, 0)
})


test('SWITCH detail header preserves navigation and restart from both candidate and comparison details', async () => {
  await renderApp()
  await reachResultsWithConditions()
  await selectCandidate(candidateA.canonical_name)
  await click('비교에 추가')
  const before = session()
  await click('상세 보기')
  await waitForUi(() => document.querySelector('.detail-stage'), 'candidate detail navigation')
  assert.equal(all('.site-header').length, 1)
  assert.ok(exactButton('← 돌아가기 · 제품 목록'))
  assert.ok(exactButton('CATFOOD'))
  assert.ok(exactButton('처음부터 시작'))
  assert.equal(exactButton('현재 사료').getAttribute('aria-current'), 'page')
  await click(exactButton('현재 사료'))
  assert.ok(document.querySelector('.detail-stage'), 'active mode must not close the detail')
  await click(exactButton('제품 찾기'))
  await waitForUi(() => document.querySelector('.lookup-input'), 'LOOKUP from candidate detail')
  await click(exactButton('현재 사료'))
  await waitForUi(() => document.querySelector('.detail-stage'), 'detail restored on mode return')
  assert.deepEqual(session().compareIds, before.compareIds)
  assert.deepEqual(session().variantSelection, before.variantSelection)
  await click('돌아가기')
  await waitForUi(() => document.querySelector('.switch-candidate-inspector'), 'candidate return')
  await click('현재 사료와 비교')
  await waitForUi(() => document.querySelector('.compare-stage'), 'comparison')
  await click(all('.compare-detail-link')[0])
  await waitForUi(() => document.querySelector('.detail-stage'), 'comparison detail navigation')
  assert.equal(all('.site-header').length, 1)
  await click(exactButton('CATFOOD'))
  await waitForUi(() => document.querySelector('.home-shell'), 'Home from comparison detail')
  await click('이어서 찾기')
  await waitForUi(() => document.querySelector('.detail-stage'), 'resumed comparison detail')
  assert.equal(all('.site-header').length, 1)
  await click('비교로 돌아가기')
  await waitForUi(() => document.querySelector('.compare-stage'), 'comparison return')
  assert.deepEqual(session().compareIds, before.compareIds)
  assert.deepEqual(session().variantSelection, before.variantSelection)
  await click(all('.compare-detail-link')[0])
  await click('처음부터 시작')
  const restarted = session()
  assert.deepEqual(restarted, app.createInitialSwitchSession('', restarted.restartId))
  assert.equal(document.activeElement, document.querySelector('.switch-find-search input'))
  await browserBack(() => document.querySelector('.switch-find-search input'), 'back after detail restart')
  assert.deepEqual(session(), restarted)
})

function journey() { return app.readJourneyRecords() }
async function textareaValue(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function retainAFromDetail() {
  await selectCandidate()
  await click('상세 보기')
  await waitForUi(() => button('후보로 남기기'), 'retention available in full detail')
  await click('후보로 남기기')
}
test('optional memo preserves applied criteria and never enters navigation or exact intake payloads; cancel keeps saved text', async () => {
  await renderApp(); await reachResultsWithConditions()
  const key = app.switchSelectionKey(session())
  await click(exactButton('내 메모'))
  await textareaValue(document.querySelector('dialog textarea'), 'PRIVATE_MEMO 잘 안 먹어서 알아보는 중')
  await click('메모 남기기')
  assert.equal(journey().memo, 'PRIVATE_MEMO 잘 안 먹어서 알아보는 중')
  assert.equal(app.switchSelectionKey(session()), key)
  assert.doesNotMatch(window.location.href + JSON.stringify(window.history.state) + JSON.stringify(searchRuns) + JSON.stringify(considerations), /PRIVATE_MEMO/)
  await click(exactButton('내 메모'))
  await textareaValue(document.querySelector('dialog textarea'), '저장하지 않은 변경')
  await act(async () => document.querySelector('dialog').dispatchEvent(new window.Event('cancel', { cancelable: true })))
  assert.equal(journey().memo, 'PRIVATE_MEMO 잘 안 먹어서 알아보는 중')
  await remountApp()
  assert.equal(journey().memo, 'PRIVATE_MEMO 잘 안 먹어서 알아보는 중')
  assert.equal(app.switchSelectionKey(session()), key)
})
test('explicit retained candidate is independent of basket, current reselection and changed conditions; restart alone clears it', async () => {
  await renderApp(); await reachResultsWithConditions(); await retainAFromDetail()
  const original = structuredClone(journey().retained[0].context)
  assert.equal(journey().retained.filter((row) => row.active).length, 1)
  await click('비교에 추가')
  await click('비교에서 제거')
  assert.equal(journey().retained[0].active, true)
  await click('돌아가기')
  await waitForUi(() => document.querySelector('.switch-results-stage') && !document.querySelector('.detail-stage'), 'return from retained detail')
  await click('조건 수정')
  await click('현재 사료 다시 선택')
  assert.equal(session().currentProductId, null)
  assert.deepEqual(journey().retained[0].context, original)
  await click('처음부터 시작')
  assert.ok(document.querySelector('dialog[aria-label="새로 찾아볼까요?"]'))
  await click(exactButton('새로 찾기'))
  assert.equal(journey().retained.length, 0)
  await remountApp()
  assert.equal(journey().retained.length, 0, 'old navigation cannot resurrect separate cleared records')
})
test('rapid retain then remove serializes server revisions on the original run even before first acknowledgement', async () => {
  let release
  let intercepted = false
  holdDecision = () => { if (intercepted) return Response.json({ status: 'recorded' }); intercepted = true; return new Promise((resolve) => { release = resolve }) }
  await renderApp(); await reachResultsWithConditions(); await retainAFromDetail()
  await waitForUi(() => decisions.length === 1, 'first retain reaches intake')
  await click('남긴 후보에서 제거')
  assert.equal(journey().retained[0].active, false)
  assert.equal(decisions.length, 1, 'removal waits for retain ack')
  await act(async () => { release(Response.json({ status: 'recorded' })); await new Promise((resolve) => setTimeout(resolve, 30)) })
  assert.equal(decisions.length, 2)
  assert.deepEqual(decisions.map((row) => [row.kind, row.revision, row.expected_previous_revision]), [['candidate_retained',1,0],['retained_candidate_removed',2,1]])
  assert.equal(decisions[0].search_run_id, decisions[1].search_run_id)
  assert.equal(decisions[0].record_id, decisions[1].record_id)
  await click('후보로 남기기')
  await waitForUi(() => decisions.length === 3, 're-retain after removal')
  assert.equal(decisions[2].revision, 3)
  assert.equal(decisions[2].record_id, decisions[0].record_id)
})
test('keep-current and undecided are explicit and serialize on one result record', async () => {
  await renderApp(); await reachResultsWithConditions()
  assert.equal(journey().outcome, null)
  await click('지금 사료 유지')
  await click('아직 못 고름')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  assert.equal(journey().outcome.kind, 'undecided')
  assert.deepEqual(decisions.map((row) => [row.kind,row.revision]), [['keep_current',1],['undecided',2]])
  assert.equal(decisions[0].record_id, decisions[1].record_id)
  assert.equal(decisions[0].product_id, null)
  assert.deepEqual(session().compareIds, [])
})
test('five retained records expose a removal path instead of silently dropping one', async () => {
  await renderApp(); await reachResultsWithConditions()
  const context = { selectionKey: 'old', current: { productId: current.product_id, brand: current.brand, name: current.canonical_name }, variantId: null, variantLabel: '사용 규격 모름', criteria: [], labels: [] }
  app.writeJourneyRecords({ memo: '', outcome: null, retained: Array.from({ length: 5 }, (_, i) => ({ id: `saved-${i}`, revision: 1, active: true, candidate: { productId: `saved-product-${i}`, brand: '기존 후보', name: `후보 ${i}` }, context, note: '', createdAt: '2026-10-23', searchRunId: null })) })
  await remountApp(); await selectCandidate(); await click('상세 보기'); await click('후보로 남기기')
  assert.equal(journey().retained.filter((row) => row.active).length, 5)
  assert.match(document.body.textContent, /남긴 후보는 최대 5개/)
  assert.ok(button('남긴 후보 정리'))
  assert.equal(document.activeElement.id, 'journey-records')
})

test('outcome reload preserves acknowledged server revision before switching to undecided', async () => {
  await renderApp(); await reachResultsWithConditions(); await click('지금 사료 유지')
  await waitForUi(() => journey().outcome?.intakeRevision === 1, 'keep acknowledged')
  await remountApp(); await click('아직 못 고름')
  await waitForUi(() => journey().outcome?.intakeRevision === 2, 'undecided acknowledged after reload')
  assert.equal(decisions.at(-1).revision, 2)
  assert.equal(decisions.at(-1).expected_previous_revision, 1)
  assert.equal(decisions.at(-1).search_run_id, decisions[0].search_run_id)
  assert.equal(decisions.at(-1).record_id, decisions[0].record_id)
})
test('lost retain acknowledgement replays the exact pending operation before sending removal', async () => {
  failDecisionCount = 2
  await renderApp(); await reachResultsWithConditions(); await retainAFromDetail()
  await waitForUi(() => journey().retained[0]?.pendingIntake?.pending, 'unacknowledged retain persisted')
  assert.equal(decisions.length, 2)
  const first = decisions[0]
  await click('남긴 후보에서 제거')
  await waitForUi(() => decisions.length === 4 && journey().retained[0]?.intakeRevision === 2, 'pending retain recovered before removal')
  assert.deepEqual(decisions[2], first)
  assert.equal(decisions[3].kind, 'retained_candidate_removed')
  assert.equal(decisions[3].revision, 2)
  assert.equal(journey().retained[0].active, false)
})

test('changed applied criteria mark retained snapshots as previous context without rewriting them', async () => {
  await renderApp(); await reachResultsWithConditions(); await retainAFromDetail()
  const original = structuredClone(journey().retained[0].context)
  await click('돌아가기')
  await waitForUi(() => document.querySelector('.switch-results-stage') && !document.querySelector('.detail-stage'), 'return to results before criteria edit')
  await click('조건 수정'); await click('다른 브랜드로 보기'); await click('후보 제품 보기')
  assert.notEqual(session().appliedCriteriaKey, original.selectionKey)
  assert.deepEqual(journey().retained[0].context, original)
  assert.match(document.querySelector('.journey-old-context').textContent, /이전 기준/)
})

test('a delayed decision acknowledgement cannot resurrect records after explicit new journey', async () => {
  let release
  holdDecision = () => new Promise((resolve) => { release = resolve })
  await renderApp(); await reachResultsWithConditions(); await retainAFromDetail()
  await waitForUi(() => decisions.length === 1, 'retained decision pending')
  await click('처음부터 시작'); await click(exactButton('새로 찾기'))
  await waitForUi(() => document.querySelector('.switch-find-search'), 'fresh journey mounted')
  await act(async () => { release(Response.json({ status: 'recorded' })); await new Promise((resolve) => setTimeout(resolve, 30)) })
  assert.equal(journey().retained.length, 0)
  assert.equal(journey().outcome, null)
  assert.equal(session().currentProductId, null)
})
