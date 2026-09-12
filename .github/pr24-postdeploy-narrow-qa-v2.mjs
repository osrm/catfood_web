import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const DEPLOY_SHA = process.env.DEPLOY_SHA
const EXPECTED_CSS = process.env.EXPECTED_CSS
const EXPECTED_JS = process.env.EXPECTED_JS
const IDS = ['product_b47d3ae674773585', 'product_99c5ee4eb9211a75']
const OUT = 'qa-artifacts'
mkdirSync(OUT, { recursive: true })
assert.ok(DEPLOY_SHA && EXPECTED_CSS && EXPECTED_JS)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const q = value => JSON.stringify(value)

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })
    this.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data)
      if (m.method === 'Network.requestWillBeSent') this.requests.push({ url: m.params.request.url, method: m.params.request.method })
      const p = m.id ? this.pending.get(m.id) : null
      if (!p) return
      this.pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
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
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const x = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text)
    return x.result?.value
  }
  async wait(expression, label, ms = 40000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, 'ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'root')
    await this.eval('document.fonts?.ready')
    await sleep(250)
  }
  async shot(name) {
    const x = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(x.data, 'base64'))
  }
  async fonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId)
    return (await this.send('CSS.getPlatformFontsForNode', { nodeId })).fonts ?? []
  }
  close() { try { this.ws?.close() } catch {} }
}

