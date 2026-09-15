import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const OUT = 'qa-artifacts'
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

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome is required')
  const port = 11500 + (process.pid % 100) + launchNo++ * 50
  const dir = `/tmp/switch-change-burden-${process.pid}-${launchNo}`
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
      await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844 })
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const original=window.fetch.bind(window);window.__qaBlocked={analytics:0,writes:0};window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}return original(input,init)}})();` })
      return { c, proc, dir }
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
  for (let i = 0; i < 5; i++) {
    try { rmSync(handle.dir, { recursive: true, force: true }); return } catch { await sleep(80) }
  }
}

async function click(c, selector, index = 0, contains = []) {
  const point = await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${q(selector)})].filter(n=>${q(contains)}.every(t=>n.textContent?.includes(t)));const n=nodes[${index}];if(!n)return null;const r=n.getBoundingClientRect();if(r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth)return{offscreen:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},text:n.textContent.trim()};window.__qaTrustedClick=null;n.addEventListener('click',e=>window.__qaTrustedClick=e.isTrusted,{once:true,capture:true});return{x:Math.max(2,Math.min(innerWidth-2,r.left+r.width/2)),y:Math.max(2,Math.min(innerHeight-2,r.top+r.height/2)),text:n.textContent.trim()}})()`)
  assert.ok(point, `missing ${selector}`)
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
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 180, y: 600, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 180, y: 600, deltaX: 0, deltaY, pointerType: 'mouse' })
  await sleep(70)
}

async function makeVisible(c, selector, index = 0) {
  for (let i = 0; i < 40; i++) {
    const r = await c.eval(`(()=>{const n=document.querySelectorAll(${q(selector)})[${index}];if(!n)return null;const r=n.getBoundingClientRect();return{ok:r.top>=8&&r.bottom<=innerHeight-8,top:r.top,bottom:r.bottom}})()`)
    assert.ok(r, `missing ${selector}`)
    if (r.ok) return
    await wheel(c, r.top < 8 ? -480 : 560)
  }
  throw new Error(`could not make visible ${selector}`)
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
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'sku options')
  await makeVisible(c, '.switch-sku-option')
  const sku = await c.eval(`document.querySelector('.switch-sku-option')?.textContent.trim()`)
  await click(c, '.switch-sku-option')
  await makeVisible(c, '.switch-step-actions .switch-primary-action')
  await click(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-no-change')`, 'CHANGE')
  assert.ok((await c.eval('document.scrollingElement.scrollTop')) <= 1)
  return sku
}

async function absoluteRect(c, selector, index = 0) {
  return c.eval(`(()=>{const n=document.querySelectorAll(${q(selector)})[${index}];if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right,documentTop:r.top+(document.scrollingElement?.scrollTop||0),documentBottom:r.bottom+(document.scrollingElement?.scrollTop||0),text:n.textContent.trim(),disabled:Boolean(n.disabled),ariaDisabled:n.getAttribute('aria-disabled'),ariaPressed:n.getAttribute('aria-pressed'),className:n.className}})()`)
}

async function changeLayout(c) {
  return c.eval(`(()=>({
    scrollTop:document.scrollingElement?.scrollTop||0,
    scrollMax:(document.scrollingElement?.scrollHeight||0)-(document.scrollingElement?.clientHeight||0),
    groups:[...document.querySelectorAll('.switch-criterion-section')].map((n,i)=>{const r=n.getBoundingClientRect();const h=n.querySelector('.switch-criterion-heading');return{index:i,title:h?.querySelector('strong')?.textContent?.trim()||'',hint:h?.querySelector('span')?.textContent?.trim()||'',documentTop:r.top+(document.scrollingElement?.scrollTop||0),height:r.height,documentBottom:r.bottom+(document.scrollingElement?.scrollTop||0)}}),
    currentSummary:document.querySelector('.switch-reference-rail')?.textContent?.trim()||'',
    noChangeCopy:document.querySelector('.switch-no-change')?.textContent?.trim()||'',
    changeText:document.querySelector('.switch-step-main')?.textContent?.trim()||'',
    currentMentions:[...document.querySelectorAll('.switch-criterion-heading span')].map(n=>n.textContent?.trim()||'').filter(Boolean),
  }))()`)
}

async function nextButtonState(c) {
  return absoluteRect(c, '.switch-step-actions .switch-primary-action')
}

async function scrollToNext(c) {
  const start = await c.eval('document.scrollingElement.scrollTop')
  let events = 0
  for (; events < 20; events++) {
    const rect = await absoluteRect(c, '.switch-step-actions .switch-primary-action')
    if (rect && rect.top >= 8 && rect.bottom <= 836) break
    await wheel(c, 240)
  }
  const end = await c.eval('document.scrollingElement.scrollTop')
  const rect = await absoluteRect(c, '.switch-step-actions .switch-primary-action')
  assert.ok(rect && rect.top >= 8 && rect.bottom <= 836, JSON.stringify(rect))
  return { start, end, actualScroll: end - start, wheelEvents: events, visibleRect: rect }
}

