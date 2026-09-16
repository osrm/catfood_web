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
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = []
  }
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

async function launch(width, height, mobile) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome is required')
  const port = 12800 + (process.pid % 100) + launchNo++ * 40
  const dir = `/tmp/pr39-final2-${process.pid}-${launchNo}`
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
      await c.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height,
      })
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
        const original=window.fetch.bind(window)
        window.__qaBlocked={analytics:0,writes:0}
        window.fetch=(input,init={})=>{
          const url=typeof input==='string'?input:(input&&input.url)||''
          const method=String(init.method||(input&&input.method)||'GET').toUpperCase()
          if(url.includes('/functions/v1/decision-intake')){
            window.__qaBlocked.analytics++
            return Promise.reject(new TypeError('blocked analytics'))
          }
          if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){
            window.__qaBlocked.writes++
            return Promise.reject(new TypeError('blocked write'))
          }
          return original(input,init)
        }
      })();` })
      return { c, proc, dir, requested: { width, height, mobile } }
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
  for (let i = 0; i < 5; i++) {
    try { rmSync(handle.dir, { recursive: true, force: true }); return } catch { await sleep(80) }
  }
}

async function viewport(c) {
  return c.eval(`({width:innerWidth,height:innerHeight,devicePixelRatio})`)
}

async function wheel(c, deltaY) {
  const x = await c.eval('Math.round(innerWidth/2)')
  const y = await c.eval('Math.round(innerHeight*0.68)')
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse' })
  await sleep(70)
}

async function findExact(c, selector, label) {
  return c.eval(`(()=>{
    const n=[...document.querySelectorAll(${q(selector)})].find(n=>n.textContent.trim()===${q(label)})
    if(!n)return null
    const r=n.getBoundingClientRect();const s=getComputedStyle(n)
    return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,display:s.display,visibility:s.visibility}
  })()`)
}

async function makeVisible(c, selector, index = 0) {
  for (let i = 0; i < 40; i++) {
    const r = await c.eval(`(()=>{
      const n=document.querySelectorAll(${q(selector)})[${index}]
      if(!n)return null
      const r=n.getBoundingClientRect();const s=getComputedStyle(n)
      return{ok:s.display!=='none'&&s.visibility!=='hidden'&&r.top>=8&&r.bottom<=innerHeight-8,top:r.top,bottom:r.bottom}
    })()`)
    assert.ok(r, `missing ${selector} [${index}]`)
    if (r.ok) return
    await wheel(c, r.top < 8 ? -480 : 520)
  }
  throw new Error(`could not make visible ${selector} [${index}]`)
}

async function makeExactVisible(c, selector, label) {
  for (let i = 0; i < 40; i++) {
    const r = await findExact(c, selector, label)
    assert.ok(r, `missing exact ${selector} ${label}`)
    if (r.display !== 'none' && r.visibility !== 'hidden' && r.top >= 8 && r.bottom <= await c.eval('innerHeight-8')) return
    await wheel(c, r.top < 8 ? -480 : 520)
  }
  throw new Error(`could not make visible exact ${selector} ${label}`)
}

async function click(c, selector, index = 0, contains = []) {
  const point = await c.eval(`(()=>{
    const nodes=[...document.querySelectorAll(${q(selector)})].filter(n=>${q(contains)}.every(t=>n.textContent?.includes(t)))
    const n=nodes[${index}]
    if(!n)return null
    const r=n.getBoundingClientRect();const s=getComputedStyle(n)
    const x=Math.max(2,Math.min(innerWidth-2,r.left+r.width/2));const y=Math.max(2,Math.min(innerHeight-2,r.top+r.height/2))
    const hit=document.elementFromPoint(x,y)
    if(s.display==='none'||s.visibility==='hidden'||r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth)return{offscreen:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}
    if(!hit||!n.contains(hit))return{blocked:true,hit:hit?.tagName||null,hitClass:hit?.className||'',rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}
    window.__qaTrustedClick=null
    n.addEventListener('click',e=>window.__qaTrustedClick=e.isTrusted,{once:true,capture:true})
    return{x,y,text:n.textContent.trim()}
  })()`)
  assert.ok(point, `missing ${selector} ${contains.join('+')} [${index}]`)
  assert.ok(!point.offscreen && !point.blocked, `unclickable ${selector}: ${JSON.stringify(point)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(80)
  assert.equal(await c.eval('window.__qaTrustedClick'), true, `untrusted click: ${selector}`)
}

