import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const DEPLOY_SHA = process.env.DEPLOY_SHA
const EXPECTED_CSS = process.env.EXPECTED_CSS
const EXPECTED_JS = process.env.EXPECTED_JS
const OUT = 'qa-artifacts'
const STORAGE_KEY = 'catfood.switch-session.v1'
const IDS = ['product_b47d3ae674773585', 'product_99c5ee4eb9211a75']
mkdirSync(OUT, { recursive: true })
assert.ok(DEPLOY_SHA && EXPECTED_CSS && EXPECTED_JS)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = value => JSON.stringify(value)

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = []
  }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
    })
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') {
        this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      }
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'CSS.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const nativeFetch = window.fetch.bind(window)
      window.__qaBlockedAnalytics = 0
      window.__qaBlockedWrites = 0
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
        if (url.includes('/functions/v1/decision-intake')) {
          window.__qaBlockedAnalytics += 1
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          window.__qaBlockedWrites += 1
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        return nativeFetch(input, init)
      }
    })();` })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, 'page ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'react root')
    await this.eval('document.fonts?.ready')
    await sleep(250)
  }
  async shot(filename) {
    await this.eval('document.fonts?.ready')
    await sleep(100)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${filename}`, Buffer.from(result.data, 'base64'))
  }
  async fonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId, `font node missing: ${selector}`)
    return (await this.send('CSS.getPlatformFontsForNode', { nodeId })).fonts ?? []
  }
  close() { try { this.ws?.close() } catch {} }
}

