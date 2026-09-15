import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
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

let helper, temp, animationFrameCallback
Object.defineProperty(window, 'requestAnimationFrame', {
  configurable: true,
  writable: true,
  value: (callback) => {
    animationFrameCallback = callback
    return 1
  },
})

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
  animationFrameCallback = null
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

test('history traversal keeps manual restoration through the reset frame, then restores the original value', () => {
  const traversal = helper.beginSwitchExplicitScrollIntent('change', true)
  assert.equal(traversal.target, 'change')
  assert.equal(traversal.previousScrollRestoration, 'auto')
  assert.equal(window.history.scrollRestoration, 'manual')

  helper.releaseSwitchExplicitScrollIntent(traversal)
  assert.equal(window.history.scrollRestoration, 'manual')
  assert.equal(typeof animationFrameCallback, 'function')
  animationFrameCallback(0)
  assert.equal(window.history.scrollRestoration, 'auto')

  const direct = helper.beginSwitchExplicitScrollIntent('results', false)
  assert.equal(direct.previousScrollRestoration, null)
  assert.equal(window.history.scrollRestoration, 'auto')
  helper.releaseSwitchExplicitScrollIntent(direct)
  assert.equal(window.history.scrollRestoration, 'auto')
})

test('missing destination does not move the current document position', () => {
  document.documentElement.scrollTop = 431
  assert.equal(helper.resetSwitchExplicitNavigationScroll('compare'), false)
  assert.equal(document.documentElement.scrollTop, 431)
})
