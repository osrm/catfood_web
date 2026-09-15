import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE
const API = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
mkdirSync(OUT, { recursive: true })
assert.ok(BASE && API && KEY)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const q = (value) => JSON.stringify(value)
let launchNo = 0

async function api(view, params = {}) {
  const url = new URL(`${API.replace(/\/$/, '')}/rest/v1/${view}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  const response = await fetch(url, { headers: { apikey: KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view}: ${response.status}`)
  return response.json()
}

async function dataContext() {
  const products = await api('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name', order: 'brand.asc,canonical_name.asc', limit: 1000,
  })
  const current = products.find((product) => product.brand === 'AATU' && product.canonical_name === '연어')
  assert.ok(current, 'AATU 연어 current product missing')
  const variants = await api('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,display_rank', product_id: `eq.${current.product_id}`, order: 'display_rank.asc', limit: 100,
  })
  const sku = variants.find((variant) => /1\s*kg/i.test(variant.package_size_text ?? ''))
  assert.ok(sku, 'AATU 연어 1 kg variant missing')
  const candidates = products.filter((product) => product.product_id !== current.product_id).slice(0, 5)
  assert.equal(candidates.length, 5)
  return { current, sku, candidates }
}

const emptyCriteria = () => ({ feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false })
function switchFixture(ctx, compareTab = 'overview') {
  return {
    version: 1,
    state: {
      query: 'AATU 연어',
      currentProductId: ctx.current.product_id,
      variantSelection: { kind: 'variant', variantId: ctx.sku.variant_id },
      change: emptyCriteria(), keep: emptyCriteria(), changeBrand: false, keepBrand: false,
      ingredientAvoidTerms: [], noChangeIntent: true, step: 'results', visibleCandidateCount: 40,
      selectedCandidateId: null, compareIds: ctx.candidates.map((product) => product.product_id), compareOpen: true,
      compareTab, detailProductId: null, detailTab: 'overview',
    },
  }
}

class CDP {
  constructor(ws) { this.wsUrl = ws; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method })
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
    const id = this.id++
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
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'app root')
    await this.eval('document.fonts?.ready')
    await sleep(250)
  }
  async shot(name) {
    const capture = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(capture.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile, snapshot = null) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome))
  const port = 9900 + (process.pid % 100) + launchNo++ * 40
  const profile = `/tmp/pr37-scroll-${process.pid}-${launchNo}`
  rmSync(profile, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
      if (page) {
        const cdp = new CDP(page.webSocketDebuggerUrl)
        await cdp.connect()
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
          ${snapshot ? `sessionStorage.setItem(${q(STORAGE)},${q(JSON.stringify(snapshot))});` : ''}
          const originalFetch = window.fetch.bind(window)
          window.__blocked = { analytics: 0, writes: 0 }
          window.fetch = (input, init = {}) => {
            const url = typeof input === 'string' ? input : (input && input.url) || ''
            const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
            if (url.includes('/functions/v1/decision-intake')) {
              window.__blocked.analytics++
              return Promise.reject(new TypeError('blocked analytics'))
            }
            if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(method)) {
              window.__blocked.writes++
              return Promise.reject(new TypeError('blocked write'))
            }
            return originalFetch(input, init)
          }
        })();` })
        return { c: cdp, proc, profile }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function cleanup(handle) {
  handle.c.close()
  handle.proc.kill('SIGTERM')
  await sleep(120)
  if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL')
  try { rmSync(handle.profile, { recursive: true, force: true }) } catch {}
}

async function trustedClick(c, selector, text) {
  const point = await c.eval(`(() => {
    const node = [...document.querySelectorAll(${q(selector)})].find((candidate) => candidate.textContent?.includes(${q(text)}))
    if (!node) return null
    node.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = node.getBoundingClientRect()
    window.__trustedClick = null
    node.addEventListener('click', (event) => { window.__trustedClick = event.isTrusted }, { once: true, capture: true })
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, `missing click target ${selector}: ${text}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(160)
  assert.equal(await c.eval('window.__trustedClick'), true)
}

async function trustedHorizontalScrollToEnd(c, selector = '.compare-table-wrap') {
  const start = await c.eval(`(() => {
    const wrap = document.querySelector(${q(selector)})
    if (!wrap) return null
    const rect = wrap.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 320), scrollLeft: wrap.scrollLeft, max: wrap.scrollWidth - wrap.clientWidth }
  })()`)
  assert.ok(start, `missing scroll target ${selector}`)
  assert.ok(start.max > 0, `no horizontal overflow: ${JSON.stringify(start)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, pointerType: 'mouse' })
  for (let i = 0; i < 12; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: start.x, y: start.y, deltaX: Math.max(240, start.max), deltaY: 0, pointerType: 'mouse' })
    await sleep(80)
    const position = await c.eval(`(() => { const wrap=document.querySelector(${q(selector)}); return { scrollLeft: wrap.scrollLeft, max: wrap.scrollWidth-wrap.clientWidth } })()`)
    if (position.scrollLeft >= position.max - 1) break
  }
  await c.wait(`document.querySelector(${q(selector)}).scrollLeft > 0`, 'horizontal scroll > 0')
  await sleep(120)
}

