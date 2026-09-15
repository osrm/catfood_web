import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/catfood_web/'
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
const BASELINE_SCROLL = 1103
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const q = JSON.stringify
let launchNo = 0

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
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
    for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(domain)
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
      await sleep(80)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length`, 'root content')
    await this.eval('document.fonts?.ready')
    await sleep(160)
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height = 844, mobile = width <= 760) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome is required')
  const port = 12200 + (process.pid % 100) + launchNo++ * 40
  const dir = `/tmp/pr39-change-${process.pid}-${launchNo}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const c = new CDP(page.webSocketDebuggerUrl)
      await c.connect()
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const original=window.fetch.bind(window);window.__qaBlocked={analytics:0,writes:0};window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}return original(input,init)}})();` })
      return { c, proc, dir, width, height }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}

async function cleanup(handle) {
  handle.c.close()
  handle.proc.kill('SIGTERM')
  await sleep(80)
  if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL')
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(handle.dir, { recursive: true, force: true }); return } catch { await sleep(80) }
  }
}

async function click(c, selector, index = 0, contains = []) {
  const point = await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${q(selector)})].filter(n=>${q(contains)}.every(t=>n.textContent?.includes(t)));const n=nodes[${index}];if(!n)return null;const r=n.getBoundingClientRect();const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth)return{offscreen:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},text:n.textContent.trim()};window.__qaTrustedClick=null;n.addEventListener('click',e=>window.__qaTrustedClick=e.isTrusted,{once:true,capture:true});return{x:Math.max(2,Math.min(innerWidth-2,r.left+r.width/2)),y:Math.max(2,Math.min(innerHeight-2,r.top+r.height/2)),text:n.textContent.trim()}})()`)
  assert.ok(point, `missing ${selector} ${contains.join('+')} [${index}]`)
  assert.ok(!point.offscreen, `offscreen ${selector}: ${JSON.stringify(point)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(80)
  assert.equal(await c.eval('window.__qaTrustedClick'), true, `untrusted click: ${selector}`)
}

async function typeText(c, selector, text) {
  await click(c, selector)
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector(${q(selector)})?.value===${q(text)}`, 'typed input')
}

async function wheel(c, deltaY) {
  const x = await c.eval('Math.round(innerWidth/2)')
  const y = await c.eval('Math.round(innerHeight*0.68)')
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse' })
  await sleep(70)
}

async function makeVisible(c, selector, index = 0) {
  for (let i = 0; i < 40; i++) {
    const r = await c.eval(`(()=>{const n=document.querySelectorAll(${q(selector)})[${index}];if(!n)return null;const r=n.getBoundingClientRect();const s=getComputedStyle(n);return{ok:s.display!=='none'&&s.visibility!=='hidden'&&r.top>=8&&r.bottom<=innerHeight-8,top:r.top,bottom:r.bottom}})()`)
    assert.ok(r, `missing ${selector} [${index}]`)
    if (r.ok) return
    await wheel(c, r.top < 8 ? -480 : 520)
  }
  throw new Error(`could not make visible ${selector} [${index}]`)
}

async function absoluteRect(c, selector, index = 0) {
  return c.eval(`(()=>{const n=document.querySelectorAll(${q(selector)})[${index}];if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right,documentTop:r.top+(document.scrollingElement?.scrollTop||0),documentBottom:r.bottom+(document.scrollingElement?.scrollTop||0),text:n.textContent.trim(),display:getComputedStyle(n).display,disabled:Boolean(n.disabled),ariaExpanded:n.getAttribute('aria-expanded'),ariaPressed:n.getAttribute('aria-pressed')}})()`)
}

