import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const q = (value) => JSON.stringify(value)

class CDP {
  constructor(ws) { this.wsUrl = ws; this.ws = null; this.nextId = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') {
        this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      }
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, timeout = 30000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`).catch(() => false)) return
      await sleep(100)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, 'document ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'app root')
    await this.eval('document.fonts?.ready')
    await sleep(350)
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome))
  const port = 9800 + (process.pid % 500)
  const dir = `/tmp/catfood-switch-design-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })

  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) {
        const c = new CDP(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', {
          width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844,
        })
        await c.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(() => {
            const originalFetch = window.fetch.bind(window)
            window.__blocked = { analytics: 0, writes: 0 }
            window.fetch = (input, init = {}) => {
              const url = typeof input === 'string' ? input : (input && input.url) || ''
              const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
              if (url.includes('/functions/v1/decision-intake')) {
                window.__blocked.analytics += 1
                return Promise.reject(new TypeError('blocked analytics'))
              }
              if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
                window.__blocked.writes += 1
                return Promise.reject(new TypeError('blocked write'))
              }
              return originalFetch(input, init)
            }
          })();`,
        })
        return { c, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}

async function cleanup(handle) {
  handle.c.close()
  handle.proc.kill('SIGTERM')
  await sleep(100)
  if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL')
  rmSync(handle.dir, { recursive: true, force: true })
}

function nodeExpression(selector, texts = [], index = 0) {
  return `([...document.querySelectorAll(${q(selector)})].filter((node) => ${q(texts)}.every((text) => node.textContent?.includes(text)))[${index}] || null)`
}

async function nodeMetrics(c, selector, texts = [], index = 0) {
  return c.eval(`(() => {
    const node = ${nodeExpression(selector, texts, index)}
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return {
      text: node.textContent?.trim() || '',
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: rect.width, height: rect.height,
      visible: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
      fullyVisible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
      scrollY,
    }
  })()`)
}

async function wheelVertical(c, deltaY) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 180, y: 700, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 180, y: 700, deltaX: 0, deltaY, pointerType: 'mouse' })
  await sleep(120)
}

async function reveal(c, selector, texts = [], index = 0) {
  const before = await nodeMetrics(c, selector, texts, index)
  assert.ok(before, `missing ${selector} ${texts.join('+')} ${index}`)
  const startY = await c.eval('scrollY')
  let current = before
  let iterations = 0
  while (!current.fullyVisible && iterations < 20) {
    let delta = 0
    if (current.bottom > 820) delta = Math.min(520, Math.max(120, current.bottom - 800))
    else if (current.top < 24) delta = -Math.min(520, Math.max(120, 40 - current.top))
    else break
    await wheelVertical(c, delta)
    current = await nodeMetrics(c, selector, texts, index)
    iterations += 1
  }
  const endY = await c.eval('scrollY')
  return { selector, texts, index, before, after: current, scrollDelta: endY - startY, iterations }
}

async function trustedClick(c, selector, texts = [], index = 0) {
  const revealResult = await reveal(c, selector, texts, index)
  const point = await c.eval(`(() => {
    const node = ${nodeExpression(selector, texts, index)}
    const rect = node.getBoundingClientRect()
    window.__trustedClick = null
    node.addEventListener('click', (event) => { window.__trustedClick = event.isTrusted }, { once: true, capture: true })
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: node.textContent?.trim() || '' }
  })()`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(220)
  assert.equal(await c.eval('window.__trustedClick'), true)
  return { ...revealResult, clickedText: point.text }
}

async function typeText(c, selector, text) {
  const interaction = await trustedClick(c, selector)
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector(${q(selector)})?.value === ${q(text)}`, 'typed query')
  await sleep(250)
  return interaction
}