async function waitForLiveAssets() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`${BASE}?postdeploy=${Date.now()}`, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } })
    const html = await response.text()
    if (response.ok && html.includes(EXPECTED_CSS) && html.includes(EXPECTED_JS)) {
      return { status: response.status, css: EXPECTED_CSS, js: EXPECTED_JS }
    }
    await sleep(1000)
  }
  throw new Error(`live Pages did not expose ${EXPECTED_CSS} and ${EXPECTED_JS}`)
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Google Chrome unavailable')
  const port = 9751 + (process.pid % 100)
  const dir = `/tmp/pr24-postdeploy-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const cdp = new Cdp(page.webSocketDebuggerUrl)
        await cdp.connect()
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844 })
        await cdp.send('Emulation.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
          acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8',
          platform: 'Android'
        })
        return { cdp, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

const state = cdp => cdp.eval(`(() => { const raw = sessionStorage.getItem(${js(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`)

async function scrollRight(cdp) {
  await cdp.eval(`(() => { const wrap = document.querySelector('.compare-table-wrap'); wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth; return wrap.scrollLeft })()`)
  await sleep(150)
}

async function clickCompareTab(cdp, text) {
  const info = await cdp.eval(`(() => {
    const buttons = [...document.querySelectorAll('.compare-tabs button')]
    const button = buttons.find(node => node.textContent.trim() === ${js(text)})
    if (!button) return null
    button.scrollIntoView({ block: 'center', inline: 'nearest' })
    const r = button.getBoundingClientRect()
    return { index: buttons.indexOf(button), x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  assert.ok(info, `missing compare tab ${text}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  await sleep(180)
}

async function pointerClick(cdp, selector, index) {
  await cdp.eval(`(() => {
    const node = document.querySelectorAll(${js(selector)})[${index}]
    if (!node) return false
    node.scrollIntoView({ block: 'center', inline: 'nearest' })
    return true
  })()`)
  await scrollRight(cdp)
  const info = await cdp.eval(`(() => {
    const node = document.querySelectorAll(${js(selector)})[${index}]
    if (!node) return null
    const r = node.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { text: node.textContent.trim(), rect: [r.left, r.top, r.width, r.height], x, y, centerHit: hit === node || node.contains(hit), hit: hit?.className || hit?.tagName }
  })()`)
  assert.ok(info, `missing pointer target ${selector}[${index}]`)
  assert.equal(info.centerHit, true, `pointer target occluded: ${JSON.stringify(info)}`)
  assert.ok(info.x >= 0 && info.x < 360 && info.y >= 0 && info.y < 844, `pointer target outside viewport: ${JSON.stringify(info)}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  await sleep(220)
  return info
}

async function metrics(cdp) {
  return cdp.eval(`(() => {
    const wrap = document.querySelector('.compare-table-wrap')
    const label = document.querySelector('.compare-corner')
    const heads = [...document.querySelectorAll('.compare-product-head')]
    const last = heads.at(-1)
    const wr = wrap.getBoundingClientRect(), lr = label.getBoundingClientRect(), hr = last.getBoundingClientRect()
    return {
      viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth,
      wrap: { left: wr.left, right: wr.right, width: wr.width, clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth, scrollLeft: wrap.scrollLeft, maxScroll: wrap.scrollWidth - wrap.clientWidth },
      label: { left: lr.left, right: lr.right, width: lr.width },
      last: { left: hr.left, right: hr.right, width: hr.width },
      readable: hr.left >= lr.right - 1 && hr.right <= wr.right + 2,
      count: heads.length
    }
  })()`)
}

async function nutritionMetric(cdp) {
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.compare-row')].find(node => node.querySelector('.compare-row-label')?.textContent.trim() === '열량')
    if (!row) return false
    row.scrollIntoView({ block: 'center', inline: 'nearest' })
    return true
  })()`)
  await sleep(120)
  await scrollRight(cdp)
  return cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.compare-row')].find(node => node.querySelector('.compare-row-label')?.textContent.trim() === '열량')
    if (!row) return null
    const label = row.querySelector('.compare-row-label')
    const cells = row.querySelectorAll('.compare-cell')
    const cell = cells[cells.length - 1]
    const wrap = document.querySelector('.compare-table-wrap')
    const lr = label.getBoundingClientRect(), cr = cell.getBoundingClientRect(), wr = wrap.getBoundingClientRect()
    return {
      text: cell.textContent.trim().replace(/\\s+/g, ' '),
      label: [lr.left, lr.right, lr.width], cell: [cr.left, cr.right, cr.width], wrap: [wr.left, wr.right, wr.width],
      readable: cr.left >= lr.right - 1 && cr.right <= wr.right + 2,
      overflow: getComputedStyle(cell).overflow, textOverflow: getComputedStyle(cell).textOverflow
    }
  })()`)
}

const report = {
  deploySha: DEPLOY_SHA,
  pagesUrl: BASE,
  expectedAssets: { css: EXPECTED_CSS, js: EXPECTED_JS },
  environment: { viewport: '360x844', locale: 'ko-KR', kind: 'GitHub-hosted headless Chrome mobile emulation; not a physical device' },
  status: 'running', captures: []
}
const save = () => writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))

let browser
try {
  report.liveAssets = await waitForLiveAssets()
  browser = await launch()
  const { cdp } = browser
  report.chrome = browser.version
  const url = `${BASE}?view=workspace&applied=1&compare=${IDS.join(',')}&compareOpen=1&compareTab=overview`
  await cdp.nav(url)
  await cdp.wait(`document.querySelectorAll('.compare-product-head').length === 2`, 'two compare products')
  report.fonts = await cdp.fonts('.compare-product-copy>strong')
  assert.ok(report.fonts.some(item => item.familyName.includes('Noto Sans CJK KR')), 'Korean font mismatch')
  report.beforeDetailState = await state(cdp)
  assert.deepEqual(report.beforeDetailState?.compareIds, IDS, 'initial compare selection mismatch')

  await scrollRight(cdp)
  report.overview = await metrics(cdp)
  assert.equal(report.overview.count, 2)
  assert.ok(report.overview.documentWidth <= 361, `document horizontal overflow: ${JSON.stringify(report.overview)}`)
  assert.equal(report.overview.readable, true, `last product column still occluded: ${JSON.stringify(report.overview)}`)
  await cdp.shot('01-overview-right.png')
  report.captures.push('01-overview-right.png')

  await clickCompareTab(cdp, '영양')
  await cdp.wait(`!document.body.innerText.includes('영양 정보를 불러오는 중입니다.') && document.querySelector('.compare-row.is-metric')`, 'nutrition loaded')
  report.nutrition = await nutritionMetric(cdp)
  assert.ok(report.nutrition, 'energy row missing')
  assert.equal(report.nutrition.readable, true, `energy cell occluded: ${JSON.stringify(report.nutrition)}`)
  assert.match(report.nutrition.text, /\d[\d,]*\s*kcal\/kg/, `energy number/unit incomplete: ${report.nutrition.text}`)
  await cdp.shot('02-nutrition-energy-right.png')
  report.captures.push('02-nutrition-energy-right.png')

  await clickCompareTab(cdp, '개요')
  await cdp.wait(`document.querySelectorAll('.compare-product-head').length === 2`, 'overview restored')
  await scrollRight(cdp)
  report.detailPointer = await pointerClick(cdp, '.compare-detail-link', 1)
  await cdp.wait(`document.querySelector('.detail-stage')`, 'detail entered by pointer')
  await cdp.shot('03-detail-after-pointer.png')
  report.captures.push('03-detail-after-pointer.png')

  const backIndex = await cdp.eval(`[...document.querySelectorAll('.detail-topbar button')].findIndex(button => button.textContent.includes('돌아가기'))`)
  assert.ok(backIndex >= 0, 'detail return button missing')
  report.returnPointer = await pointerClick(cdp, '.detail-topbar button', backIndex)
  await cdp.wait(`document.querySelector('.compare-stage')`, 'compare return')
  await cdp.wait(`document.querySelectorAll('.compare-product-head').length === 2`, 'two products after detail return')
  report.afterDetailState = await state(cdp)
  assert.deepEqual(report.afterDetailState?.compareIds, IDS, 'compare selection changed after detail roundtrip')
  await scrollRight(cdp)
  report.afterReturn = await metrics(cdp)
  assert.equal(report.afterReturn.readable, true, 'last product not readable after detail return')
  await cdp.shot('04-compare-return.png')
  report.captures.push('04-compare-return.png')

  const sentAnalytics = cdp.requests.filter(request => request.url.includes('/functions/v1/decision-intake'))
  const sentWrites = cdp.requests.filter(request => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  report.network = {
    blocked: await cdp.eval(`({ analytics: window.__qaBlockedAnalytics || 0, writes: window.__qaBlockedWrites || 0 })`),
    sentAnalytics, sentWrites,
    publicReads: cdp.requests.filter(request => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && request.method === 'GET').length
  }
  assert.equal(sentAnalytics.length, 0, 'analytics request escaped pre-navigation blocker')
  assert.equal(sentWrites.length, 0, 'production write escaped blocker')
  report.status = 'pass'
  save()
  console.log('PR24_POSTDEPLOY_NARROW_PASS ' + JSON.stringify({
    deploySha: report.deploySha, chrome: report.chrome, overview: report.overview,
    nutrition: report.nutrition, detailPointer: report.detailPointer,
    compareIdsAfterReturn: report.afterDetailState.compareIds, network: report.network
  }))
} catch (error) {
  report.status = 'fail'
  report.error = String(error?.stack || error)
  save()
  throw error
} finally {
  if (browser) {
    browser.cdp.close()
    browser.proc.kill('SIGTERM')
    await sleep(150)
    if (browser.proc.exitCode == null) browser.proc.kill('SIGKILL')
    rmSync(browser.dir, { recursive: true, force: true })
  }
}