async function clickExact(c, selector, label) {
  const point = await c.eval(`(()=>{
    const n=[...document.querySelectorAll(${q(selector)})].find(n=>n.textContent.trim()===${q(label)})
    if(!n)return null
    const r=n.getBoundingClientRect();const s=getComputedStyle(n)
    const x=Math.max(2,Math.min(innerWidth-2,r.left+r.width/2));const y=Math.max(2,Math.min(innerHeight-2,r.top+r.height/2))
    const hit=document.elementFromPoint(x,y)
    if(s.display==='none'||s.visibility==='hidden'||r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth)return{offscreen:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}
    if(!hit||!n.contains(hit))return{blocked:true,hit:hit?.tagName||null,hitClass:hit?.className||'',rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}
    window.__qaTrustedClick=null
    n.addEventListener('click',e=>window.__qaTrustedClick=e.isTrusted,{once:true,capture:true})
    return{x,y,text:n.textContent.trim()}
  })()`)
  assert.ok(point, `missing exact ${selector} ${label}`)
  assert.ok(!point.offscreen && !point.blocked, `unclickable exact ${label}: ${JSON.stringify(point)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(80)
  assert.equal(await c.eval('window.__qaTrustedClick'), true, `untrusted exact click: ${label}`)
}

async function typeText(c, selector, text) {
  await click(c, selector)
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector(${q(selector)})?.value===${q(text)}`, 'typed input')
}

async function rect(c, selector) {
  return c.eval(`(()=>{
    const n=document.querySelector(${q(selector)});if(!n)return null
    const r=n.getBoundingClientRect()
    return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,width:r.width,disabled:Boolean(n.disabled),ariaExpanded:n.getAttribute('aria-expanded')}
  })()`)
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
  await makeVisible(c, '.switch-sku-option')
  await click(c, '.switch-sku-option')
  await makeVisible(c, '.switch-step-actions .switch-primary-action')
  await click(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-no-change')`, 'CHANGE')
  await sleep(80)
}

async function scrollToNext(c) {
  const start = await c.eval('document.scrollingElement?.scrollTop||0')
  const height = await c.eval('innerHeight')
  let events = 0
  for (; events < 20; events++) {
    const r = await rect(c, '.switch-step-actions .switch-primary-action')
    if (r && r.top >= 8 && r.bottom <= height - 8) break
    await wheel(c, 220)
  }
  const end = await c.eval('document.scrollingElement?.scrollTop||0')
  const visibleRect = await rect(c, '.switch-step-actions .switch-primary-action')
  assert.ok(visibleRect && visibleRect.top >= 8 && visibleRect.bottom <= height - 8, JSON.stringify(visibleRect))
  return { start, end, actualScroll: end - start, reduction: BASELINE_SCROLL - (end - start), wheelEvents: events, visibleRect }
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
  const handle = await launch(360, 844, true)
  const c = handle.c
  try {
    await enterChange(c)
    const vp = await viewport(c)
    assert.deepEqual({ width: vp.width, height: vp.height }, { width: 360, height: 844 })
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'false')
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-content')?.hidden`), true)
    assert.equal(await c.eval(`getComputedStyle(document.querySelector('.switch-change-desktop-criteria')).display`), 'none')

    if (kind === 'no-change') {
      await makeVisible(c, '.switch-no-change')
      await click(c, '.switch-no-change')
      assert.equal(await c.eval(`document.querySelector('.switch-no-change')?.classList.contains('is-selected')`), true)
      await c.shot('360-basic-folded.png')
    } else {
      await makeExactVisible(c, '.switch-change-mobile-basic button', '다른 브랜드로 보기')
      await clickExact(c, '.switch-change-mobile-basic button', '다른 브랜드로 보기')
      assert.equal(await c.eval(`[...document.querySelectorAll('.switch-change-mobile-basic button')].find(n=>n.textContent.trim()==='다른 브랜드로 보기')?.getAttribute('aria-pressed')`), 'true')
      await c.shot('360-brand-only-folded.png')
    }

    const nextInitial = await rect(c, '.switch-step-actions .switch-primary-action')
    assert.equal(nextInitial?.disabled, false)
    const scroll = await scrollToNext(c)
    assert.ok(scroll.actualScroll < BASELINE_SCROLL, JSON.stringify(scroll))
    return { viewport: vp, nextInitial, baselineActualScroll: BASELINE_SCROLL, scroll, network: await networkReport(c) }
  } finally { await cleanup(handle) }
}

async function pressKey(c, key, code, keyCode, text = '') {
  const payload = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload, ...(text ? { text, unmodifiedText: text } : {}) })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload })
  await sleep(100)
}

async function pressTab(c, shift = false) {
  const modifiers = shift ? 8 : 0
  const payload = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers }
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload })
  await sleep(80)
}

