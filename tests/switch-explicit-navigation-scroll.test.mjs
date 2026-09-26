import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement, useState } from 'react'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/catfood_web/?view=workspace&mode=switch' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement })
Object.defineProperty(window.history, 'scrollRestoration', { configurable: true, writable: true, value: 'auto' })
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch

let helper, app, temp, root, nextAnimationFrameId
const animationFrames = new Map()
Object.defineProperty(window, 'requestAnimationFrame', {
  configurable: true,
  writable: true,
  value: (callback) => {
    const id = nextAnimationFrameId++
    animationFrames.set(id, { callback, canceled: false })
    return id
  },
})
Object.defineProperty(window, 'cancelAnimationFrame', {
  configurable: true,
  writable: true,
  value: (id) => {
    const frame = animationFrames.get(id)
    if (frame) frame.canceled = true
  },
})

function activeFrameIds() {
  return [...animationFrames.entries()].filter(([, frame]) => !frame.canceled).map(([id]) => id)
}
function frameState(id) { return animationFrames.get(id) ?? null }
function runFrame(id, { force = false } = {}) {
  const frame = animationFrames.get(id)
  if (!frame) return false
  animationFrames.delete(id)
  if (frame.canceled && !force) return false
  frame.callback(16)
  return true
}
function runNextActiveFrame() {
  const [id] = activeFrameIds()
  assert.ok(id, 'expected a scheduled animation frame')
  assert.equal(runFrame(id), true)
  return id
}
function drainActiveFrames() {
  while (activeFrameIds().length) runNextActiveFrame()
}
function stepScreen(step) {
  const inner = step === 'sku'
    ? '<section class="switch-sku-list"></section>'
    : step === 'change'
      ? '<button class="switch-no-change"></button>'
      : step === 'keep'
        ? '<section class="switch-current-facts-strip"></section>'
        : ''
  document.getElementById('root').innerHTML = `<main class="switch-step-main">${inner}</main>`
}
function product(id, name) {
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
  }
}

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-switch-scroll-'))

  const helperResult = await build({
    configFile: false,
    logLevel: 'silent',
    build: { ssr: 'src/switch-explicit-navigation-scroll.ts', write: false, minify: false },
  })
  const helperChunk = helperResult.output.find((item) => item.type === 'chunk' && item.isEntry)
  const helperFile = resolve(temp, 'switch-explicit-navigation-scroll.mjs')
  await writeFile(helperFile, helperChunk.code)
  helper = await import(pathToFileURL(helperFile).href)

  const appResult = await build({
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
  const appChunk = appResult.output.find((item) => item.type === 'chunk' && item.isEntry)
  const appFile = resolve(temp, 'switch-explicit-navigation-scroll-app.mjs')
  await writeFile(appFile, appChunk.code)
  app = await import(pathToFileURL(appFile).href)
})

after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  document.documentElement.scrollTop = 0
  window.history.scrollRestoration = 'auto'
  nextAnimationFrameId = 1
  animationFrames.clear()
  globalThis.fetch = window.fetch = async () => Response.json([])
})

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = null
  }
  drainActiveFrames()
  animationFrames.clear()
  globalThis.fetch = nativeFetch
})

