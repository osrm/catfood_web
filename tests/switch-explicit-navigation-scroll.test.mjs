import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/catfood_web/?view=workspace&mode=switch' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement })
Object.defineProperty(window.history, 'scrollRestoration', { configurable: true, writable: true, value: 'auto' })

let helper, temp, nextAnimationFrameId
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

before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/catfood-switch-scroll-'))
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: { ssr: 'src/switch-explicit-navigation-scroll.ts', write: false, minify: false },
  })
  const chunk = result.output.find((item) => item.type === 'chunk' && item.isEntry)
  const file = resolve(temp, 'switch-explicit-navigation-scroll.mjs')
  await writeFile(file, chunk.code)
  helper = await import(pathToFileURL(file).href)
})

after(async () => {
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  document.documentElement.scrollTop = 0
  window.history.scrollRestoration = 'auto'
  nextAnimationFrameId = 1
  animationFrames.clear()
})

afterEach(() => {
  drainActiveFrames()
  animationFrames.clear()
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
  assert.match(flow, /if \(renderedTarget === pending\.intent\.target\)/)
  assert.match(flow, /if \(renderedTarget !== pending\.source\) releasePendingExplicitScroll\(\)/)
  assert.match(flow, /useEffect\(\(\) => \(\) => releasePendingExplicitScroll\(\), \[\]\)/)

  assert.doesNotMatch(main, /installSwitchExplicitNavigationScroll/)
  assert.match(main, /document\.addEventListener\('scroll', syncCompareScroll, true\)/)
  assert.doesNotMatch(scrollHelper, /MutationObserver/)
  assert.doesNotMatch(scrollHelper, /addEventListener\(['"]click/)
  assert.doesNotMatch(scrollHelper, /textContent|switch-step-header h1/)
  assert.doesNotMatch(scrollHelper, /scrollRestoration\s*=/)
})

test('step identifiers resolve structural anchors and reset the actual mobile document owner', () => {
  stepScreen('change')
  document.documentElement.scrollTop = 643
  assert.equal(helper.resetSwitchExplicitNavigationScroll('change'), true)
  assert.equal(document.documentElement.scrollTop, 0)

  stepScreen('keep')
  document.documentElement.scrollTop = 511
  assert.equal(helper.resetSwitchExplicitNavigationScroll('keep'), true)
  assert.equal(document.documentElement.scrollTop, 0)

  document.getElementById('root').innerHTML = '<main class="switch-results-stage"><div class="switch-candidate-list"></div></main>'
  document.documentElement.scrollTop = 422
  assert.equal(helper.resetSwitchExplicitNavigationScroll('results'), true)
  assert.equal(document.documentElement.scrollTop, 0)
})

test('desktop keeps the existing internal step scroller and does not move the document', () => {
  stepScreen('change')
  const main = document.querySelector('.switch-step-main')
  main.style.overflowY = 'auto'
  Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 1400 })
  Object.defineProperty(main, 'clientHeight', { configurable: true, value: 600 })
  main.scrollTop = 720
  document.documentElement.scrollTop = 91

  assert.equal(helper.resetSwitchExplicitNavigationScroll('change'), true)
  assert.equal(main.scrollTop, 0)
  assert.equal(document.documentElement.scrollTop, 91)
})

test('a history traversal leaves native auto restoration untouched while the next frame stabilizes the destination', () => {
  stepScreen('change')
  const intent = helper.beginSwitchExplicitScrollIntent('change', true)
  assert.equal(window.history.scrollRestoration, 'auto')

  document.documentElement.scrollTop = 700
  assert.equal(helper.resetSwitchExplicitNavigationScroll('change'), true)
  assert.equal(document.documentElement.scrollTop, 0)
  helper.releaseSwitchExplicitScrollIntent(intent)
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
  helper.resetSwitchExplicitNavigationScroll('change')
  helper.releaseSwitchExplicitScrollIntent(first)
  const [staleFrame] = activeFrameIds()
  assert.ok(staleFrame)

  stepScreen('sku')
  document.documentElement.scrollTop = 444
  const second = helper.beginSwitchExplicitScrollIntent('sku', true)
  assert.equal(frameState(staleFrame)?.canceled, true)
  assert.equal(window.history.scrollRestoration, 'auto')

  assert.equal(runFrame(staleFrame, { force: true }), true, 'force stale callback to prove the generation guard')
  assert.equal(document.documentElement.scrollTop, 444, 'stale CHANGE frame cannot reset SKU')

  helper.resetSwitchExplicitNavigationScroll('sku')
  helper.releaseSwitchExplicitScrollIntent(second)
  document.documentElement.scrollTop = 333
  runNextActiveFrame()
  assert.equal(document.documentElement.scrollTop, 0)
})

test('canceling an intent before its destination renders leaves no stale frame for its replacement', () => {
  const canceled = helper.beginSwitchExplicitScrollIntent('keep', true)
  helper.releaseSwitchExplicitScrollIntent(canceled)
  assert.equal(activeFrameIds().length, 0)

  document.getElementById('root').innerHTML = '<main class="switch-results-stage"><div class="switch-candidate-list"></div></main>'
  document.documentElement.scrollTop = 321
  const replacement = helper.beginSwitchExplicitScrollIntent('results', false)
  helper.resetSwitchExplicitNavigationScroll('results')
  helper.releaseSwitchExplicitScrollIntent(replacement)
  document.documentElement.scrollTop = 222
  runNextActiveFrame()
  assert.equal(document.documentElement.scrollTop, 0)
  assert.equal(window.history.scrollRestoration, 'auto')
})

test('an original manual scrollRestoration value is never changed by explicit intents', () => {
  window.history.scrollRestoration = 'manual'
  stepScreen('change')
  const first = helper.beginSwitchExplicitScrollIntent('change', true)
  assert.equal(window.history.scrollRestoration, 'manual')
  helper.resetSwitchExplicitNavigationScroll('change')
  helper.releaseSwitchExplicitScrollIntent(first)
  assert.equal(window.history.scrollRestoration, 'manual')
  runNextActiveFrame()
  assert.equal(window.history.scrollRestoration, 'manual')

  const canceled = helper.beginSwitchExplicitScrollIntent('keep', true)
  helper.releaseSwitchExplicitScrollIntent(canceled)
  assert.equal(window.history.scrollRestoration, 'manual')
})

test('release is idempotent so cancel and unmount cleanup cannot revive an old intent', () => {
  const intent = helper.beginSwitchExplicitScrollIntent('change', true)
  helper.releaseSwitchExplicitScrollIntent(intent)
  helper.releaseSwitchExplicitScrollIntent(intent)
  assert.equal(activeFrameIds().length, 0)

  stepScreen('change')
  document.documentElement.scrollTop = 431
  assert.equal(helper.resetSwitchExplicitNavigationScroll('change'), true)
  assert.equal(document.documentElement.scrollTop, 0)
  assert.equal(activeFrameIds().length, 0, 'released intent cannot schedule a later reset')
})

test('missing or different structural destination never moves the current position', () => {
  stepScreen('change')
  document.documentElement.scrollTop = 431
  assert.equal(helper.resetSwitchExplicitNavigationScroll('keep'), false)
  assert.equal(document.documentElement.scrollTop, 431)
})
