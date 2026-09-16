import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.MERGE_SHA
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
const q = JSON.stringify
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })

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
    await sleep(180)
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
  const port = 12300 + (process.pid % 400)
  const dir = `/tmp/pr39-postdeploy-${process.pid}`
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
        width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844,
      })
      await c.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(()=>{
          const original=window.fetch.bind(window)
          window.__qaBlocked={analytics:0,writes:0}
          window.__qaTabTrusted=[]
          document.addEventListener('keydown',e=>{if(e.key==='Tab')window.__qaTabTrusted.push(e.isTrusted)},true)
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
        })();`,
      })
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
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(handle.dir, { recursive: true, force: true }); return } catch {
      if (attempt === 4) return
      await sleep(100)
    }
  }
}

async function viewport(c) {
  return c.eval(`({width:innerWidth,height:innerHeight,devicePixelRatio})`)
}

async function rect(c, selector) {
  return c.eval(`(()=>{const n=document.querySelector(${q(selector)});if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,disabled:Boolean(n.disabled)}})()`)
}

async function wheel(c, deltaY) {
  const x = await c.eval('Math.round(innerWidth/2)')
  const y = await c.eval('Math.round(innerHeight*0.68)')
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse' })
  await sleep(80)
}

async function exactRect(c, selector, label) {
  return c.eval(`(()=>{const n=[...document.querySelectorAll(${q(selector)})].find(n=>n.textContent.trim()===${q(label)});if(!n)return null;const r=n.getBoundingClientRect();const s=getComputedStyle(n);return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,display:s.display,visibility:s.visibility}})()`)
}

async function makeVisible(c, selector, index = 0) {
  for (let i = 0; i < 40; i++) {
    const info = await c.eval(`(()=>{const n=document.querySelectorAll(${q(selector)})[${index}];if(!n)return null;const r=n.getBoundingClientRect();const s=getComputedStyle(n);return{ok:s.display!=='none'&&s.visibility!=='hidden'&&r.top>=8&&r.bottom<=innerHeight-8,top:r.top,bottom:r.bottom}})()`)
    assert.ok(info, `missing ${selector} [${index}]`)
    if (info.ok) return
    await wheel(c, info.top < 8 ? -480 : 520)
  }
  throw new Error(`could not make visible ${selector} [${index}]`)
}

async function makeExactVisible(c, selector, label) {
  for (let i = 0; i < 40; i++) {
    const info = await exactRect(c, selector, label)
    assert.ok(info, `missing exact ${selector} ${label}`)
    const height = await c.eval('innerHeight')
    if (info.display !== 'none' && info.visibility !== 'hidden' && info.top >= 8 && info.bottom <= height - 8) return
    await wheel(c, info.top < 8 ? -480 : 260)
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
  await sleep(90)
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
  await sleep(90)
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

async function state(c) {
  return c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`)
}

async function scrollDocumentToVisible(c, selector) {
  const start = await c.eval('document.scrollingElement?.scrollTop||0')
  const height = await c.eval('innerHeight')
  let wheelEvents = 0
  for (; wheelEvents < 20; wheelEvents++) {
    const r = await rect(c, selector)
    assert.ok(r, `missing ${selector}`)
    if (r.top >= 8 && r.bottom <= height - 8) break
    await wheel(c, r.top < 8 ? -220 : 220)
  }
  const end = await c.eval('document.scrollingElement?.scrollTop||0')
  const visibleRect = await rect(c, selector)
  assert.ok(visibleRect && visibleRect.top >= 8 && visibleRect.bottom <= height - 8, JSON.stringify(visibleRect))
  assert.equal(visibleRect.disabled, false)
  return { start, end, actualScroll: end - start, wheelEvents, visibleRect }
}

async function pressTab(c) {
  const payload = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload })
  await sleep(80)
}