async function captureStage(c, number, slug) {
  const name = `${String(number).padStart(2, '0')}-${slug}.png`
  const metrics = await c.eval(`(() => {
    const intersects = (rect) => rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
    const textNodes = [...document.querySelectorAll('h1,h2,h3,p,button,label,strong,small,span')]
      .filter((node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return intersects(rect) && style.display !== 'none' && style.visibility !== 'hidden' && (node.textContent?.trim() || '')
      })
    const fonts = textNodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)).filter(Number.isFinite)
    const buttons = [...document.querySelectorAll('button')]
      .filter((button) => intersects(button.getBoundingClientRect()) && getComputedStyle(button).visibility !== 'hidden')
      .map((button) => button.textContent?.trim() || '')
      .filter(Boolean)
    const activeStep = document.querySelector('.switch-progress [aria-current="step"] strong')?.textContent?.trim() || null
    const rail = document.querySelector('.switch-reference-rail')?.innerText.trim() || null
    const currentPreview = document.querySelector('.switch-current-preview')?.innerText.trim() || null
    const compareCurrent = document.querySelector('.compare-mobile-product-head.is-current')?.innerText.trim() || null
    const compareCandidate = document.querySelector('.compare-mobile-product-head.is-candidate')?.innerText.trim() || null
    const picker = [...document.querySelectorAll('.compare-mobile-candidate-picker button')].map((button) => button.textContent?.trim() || '').filter(Boolean)
    return {
      scrollY,
      viewportHeight: innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      question: document.querySelector('main h1, .compare-stage h1, h1')?.textContent?.trim() || null,
      firstHeading: document.querySelector('h1,h2')?.textContent?.trim() || null,
      visibleButtons: buttons,
      minVisibleFontPx: fonts.length ? Math.min(...fonts) : null,
      visibleTextAtOrBelow12px: fonts.filter((value) => value <= 12).length,
      activeStep,
      rail,
      currentPreview,
      compareCurrent,
      compareCandidate,
      picker,
      bodyExcerpt: document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 1800),
    }
  })()`)
  await c.shot(name)
  return { number, slug, screenshot: name, ...metrics }
}

function networkSummary(c) {
  const writes = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  const analytics = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const nonRead = c.requests.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  return { writes, analytics, nonRead, getCount: c.requests.filter((request) => request.method === 'GET').length }
}

const report = {
  deployedSha: process.env.MERGE_SHA,
  page: BASE,
  viewport: '360x844',
  status: 'running',
  stages: [],
  interactions: [],
  actualPath: {},
}