async function waitForAssets() {
  for (let i = 0; i < 30; i++) {
    const response = await fetch(`${BASE}?postdeploy=${Date.now()}`, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } })
    const html = await response.text()
    if (response.ok && html.includes(EXPECTED_CSS) && html.includes(EXPECTED_JS)) return { status: response.status, css: EXPECTED_CSS, js: EXPECTED_JS }
    await sleep(1000)
  }
  throw new Error('expected deployed assets not visible')
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome))
  const port = 9850 + (process.pid % 100), dir = `/tmp/pr24-postdeploy-v2-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find(x => x.type === 'page' && x.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844 })
        await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' })
        return { c, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}

async function scrollRight(c) {
  await c.eval(`(() => { const w = document.querySelector('.compare-table-wrap'); w.scrollLeft = w.scrollWidth - w.clientWidth })()`)
  await sleep(140)
}

async function selection(c) {
  return c.eval(`(() => ({
    names: [...document.querySelectorAll('.compare-product-copy > strong')].map(n => n.textContent.trim()),
    compareParam: new URL(location.href).searchParams.get('compare'),
    headCount: document.querySelectorAll('.compare-product-head').length
  }))()`)
}

async function layout(c) {
  return c.eval(`(() => {
    const w = document.querySelector('.compare-table-wrap'), label = document.querySelector('.compare-corner'), last = [...document.querySelectorAll('.compare-product-head')].at(-1)
    const wr = w.getBoundingClientRect(), lr = label.getBoundingClientRect(), hr = last.getBoundingClientRect()
    return { documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, scrollLeft: w.scrollLeft, maxScroll: w.scrollWidth - w.clientWidth, wrap: [wr.left, wr.right, wr.width], label: [lr.left, lr.right, lr.width], last: [hr.left, hr.right, hr.width], readable: hr.left >= lr.right - 1 && hr.right <= wr.right + 2 }
  })()`)
}

async function pointer(c, selector, index) {
  const prepared = await c.eval(`(() => { const n = document.querySelectorAll(${q(selector)})[${index}]; if (!n) return false; n.scrollIntoView({ block: 'center', inline: 'nearest' }); return true })()`)
  assert.equal(prepared, true)
  if (selector.includes('compare-detail')) await scrollRight(c)
  const info = await c.eval(`(() => { const n = document.querySelectorAll(${q(selector)})[${index}]; const r = n.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return { text: n.textContent.trim(), rect: [r.left, r.top, r.width, r.height], x, y, centerHit: hit === n || n.contains(hit), hit: hit?.className || hit?.tagName } })()`)
  assert.equal(info.centerHit, true, `occluded pointer: ${JSON.stringify(info)}`)
  assert.ok(info.x >= 0 && info.x < 360 && info.y >= 0 && info.y < 844)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  await sleep(220)
  return info
}

async function tab(c, text) {
  const index = await c.eval(`[...document.querySelectorAll('.compare-tabs button')].findIndex(b => b.textContent.trim() === ${q(text)})`)
  assert.ok(index >= 0)
  return pointer(c, '.compare-tabs button', index)
}

async function energy(c) {
  const exists = await c.eval(`(() => { const row = [...document.querySelectorAll('.compare-row')].find(r => r.querySelector('.compare-row-label')?.textContent.trim() === '열량'); if (!row) return false; row.scrollIntoView({ block: 'center', inline: 'nearest' }); return true })()`)
  assert.equal(exists, true)
  await sleep(120)
  await scrollRight(c)
  return c.eval(`(() => {
    const row = [...document.querySelectorAll('.compare-row')].find(r => r.querySelector('.compare-row-label')?.textContent.trim() === '열량'), label = row.querySelector('.compare-row-label'), cells = row.querySelectorAll('.compare-cell'), cell = cells[cells.length - 1], wrap = document.querySelector('.compare-table-wrap')
    const lr = label.getBoundingClientRect(), cr = cell.getBoundingClientRect(), wr = wrap.getBoundingClientRect()
    return { text: cell.textContent.trim().replace(/\\s+/g, ' '), label: [lr.left, lr.right, lr.width], cell: [cr.left, cr.right, cr.width], wrap: [wr.left, wr.right, wr.width], readable: cr.left >= lr.right - 1 && cr.right <= wr.right + 2 }
  })()`)
}

const report = { deploySha: DEPLOY_SHA, pagesUrl: BASE, expectedAssets: { css: EXPECTED_CSS, js: EXPECTED_JS }, environment: { viewport: '360x844', locale: 'ko-KR', kind: 'GitHub-hosted headless Chrome mobile emulation; not a physical device' }, status: 'running', captures: [] }
const save = () => writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
let browser
try {
  report.liveAssets = await waitForAssets()
  browser = await launch()
  const { c } = browser
  report.chrome = browser.version
  await c.nav(`${BASE}?view=workspace&applied=1&compare=${IDS.join(',')}&compareOpen=1&compareTab=overview`)
  await c.wait(`document.querySelectorAll('.compare-product-head').length === 2`, 'two products')
  report.fonts = await c.fonts('.compare-product-copy > strong')
  assert.ok(report.fonts.some(f => f.familyName.includes('Noto Sans CJK KR')), 'Korean font mismatch')
  report.beforeSelection = await selection(c)
  assert.equal(report.beforeSelection.headCount, 2)
  assert.equal(report.beforeSelection.compareParam, IDS.join(','))

  await scrollRight(c)
  report.overview = await layout(c)
  assert.ok(report.overview.documentWidth <= 361)
  assert.equal(report.overview.readable, true, `last column occluded: ${JSON.stringify(report.overview)}`)
  await c.shot('01-overview-right.png'); report.captures.push('01-overview-right.png')

  await tab(c, '영양')
  await c.wait(`!document.body.innerText.includes('영양 정보를 불러오는 중입니다.') && document.querySelector('.compare-row.is-metric')`, 'nutrition loaded')
  report.energy = await energy(c)
  assert.equal(report.energy.readable, true, `energy occluded: ${JSON.stringify(report.energy)}`)
  assert.match(report.energy.text, /\d[\d,]*\s*kcal\/kg/, `energy value incomplete: ${report.energy.text}`)
  await c.shot('02-energy-right.png'); report.captures.push('02-energy-right.png')

  await tab(c, '개요')
  await c.wait(`document.querySelectorAll('.compare-product-head').length === 2`, 'overview return')
  report.detailPointer = await pointer(c, '.compare-detail-link', 1)
  await c.wait(`document.querySelector('.detail-stage')`, 'detail pointer entry')
  await c.shot('03-detail-pointer.png'); report.captures.push('03-detail-pointer.png')

  const backIndex = await c.eval(`[...document.querySelectorAll('.detail-topbar button')].findIndex(b => b.textContent.includes('돌아가기'))`)
  assert.ok(backIndex >= 0)
  report.returnPointer = await pointer(c, '.detail-topbar button', backIndex)
  await c.wait(`document.querySelector('.compare-stage') && document.querySelectorAll('.compare-product-head').length === 2`, 'compare restored')
  report.afterSelection = await selection(c)
  assert.deepEqual(report.afterSelection.names, report.beforeSelection.names, 'product names changed after detail roundtrip')
  assert.equal(report.afterSelection.compareParam, report.beforeSelection.compareParam, 'compare URL state changed after detail roundtrip')
  await scrollRight(c)
  report.afterReturn = await layout(c)
  assert.equal(report.afterReturn.readable, true)
  await c.shot('04-compare-return.png'); report.captures.push('04-compare-return.png')

  const sentAnalytics = c.requests.filter(r => r.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter(r => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(r.method))
  report.network = { blocked: await c.eval(`({ analytics: window.__qaBlockedAnalytics || 0, writes: window.__qaBlockedWrites || 0 })`), sentAnalytics, sentWrites, publicReads: c.requests.filter(r => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && r.method === 'GET').length }
  assert.equal(sentAnalytics.length, 0)
  assert.equal(sentWrites.length, 0)
  report.status = 'pass'
  save()
  console.log('PR24_POSTDEPLOY_NARROW_PASS ' + JSON.stringify({ deploySha: report.deploySha, chrome: report.chrome, beforeSelection: report.beforeSelection, overview: report.overview, energy: report.energy, detailPointer: report.detailPointer, afterSelection: report.afterSelection, network: report.network }))
} catch (error) {
  report.status = 'fail'; report.error = String(error?.stack || error); save(); throw error
} finally {
  if (browser) { browser.c.close(); browser.proc.kill('SIGTERM'); await sleep(150); if (browser.proc.exitCode == null) browser.proc.kill('SIGKILL'); rmSync(browser.dir, { recursive: true, force: true }) }
}