async function measureMobileTable(c, label) {
  return c.eval(`(() => {
    const wrap = document.querySelector('.compare-table-wrap')
    const row = [...document.querySelectorAll('.compare-row')].find((candidate) => candidate.querySelector('.compare-row-label'))
    const rowLabel = row?.querySelector('.compare-row-label')
    const heads = [...document.querySelectorAll('.compare-head-row .compare-product-head')]
    const lastHead = heads.at(-1)
    const detail = lastHead?.querySelector('.compare-detail-link')
    if (!wrap || !rowLabel || !detail) return null
    const rect = (node) => { const r=node.getBoundingClientRect(); return { left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height } }
    const wr=rect(wrap), lr=rect(rowLabel), dr=rect(detail), hr=rect(lastHead)
    const hit=document.elementFromPoint(dr.left+dr.width/2,dr.top+dr.height/2)
    return {
      label: ${q(label)}, scrollLeft: wrap.scrollLeft, max: wrap.scrollWidth-wrap.clientWidth,
      cssScrollX: getComputedStyle(wrap).getPropertyValue('--compare-scroll-x').trim(),
      wrap: wr, rowLabel: lr, lastHead: hr, detail: dr,
      rowLabelText: rowLabel.textContent.trim(),
      hit: hit===detail || detail.contains(hit),
    }
  })()`)
}

function assertMobileGeometry(geometry) {
  assert.ok(geometry, 'mobile geometry missing')
  assert.ok(geometry.scrollLeft > 0, JSON.stringify(geometry))
  assert.equal(Math.round(geometry.scrollLeft), Math.round(geometry.max), JSON.stringify(geometry))
  assert.equal(Number.parseFloat(geometry.cssScrollX), geometry.scrollLeft, JSON.stringify(geometry))
  assert.ok(Math.abs(geometry.rowLabel.left - geometry.wrap.left) <= 1.5, JSON.stringify(geometry))
  assert.ok(geometry.rowLabel.right <= geometry.wrap.right + 1, JSON.stringify(geometry))
  assert.ok(geometry.detail.left >= geometry.wrap.left - 1 && geometry.detail.right <= geometry.wrap.right + 1, JSON.stringify(geometry))
  assert.equal(geometry.hit, true, JSON.stringify(geometry))
}

function verifyNoWrites(c) {
  const sentWrites = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(request.method))
  const sentAnalytics = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  return c.eval('window.__blocked').then((blocked) => {
    assert.equal(sentWrites.length, 0)
    assert.equal(sentAnalytics.length, 0)
    return { blocked, sentWrites: sentWrites.length, sentAnalytics: sentAnalytics.length }
  })
}

async function lookupMobile(ctx) {
  const handle = await launch(360, 844, true)
  const c = handle.c
  try {
    const ids = ctx.candidates.map((product) => product.product_id).join(',')
    await c.nav(`${BASE}?view=workspace&mode=lookup&compare=${encodeURIComponent(ids)}&compareOpen=1`)
    await c.wait(`document.querySelector('.compare-table-wrap') && document.querySelectorAll('.compare-head-row .compare-product-head').length===5`, 'LOOKUP compare')
    await trustedHorizontalScrollToEnd(c)
    const geometry = await measureMobileTable(c, 'lookup-overview')
    assertMobileGeometry(geometry)
    await c.shot('360x844-lookup-right-edge.png')
    return { geometry, network: await verifyNoWrites(c) }
  } finally { await cleanup(handle) }
}

