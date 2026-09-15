import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/catfood_web/?view=workspace&mode=switch' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Element = dom.window.Element
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement })

let helper, temp

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
  helper?.uninstallSwitchExplicitNavigationScrollForTest()
  dom.window.close()
  await rm(temp, { recursive: true })
})

beforeEach(() => {
  helper?.uninstallSwitchExplicitNavigationScrollForTest()
  document.body.innerHTML = '<div id="root"></div>'
  document.documentElement.scrollTop = 0
  helper.installSwitchExplicitNavigationScroll()
})

async function flushMutations() {
  await Promise.resolve()
  await new Promise((resolvePromise) => queueMicrotask(resolvePromise))
}

function stepScreen(question, actionClass, actionText) {
  document.getElementById('root').innerHTML = `
    <main class="switch-step-main">
      <div class="switch-step-header"><h1>${question}</h1></div>
      <div class="switch-step-actions"><button class="${actionClass}">${actionText}</button></div>
    </main>`
}

function resultsScreen({ withCompare = false } = {}) {
  document.getElementById('root').innerHTML = `
    <main class="switch-results-stage">
      <div class="switch-session-bar"><button>조건 수정</button></div>
      <div class="switch-candidate-list"><button class="switch-candidate-row">후보 보기</button></div>
      ${withCompare ? '<div class="switch-compare-dock"><button>비교 보기 →</button></div>' : ''}
    </main>`
}

test('explicit mobile step, results, and compare entries reset the document scroll only after the destination is rendered', async () => {
  stepScreen('무엇을 바꾸고 싶나요?', 'switch-primary-action', '다음 →')
  document.documentElement.scrollTop = 643
  document.querySelector('.switch-primary-action').click()
  stepScreen('무엇을 그대로 유지할까요?', 'switch-primary-action', '후보 제품 보기 →')
  await flushMutations()
  assert.equal(document.documentElement.scrollTop, 0)

  document.documentElement.scrollTop = 643
  document.querySelector('.switch-primary-action').click()
  resultsScreen({ withCompare: true })
  await flushMutations()
  assert.equal(document.documentElement.scrollTop, 0)

  document.documentElement.scrollTop = 347
  document.querySelector('.switch-compare-dock > button').click()
  document.getElementById('root').innerHTML = '<main class="compare-stage"><header class="compare-header"><button>비교 닫기</button></header></main>'
  await flushMutations()
  assert.equal(document.documentElement.scrollTop, 0)
})

test('candidate selection, data rerenders, compare return, and browser-style restores do not request a reset', async () => {
  resultsScreen()
  document.documentElement.scrollTop = 512
  document.querySelector('.switch-candidate-row').click()
  document.querySelector('.switch-results-stage').append(document.createElement('aside'))
  await flushMutations()
  assert.equal(document.documentElement.scrollTop, 512, 'candidate selection/rerender keeps the read position')

  document.getElementById('root').innerHTML = '<main class="compare-stage"><header class="compare-header"><button>비교 닫기</button></header></main>'
  document.documentElement.scrollTop = 287
  document.querySelector('.compare-header button').click()
  resultsScreen()
  await flushMutations()
  assert.equal(document.documentElement.scrollTop, 287, 'compare return is left to the existing history restoration contract')

  document.documentElement.scrollTop = 431
  stepScreen('무엇을 바꾸고 싶나요?', 'switch-primary-action', '다음 →')
  await flushMutations()
  assert.equal(document.documentElement.scrollTop, 431, 'browser-style state restoration without an explicit click is untouched')

  document.querySelector('.switch-step-main').append(document.createElement('span'))
  await flushMutations()
  assert.equal(document.documentElement.scrollTop, 431, 'plain data/render completion is untouched')
})

test('explicit previous-step buttons reset the new step without turning browser back/forward into a blanket reset', async () => {
  stepScreen('무엇을 그대로 유지할까요?', 'switch-secondary-action', '← 바꿀 것 수정')
  document.documentElement.scrollTop = 700
  const supportsRestoration = 'scrollRestoration' in window.history
  if (supportsRestoration) window.history.scrollRestoration = 'auto'
  document.querySelector('.switch-secondary-action').click()
  stepScreen('무엇을 바꾸고 싶나요?', 'switch-secondary-action', '← 사용 규격')
  await flushMutations()
  assert.equal(document.documentElement.scrollTop, 0)
  if (supportsRestoration) assert.equal(window.history.scrollRestoration, 'auto')
})

test('desktop keeps the internal step scroller as owner and does not move the document root', async () => {
  stepScreen('무엇을 바꾸고 싶나요?', 'switch-primary-action', '다음 →')
  const main = document.querySelector('.switch-step-main')
  main.style.overflowY = 'auto'
  Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 1400 })
  Object.defineProperty(main, 'clientHeight', { configurable: true, value: 600 })
  main.scrollTop = 720
  document.documentElement.scrollTop = 91

  document.querySelector('.switch-primary-action').click()
  document.querySelector('.switch-step-header h1').textContent = '무엇을 그대로 유지할까요?'
  await flushMutations()

  assert.equal(main.scrollTop, 0)
  assert.equal(document.documentElement.scrollTop, 91)
})
