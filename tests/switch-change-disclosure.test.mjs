import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement, useState } from 'react'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch
let app, root, temp

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
      'import.meta.env.VITE_DECISION_INTAKE_ENABLED': '"false"',
      'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"',
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
    },
    build: { ssr: 'tests/entry.ts', write: false, minify: false },
  })
  const chunk = result.output.find((item) => item.type === 'chunk' && item.isEntry)
  const file = resolve(temp, 'switch-change-disclosure.mjs')
  await writeFile(file, chunk.code)
  return import(pathToFileURL(file).href)
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-switch-disclosure-tests-'))
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
  globalThis.fetch = window.fetch = async () => Response.json([])
  root = createRoot(document.getElementById('root'))
})

afterEach(async () => {
  await act(async () => root.unmount())
})

const all = (selector) => [...document.querySelectorAll(selector)]
const exactButton = (text, scope = document) => [...scope.querySelectorAll('button')].find((node) => node.textContent.trim() === text)

async function click(node) {
  assert.ok(node, 'expected button')
  await act(async () => {
    node.click()
    await Promise.resolve()
  })
}

function Harness({ initialSession, products }) {
  const [session, setSession] = useState(initialSession)
  return createElement(app.SwitchFlow, {
    products,
    loading: false,
    error: null,
    session,
    onSessionChange: (update) => setSession((current) => typeof update === 'function' ? update(current) : update),
    onHome: () => {},
    onModeChange: () => {},
    onRetryCatalog: () => {},
  })
}

test('mobile CHANGE disclosure preserves advanced selection across collapse and re-entry, then no-change clears it', async () => {
  const current = product('current', 'Current food')
  const initialSession = {
    ...app.createInitialSwitchSession(),
    currentProductId: current.product_id,
    variantSelection: { kind: 'unknown', variantId: null },
    step: 'change',
  }

  await act(async () => {
    root.render(createElement(Harness, { initialSession, products: [current] }))
  })

  const toggle = document.querySelector('.switch-change-additional-toggle')
  assert.ok(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(document.querySelector('.switch-change-additional-content').hidden, true)

  await click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')

  const content = document.querySelector('.switch-change-additional-content')
  const kitten = exactButton('키튼', content)
  assert.ok(kitten)
  await click(kitten)

  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'choosing an advanced condition must not auto-fold the disclosure')
  assert.equal(kitten.getAttribute('aria-pressed'), 'true')
  assert.equal(document.querySelector('.switch-change-additional-toggle small').textContent.trim(), '1개 선택')
  assert.equal(document.querySelector('.switch-change-additional-summary'), null, 'expanded disclosure hides duplicate selected-name summary')

  await click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(content.hidden, true)
  assert.equal(kitten.getAttribute('aria-pressed'), 'true', 'manual collapse must preserve the selected value')
  assert.match(document.querySelector('.switch-change-additional-summary').textContent, /키튼/)

  await click(document.querySelector('.switch-step-actions .switch-primary-action'))
  assert.match(document.querySelector('.switch-step-header h1').textContent, /그대로 유지/)
  assert.match(document.querySelector('.switch-keep-change-summary').textContent, /바꾸기로 정함.*키튼/s)
  assert.match(document.querySelector('.switch-current-facts-summary').textContent, /현재 제품에서 확인됨.*건식.*성묘/s)
  assert.doesNotMatch(document.querySelector('.switch-current-facts-summary').textContent, /키튼/, 'current facts stay separate from CHANGE intent')

  await click(exactButton('← 바꿀 것 수정'))
  assert.match(document.querySelector('.switch-step-header h1').textContent, /바꾸고 싶나요/)
  assert.equal(document.querySelector('.switch-change-additional-toggle').getAttribute('aria-expanded'), 'true', 're-entering CHANGE with advanced values must reopen the disclosure')

  const reentryContent = document.querySelector('.switch-change-additional-content')
  const reentryKitten = exactButton('키튼', reentryContent)
  assert.equal(reentryKitten.getAttribute('aria-pressed'), 'true')
  assert.equal(document.querySelector('.switch-change-additional-toggle small').textContent.trim(), '1개 선택')
  assert.equal(document.querySelector('.switch-change-additional-summary'), null, 're-entered expanded disclosure keeps duplicate summary hidden')

  await click(document.querySelector('.switch-no-change'))
  assert.equal(document.querySelector('.switch-no-change').classList.contains('is-selected'), true)
  assert.equal(reentryKitten.getAttribute('aria-pressed'), 'false')
  assert.equal(document.querySelector('.switch-change-additional-summary'), null)
  assert.equal(document.querySelector('.switch-change-additional-toggle small').textContent.trim(), '필요할 때만 선택하세요.')
  assert.equal(document.querySelector('.switch-change-additional-toggle').getAttribute('aria-expanded'), 'true', 'clearing values must not auto-fold the disclosure')
})

test('mobile CHANGE disclosure counts only advanced selections and retains desktop-only presentation contract', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => Promise.all([
    readFile(new URL('../src/SwitchFlow.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/switch-change-disclosure.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/switch-change-keep-editorial.css', import.meta.url), 'utf8'),
  ]))
  const [flow, css, editorial] = source
  const helper = flow.slice(flow.indexOf('function additionalChangeLabels'), flow.indexOf('function buildConditions'))
  for (const token of ['criteria.lifeStage', 'ingredientAvoidTerms', 'criteria.officialTargets', 'criteria.features', 'criteria.recipeFamilies', 'criteria.grainFree']) {
    assert.match(helper, new RegExp(token.replace('.', '\\.')))
  }
  assert.doesNotMatch(helper, /changeBrand|criteria\.feedType/)
  assert.match(css, /@media \(max-width: 760px\)/)
  assert.match(css, /\.switch-change-desktop-criteria \{\s*display: none;/)
  assert.match(flow, /!changeAdditionalOpen && changeAdditionalLabels\.length > 0/)
  assert.match(flow, /switch-decision-step-layout/)
  assert.match(flow, /switch-keep-change-summary/)
  assert.match(flow, /switch-current-facts-summary/)
  assert.match(editorial, /\.switch-decision-step-layout \.switch-choice \{[\s\S]*?min-height:\s*44px/)
  assert.match(editorial, /\.switch-decision-step-layout \.switch-primary-action,[\s\S]*?min-height:\s*48px/)
  assert.doesNotMatch(css + editorial, /position:\s*(?:fixed|sticky)/)
})