async function state(c) {
  return c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`)
}

function additionalState(value) {
  return {
    lifeStage: value.change.lifeStage,
    ingredientAvoidTerms: value.ingredientAvoidTerms,
    officialTargets: value.change.officialTargets,
    features: value.change.features,
    recipeFamilies: value.change.recipeFamilies,
    grainFree: value.change.grainFree,
  }
}

async function enterChange(c) {
  await c.nav(BASE)
  await c.wait(`document.querySelector('.home-start-path button')`, 'home switch entry')
  await makeVisible(c, '.home-start-path button')
  await click(c, '.home-start-path button', 0, ['현재 사료로 시작하기'])
  await c.wait(`document.querySelector('.switch-find-search input')`, 'current search')
  await typeText(c, '.switch-find-search input', 'AATU 연어')
  await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes('AATU')&&n.textContent.includes('연어'))`, 'AATU result')
  const productIndex = await c.eval(`[...document.querySelectorAll('.switch-find-result')].findIndex(n=>n.textContent.includes('AATU')&&n.textContent.includes('연어'))`)
  await makeVisible(c, '.switch-find-result', productIndex)
  await click(c, '.switch-find-result', productIndex, ['AATU', '연어'])
  await c.wait(`document.querySelector('.switch-current-preview')`, 'current preview')
  await makeVisible(c, '.switch-current-preview .switch-primary-action')
  await click(c, '.switch-current-preview .switch-primary-action')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'sku options', 20000)
  const sku = await c.eval(`document.querySelector('.switch-sku-option')?.textContent.trim()`)
  assert.ok(sku)
  await makeVisible(c, '.switch-sku-option')
  await click(c, '.switch-sku-option')
  await makeVisible(c, '.switch-step-actions .switch-primary-action')
  await click(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-no-change')`, 'CHANGE')
  await sleep(80)
  return sku
}

async function scrollToNext(c) {
  const start = await c.eval('document.scrollingElement?.scrollTop||0')
  let events = 0
  for (; events < 20; events++) {
    const rect = await absoluteRect(c, '.switch-step-actions .switch-primary-action')
    if (rect && rect.top >= 8 && rect.bottom <= innerHeight - 8) break
    await wheel(c, 220)
  }
  const end = await c.eval('document.scrollingElement?.scrollTop||0')
  const visibleRect = await absoluteRect(c, '.switch-step-actions .switch-primary-action')
  assert.ok(visibleRect && visibleRect.top >= 8 && visibleRect.bottom <= 836, JSON.stringify(visibleRect))
  return { start, end, actualScroll: end - start, wheelEvents: events, visibleRect }
}

async function networkReport(c) {
  const writes = c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method))
  const analytics = c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake'))
  const nonRead = c.requests.filter((r) => !['GET','HEAD','OPTIONS'].includes(r.method))
  const blocked = await c.eval('window.__qaBlocked')
  assert.equal(writes.length, 0)
  assert.equal(analytics.length, 0)
  assert.equal(nonRead.length, 0)
  assert.deepEqual(blocked, { analytics: 0, writes: 0 })
  return { writes: 0, analytics: 0, nonRead: 0, gets: c.requests.filter((r) => r.method === 'GET').length, blocked }
}

async function basicScenario(kind) {
  const handle = await launch(360)
  const c = handle.c
  try {
    const sku = await enterChange(c)
    const disclosure = await absoluteRect(c, '.switch-change-additional-toggle')
    assert.equal(disclosure?.ariaExpanded, 'false')
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-content')?.hidden`), true)
    assert.equal(await c.eval(`getComputedStyle(document.querySelector('.switch-change-desktop-criteria')).display`), 'none')

    let selectionRect
    if (kind === 'no-change') {
      selectionRect = await absoluteRect(c, '.switch-no-change')
      await click(c, '.switch-no-change')
      assert.equal(await c.eval(`document.querySelector('.switch-no-change')?.classList.contains('is-selected')`), true)
      await c.shot('360-basic-folded.png')
    } else {
      await makeVisible(c, '.switch-change-mobile-basic .switch-criterion-section button')
      selectionRect = await absoluteRect(c, '.switch-change-mobile-basic .switch-criterion-section button')
      await click(c, '.switch-change-mobile-basic .switch-criterion-section button', 0, ['다른 브랜드로 보기'])
      assert.equal(await c.eval(`document.querySelector('.switch-change-mobile-basic .switch-criterion-section button')?.getAttribute('aria-pressed')`), 'true')
    }
    const nextInitial = await absoluteRect(c, '.switch-step-actions .switch-primary-action')
    assert.equal(nextInitial?.disabled, false)
    const scrollToAction = await scrollToNext(c)
    assert.ok(scrollToAction.actualScroll < BASELINE_SCROLL, JSON.stringify(scrollToAction))
    return { kind, sku, selectionRect, nextInitial, baselineActualScroll: BASELINE_SCROLL, scrollToAction, network: await networkReport(c) }
  } finally {
    await cleanup(handle)
  }
}