async function tabToDisclosure(c) {
  for (let i = 0; i < 32; i++) {
    if (await c.eval(`document.activeElement===document.querySelector('.switch-change-additional-toggle')`)) return i
    await pressTab(c)
  }
  throw new Error('Tab did not reach disclosure toggle')
}

async function recordTrustedKey(c, expectedKey, action) {
  await c.eval(`(()=>{
    const n=document.querySelector('.switch-change-additional-toggle')
    window.__qaKey={down:null,up:null}
    n.addEventListener('keydown',e=>window.__qaKey.down={key:e.key,isTrusted:e.isTrusted},{once:true,capture:true})
    n.addEventListener('keyup',e=>window.__qaKey.up={key:e.key,isTrusted:e.isTrusted},{once:true,capture:true})
  })()`)
  await action()
  const observed = await c.eval('window.__qaKey')
  assert.equal(observed.down?.isTrusted, true, JSON.stringify(observed))
  assert.equal(observed.up?.isTrusted, true, JSON.stringify(observed))
  assert.equal(observed.down?.key, expectedKey)
  return observed
}

async function focusGeometry(c) {
  return c.eval(`(()=>{
    const n=document.querySelector('.switch-change-additional-toggle');const p=n.parentElement
    const r=n.getBoundingClientRect();const pr=p.getBoundingClientRect();const s=getComputedStyle(n);const ps=getComputedStyle(p)
    const width=parseFloat(s.outlineWidth)||0;const offset=parseFloat(s.outlineOffset)||0;const extent=width+Math.max(0,offset)
    const clips=ps.overflow!=='visible'&&(r.left-extent<pr.left||r.right+extent>pr.right||r.top-extent<pr.top||r.bottom+extent>pr.bottom)
    return{active:document.activeElement===n,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,parentOverflow:ps.overflow,button:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},parent:{left:pr.left,right:pr.right,top:pr.top,bottom:pr.bottom},outlineExtent:extent,clippedByParent:clips}
  })()`)
}

async function advancedScenario() {
  const handle = await launch(360, 844, true)
  const c = handle.c
  try {
    await enterChange(c)
    const vp = await viewport(c)
    assert.deepEqual({ width: vp.width, height: vp.height }, { width: 360, height: 844 })
    await makeVisible(c, '.switch-change-additional-toggle')
    const tabCount = await tabToDisclosure(c)
    const focus = await focusGeometry(c)
    assert.equal(focus.active, true)
    assert.equal(focus.parentOverflow, 'visible')
    assert.equal(focus.clippedByParent, false)
    await c.shot('360-disclosure-focus.png')

    const enter = await recordTrustedKey(c, 'Enter', () => pressKey(c, 'Enter', 'Enter', 13, '\r'))
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')
    const space = await recordTrustedKey(c, ' ', () => pressKey(c, ' ', 'Space', 32, ' '))
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'false')

    await pressTab(c)
    const tabAfterCollapse = await c.eval(`(()=>{const a=document.activeElement;return{inside:Boolean(a?.closest?.('.switch-change-additional-content')),text:a?.textContent?.trim()||'',className:a?.className||''}})()`)
    assert.equal(tabAfterCollapse.inside, false, JSON.stringify(tabAfterCollapse))
    await pressTab(c, true)
    assert.equal(await c.eval(`document.activeElement===document.querySelector('.switch-change-additional-toggle')`), true)
    await recordTrustedKey(c, 'Enter', () => pressKey(c, 'Enter', 'Enter', 13, '\r'))
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')

    await makeExactVisible(c, '.switch-change-additional-content button', '키튼')
    const beforeSelectScroll = await c.eval('document.scrollingElement?.scrollTop||0')
    await clickExact(c, '.switch-change-additional-content button', '키튼')
    const afterSelectScroll = await c.eval('document.scrollingElement?.scrollTop||0')
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')
    assert.ok(Math.abs(afterSelectScroll - beforeSelectScroll) <= 2, JSON.stringify({ beforeSelectScroll, afterSelectScroll }))

    await makeVisible(c, '.switch-change-additional-toggle')
    await click(c, '.switch-change-additional-toggle')
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'false')
    const selected = additionalState(await state(c))
    assert.equal(selected.lifeStage, 'kitten')
    const summary = await c.eval(`document.querySelector('.switch-change-additional-summary')?.textContent.trim()`)
    const countCopy = await c.eval(`document.querySelector('.switch-change-additional-toggle small')?.textContent.trim()`)
    assert.equal(countCopy, '1개 선택')
    assert.ok(summary?.includes('키튼'), summary)
    await c.shot('360-selected-summary-collapsed.png')

    await makeVisible(c, '.switch-step-actions .switch-primary-action')
    await click(c, '.switch-step-actions .switch-primary-action')
    await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'KEEP')
    await makeExactVisible(c, '.switch-step-actions button', '← 바꿀 것 수정')
    await clickExact(c, '.switch-step-actions button', '← 바꿀 것 수정')
    await c.wait(`document.querySelector('.switch-change-additional-toggle')`, 'CHANGE re-entry')
    await c.wait(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')==='true'`, 'advanced disclosure open on re-entry')
    const reentry = additionalState(await state(c))
    assert.equal(reentry.lifeStage, 'kitten')
    assert.equal(await c.eval(`[...document.querySelectorAll('.switch-change-additional-content button')].some(n=>n.textContent.trim()==='키튼'&&n.getAttribute('aria-pressed')==='true')`), true)
    await c.shot('360-reentry-expanded.png')

    await makeVisible(c, '.switch-no-change')
    await click(c, '.switch-no-change')
    const cleared = additionalState(await state(c))
    assert.deepEqual(cleared, { lifeStage: '', ingredientAvoidTerms: [], officialTargets: [], features: [], recipeFamilies: [], grainFree: false })
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-summary')`), null)
    assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle small')?.textContent.trim()`), '필요할 때만 선택하세요.')

    return { viewport: vp, tabCount, focus, enter, space, tabAfterCollapse, beforeSelectScroll, afterSelectScroll, selected, summary, countCopy, reentry, cleared, network: await networkReport(c) }
  } finally { await cleanup(handle) }
}

