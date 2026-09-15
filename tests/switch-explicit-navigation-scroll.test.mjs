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

function frameState(id) {
  return animationFrames.get(id) ?? null
}

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
  for (const id of activeFrameIds()) runFrame(id)
  animationFrames.clear()
})

test('explicit navigation is owned by SwitchFlow without global click or mutation observers', async () => {
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
  assert.doesNotMatch(scrollHelper, /무엇을|후보 제품|비교 보기|사용 규격/)
})

test('mobile step, results, and compare targets reset the document scroll owner', () => {
  document.getElementById('root').innerHTML = '<main class="switch-step-main"></main>'
  document.documentElement.scrollTop = 643
  assert.equal(helper.resetSwitchExplicitNavigationScroll('keep'), true)
  assert.equal(document.documentElement.scrollTop, 0)

  document.getElementById('root').innerHTML = '<main class="switch-results-stage"><div class="switch-candidate-list"></div></main>'
  document.documentElement.scrollTop = 643
  assert.equal(helper.resetSwitchExplicitNavigationScroll('results'), true)
  assert.equal(document.documentElement.scrollTop, 0)

  document.getElementById('root').innerHTML = '<main class="compare-stage"></main>'
  document.documentElement.scrollTop = 347
  assert.equal(helper.resetSwitchExplicitNavigationScroll('compare'), true)
  assert.equal(document.documentElement.scrollTop, 0)
})

test('desktop keeps an existing internal scroll owner instead of moving the document', () => {
  document.getElementById('root').innerHTML = '<main class="switch-step-main" style="overflow-y:auto"></main>'
  const main = document.querySelector('.switch-step-main')
  Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 1400 })
  Object.defineProperty(main, 'clientHeight', { configurable: true, value: 600 })
  main.scrollTop = 720
  document.documentElement.scrollTop = 91

  assert.equal(helper.resetSwitchExplicitNavigationScroll('change'), true)
  assert.equal(main.scrollTop, 0)
  assert.equal(document.documentElement.scrollTop, 91)
})

test('single history traversal keeps manual restoration through the reset frame then restores auto', () => {
  const traversal = helper.beginSwitchExplicitScrollIntent('change', true)
  assert.equal(traversal.target, 'change')
  assert.equal(typeof traversal.restorationLeaseId, 'number')
  assert.equal(window.history.scrollRestoration, 'manual')

  helper.releaseSwitchExplicitScrollIntent(traversal)
  assert.equal(window.history.scrollRestoration, 'manual')
  assert.equal(activeFrameIds().length, 1)
  runNextActiveFrame()
  assert.equal(window.history.scrollRestoration, 'auto')
})

test('a second traversal before the first restore frame inherits the original value and invalidates the stale frame', () => {
  const first = helper.beginSwitchExplicitScrollIntent('change', true)
  helper.releaseSwitchExplicitScrollIntent(first)
  const [firstRestoreFrame] = activeFrameIds()
  assert.ok(firstRestoreFrame)
  assert.equal(window.history.scrollRestoration, 'manual')

  const second = helper.beginSwitchExplicitScrollIntent('sku', true)
  assert.equal(second.restorationLeaseId, first.restorationLeaseId)
  assert.equal(frameState(firstRestoreFrame)?.canceled, true)
  assert.equal(window.history.scrollRestoration, 'manual')

  assert.equal(runFrame(firstRestoreFrame, { force: true }), true, 'force the stale callback to prove it is harmless')
  assert.equal(window.history.scrollRestoration, 'manual')

  helper.releaseSwitchExplicitScrollIntent(second)
  assert.equal(activeFrameIds().length, 1)
  runNextActiveFrame()
  assert.equal(window.history.scrollRestoration, 'auto')
})

test('replacing a pending traversal with a direct intent keeps the shared lease until the replacement finishes', () => {
  const previous = helper.beginSwitchExplicitScrollIntent('change', true)
  helper.releaseSwitchExplicitScrollIntent(previous)
  const [staleRestoreFrame] = activeFrameIds()
  assert.ok(staleRestoreFrame)

  const replacement = helper.beginSwitchExplicitScrollIntent('results', false)
  assert.equal(replacement.restorationLeaseId, previous.restorationLeaseId)
  assert.equal(frameState(staleRestoreFrame)?.canceled, true)
  assert.equal(window.history.scrollRestoration, 'manual')

  assert.equal(runFrame(staleRestoreFrame, { force: true }), true)
  assert.equal(window.history.scrollRestoration, 'manual')

  helper.releaseSwitchExplicitScrollIntent(replacement)
  runNextActiveFrame()
  assert.equal(window.history.scrollRestoration, 'auto')
})

test('releasing overlapping owners does not restore until the last owner finishes', () => {
  const first = helper.beginSwitchExplicitScrollIntent('change', true)
  const second = helper.beginSwitchExplicitScrollIntent('sku', true)
  assert.equal(second.restorationLeaseId, first.restorationLeaseId)

  helper.releaseSwitchExplicitScrollIntent(first)
  assert.equal(activeFrameIds().length, 0)
  assert.equal(window.history.scrollRestoration, 'manual')

  helper.releaseSwitchExplicitScrollIntent(second)
  assert.equal(activeFrameIds().length, 1)
  runNextActiveFrame()
  assert.equal(window.history.scrollRestoration, 'auto')
})

test('an original manual scrollRestoration value remains manual after completion or cancellation', () => {
  window.history.scrollRestoration = 'manual'
  const traversal = helper.beginSwitchExplicitScrollIntent('change', true)
  assert.equal(window.history.scrollRestoration, 'manual')

  helper.releaseSwitchExplicitScrollIntent(traversal)
  runNextActiveFrame()
  assert.equal(window.history.scrollRestoration, 'manual')

  const direct = helper.beginSwitchExplicitScrollIntent('results', false)
  assert.equal(direct.restorationLeaseId, null)
  helper.releaseSwitchExplicitScrollIntent(direct)
  assert.equal(activeFrameIds().length, 0)
  assert.equal(window.history.scrollRestoration, 'manual')
})

test('release is idempotent so unmount cleanup cannot double-release a restoration lease', () => {
  const traversal = helper.beginSwitchExplicitScrollIntent('change', true)
  helper.releaseSwitchExplicitScrollIntent(traversal)
  helper.releaseSwitchExplicitScrollIntent(traversal)
  assert.equal(activeFrameIds().length, 1)
  runNextActiveFrame()
  assert.equal(window.history.scrollRestoration, 'auto')
})

test('missing destination does not move the current document position', () => {
  document.documentElement.scrollTop = 431
  assert.equal(helper.resetSwitchExplicitNavigationScroll('compare'), false)
  assert.equal(document.documentElement.scrollTop, 431)
})