test('explicit navigation remains owned by SwitchFlow and never installs global navigation observers', async () => {
  const [flow, main, scrollHelper] = await Promise.all([
    readFile('src/SwitchFlow.tsx', 'utf8'),
    readFile('src/main.tsx', 'utf8'),
    readFile('src/switch-explicit-navigation-scroll.ts', 'utf8'),
  ])

  assert.match(flow, /useLayoutEffect/)
  assert.match(flow, /requestExplicitScroll\('keep'\)/)
  assert.match(flow, /requestExplicitScroll\('results'\)/)
  assert.match(flow, /requestExplicitScroll\('compare'\)/)
  assert.match(flow, /requestExplicitScroll\(nextStep, Boolean\(onHistoryBack\)\)/)
  assert.match(flow, /settle: SwitchExplicitScrollSettleHandle \| null/)
  assert.match(flow, /cancelSwitchExplicitScrollSettle\(pending\.settle\)/)
  assert.match(flow, /useEffect\(\(\) => \(\) => releasePendingExplicitScroll\(\), \[\]\)/)

  assert.doesNotMatch(main, /installSwitchExplicitNavigationScroll/)
  assert.match(main, /document\.addEventListener\('scroll', syncCompareScroll, true\)/)
  assert.doesNotMatch(scrollHelper, /MutationObserver/)
  assert.doesNotMatch(scrollHelper, /addEventListener\(['"]click/)
  assert.doesNotMatch(scrollHelper, /textContent|switch-step-header h1/)
  assert.doesNotMatch(scrollHelper, /scrollRestoration\s*=/)
})

test('step identifiers reset the actual mobile document owner', () => {
  stepScreen('change')
  document.documentElement.scrollTop = 643
  const changeIntent = helper.beginSwitchExplicitScrollIntent('change', false)
  const changeSettle = helper.resetSwitchExplicitNavigationScroll(changeIntent)
  assert.equal(document.documentElement.scrollTop, 0)
  changeSettle?.cancel()

  stepScreen('keep')
  document.documentElement.scrollTop = 511
  const keepIntent = helper.beginSwitchExplicitScrollIntent('keep', false)
  const keepSettle = helper.resetSwitchExplicitNavigationScroll(keepIntent)
  assert.equal(document.documentElement.scrollTop, 0)
  keepSettle?.cancel()

  document.getElementById('root').innerHTML = '<main class="switch-results-stage"><div class="switch-candidate-list"></div></main>'
  document.documentElement.scrollTop = 422
  const resultsIntent = helper.beginSwitchExplicitScrollIntent('results', false)
  const resultsSettle = helper.resetSwitchExplicitNavigationScroll(resultsIntent)
  assert.equal(document.documentElement.scrollTop, 0)
  resultsSettle?.cancel()
})

test('desktop keeps the existing internal step scroller and does not move the document', () => {
  stepScreen('change')
  const main = document.querySelector('.switch-step-main')
  main.style.overflowY = 'auto'
  Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 1400 })
  Object.defineProperty(main, 'clientHeight', { configurable: true, value: 600 })
  main.scrollTop = 720
  document.documentElement.scrollTop = 91

  const intent = helper.beginSwitchExplicitScrollIntent('change', false)
  const settle = helper.resetSwitchExplicitNavigationScroll(intent)
  assert.equal(main.scrollTop, 0)
  assert.equal(document.documentElement.scrollTop, 91)
  settle?.cancel()
})

test('a history traversal leaves native auto restoration untouched while the next frame stabilizes the same destination', () => {
  stepScreen('change')
  const intent = helper.beginSwitchExplicitScrollIntent('change', true)
  assert.equal(window.history.scrollRestoration, 'auto')

  document.documentElement.scrollTop = 700
  const settle = helper.resetSwitchExplicitNavigationScroll(intent)
  assert.ok(settle)
  assert.equal(document.documentElement.scrollTop, 0)
  assert.equal(window.history.scrollRestoration, 'auto')
  assert.equal(activeFrameIds().length, 1)

  document.documentElement.scrollTop = 555
  runNextActiveFrame()
  assert.equal(document.documentElement.scrollTop, 0, 'settle frame wins over a late traversal/layout position')
  assert.equal(window.history.scrollRestoration, 'auto')
})

test('a second intent before the first settle frame cancels the stale frame and owns the next structural target', () => {
  stepScreen('change')
  const first = helper.beginSwitchExplicitScrollIntent('change', true)
  const firstSettle = helper.resetSwitchExplicitNavigationScroll(first)
  assert.ok(firstSettle)
  const [staleFrame] = activeFrameIds()
  assert.ok(staleFrame)

  stepScreen('sku')
  document.documentElement.scrollTop = 444
  const second = helper.beginSwitchExplicitScrollIntent('sku', true)
  assert.equal(frameState(staleFrame)?.canceled, true)
  assert.equal(window.history.scrollRestoration, 'auto')

  assert.equal(runFrame(staleFrame, { force: true }), true, 'force stale callback to prove cancellation and generation guards')
  assert.equal(document.documentElement.scrollTop, 444, 'stale CHANGE frame cannot reset SKU')

  const secondSettle = helper.resetSwitchExplicitNavigationScroll(second)
  assert.ok(secondSettle)
  document.documentElement.scrollTop = 333
  runNextActiveFrame()
  assert.equal(document.documentElement.scrollTop, 0)
})

test('canceling a scheduled settle prevents a forced stale callback from changing a replacement screen', () => {
  stepScreen('keep')
  const intent = helper.beginSwitchExplicitScrollIntent('keep', true)
  const settle = helper.resetSwitchExplicitNavigationScroll(intent)
  assert.ok(settle)
  const [staleFrame] = activeFrameIds()
  assert.ok(staleFrame)

  helper.cancelSwitchExplicitScrollSettle(settle)
  assert.equal(frameState(staleFrame)?.canceled, true)
  stepScreen('keep')
  document.documentElement.scrollTop = 287
  assert.equal(runFrame(staleFrame, { force: true }), true)
  assert.equal(document.documentElement.scrollTop, 287)
})

test('a same-selector replacement is not mistaken for the original destination anchor', () => {
  stepScreen('keep')
  const intent = helper.beginSwitchExplicitScrollIntent('keep', false)
  const originalAnchor = document.querySelector('.switch-current-facts-strip')
  const settle = helper.resetSwitchExplicitNavigationScroll(intent)
  assert.ok(settle)
  const [staleFrame] = activeFrameIds()

  stepScreen('keep')
  const replacementAnchor = document.querySelector('.switch-current-facts-strip')
  assert.notEqual(replacementAnchor, originalAnchor)
  document.documentElement.scrollTop = 391
  assert.equal(runFrame(staleFrame, { force: true }), true)
  assert.equal(document.documentElement.scrollTop, 391, 'settle must not query a same-selector replacement and reset it')
})

test('an original manual scrollRestoration value is never changed by explicit intents', () => {
  window.history.scrollRestoration = 'manual'
  stepScreen('change')
  const intent = helper.beginSwitchExplicitScrollIntent('change', true)
  const settle = helper.resetSwitchExplicitNavigationScroll(intent)
  assert.ok(settle)
  assert.equal(window.history.scrollRestoration, 'manual')
  runNextActiveFrame()
  assert.equal(window.history.scrollRestoration, 'manual')

  const canceled = helper.beginSwitchExplicitScrollIntent('keep', true)
  helper.releaseSwitchExplicitScrollIntent(canceled)
  assert.equal(window.history.scrollRestoration, 'manual')
})

test('SwitchFlow unmount cancels its scheduled settle handle before a stale callback can touch a new screen', async () => {
  const current = product('scroll_current', '현재 사료')
  const initial = {
    ...app.createInitialSwitchSession(),
    currentProductId: current.product_id,
    variantSelection: { kind: 'unknown', variantId: null },
    noChangeIntent: true,
    step: 'change',
  }

  function Harness() {
    const [session, setSession] = useState(initial)
    return createElement(app.SwitchFlow, {
      products: [current],
      loading: false,
      error: null,
      session,
      onSessionChange: (update) => setSession((value) => typeof update === 'function' ? update(value) : update),
      onHome: () => {},
      onModeChange: () => {},
      onRetryCatalog: () => {},
    })
  }

  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(createElement(Harness)))
  const next = [...document.querySelectorAll('.switch-step-actions .switch-primary-action')]
    .find((node) => node.textContent.trim() === '다음 →')
  assert.ok(next)
  await act(async () => next.click())
  assert.ok(document.querySelector('.switch-current-facts-summary'), 'KEEP destination rendered')
  const [staleFrame] = activeFrameIds()
  assert.ok(staleFrame, 'SwitchFlow keeps one settle frame pending after the synchronous reset')

  await act(async () => root.unmount())
  root = null
  assert.equal(frameState(staleFrame)?.canceled, true, 'component cleanup cancels the owned settle frame')

  document.body.innerHTML = '<div id="root"><main class="switch-step-main"><section class="switch-current-facts-summary"></section></main></div>'
  document.documentElement.scrollTop = 463
  assert.equal(runFrame(staleFrame, { force: true }), true, 'force the canceled callback to prove it is harmless')
  assert.equal(document.documentElement.scrollTop, 463)
})

test('release is idempotent before a destination renders and cannot revive an old intent', () => {
  const intent = helper.beginSwitchExplicitScrollIntent('change', true)
  helper.releaseSwitchExplicitScrollIntent(intent)
  helper.releaseSwitchExplicitScrollIntent(intent)
  assert.equal(activeFrameIds().length, 0)

  stepScreen('change')
  document.documentElement.scrollTop = 431
  assert.equal(helper.resetSwitchExplicitNavigationScroll(intent), null)
  assert.equal(document.documentElement.scrollTop, 431)
})

test('missing or different structural destination never moves the current position', () => {
  stepScreen('change')
  document.documentElement.scrollTop = 431
  const intent = helper.beginSwitchExplicitScrollIntent('keep', false)
  assert.equal(helper.resetSwitchExplicitNavigationScroll(intent), null)
  assert.equal(document.documentElement.scrollTop, 431)
  helper.releaseSwitchExplicitScrollIntent(intent)
})