async function longSummary390() {
  const handle = await launch(390, 900, true)
  const c = handle.c
  try {
    await enterChange(c)
    const vp = await viewport(c)
    assert.deepEqual({ width: vp.width, height: vp.height }, { width: 390, height: 900 })
    await makeVisible(c, '.switch-change-additional-toggle')
    await click(c, '.switch-change-additional-toggle')
    const labels = ['키튼', '실내묘', '중성화묘', '체중 관리', '헤어볼', '소화', '요로', '가금류', '육류', 'Grain-Free 표기']
    for (const label of labels) {
      await makeExactVisible(c, '.switch-change-additional-content button', label)
      await clickExact(c, '.switch-change-additional-content button', label)
      assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')
    }
    await makeVisible(c, '.switch-change-additional-toggle')
    await click(c, '.switch-change-additional-toggle')
    const metrics = await c.eval(`(()=>{
      const s=document.querySelector('.switch-change-additional-summary');const r=s.getBoundingClientRect()
      return{height:r.height,width:r.width,text:s.textContent.trim(),scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,count:document.querySelector('.switch-change-additional-toggle small')?.textContent.trim()}
    })()`)
    assert.ok(metrics.height > 34, JSON.stringify(metrics))
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, JSON.stringify(metrics))
    assert.equal(metrics.count, `${labels.length}개 선택`)
    await c.shot('390x900-long-summary.png')
    return { viewport: vp, labels, metrics, network: await networkReport(c) }
  } finally { await cleanup(handle) }
}

async function boundary(width, height, mobile) {
  const handle = await launch(width, height, mobile)
  const c = handle.c
  try {
    await enterChange(c)
    const vp = await viewport(c)
    assert.deepEqual({ width: vp.width, height: vp.height }, { width, height })
    const result = await c.eval(`(()=>{
      const mobile=document.querySelector('.switch-change-mobile-criteria');const desktop=document.querySelector('.switch-change-desktop-criteria');const toggle=document.querySelector('.switch-change-additional-toggle');const main=document.querySelector('.switch-step-main')
      return{mobileDisplay:getComputedStyle(mobile).display,desktopDisplay:getComputedStyle(desktop).display,toggleExpanded:toggle.getAttribute('aria-expanded'),desktopColumns:getComputedStyle(desktop).gridTemplateColumns,mainOverflowY:getComputedStyle(main).overflowY,documentTop:document.scrollingElement?.scrollTop||0,desktopAdvancedVisible:[...desktop.querySelectorAll('.switch-criterion-section')].every(n=>getComputedStyle(n).display!=='none')}
    })()`)
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
    return { viewport: vp, ...result, network: await networkReport(c) }
  } finally { await cleanup(handle) }
}

const report = {
  productSha: process.env.PRODUCT_SHA,
  baseline: { width: 360, height: 844, simplePathActualScroll: BASELINE_SCROLL },
  noChange: await basicScenario('no-change'),
  brandOnly: await basicScenario('brand'),
  advanced: await advancedScenario(),
  longSummary390: await longSummary390(),
  boundaries: {
    width760: await boundary(760, 844, true),
    width761: await boundary(761, 844, false),
    width1280: await boundary(1280, 900, false),
  },
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log('PR39_CHANGE_DISCLOSURE_FINAL2 PASS', JSON.stringify(report))