async function switchMobileTabs(ctx) {
  const handle = await launch(360, 844, true, switchFixture(ctx, 'overview'))
  const c = handle.c
  try {
    await c.nav(`${BASE}?view=workspace&mode=switch`)
    await c.wait(`document.querySelector('.compare-tabs')`, 'SWITCH compare tabs')

    const results = {}
    for (const tab of ['영양', '원재료']) {
      await trustedClick(c, '.compare-tabs button', tab)
      await c.wait(`document.querySelector('.compare-table-wrap') && document.querySelectorAll('.compare-head-row .compare-product-head').length===5 && document.querySelector('.compare-row-label')`, `SWITCH ${tab}`)
      await trustedHorizontalScrollToEnd(c)
      const geometry = await measureMobileTable(c, `switch-${tab}`)
      assertMobileGeometry(geometry)
      await c.shot(`360x844-switch-${tab === '영양' ? 'nutrition' : 'ingredients'}-right-edge.png`)
      results[tab] = geometry
    }
    return { ...results, network: await verifyNoWrites(c) }
  } finally { await cleanup(handle) }
}

async function switchOverview761(ctx) {
  const handle = await launch(761, 900, false, switchFixture(ctx, 'overview'))
  const c = handle.c
  try {
    await c.nav(`${BASE}?view=workspace&mode=switch`)
    await c.wait(`document.querySelector('.compare-switch-overview-desktop') && getComputedStyle(document.querySelector('.compare-switch-overview-desktop')).display!=='none'`, '761 desktop overview')
    await trustedHorizontalScrollToEnd(c)
    const geometry = await c.eval(`(() => {
      const wrap=document.querySelector('.compare-table-wrap')
      const row=[...document.querySelectorAll('.compare-switch-overview-row')].find((candidate)=>candidate.querySelector('.compare-row-label')?.textContent.trim()==='사료 형태')
      const label=row?.querySelector('.compare-row-label')
      const current=row?.querySelector('.compare-cell.is-current')
      const last=[...row?.querySelectorAll('.compare-cell:not(.is-current)') ?? []].at(-1)
      const heads=[...document.querySelectorAll('.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head)')]
      const lastHead=heads.at(-1)
      const detail=lastHead?.querySelector('.compare-detail-link')
      if(!wrap||!label||!current||!last||!detail)return null
      const rect=(node)=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
      const wr=rect(wrap),lr=rect(label),cr=rect(current),vr=rect(last),dr=rect(detail)
      const hit=document.elementFromPoint(dr.left+dr.width/2,dr.top+dr.height/2)
      return{scrollLeft:wrap.scrollLeft,max:wrap.scrollWidth-wrap.clientWidth,wrap:wr,label:lr,current:cr,last:vr,detail:dr,hit:hit===detail||detail.contains(hit),texts:{label:label.textContent.trim(),current:current.textContent.trim(),last:last.textContent.trim()}}
    })()`)
    assert.ok(geometry, '761 geometry missing')
    assert.ok(geometry.scrollLeft > 0, JSON.stringify(geometry))
    assert.equal(Math.round(geometry.scrollLeft), Math.round(geometry.max), JSON.stringify(geometry))
    assert.ok(geometry.label.left >= geometry.wrap.left - 1 && geometry.label.right <= geometry.wrap.right + 1, JSON.stringify(geometry))
    assert.ok(geometry.current.left >= geometry.label.right - 1 && geometry.current.right <= geometry.wrap.right + 1, JSON.stringify(geometry))
    assert.ok(geometry.last.left >= geometry.current.right - 1 && geometry.last.right <= geometry.wrap.right + 1, JSON.stringify(geometry))
    assert.equal(geometry.hit, true, JSON.stringify(geometry))
    await c.shot('761x900-switch-overview-right-edge.png')
    return { geometry, network: await verifyNoWrites(c) }
  } finally { await cleanup(handle) }
}

const ctx = await dataContext()
const report = {
  productSha: process.env.PRODUCT_SHA,
  browserVersion: execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim(),
  koreanFont: execFileSync('fc-match', [':lang=ko'], { encoding: 'utf8' }).trim().split('\n')[0],
  status: 'running',
}
try {
  report.lookupMobile = await lookupMobile(ctx)
  report.switchMobileTabs = await switchMobileTabs(ctx)
  report.switchOverview761 = await switchOverview761(ctx)
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR37_SCROLL_SYNC_QA PASS', JSON.stringify({
    lookup: report.lookupMobile.geometry,
    nutrition: report.switchMobileTabs['영양'],
    ingredients: report.switchMobileTabs['원재료'],
    desktop761: report.switchOverview761.geometry,
  }))
} catch (error) {
  report.status = 'fail'
  report.error = String(error?.stack ?? error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}