async function key(c, keyName, code, windowsVirtualKeyCode) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode })
  await sleep(80)
}

async function advancedScenario() {
  const handle = await launch(360)
  const c = handle.c
  try {
    await enterChange(c)
    await makeVisible(c, '.switch-change-additional-toggle')
    await click(c, '.switch-change-additional-toggle')
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')

    // Native keyboard operation: Enter closes, Space opens again.
    await key(c, 'Enter', 'Enter', 13)
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'false')
    await key(c, ' ', 'Space', 32)
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')

    const lifeButtonIndex = await c.eval(`[...document.querySelectorAll('.switch-change-additional-content button')].findIndex(n=>n.textContent.trim()==='키튼')`)
    assert.ok(lifeButtonIndex >= 0)
    await makeVisible(c, '.switch-change-additional-content button', lifeButtonIndex)
    const beforeSelectScroll = await c.eval('document.scrollingElement?.scrollTop||0')
    await click(c, '.switch-change-additional-content button', lifeButtonIndex, ['키튼'])
    const afterSelectScroll = await c.eval('document.scrollingElement?.scrollTop||0')
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')
    assert.ok(Math.abs(afterSelectScroll - beforeSelectScroll) <= 2, JSON.stringify({ beforeSelectScroll, afterSelectScroll }))

    await makeVisible(c, '.switch-change-additional-toggle')
    await click(c, '.switch-change-additional-toggle')
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'false')
    const selectedState = additionalState(await state(c))
    assert.equal(selectedState.lifeStage, 'kitten')
    const summary = await c.eval(`document.querySelector('.switch-change-additional-summary')?.textContent.trim()`)
    const countCopy = await c.eval(`document.querySelector('.switch-change-additional-toggle small')?.textContent.trim()`)
    assert.equal(countCopy, '1개 선택')
    assert.ok(summary?.includes('키튼'), summary)
    await c.shot('360-selected-summary-collapsed.png')

    // Collapsed descendants must not enter Tab order.
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-content')?.hidden`), true)
    await key(c, 'Tab', 'Tab', 9)
    const tabAfterCollapse = await c.eval(`(()=>{const a=document.activeElement;return{className:a?.className||'',inside:Boolean(a?.closest?.('.switch-change-additional-content')),text:a?.textContent?.trim()||''}})()`)
    assert.equal(tabAfterCollapse.inside, false, JSON.stringify(tabAfterCollapse))

    await makeVisible(c, '.switch-step-actions .switch-primary-action')
    await click(c, '.switch-step-actions .switch-primary-action')
    await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'KEEP')
    await makeVisible(c, '.switch-step-actions .switch-secondary-action')
    await click(c, '.switch-step-actions .switch-secondary-action', 0, ['바꿀 것 수정'])
    await c.wait(`document.querySelector('.switch-change-additional-toggle')`, 'CHANGE re-entry')
    await c.wait(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')==='true'`, 'advanced disclosure auto-open on re-entry')
    const reentryState = additionalState(await state(c))
    assert.equal(reentryState.lifeStage, 'kitten')
    assert.equal(await c.eval(`[...document.querySelectorAll('.switch-change-additional-content button')].some(n=>n.textContent.trim()==='키튼'&&n.getAttribute('aria-pressed')==='true')`), true)
    await c.shot('360-reentry-expanded.png')

    // No-change keeps the existing exclusivity contract and clears advanced values without auto-folding.
    await makeVisible(c, '.switch-no-change')
    await click(c, '.switch-no-change')
    const cleared = additionalState(await state(c))
    assert.deepEqual(cleared, { lifeStage: '', ingredientAvoidTerms: [], officialTargets: [], features: [], recipeFamilies: [], grainFree: false })
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-summary')`), null)
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle small')?.textContent.trim()`), '필요할 때만 선택하세요.')

    return {
      selectedState,
      summary,
      countCopy,
      beforeSelectScroll,
      afterSelectScroll,
      tabAfterCollapse,
      reentryState,
      noChangeCleared: cleared,
      network: await networkReport(c),
    }
  } finally {
    await cleanup(handle)
  }
}

