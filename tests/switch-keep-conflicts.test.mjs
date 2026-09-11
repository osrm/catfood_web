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
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch
let app, root, temp, requestHandler

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
  const file = resolve(temp, 'switch-keep-conflicts.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-switch-conflict-tests-'))
  app = await bundle()
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  dom.reconfigure({ url: 'https://catfood.test/' })
  sessionStorage.clear()
  document.getElementById('root').replaceChildren()
  requestHandler = async (url) => {
    if (url.pathname.endsWith('/search-runs')) return Response.json({ search_run_id: 'run-test' })
    if (url.pathname.endsWith('/considerations')) return Response.json({ ok: true })
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    return Response.json([])
  }
  globalThis.fetch = window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.origin, 'https://api.test')
    return requestHandler(url, init)
  }
  root = createRoot(document.getElementById('root'))
})

afterEach(async () => {
  await act(async () => root.unmount())
})

const all = (selector) => [...document.querySelectorAll(selector)]
const button = (text) => all('button').find((node) => node.textContent.includes(text))
const exactButton = (text) => all('button').find((node) => node.textContent.trim() === text)

async function click(target) {
  const node = typeof target === 'string' ? button(target) : target
  assert.ok(node, `missing button: ${target}`)
  assert.equal(node.disabled, false)
  await act(async () => node.click())
}