async function tabToDisclosure(c) {
  await c.eval('document.activeElement?.blur?.()')
  for (let i = 0; i < 40; i++) {
    if (await c.eval(`document.activeElement===document.querySelector('.switch-change-additional-toggle')`)) return i
    await pressTab(c)
  }
  throw new Error('Tab did not reach disclosure toggle')
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

const handle = await launch()
const c = handle.c
const report = { mergeSha: MERGE_SHA, page: BASE, viewport: '360x844', status: 'running' }

try {
  await c.nav(BASE)
  const vp = await viewport(c)
  assert.deepEqual({ width: vp.width, height: vp.height }, { width: 360, height: 844 })

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
  report.currentProduct = await c.eval(`document.querySelector('.switch-current-preview')?.textContent.trim()`)
  await makeVisible(c, '.switch-current-preview .switch-primary-action')
  await click(c, '.switch-current-preview .switch-primary-action')

  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'sku options', 20000)
  report.actualSku = await c.eval(`document.querySelector('.switch-sku-option')?.textContent.trim()`)
  assert.ok(report.actualSku, 'expected actual SKU')
  await makeVisible(c, '.switch-sku-option')
  await click(c, '.switch-sku-option')
  await makeVisible(c, '.switch-step-actions .switch-primary-action')
  await click(c, '.switch-step-actions .switch-primary-action')

  await c.wait(`document.querySelector('.switch-no-change')`, 'CHANGE')
  const initialExpanded = await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`)
  const initialHidden = await c.eval(`document.querySelector('.switch-change-additional-content')?.hidden`)
  assert.equal(initialExpanded, 'false')
  assert.equal(initialHidden, true)
  report.initial = { disclosureExpanded: initialExpanded, contentHidden: initialHidden }

  await makeVisible(c, '.switch-no-change')
  await click(c, '.switch-no-change')
  const nextInitial = await rect(c, '.switch-step-actions .switch-primary-action')
  assert.equal(nextInitial?.disabled, false)
  const nextScroll = await scrollDocumentToVisible(c, '.switch-step-actions .switch-primary-action')
  assert.ok(nextScroll.actualScroll < 844, JSON.stringify(nextScroll))
  await click(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'KEEP after no-change')
  report.noChange = { nextInitial, scroll: nextScroll, keepReached: true }

  await makeExactVisible(c, '.switch-step-actions button', '← 바꿀 것 수정')
  await clickExact(c, '.switch-step-actions button', '← 바꿀 것 수정')
  await c.wait(`document.querySelector('.switch-change-additional-toggle')`, 'CHANGE return')
  assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'false')

  await makeVisible(c, '.switch-change-additional-toggle')
  await click(c, '.switch-change-additional-toggle')
  assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')
  await makeExactVisible(c, '.switch-change-additional-content button', '키튼')
  await clickExact(c, '.switch-change-additional-content button', '키튼')
  assert.equal(await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')`), 'true')

  await makeVisible(c, '.switch-change-additional-toggle')
  await click(c, '.switch-change-additional-toggle')
  const collapsedState = await state(c)
  const collapsedCount = await c.eval(`document.querySelector('.switch-change-additional-toggle small')?.textContent.trim()`)
  const collapsedSummary = await c.eval(`document.querySelector('.switch-change-additional-summary')?.textContent.trim()`)
  assert.equal(collapsedState.change.lifeStage, 'kitten')
  assert.equal(collapsedCount, '1개 선택')
  assert.ok(collapsedSummary?.includes('키튼'), collapsedSummary)
  assert.equal(await c.eval(`document.querySelector('.switch-change-additional-content')?.hidden`), true)
  await c.shot('360-postdeploy-selected-summary-collapsed.png')
  report.collapsed = { count: collapsedCount, summary: collapsedSummary, lifeStage: collapsedState.change.lifeStage }

  await makeVisible(c, '.switch-step-actions .switch-primary-action')
  await click(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'KEEP with kitten')
  await makeExactVisible(c, '.switch-step-actions button', '← 바꿀 것 수정')
  await clickExact(c, '.switch-step-actions button', '← 바꿀 것 수정')
  await c.wait(`document.querySelector('.switch-change-additional-toggle')`, 'CHANGE re-entry')
  await c.wait(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')==='true'`, 'auto-expanded disclosure')
  const reentryState = await state(c)
  assert.equal(reentryState.change.lifeStage, 'kitten')
  assert.equal(await c.eval(`[...document.querySelectorAll('.switch-change-additional-content button')].some(n=>n.textContent.trim()==='키튼'&&n.getAttribute('aria-pressed')==='true')`), true)
  const reentryBeforeScroll = await c.eval('document.scrollingElement?.scrollTop||0')
  await makeExactVisible(c, '.switch-change-additional-content button', '키튼')
  const reentryAfterScroll = await c.eval('document.scrollingElement?.scrollTop||0')
  const kittenRect = await exactRect(c, '.switch-change-additional-content button', '키튼')
  assert.ok(kittenRect && kittenRect.top >= 8 && kittenRect.bottom <= 836, JSON.stringify(kittenRect))
  await c.shot('360-postdeploy-reentry-expanded.png')
  report.reentry = {
    expanded: true,
    lifeStage: reentryState.change.lifeStage,
    kittenPressed: true,
    screenshotPosition: { before: reentryBeforeScroll, after: reentryAfterScroll, additionalScroll: reentryAfterScroll - reentryBeforeScroll },
  }

  await makeVisible(c, '.switch-change-additional-toggle')
  if (await c.eval(`document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')==='true'`)) {
    await click(c, '.switch-change-additional-toggle')
  }
  await c.eval('document.activeElement?.blur?.()')
  const tabCount = await tabToDisclosure(c)
  const focus = await focusGeometry(c)
  const trustedTabs = await c.eval('window.__qaTabTrusted')
  assert.equal(focus.active, true)
  assert.equal(focus.outlineStyle, 'solid')
  assert.equal(focus.outlineWidth, '2px')
  assert.equal(focus.outlineOffset, '2px')
  assert.equal(focus.parentOverflow, 'visible')
  assert.equal(focus.clippedByParent, false)
  assert.ok(trustedTabs.length > 0 && trustedTabs.every(Boolean), JSON.stringify(trustedTabs))
  await c.shot('360-postdeploy-disclosure-focus.png')
  report.focus = { tabCount, trustedTabs, ...focus }

  report.network = await networkReport(c)
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR39_POSTDEPLOY_PASS', JSON.stringify(report))
} catch (error) {
  report.status = 'fail'
  report.error = String(error?.stack ?? error)
  try { report.network = await networkReport(c) } catch (networkError) { report.networkError = String(networkError) }
  try { await c.shot('360-postdeploy-failure.png') } catch {}
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  await cleanup(handle)
}