async function longSummary390() {
  const handle = await launch(390, 844, true)
  const c = handle.c
  try {
    await enterChange(c)
    await makeVisible(c, '.switch-change-additional-toggle')
    await click(c, '.switch-change-additional-toggle')
    const labels = ['키튼', '실내묘', '중성화묘', '체중 관리', '헤어볼', '소화', '요로', '가금류', '육류', 'Grain-Free 표기']
    for (const label of labels) {
      const index = await c.eval(`[...document.querySelectorAll('.switch-change-additional-content button')].findIndex(n=>n.textContent.trim()===${q(label)})`)
      assert.ok(index >= 0, `missing advanced choice ${label}`)
      await makeVisible(c, '.switch-change-additional-content button', index)
      await click(c, '.switch-change-additional-content button', index, [label])
      assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')
    }
    await makeVisible(c, '.switch-change-additional-toggle')
    await click(c, '.switch-change-additional-toggle')
    const metrics = await c.eval(`(()=>{const s=document.querySelector('.switch-change-additional-summary');const r=s.getBoundingClientRect();return{height:r.height,width:r.width,text:s.textContent.trim(),scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,count:document.querySelector('.switch-change-additional-toggle small')?.textContent.trim()}})()`)
    assert.ok(metrics.height > 34, JSON.stringify(metrics))
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, JSON.stringify(metrics))
    assert.equal(metrics.count, `${labels.length}개 선택`)
    await c.shot('390-long-summary.png')
    return { labels, metrics, network: await networkReport(c) }
  } finally {
    await cleanup(handle)
  }
}

async function boundary(width) {
  const handle = await launch(width, width === 1280 ? 900 : 844, false)
  const c = handle.c
  try {
    await enterChange(c)
    const result = await c.eval(`(()=>{const mobile=document.querySelector('.switch-change-mobile-criteria');const desktop=document.querySelector('.switch-change-desktop-criteria');const toggle=document.querySelector('.switch-change-additional-toggle');const main=document.querySelector('.switch-step-main');return{width:innerWidth,mobileDisplay:getComputedStyle(mobile).display,desktopDisplay:getComputedStyle(desktop).display,toggleDisplay:getComputedStyle(toggle).display,toggleExpanded:toggle.getAttribute('aria-expanded'),desktopColumns:getComputedStyle(desktop).gridTemplateColumns,mainOverflowY:getComputedStyle(main).overflowY,documentTop:document.scrollingElement?.scrollTop||0,desktopAdvancedVisible:[...desktop.querySelectorAll('.switch-criterion-section')].every(n=>getComputedStyle(n).display!=='none')}})()`)
    if (width <= 760) {
      assert.notEqual(result.mobileDisplay, 'none')
      assert.equal(result.desktopDisplay, 'none')
      assert.equal(result.toggleExpanded, 'false')
    } else {
      assert.equal(result.mobileDisplay, 'none')
      assert.equal(result.desktopDisplay, 'grid')
      assert.equal(result.desktopAdvancedVisible, true)
    }
    if (width === 1280) {
      assert.equal(result.mainOverflowY, 'auto')
      assert.equal(result.documentTop, 0)
      assert.ok(result.desktopColumns.split(' ').length >= 2, JSON.stringify(result))
    }
    return { ...result, network: await networkReport(c) }
  } finally {
    await cleanup(handle)
  }
}

const report = {
  productSha: process.env.PRODUCT_SHA,
  viewportBaseline: { width: 360, height: 844, simplePathActualScroll: BASELINE_SCROLL },
  noChange: await basicScenario('no-change'),
  brandOnly: await basicScenario('brand'),
  advanced: await advancedScenario(),
  longSummary390: await longSummary390(),
  boundaries: {
    width760: await boundary(760),
    width761: await boundary(761),
    width1280: await boundary(1280),
  },
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log('PR39_CHANGE_DISCLOSURE PASS', JSON.stringify(report))