async function waitForUi(predicate, message) {
  if (predicate()) return
  await new Promise((resolvePromise, rejectPromise) => {
    const observer = new window.MutationObserver(check)
    const timeout = window.setTimeout(() => finish(new Error(`UI condition not reached: ${message}`)), 1800)
    let settled = false
    function finish(error) {
      if (settled) return
      settled = true
      observer.disconnect()
      window.clearTimeout(timeout)
      error ? rejectPromise(error) : resolvePromise()
    }
    function check() {
      try {
        if (predicate()) finish()
      } catch (error) {
        finish(error)
      }
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    check()
  })
}

test('SWITCH clears only conflicting KEEP axes and never restores them after CHANGE is removed', async () => {
  const current = product('product_000000000101', '현재 건식 사료', {
    brand: '현재브랜드', feed_type: '건식', life_stage: 'adult',
    official_targets: ['indoor'], features: ['digestive'], recipe_families: ['poultry'],
    confirmed_present_ingredient_terms: ['chicken'], direct_evidence_ingredient_terms: ['chicken'],
  })
  const matching = product('product_000000000102', '전환 습식 생선', {
    brand: '새브랜드', feed_type: '습식', life_stage: 'senior',
    official_targets: ['indoor'], features: ['digestive'], recipe_families: ['fish'],
    reviewed_not_found_ingredient_terms: ['chicken'],
  })
  const sameBrand = product('product_000000000103', '같은 브랜드 습식', {
    brand: '현재브랜드', feed_type: '습식', life_stage: 'senior', recipe_families: ['fish'],
    reviewed_not_found_ingredient_terms: ['chicken'],
  })
  const ingredientConflict = product('product_000000000104', '닭 포함 습식', {
    brand: '다른브랜드', feed_type: '습식', life_stage: 'senior', recipe_families: ['fish'],
    confirmed_present_ingredient_terms: ['chicken'], direct_evidence_ingredient_terms: ['chicken'],
  })
  const dryCandidate = product('product_000000000105', '다른 건식 후보', {
    brand: '다른브랜드', feed_type: '건식', life_stage: 'senior', recipe_families: ['fish'],
    reviewed_not_found_ingredient_terms: ['chicken'],
  })
  const searchRuns = []
  requestHandler = async (url, init) => {
    if (url.pathname.endsWith('/switch_current_variant_options')) return Response.json([])
    if (url.pathname.endsWith('/search-runs')) {
      searchRuns.push(JSON.parse(init.body))
      return Response.json({ search_run_id: 'run-switch-conflict' })
    }
    if (url.pathname.endsWith('/considerations')) return Response.json({ ok: true })
    return Response.json([])
  }

  await act(async () => root.render(createElement(app.SwitchFlow, {
    products: [current, matching, sameBrand, ingredientConflict, dryCandidate],
    loading: false, error: null, initialQuery: '현재 건식',
    onHome() {}, onModeChange() {}, onRetryCatalog() {},
  })))

  await click(all('.switch-find-result').find((node) => node.textContent.includes('현재 건식 사료')))
  await click('이 제품을 현재 사료로 선택')
  await waitForUi(() => document.body.textContent.includes('선택할 수 있는 판매 규격을 확인하지 못했습니다'), 'empty variants')
  await click('사용 규격을 모르겠어요')
  await click('특별히 바꾸고 싶은 점 없음')
  await click(exactButton('다음 →'))

  await click(exactButton('현재브랜드 유지'))
  await click(exactButton('건식 유지'))
  await click(exactButton('성묘 유지'))
  await click(exactButton('가금류'))
  await click(exactButton('실내묘'))
  assert.equal(exactButton('실내묘').getAttribute('aria-pressed'), 'true')

  await click('← 바꿀 것 수정')
  await click(all('.switch-current-ingredients button')[0])
  assert.match(document.body.textContent, /닭 ×/)

  await click('다른 브랜드로 보기')
  assert.match(document.querySelector('[role="status"]').textContent, /브랜드 유지 조건을 해제했습니다/)
  await click(exactButton('습식'))
  assert.match(document.querySelector('[role="status"]').textContent, /사료 형태 유지 조건을 해제했습니다/)
  await click(exactButton('시니어'))
  assert.match(document.querySelector('[role="status"]').textContent, /생애주기 유지 조건을 해제했습니다/)
  await click(exactButton('생선'))
  assert.match(document.querySelector('[role="status"]').textContent, /레시피 계열 유지 조건을 해제했습니다/)

  await click(exactButton('다음 →'))
  assert.equal(exactButton('현재브랜드 유지'), undefined)
  assert.equal(exactButton('건식 유지'), undefined)
  assert.equal(exactButton('성묘 유지'), undefined)
  assert.equal(exactButton('가금류'), undefined)
  assert.equal(exactButton('실내묘').getAttribute('aria-pressed'), 'true', 'unrelated KEEP must survive')

  await click('후보 제품 보기')
  await waitForUi(() => document.querySelector('.switch-results-stage'), 'switch results')
  const session = document.querySelector('.switch-session-bar').textContent
  assert.match(session, /CHANGE.*다른 브랜드.*습식.*시니어.*생선.*피함 · 닭/s)
  assert.match(session, /KEEP.*실내묘/s)
  assert.doesNotMatch(session, /KEEP.*현재브랜드/s)
  assert.doesNotMatch(session, /KEEP.*건식/s)
  assert.doesNotMatch(session, /KEEP.*성묘/s)
  assert.doesNotMatch(session, /KEEP.*가금류/s)

  const candidates = document.querySelector('.switch-candidate-list').textContent
  assert.match(candidates, /전환 습식 생선/)
  assert.doesNotMatch(candidates, /같은 브랜드 습식/)
  assert.doesNotMatch(candidates, /닭 포함 습식/)
  assert.doesNotMatch(candidates, /다른 건식 후보/)

  await waitForUi(() => searchRuns.length === 1, 'criteria snapshot')
  const snapshot = searchRuns[0].criteria_snapshot
  assert.ok(snapshot.some((item) => item.axis === 'brand' && item.role === 'desired_change'))
  assert.ok(snapshot.some((item) => item.axis === 'feed_type' && item.value === '습식' && item.role === 'desired_change'))
  assert.ok(snapshot.some((item) => item.axis === 'life_stage' && item.value === 'senior' && item.role === 'desired_change'))
  assert.ok(snapshot.some((item) => item.axis === 'recipe_family' && item.value === 'fish' && item.role === 'desired_change'))
  assert.ok(snapshot.some((item) => item.axis === 'official_target' && item.value === 'indoor' && item.role === 'keep'))
  assert.ok(snapshot.some((item) => item.axis === 'ingredient' && item.value === 'chicken' && item.role === 'ingredient_avoid'))
  for (const axis of ['brand', 'feed_type', 'life_stage', 'recipe_family']) {
    assert.equal(snapshot.some((item) => item.axis === axis && item.role === 'keep'), false, `${axis} KEEP must be cleared`)
  }

  await click('조건 수정')
  await click('다른 브랜드로 보기')
  await click(exactButton('습식'))
  await click(exactButton('시니어'))
  await click(exactButton('생선'))
  await click(exactButton('다음 →'))

  assert.equal(exactButton('현재브랜드 유지').getAttribute('aria-pressed'), 'false')
  assert.equal(exactButton('건식 유지').getAttribute('aria-pressed'), 'false')
  assert.equal(exactButton('성묘 유지').getAttribute('aria-pressed'), 'false')
  assert.equal(exactButton('가금류').getAttribute('aria-pressed'), 'false')
  assert.equal(exactButton('실내묘').getAttribute('aria-pressed'), 'true', 'unrelated KEEP must remain selected')
})