const handle = await launch()
const c = handle.c
try {
  await c.nav(BASE)
  await c.wait(`document.querySelector('.home-shell')`, 'home')
  await c.wait(`document.querySelector('.home-search-console small')?.textContent?.trim() !== '현재 확인된 제품 —개'`, 'home catalog ready', 30000).catch(() => {})
  report.stages.push(await captureStage(c, 1, 'home-first'))
  report.interactions.push({ stage: 'home', purpose: 'SWITCH 시작', ...(await trustedClick(c, 'button', ['현재 사료로 시작하기'])) })

  await c.wait(`document.querySelector('.switch-find-search input')`, 'current food find')
  report.stages.push(await captureStage(c, 2, 'current-food-find-first'))
  report.interactions.push({ stage: 'current-food-find', purpose: '검색어 입력', ...(await typeText(c, '.switch-find-search input', 'AATU 연어')) })
  await c.wait(`[...document.querySelectorAll('.switch-find-result')].some((node) => node.textContent.includes('AATU') && node.textContent.includes('연어'))`, 'current product result')
  report.interactions.push({ stage: 'current-food-find', purpose: '현재 제품 선택', ...(await trustedClick(c, '.switch-find-result', ['AATU', '연어'])) })

  await c.wait(`document.querySelector('.switch-current-preview')`, 'current product preview')
  report.stages.push(await captureStage(c, 3, 'current-product-selected-first'))
  report.actualPath.currentProduct = await c.eval(`({
    brand: document.querySelector('.switch-current-preview .switch-current-brand')?.textContent?.trim() || null,
    name: document.querySelector('.switch-current-preview h2')?.textContent?.trim() || null,
    previewText: document.querySelector('.switch-current-preview')?.innerText.trim() || null,
  })`)
  report.interactions.push({ stage: 'current-product-selected', purpose: '규격 선택으로 이동', ...(await trustedClick(c, '.switch-current-preview .switch-primary-action')) })

  await c.wait(`document.querySelector('.switch-sku-list')`, 'sku stage')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length > 0`, 'sku options')
  report.stages.push(await captureStage(c, 4, 'sku-first'))
  report.actualPath.availableSkuLabels = await c.eval(`[...document.querySelectorAll('.switch-sku-option')].map((node) => node.textContent?.trim() || '').filter(Boolean)`)
  const skuInteraction = await trustedClick(c, '.switch-sku-option', [], 0)
  report.actualPath.selectedSku = skuInteraction.clickedText
  report.interactions.push({ stage: 'sku', purpose: '첫 실제 SKU 선택', ...skuInteraction })
  report.interactions.push({ stage: 'sku', purpose: 'CHANGE로 이동', ...(await trustedClick(c, '.switch-step-actions .switch-primary-action')) })

  await c.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'change stage')
  report.stages.push(await captureStage(c, 5, 'change-first'))
  report.interactions.push({ stage: 'change', purpose: '기본 최소 선택 — 특별히 바꿀 점 없음', ...(await trustedClick(c, '.switch-no-change')) })
  report.interactions.push({ stage: 'change', purpose: 'KEEP으로 이동', ...(await trustedClick(c, '.switch-step-actions .switch-primary-action')) })

  await c.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'keep stage')
  report.stages.push(await captureStage(c, 6, 'keep-first'))
  report.interactions.push({ stage: 'keep', purpose: '추가 유지 조건 없이 후보 보기', ...(await trustedClick(c, '.switch-step-actions .switch-primary-action')) })

  await c.wait(`document.querySelectorAll('.switch-candidate-row').length >= 2`, 'candidate results')
  report.stages.push(await captureStage(c, 7, 'results-first'))
  report.actualPath.candidateCountLoaded = await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)
  report.actualPath.initialResultIdentities = await c.eval(`[...document.querySelectorAll('.switch-candidate-row')].slice(0, 5).map((row) => ({
    brand: row.querySelector('.switch-candidate-identity > span')?.textContent?.trim() || null,
    name: row.querySelector('.switch-candidate-identity > strong')?.textContent?.trim() || null,
  }))`)
  report.actualPath.compareDockOnInitialResults = await nodeMetrics(c, '.switch-compare-dock > button', ['비교 보기'])

  const firstIdentity = await c.eval(`(() => { const row = document.querySelectorAll('.switch-candidate-row')[0]; return { brand: row?.querySelector('.switch-candidate-identity > span')?.textContent?.trim() || null, name: row?.querySelector('.switch-candidate-identity > strong')?.textContent?.trim() || null } })()`)
  report.interactions.push({ stage: 'results', purpose: '첫 후보 열기', ...(await trustedClick(c, '.switch-candidate-row', [], 0)) })
  await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'candidate inspector')
  report.stages.push(await captureStage(c, 8, 'candidate-inspector-first'))
  report.actualPath.firstCandidate = firstIdentity
  report.actualPath.inspectorCompareActionAtEntry = await nodeMetrics(c, '.switch-candidate-inspector .switch-compare-action', ['비교에 추가'])
  report.interactions.push({ stage: 'candidate-inspector', purpose: '첫 후보 비교에 추가', ...(await trustedClick(c, '.switch-candidate-inspector .switch-compare-action', ['비교에 추가'])) })
  report.interactions.push({ stage: 'candidate-inspector', purpose: '결과로 닫기', ...(await trustedClick(c, '.switch-candidate-inspector .switch-preview-topline button')) })
  await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'first inspector close')

  const secondIdentity = await c.eval(`(() => { const row = document.querySelectorAll('.switch-candidate-row')[1]; return { brand: row?.querySelector('.switch-candidate-identity > span')?.textContent?.trim() || null, name: row?.querySelector('.switch-candidate-identity > strong')?.textContent?.trim() || null } })()`)
  report.interactions.push({ stage: 'results', purpose: '둘째 후보 열기', ...(await trustedClick(c, '.switch-candidate-row', [], 1)) })
  await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'second candidate inspector')
  report.actualPath.secondCandidate = secondIdentity
  report.interactions.push({ stage: 'candidate-inspector', purpose: '둘째 후보 비교에 추가', ...(await trustedClick(c, '.switch-candidate-inspector .switch-compare-action', ['비교에 추가'])) })
  report.interactions.push({ stage: 'candidate-inspector', purpose: '결과로 닫기', ...(await trustedClick(c, '.switch-candidate-inspector .switch-preview-topline button')) })
  await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'second inspector close')

  report.actualPath.compareDockAfterTwo = await nodeMetrics(c, '.switch-compare-dock > button', ['비교 보기'])
  report.stages.push(await captureStage(c, 9, 'results-two-in-compare-first'))
  report.interactions.push({ stage: 'results-two-in-compare', purpose: '비교 화면으로 이동', ...(await trustedClick(c, '.switch-compare-dock > button', ['비교 보기'])) })

  await c.wait(`document.querySelectorAll('.compare-mobile-candidate-picker button').length >= 2`, 'compare overview')
  const compareStage = await captureStage(c, 10, 'compare-first')
  report.stages.push(compareStage)

  // Keep the requested deliverable to nine core images: remove the less informative current-selection preview image.
  rmSync(`${OUT}/03-current-product-selected-first.png`, { force: true })
  report.stages = report.stages.filter((stage) => stage.screenshot !== '03-current-product-selected-first.png')

  report.actualPath.compare = await c.eval(`({
    currentHeader: document.querySelector('.compare-mobile-product-head.is-current')?.innerText.trim() || null,
    candidateHeader: document.querySelector('.compare-mobile-product-head.is-candidate')?.innerText.trim() || null,
    pickerLabels: [...document.querySelectorAll('.compare-mobile-candidate-picker button')].map((button) => button.textContent?.trim() || '').filter(Boolean),
    firstFactLabel: document.querySelector('.compare-switch-mobile-row .compare-mobile-row-label')?.textContent?.trim() || null,
    firstFactCurrent: document.querySelector('.compare-switch-mobile-row .compare-mobile-value.is-current')?.textContent?.trim() || null,
    firstFactCandidate: document.querySelector('.compare-switch-mobile-row .compare-mobile-value:not(.is-current)')?.textContent?.trim() || null,
  })`)

  const rawSession = await c.eval(`sessionStorage.getItem(${q(STORAGE)})`)
  report.actualPath.session = rawSession ? JSON.parse(rawSession) : null
  const network = networkSummary(c)
  assert.equal(network.writes.length, 0, JSON.stringify(network.writes))
  assert.equal(network.analytics.length, 0, JSON.stringify(network.analytics))
  assert.equal(network.nonRead.length, 0, JSON.stringify(network.nonRead))
  report.network = { writes: 0, analytics: 0, nonRead: 0, getCount: network.getCount }
  report.blocked = await c.eval('window.__blocked')
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('CATFOOD_SWITCH_DESIGN_CAPTURE PASS', JSON.stringify({ product: report.actualPath.currentProduct, sku: report.actualPath.selectedSku, stages: report.stages.map((stage) => stage.screenshot), network: report.network }))
} catch (error) {
  report.status = 'fail'
  report.error = String(error?.stack ?? error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  await cleanup(handle)
}