async function selectionState(c) {
  return c.eval(`(()=>{const no=document.querySelector('.switch-no-change');const brand=[...document.querySelectorAll('.switch-criterion-section')].find(s=>s.querySelector('.switch-criterion-heading strong')?.textContent?.trim()==='브랜드')?.querySelector('button');const next=document.querySelector('.switch-step-actions .switch-primary-action');return{noChangeSelected:no?.classList.contains('is-selected')||false,brandPressed:brand?.getAttribute('aria-pressed')==='true',nextDisabled:Boolean(next?.disabled),nextAriaDisabled:next?.getAttribute('aria-disabled')}})()`)
}

async function findBrandIndex(c) {
  return c.eval(`[...document.querySelectorAll('.switch-criterion-section')].findIndex(s=>s.querySelector('.switch-criterion-heading strong')?.textContent?.trim()==='브랜드')`)
}

async function clickBrand(c) {
  const brandSectionIndex = await findBrandIndex(c)
  assert.ok(brandSectionIndex >= 0)
  await makeVisible(c, '.switch-criterion-section', brandSectionIndex)
  const buttonIndex = await c.eval(`(()=>{const sections=[...document.querySelectorAll('.switch-criterion-section')];const target=sections[${brandSectionIndex}]?.querySelector('button');return [...document.querySelectorAll('.switch-criterion-section button')].indexOf(target)})()`)
  assert.ok(buttonIndex >= 0)
  await click(c, '.switch-criterion-section button', buttonIndex, ['다른 브랜드로 보기'])
}

async function runScenario(kind) {
  const handle = await launch()
  const c = handle.c
  try {
    const sku = await enterChange(c)
    const initialLayout = await changeLayout(c)
    let selectionRect
    const interaction = []

    if (kind === 'no-change') {
      selectionRect = await absoluteRect(c, '.switch-no-change')
      await click(c, '.switch-no-change')
      interaction.push({ step: 'select no-change', state: await selectionState(c) })
      await c.shot('360-change-no-change-selected.png')
    } else {
      const brandSectionIndex = await findBrandIndex(c)
      await makeVisible(c, '.switch-criterion-section', brandSectionIndex)
      const brandButtonIndex = await c.eval(`(()=>{const sections=[...document.querySelectorAll('.switch-criterion-section')];const target=sections[${brandSectionIndex}]?.querySelector('button');return [...document.querySelectorAll('.switch-criterion-section button')].indexOf(target)})()`)
      selectionRect = await absoluteRect(c, '.switch-criterion-section button', brandButtonIndex)
      await click(c, '.switch-criterion-section button', brandButtonIndex, ['다른 브랜드로 보기'])
      interaction.push({ step: 'select brand', state: await selectionState(c) })
      await c.shot('360-change-brand-selected.png')
    }

    const afterSelection = await selectionState(c)
    const nextInitial = await nextButtonState(c)
    const layoutAfterSelection = await changeLayout(c)
    const scrollToAction = await scrollToNext(c)
    await c.shot(kind === 'no-change' ? '360-change-no-change-next.png' : '360-change-brand-next.png')

    await wheel(c, -2000)
    await sleep(100)
    if (kind === 'no-change') {
      await clickBrand(c)
      interaction.push({ step: 'brand replaces no-change', state: await selectionState(c) })
      await clickBrand(c)
      interaction.push({ step: 'clear brand', state: await selectionState(c) })
      await makeVisible(c, '.switch-no-change')
      await click(c, '.switch-no-change')
      interaction.push({ step: 'restore no-change', state: await selectionState(c) })
    } else {
      await makeVisible(c, '.switch-no-change')
      await click(c, '.switch-no-change')
      interaction.push({ step: 'no-change replaces brand', state: await selectionState(c) })
      await click(c, '.switch-no-change')
      interaction.push({ step: 'clear no-change', state: await selectionState(c) })
      await clickBrand(c)
      interaction.push({ step: 'restore brand', state: await selectionState(c) })
    }

    const net = {
      writes: c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method)).length,
      analytics: c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake')).length,
      nonRead: c.requests.filter((r) => !['GET','HEAD','OPTIONS'].includes(r.method)).length,
      gets: c.requests.filter((r) => r.method === 'GET').length,
      blocked: await c.eval('window.__qaBlocked'),
    }
    assert.equal(net.writes, 0)
    assert.equal(net.analytics, 0)
    assert.equal(net.nonRead, 0)

    return { kind, sku, selectionRect, afterSelection, nextInitial, scrollToAction, initialLayout, layoutAfterSelection, interaction, network: net }
  } finally {
    await cleanup(handle)
  }
}

const report = { mergeSha: 'c44766d31642005079a9b44fdcb70994b344830b', page: BASE, viewport: '360x844', scenarios: {} }
try {
  report.scenarios.noChange = await runScenario('no-change')
  report.scenarios.brandOnly = await runScenario('brand')
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('SWITCH_CHANGE_BURDEN PASS', JSON.stringify(report))
} catch (error) {
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ ...report, status: 'failure', error: String(error?.stack ?? error) }, null, 2))
  throw error
}
