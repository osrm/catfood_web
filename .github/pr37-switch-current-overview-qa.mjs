import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA ?? 'unknown'
const QA_SHA = process.env.GITHUB_SHA ?? 'unknown'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const STORAGE_KEY = 'catfood.switch-session.v1'
const OUT = 'qa-artifacts'
mkdirSync(OUT, { recursive: true })
assert.ok(SUPABASE_URL && SUPABASE_KEY, 'public Supabase read config missing')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
let launchIndex = 0

async function apiRows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view} read failed: ${response.status}`)
  return response.json()
}

async function makeContext() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,manufacturing_country_codes,variant_count',
    order: 'brand.asc,canonical_name.asc',
    limit: 1000,
  })
  const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어')
  assert.ok(current, 'AATU 연어 current food not found')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,units_per_sale,display_rank',
    product_id: `eq.${current.product_id}`,
    order: 'display_rank.asc,variant_id.asc',
    limit: 100,
  })
  const sku = variants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? ''))
  assert.ok(sku, 'AATU 연어 1 kg SKU not found')

  const eligible = products.filter((row) => row.product_id !== current.product_id)
  const longest = [...eligible].sort((a, b) => b.canonical_name.length - a.canonical_name.length)[0]
  const unknown = eligible.find((row) => !row.feed_type || !row.life_stage || !(row.manufacturing_country_codes?.length))
  assert.ok(longest && unknown, 'long/unknown candidates not found')
  const selected = []
  for (const product of [longest, unknown, ...eligible]) {
    if (!selected.some((row) => row.product_id === product.product_id)) selected.push(product)
    if (selected.length === 5) break
  }
  assert.equal(selected.length, 5, 'five candidates required')
  return { current, sku, five: selected, longId: longest.product_id, unknownId: unknown.product_id }
}

function emptyCriteria() {
  return { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false }
}
function snapshot(ctx, compareIds) {
  return {
    version: 1,
    state: {
      query: `${ctx.current.brand} ${ctx.current.canonical_name}`,
      currentProductId: ctx.current.product_id,
      variantSelection: { kind: 'variant', variantId: ctx.sku.variant_id },
      change: emptyCriteria(), keep: emptyCriteria(), changeBrand: false, keepBrand: false,
      ingredientAvoidTerms: [], noChangeIntent: true, step: 'results', visibleCandidateCount: 40,
      selectedCandidateId: null, compareIds, compareOpen: true, compareTab: 'overview',
      detailProductId: null, detailTab: 'overview',
    },
  }
}

class Browser {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(domain)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await this.eval(`Boolean(${expression})`)) return } catch {} await sleep(120) } throw new Error(`timeout: ${label}`) }
  async navigate(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState === 'complete'`, 'document ready'); await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'app root'); await this.eval('document.fonts?.ready'); await sleep(350) }
  async shot(path) { await this.eval('document.fonts?.ready'); await sleep(120); const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(path, Buffer.from(image.data, 'base64')) }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile, sessionSnapshot) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9800 + (process.pid % 80) + launchIndex++ * 100
  const dir = `/tmp/pr37-compare-${process.pid}-${launchIndex}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const browser = new Browser(page.webSocketDebuggerUrl)
        await browser.connect()
        await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await browser.send('Emulation.setUserAgentOverride', { userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: mobile ? 'Android' : 'Linux' })
        await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
          try { sessionStorage.setItem(${js(STORAGE_KEY)}, ${js(JSON.stringify(sessionSnapshot))}) } catch {}
          const nativeFetch = window.fetch.bind(window)
          window.__qaBlockedAnalytics = 0; window.__qaBlockedWrites = 0
          window.fetch = (input, init = {}) => {
            const url = typeof input === 'string' ? input : (input && input.url) || ''
            const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
            if (url.includes('/functions/v1/decision-intake')) { window.__qaBlockedAnalytics += 1; return Promise.reject(new TypeError('QA blocked analytics before send')) }
            if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(method)) { window.__qaBlockedWrites += 1; return Promise.reject(new TypeError('QA blocked production write before send')) }
            return nativeFetch(input, init)
          }
        })();` })
        return { browser, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function cleanup(proc, dir, browser) {
  browser.close(); proc.kill('SIGTERM'); await sleep(200); if (proc.exitCode == null) proc.kill('SIGKILL'); try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
async function waitCompare(browser, mobile = false) {
  await browser.navigate(`${BASE}?view=workspace&mode=switch`)
  await browser.wait(`document.querySelector('.compare-stage')`, 'compare stage')
  if (mobile) await browser.wait(`getComputedStyle(document.querySelector('.compare-switch-mobile-overview')).display !== 'none'`, 'mobile overview')
  else await browser.wait(`document.querySelector('.compare-current-product-head')`, 'desktop current baseline')
}
async function sessionState(browser) { return browser.eval(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`) }
async function pointerClick(browser, selector, containsText = null) {
  const target = await browser.eval(`(() => { const nodes=[...document.querySelectorAll(${js(selector)})]; const n=${containsText ? `nodes.find((el)=>el.textContent.includes(${js(containsText)}))` : 'nodes[0]'}; if(!n)return null; n.scrollIntoView({block:'center',inline:'center'}); const r=n.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,text:n.textContent.trim(),tag:n.tagName,className:n.className} })()`)
  assert.ok(target, `pointer target missing: ${selector} ${containsText ?? ''}`)
  await browser.eval(`window.__qaPointerEvents=[]; (()=>{const nodes=[...document.querySelectorAll(${js(selector)})];const n=${containsText ? `nodes.find((el)=>el.textContent.includes(${js(containsText)}))` : 'nodes[0]'}; if(!n)return; for(const type of ['pointerdown','pointerup','click']) n.addEventListener(type,(event)=>window.__qaPointerEvents.push({type,isTrusted:event.isTrusted}),true)})()`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none', buttons: 0, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(220)
  const events = await browser.eval('window.__qaPointerEvents')
  assert.ok(events?.some((event) => event.type === 'pointerdown' && event.isTrusted), 'trusted pointerdown missing')
  assert.ok(events?.some((event) => event.type === 'pointerup' && event.isTrusted), 'trusted pointerup missing')
  assert.ok(events?.some((event) => event.type === 'click' && event.isTrusted), 'trusted click missing')
  return { target, events }
}
async function browserBack(browser) {
  const before = await browser.eval('location.href')
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 1 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, modifiers: 1 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, modifiers: 1 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 })
  for (let i = 0; i < 60; i += 1) { if (await browser.eval(`location.href !== ${js(before)}`)) return 'Alt+Left'; await sleep(100) }
  const history = await browser.send('Page.getNavigationHistory')
  const index = history.currentIndex - 1
  assert.ok(index >= 0, 'browser history has no previous entry')
  await browser.send('Page.navigateToHistoryEntry', { entryId: history.entries[index].id })
  await sleep(350)
  return 'Page.navigateToHistoryEntry'
}
async function tabTo(browser, expression, label, max = 80) {
  for (let i = 1; i <= max; i += 1) {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await sleep(45)
    if (await browser.eval(expression)) {
      const focus = await browser.eval(`(() => { const n=document.activeElement,s=getComputedStyle(n); return {tag:n.tagName,text:n.textContent.trim(),className:n.className,focusVisible:n.matches(':focus-visible'),outline:s.outline,outlineWidth:s.outlineWidth,outlineStyle:s.outlineStyle} })()`)
      assert.equal(focus.focusVisible, true, `${label}: focus-visible false`)
      assert.notEqual(focus.outlineStyle, 'none', `${label}: no outline`)
      return { tabs: i, focus }
    }
  }
  throw new Error(`Tab did not reach ${label}`)
}
async function networkReport(browser, currentId) {
  const compareRequests = browser.requests.filter((r) => r.url.includes('/compare_product_nutrition') || r.url.includes('/compare_product_ingredients'))
  const sentAnalytics = browser.requests.filter((r) => r.url.includes('/functions/v1/decision-intake'))
  const sentWrites = browser.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method))
  for (const request of compareRequests) {
    const filter = new URL(request.url).searchParams.get('product_id') ?? ''
    assert.equal(filter.includes(currentId), false, `current food leaked into compare request: ${filter}`)
  }
  const blocked = await browser.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`)
  assert.equal(sentAnalytics.length, 0, 'analytics request was sent')
  assert.equal(sentWrites.length, 0, 'write request was sent')
  return { compareRequests: compareRequests.map((r) => ({ path: new URL(r.url).pathname, filter: new URL(r.url).searchParams.get('product_id') })), sentAnalytics: sentAnalytics.length, sentWrites: sentWrites.length, blocked, publicGets: browser.requests.filter((r) => r.method === 'GET').length }
}
function assertSessionStable(before, after, expectedIds) {
  assert.deepEqual(after.compareIds, expectedIds)
  assert.equal(after.currentProductId, before.currentProductId)
  assert.deepEqual(after.variantSelection, before.variantSelection)
  assert.deepEqual(after.change, before.change)
  assert.deepEqual(after.keep, before.keep)
  assert.equal(after.compareTab, 'overview')
}
async function mobileGeometry(browser) {
  return browser.eval(`(() => {
    const rect=(n)=>{const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    const rows=[...document.querySelectorAll('.compare-mobile-overview-row')].map((row)=>{const cells=[...row.querySelectorAll('.compare-mobile-pair > div')];return{label:row.querySelector('.compare-mobile-row-label')?.textContent.trim(),cells:cells.map(rect),sameTop:cells.length===2?Math.abs(cells[0].getBoundingClientRect().top-cells[1].getBoundingClientRect().top):null,sameBottom:cells.length===2?Math.abs(cells[0].getBoundingClientRect().bottom-cells[1].getBoundingClientRect().bottom):null}})
    const candidate=document.querySelector('.compare-mobile-product-head.is-candidate > strong');const s=candidate?getComputedStyle(candidate):null;
    return {viewport:[innerWidth,innerHeight],rows,candidateName:candidate?.textContent.trim()??null,candidateRect:candidate?rect(candidate):null,candidateClient:candidate?[candidate.clientWidth,candidate.clientHeight]:null,candidateScroll:candidate?[candidate.scrollWidth,candidate.scrollHeight]:null,candidateOverflow:s?.overflow??null,candidateTextOverflow:s?.textOverflow??null,candidateLineClamp:s?.webkitLineClamp??null,pickerCount:document.querySelectorAll('.compare-mobile-candidate-picker button').length}
  })()`)
}
async function desktopGeometry(browser) {
  return browser.eval(`(() => {
    const wrap=document.querySelector('.compare-table-wrap'),table=document.querySelector('.compare-switch-overview-desktop');
    const heads=[...table.querySelectorAll('.compare-head-row > .compare-product-head')].map((head)=>({role:head.querySelector('.compare-column-role')?.textContent.trim(),brand:head.querySelector('.compare-product-copy > span')?.textContent.trim(),name:head.querySelector('.compare-product-copy > strong')?.textContent.trim(),remove:Boolean(head.querySelector('.compare-remove'))}));
    const current=table.querySelector('.compare-current-product-head .compare-product-copy > strong'),s=getComputedStyle(current);
    return {viewport:[innerWidth,innerHeight],wrap:{clientWidth:wrap.clientWidth,scrollWidth:wrap.scrollWidth,scrollLeft:wrap.scrollLeft},tableWidth:table.getBoundingClientRect().width,heads,currentName:{text:current.textContent.trim(),client:[current.clientWidth,current.clientHeight],scroll:[current.scrollWidth,current.scrollHeight],overflow:s.overflow,textOverflow:s.textOverflow,lineClamp:s.webkitLineClamp}};
  })()`)
}

async function scenario360Two(ctx) {
  const ids = ctx.five.slice(0, 2).map((row) => row.product_id)
  const { browser, proc, dir } = await launch(360, 844, true, snapshot(ctx, ids))
  const result = { ids }
  try {
    await waitCompare(browser, true)
    const before = await sessionState(browser)
    result.initial = await mobileGeometry(browser)
    assert.equal(result.initial.pickerCount, 2)
    assert.match(await browser.eval(`document.querySelector('.compare-mobile-product-head.is-current').textContent`), /AATU.*연어.*사용 규격.*1 kg/s)
    result.switchPointer = await pointerClick(browser, '.compare-mobile-candidate-picker button', '2.')
    await browser.wait(`document.querySelector('.compare-mobile-candidate-picker button:nth-child(2)').getAttribute('aria-pressed')==='true'`, 'candidate 2 selected')
    result.afterSwitch = await mobileGeometry(browser)
    assert.equal(result.afterSwitch.candidateName, ctx.five[1].canonical_name)
    assertSessionStable(before, await sessionState(browser), ids)

    result.detailPointer = await pointerClick(browser, '.compare-mobile-head-actions button', '상세 보기')
    await browser.wait(`document.querySelector('.detail-stage')`, 'candidate detail')
    result.backMethod = await browserBack(browser)
    await browser.wait(`document.querySelector('.compare-stage') && !document.querySelector('.detail-stage')`, 'back to compare')
    assert.equal((await mobileGeometry(browser)).candidateName, ctx.five[1].canonical_name, 'displayed candidate not preserved after detail roundtrip')

    result.removePointer = await pointerClick(browser, '.compare-mobile-head-actions button', '비교에서 제거')
    await browser.wait(`document.querySelectorAll('.compare-mobile-candidate-picker button').length===1`, 'candidate removed')
    const afterRemove = await sessionState(browser)
    assert.deepEqual(afterRemove.compareIds, [ids[0]])
    assert.equal((await mobileGeometry(browser)).candidateName, ctx.five[0].canonical_name)

    result.removeBackMethod = await browserBack(browser)
    await browser.wait(`document.querySelector('.switch-results-stage') && !document.querySelector('.compare-stage')`, 'back to results after removal')
    const afterBack = await sessionState(browser)
    assert.deepEqual(afterBack.compareIds, [ids[0]], 'removed candidate returned after browser back')
    result.network = await networkReport(browser, ctx.current.product_id)
  } finally { await cleanup(proc, dir, browser) }
  return result
}

async function scenario360One(ctx) {
  const ids = [ctx.five[0].product_id]
  const { browser, proc, dir } = await launch(360, 844, true, snapshot(ctx, ids))
  const result = { ids }
  try {
    await waitCompare(browser, true)
    result.capture = '360x844-current-plus-one.png'
    await browser.shot(`${OUT}/${result.capture}`)
    result.geometry = await mobileGeometry(browser)
    assert.equal(result.geometry.pickerCount, 1)
    result.removePointer = await pointerClick(browser, '.compare-mobile-head-actions button', '비교에서 제거')
    await browser.wait(`document.querySelector('.switch-results-stage') && !document.querySelector('.compare-stage')`, 'last removal closes compare')
    assert.deepEqual((await sessionState(browser)).compareIds, [])
    result.network = await networkReport(browser, ctx.current.product_id)
  } finally { await cleanup(proc, dir, browser) }
  return result
}

async function scenario390Five(ctx) {
  const ids = ctx.five.map((row) => row.product_id)
  const { browser, proc, dir } = await launch(390, 900, true, snapshot(ctx, ids))
  const result = { ids, selected: [] }
  try {
    await waitCompare(browser, true)
    assert.equal(document, document)
    for (let i = 0; i < 5; i += 1) {
      await pointerClick(browser, `.compare-mobile-candidate-picker button:nth-child(${i + 1})`)
      await browser.wait(`document.querySelector('.compare-mobile-candidate-picker button:nth-child(${i + 1})').getAttribute('aria-pressed')==='true'`, `candidate ${i + 1}`)
      result.selected.push((await mobileGeometry(browser)).candidateName)
    }
    assert.deepEqual(result.selected, ctx.five.map((row) => row.canonical_name))
    const longIndex = ctx.five.findIndex((row) => row.product_id === ctx.longId)
    if (longIndex >= 0) await pointerClick(browser, `.compare-mobile-candidate-picker button:nth-child(${longIndex + 1})`)
    const unknownIndex = ctx.five.findIndex((row) => row.product_id === ctx.unknownId)
    if (unknownIndex >= 0 && longIndex < 0) await pointerClick(browser, `.compare-mobile-candidate-picker button:nth-child(${unknownIndex + 1})`)
    result.geometry = await mobileGeometry(browser)
    assert.ok(result.geometry.candidateScroll[0] <= result.geometry.candidateClient[0] + 1, 'long candidate horizontally clipped')
    assert.ok(result.geometry.candidateScroll[1] <= result.geometry.candidateClient[1] + 1, 'long candidate vertically clipped')
    assert.notEqual(result.geometry.candidateTextOverflow, 'ellipsis')
    assert.ok(!result.geometry.candidateLineClamp || result.geometry.candidateLineClamp === 'none')
    for (const row of result.geometry.rows) { assert.ok(row.sameTop <= 1, `${row.label}: values start on different rows`); assert.ok(row.sameBottom <= 1, `${row.label}: values end on different rows`) }
    result.focusPicker = await tabTo(browser, `document.activeElement?.matches('.compare-mobile-candidate-picker button')`, 'candidate picker')
    result.focusDetail = await tabTo(browser, `document.activeElement?.closest('.compare-mobile-head-actions') && document.activeElement.textContent.includes('상세 보기')`, 'detail button')
    result.focusRemove = await tabTo(browser, `document.activeElement?.closest('.compare-mobile-head-actions') && document.activeElement.textContent.includes('비교에서 제거')`, 'remove button')
    result.capture = '390x900-five-long-focus.png'
    await browser.shot(`${OUT}/${result.capture}`)
    const unknownButtonIndex = unknownIndex + 1
    if (unknownIndex >= 0) {
      await pointerClick(browser, `.compare-mobile-candidate-picker button:nth-child(${unknownButtonIndex})`)
      result.unknownVisible = await browser.eval(`document.querySelector('.compare-switch-mobile-overview').textContent.includes('미확인')`)
      assert.equal(result.unknownVisible, true, 'unknown candidate does not expose 미확인')
    }
    result.network = await networkReport(browser, ctx.current.product_id)
  } finally { await cleanup(proc, dir, browser) }
  return result
}

async function scenarioBoundary(ctx, width, height) {
  const ids = ctx.five.map((row) => row.product_id)
  const mobile = width <= 760
  const { browser, proc, dir } = await launch(width, height, mobile, snapshot(ctx, ids))
  const result = { width, ids }
  try {
    await waitCompare(browser, mobile)
    if (mobile) {
      result.mobile = await mobileGeometry(browser)
      assert.equal(result.mobile.pickerCount, 5)
      for (const row of result.mobile.rows) { assert.ok(row.sameTop <= 1 && row.sameBottom <= 1, `${width}px ${row.label}: row misalignment`) }
    } else {
      result.desktop = await desktopGeometry(browser)
      assert.equal(result.desktop.heads.length, 6)
      assert.equal(result.desktop.heads[0].role, '현재 사료 · 기준')
      assert.equal(result.desktop.heads[0].remove, false)
      assert.equal(result.desktop.heads.slice(1).every((head) => head.role === '후보' && head.remove), true)
      const maxScroll = await browser.eval(`(()=>{const w=document.querySelector('.compare-table-wrap');w.scrollLeft=w.scrollWidth-w.clientWidth;return{left:w.scrollLeft,max:w.scrollWidth-w.clientWidth}})()`)
      assert.ok(maxScroll.left >= maxScroll.max - 2, `${width}px last candidate not horizontally accessible`)
      result.maxScroll = maxScroll
    }
    result.capture = `${width}x${height}-boundary.png`
    await browser.shot(`${OUT}/${result.capture}`)
    result.network = await networkReport(browser, ctx.current.product_id)
  } finally { await cleanup(proc, dir, browser) }
  return result
}

const ctx = await makeContext()
const report = { productSha: PRODUCT_SHA, qaSha: QA_SHA, chrome: execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim(), context: ctx }
try {
  report.mobile360Two = await scenario360Two(ctx)
  report.mobile360One = await scenario360One(ctx)
  report.mobile390Five = await scenario390Five(ctx)
  report.boundary760 = await scenarioBoundary(ctx, 760, 900)
  report.boundary761 = await scenarioBoundary(ctx, 761, 900)
  report.desktop1280 = await scenarioBoundary(ctx, 1280, 900)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR37_SWITCH_OVERVIEW_QA PASS')
} catch (error) {
  report.error = String(error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}
