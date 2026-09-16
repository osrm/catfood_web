import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PAGE = process.env.PAGE_URL ?? 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.MERGE_SHA
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
const q = JSON.stringify
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })
assert.ok(MERGE_SHA)

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
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch=window.fetch.bind(window)
      window.__qaBlocked={analytics:0,writes:0}
      window.__qaKeyEvents=[]
      const push=(event)=>window.__qaKeyEvents.push({
        type:event.type,
        key:event.key||null,
        code:event.code||null,
        trusted:event.isTrusted,
        target:event.target?.className||event.target?.tagName||null,
        expanded:document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')??null
      })
      window.addEventListener('keydown',push,true)
      window.addEventListener('keyup',push,true)
      window.addEventListener('click',push,true)
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
        return nativeFetch(input,init)
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
    let result
    try {
      result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    } catch (error) {
      throw new Error(`Runtime.evaluate failed for ${expression.slice(0, 240)} :: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (result.exceptionDetails) {
      throw new Error(`${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}; expression=${expression.slice(0, 240)}`)
    }
    return result.result?.value
  }

  async wait(expression, label, timeout = 45000) {
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
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length`, 'root')
    await this.eval('document.fonts?.ready.then(()=>true)')
    await sleep(220)
  }

  async shot(name) {
    await this.eval('document.fonts?.ready.then(()=>true)')
    await sleep(80)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }

  close() {
    try { this.ws?.close() } catch {}
  }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const port = 17300 + (process.pid % 300)
  const dir = `/tmp/pr41-postdeploy-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
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
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      return { c, proc, dir }
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
  try { rmSync(handle.dir, { recursive: true, force: true }) } catch {}
}

async function state(c) {
  return c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`)
}

function stableState(value) {
  return {
    currentProductId: value.currentProductId,
    variantSelection: value.variantSelection,
    compareIds: value.compareIds,
    compareOpen: value.compareOpen,
    compareTab: value.compareTab,
  }
}

async function trustedPointClick(c, selector, matcher = null) {
  const point = await c.eval(`(()=>{
    const nodes=[...document.querySelectorAll(${q(selector)})]
    const node=${matcher ? `nodes.find(x=>x.textContent.includes(${q(matcher)}))` : 'nodes[0]'}
    if(!node)return null
    node.scrollIntoView({block:'center',inline:'nearest'})
    const r=node.getBoundingClientRect()
    const x=Math.max(3,Math.min(innerWidth-3,r.left+r.width/2))
    const y=Math.max(3,Math.min(innerHeight-3,r.top+r.height/2))
    const hit=document.elementFromPoint(x,y)
    if(!hit||!(hit===node||node.contains(hit))){
      return{blocked:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},hit:hit?.className||hit?.tagName}
    }
    window.__qaTrustedClick=null
    node.addEventListener('click',e=>window.__qaTrustedClick=e.isTrusted,{once:true,capture:true})
    return{x,y,text:node.textContent.trim(),rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}
  })()`)
  assert.ok(point && !point.blocked, `pointer unavailable ${selector} ${matcher ?? ''}: ${JSON.stringify(point)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(160)
  assert.equal(await c.eval('window.__qaTrustedClick'), true)
  return point
}

async function activeSnapshot(c) {
  return c.eval(`(()=>{
    const n=document.activeElement
    const t=document.querySelector('.compare-mobile-candidate-toggle')
    const s=n?getComputedStyle(n):null
    return{
      tag:n?.tagName??null,
      className:n?.className??null,
      text:n?.textContent?.replace(/\\s+/g,' ').trim()??null,
      expanded:t?.getAttribute('aria-expanded')??null,
      focusVisible:Boolean(t?.matches(':focus-visible')),
      outlineStyle:s?.outlineStyle??null,
      outlineWidth:s?.outlineWidth??null,
      scrollY
    }
  })()`)
}

async function pressKey(c, key, code, keyCode) {
  await c.eval('window.__qaKeyEvents=[]')
  const before = await activeSnapshot(c)
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  const down = { type: 'keyDown', ...common }
  if (key === 'Enter') Object.assign(down, { text: '\r', unmodifiedText: '\r' })
  if (key === ' ') Object.assign(down, { text: ' ', unmodifiedText: ' ' })
  await c.send('Input.dispatchKeyEvent', down)
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(160)
  return { before, after: await activeSnapshot(c), events: await c.eval('window.__qaKeyEvents') }
}

function assertTrustedActivation(result, label) {
  const down = result.events.find((event) => event.type === 'keydown')
  const up = result.events.find((event) => event.type === 'keyup')
  const click = result.events.find((event) => event.type === 'click')
  assert.equal(down?.trusted, true, `${label}: trusted keydown missing`)
  assert.equal(up?.trusted, true, `${label}: trusted keyup missing`)
  assert.equal(click?.trusted, true, `${label}: trusted click missing`)
}

async function typeSearch(c, text) {
  await trustedPointClick(c, '.switch-find-search input')
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector('.switch-find-search input')?.value===${q(text)}`, 'typed search')
}

async function enterResults(c) {
  await c.nav(`${PAGE}?view=workspace&mode=switch`)
  await c.wait(`document.querySelector('.switch-find-search input')`, 'search')
  await c.wait(`!document.body.innerText.includes('제품 목록을 불러오는 중입니다.')`, 'catalog')
  await typeSearch(c, 'AATU 연어')
  await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(x=>x.textContent.includes('AATU')&&x.textContent.includes('연어'))`, 'AATU result')
  await trustedPointClick(c, '.switch-find-result', '연어')
  await c.wait(`document.querySelector('.switch-current-preview')`, 'preview')
  await trustedPointClick(c, '.switch-current-preview .switch-primary-action')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'SKU options', 30000)
  await trustedPointClick(c, '.switch-sku-option', '1 kg')
  await trustedPointClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-no-change')`, 'CHANGE')
  await trustedPointClick(c, '.switch-no-change')
  await trustedPointClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'KEEP')
  await trustedPointClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-results-stage')`, 'RESULTS')
  assert.ok((await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)) >= 5)
}

async function inventory(c) {
  return c.eval(`[...document.querySelectorAll('.switch-candidate-row')].map((row,index)=>({
    index,
    brand:row.querySelector('.switch-candidate-identity span')?.textContent.trim()||'',
    name:row.querySelector('.switch-candidate-identity strong')?.textContent.trim()||''
  })).filter(x=>x.name)`)
}

function chooseSameBrandTwo(rows) {
  const groups = new Map()
  for (const row of rows) {
    const values = groups.get(row.brand) ?? []
    values.push(row)
    groups.set(row.brand, values)
  }
  const group = [...groups.values()]
    .filter((values) => values.length >= 2)
    .sort((a,b) => (b[0].name.length+b[1].name.length)-(a[0].name.length+a[1].name.length))[0]
  assert.ok(group, 'same-brand candidate pair required')
  return group.slice(0, 2)
}

async function addCandidates(c, chosen) {
  const base = stableState(await state(c))
  for (let i = 0; i < chosen.length; i++) {
    await trustedPointClick(c, '.switch-candidate-row', chosen[i].name)
    await c.wait(`document.querySelector('.switch-candidate-inspector h1')?.textContent.includes(${q(chosen[i].name)})`, `inspector ${i}`)
    await trustedPointClick(c, '.switch-inspector-actions .switch-compare-action', '비교에 추가')
    await c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});const s=raw?JSON.parse(raw).state:null;return s?.compareIds?.length===${i+1}})()`, `compare count ${i+1}`)
    await trustedPointClick(c, '.switch-preview-topline button')
    await c.wait(`!document.querySelector('.switch-candidate-inspector')`, `inspector closed ${i}`)
  }
  const after = stableState(await state(c))
  assert.equal(after.currentProductId, base.currentProductId)
  assert.deepEqual(after.variantSelection, base.variantSelection)
  assert.equal(after.compareIds.length, chosen.length)
  return after
}

async function openCompare(c) {
  await trustedPointClick(c, '.switch-compare-dock > button', '비교 보기')
  await c.wait(`document.querySelector('.compare-stage.is-switch-overview')`, 'switch compare overview')
  await sleep(180)
}

async function pickerSnapshot(c) {
  return c.eval(`(()=>{
    const picker=document.querySelector('.compare-mobile-candidate-picker')
    const toggle=document.querySelector('.compare-mobile-candidate-toggle')
    const list=document.querySelector('.compare-mobile-candidate-options')
    const rect=(n)=>n?(()=>{const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})():null
    const buttons=list?[...list.querySelectorAll('button[data-product-id]')].map(b=>({
      text:b.textContent.trim(),
      pressed:b.getAttribute('aria-pressed'),
      rect:rect(b),
      scrollWidth:b.scrollWidth,
      clientWidth:b.clientWidth,
      scrollHeight:b.scrollHeight,
      clientHeight:b.clientHeight,
      whiteSpace:getComputedStyle(b).whiteSpace
    })):[]
    return{
      picker:rect(picker),
      toggle:rect(toggle),
      toggleText:toggle?.textContent?.replace(/\\s+/g,' ').trim()??null,
      expanded:toggle?.getAttribute('aria-expanded')??null,
      controls:toggle?.getAttribute('aria-controls')??null,
      list:rect(list),
      listHidden:list?.hidden??null,
      listScrollWidth:list?.scrollWidth??null,
      listClientWidth:list?.clientWidth??null,
      buttons,
      activeText:buttons.find(x=>x.pressed==='true')?.text??null,
      activeElement:document.activeElement?.className||document.activeElement?.tagName,
      focusVisible:toggle?.matches(':focus-visible')??false,
      outlineStyle:toggle?getComputedStyle(toggle).outlineStyle:null,
      outlineWidth:toggle?getComputedStyle(toggle).outlineWidth:null,
      scrollY
    }
  })()`)
}

async function assertNamesFullyReadable(c, chosen) {
  const snapshot = await pickerSnapshot(c)
  assert.equal(snapshot.buttons.length, chosen.length)
  assert.ok(snapshot.list && !snapshot.listHidden)
  assert.ok(snapshot.listScrollWidth <= snapshot.listClientWidth + 1, `horizontal overflow: ${JSON.stringify(snapshot)}`)
  for (const item of chosen) {
    const button = snapshot.buttons.find((entry) => entry.text.includes(item.name))
    assert.ok(button, `missing full name: ${item.brand} · ${item.name}`)
    assert.ok(button.text.includes(item.brand) && button.text.includes(item.name))
    assert.notEqual(button.whiteSpace, 'nowrap')
    assert.ok(button.scrollWidth <= button.clientWidth + 1, `button horizontally clipped: ${button.text}`)
    assert.ok(button.scrollHeight <= button.clientHeight + 1, `button vertically clipped: ${button.text}`)
  }
  return snapshot
}

async function tabToToggle(c) {
  await c.eval(`document.activeElement?.blur(); true`)
  const sequence = []
  for (let i = 0; i < 12; i++) {
    const step = await pressKey(c, 'Tab', 'Tab', 9)
    sequence.push(step.after)
    if (String(step.after.className).includes('compare-mobile-candidate-toggle')) return { count: i + 1, sequence }
  }
  throw new Error(`Tab did not reach candidate toggle: ${JSON.stringify(sequence)}`)
}

async function networkSummary(c) {
  const blocked = await c.eval('window.__qaBlocked')
  const supabase = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co'))
  const nonRead = supabase.filter((request) => !['GET','HEAD','OPTIONS'].includes(request.method))
  const analytics = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  assert.equal(nonRead.length, 0)
  assert.equal(analytics.length, 0)
  assert.equal(blocked.writes, 0)
  return {
    total: c.requests.length,
    supabaseRead: supabase.length,
    nonRead: nonRead.length,
    analyticsNetwork: analytics.length,
    blocked,
  }
}

const handle = await launch()
const diagnostics = { keyboard: [] }
try {
  await enterResults(handle.c)
  const rows = await inventory(handle.c)
  const chosen = chooseSameBrandTwo(rows)
  assert.equal(chosen.length, 2)
  const stable = await addCandidates(handle.c, chosen)
  await openCompare(handle.c)
  await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')`, 'disclosure toggle')

  const initial = await pickerSnapshot(handle.c)
  assert.equal(initial.expanded, 'false')
  assert.equal(initial.listHidden, true)
  assert.ok(initial.controls)
  assert.ok(initial.toggleText.includes('후보 2개'))
  assert.ok(initial.toggleText.includes('1/2'))
  assert.ok(initial.toggleText.includes(chosen[0].brand))
  assert.ok(initial.toggleText.includes(chosen[0].name))

  await trustedPointClick(handle.c, '.compare-mobile-candidate-toggle')
  await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='true'`, 'pointer open')
  const pointerOpen = await assertNamesFullyReadable(handle.c, chosen)
  await handle.c.shot('360-open.png')

  await trustedPointClick(handle.c, '.compare-mobile-candidate-options button', chosen[1].name)
  await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'pointer selection closes')
  await handle.c.wait(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.includes(${q(chosen[1].name)})`, 'pointer candidate displayed')
  const pointerClosed = await pickerSnapshot(handle.c)
  assert.ok(pointerClosed.toggleText.includes('후보 2개'))
  assert.ok(pointerClosed.toggleText.includes('2/2'))
  assert.ok(pointerClosed.toggleText.includes(chosen[1].name))
  const afterPointerState = stableState(await state(handle.c))
  assert.equal(afterPointerState.currentProductId, stable.currentProductId)
  assert.deepEqual(afterPointerState.variantSelection, stable.variantSelection)
  assert.deepEqual(afterPointerState.compareIds, stable.compareIds)
  await handle.c.shot('360-pointer-selected.png')

  const tabPath = await tabToToggle(handle.c)
  const beforeKeyboardScroll = tabPath.sequence[tabPath.sequence.length - 1].scrollY
  const enterOpen = await pressKey(handle.c, 'Enter', 'Enter', 13)
  diagnostics.keyboard.push({ action: 'toggle-enter-open', ...enterOpen })
  assertTrustedActivation(enterOpen, 'toggle Enter')
  assert.equal(enterOpen.before.expanded, 'false')
  await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='true'`, 'keyboard Enter opens', 5000)

  const optionTab = await pressKey(handle.c, 'Tab', 'Tab', 9)
  diagnostics.keyboard.push({ action: 'tab-to-option', ...optionTab })
  assert.equal(await handle.c.eval(`Boolean(document.activeElement?.matches('.compare-mobile-candidate-options button'))`), true)

  const spaceSelect = await pressKey(handle.c, ' ', 'Space', 32)
  diagnostics.keyboard.push({ action: 'option-space-select', ...spaceSelect })
  assertTrustedActivation(spaceSelect, 'candidate Space')
  await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'keyboard Space selection closes', 5000)
  await handle.c.wait(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.includes(${q(chosen[0].name)})`, 'keyboard candidate displayed')

  const keyboardClosed = await pickerSnapshot(handle.c)
  assert.ok(String(keyboardClosed.activeElement).includes('compare-mobile-candidate-toggle'))
  assert.equal(keyboardClosed.focusVisible, true)
  assert.notEqual(keyboardClosed.outlineStyle, 'none')
  assert.ok(Math.abs(keyboardClosed.scrollY - beforeKeyboardScroll) <= 1, `unexpected focus scroll jump: ${beforeKeyboardScroll} -> ${keyboardClosed.scrollY}`)
  assert.ok(keyboardClosed.toggleText.includes('1/2'))
  assert.ok(keyboardClosed.toggleText.includes(chosen[0].name))

  const afterKeyboardState = stableState(await state(handle.c))
  assert.equal(afterKeyboardState.currentProductId, stable.currentProductId)
  assert.deepEqual(afterKeyboardState.variantSelection, stable.variantSelection)
  assert.deepEqual(afterKeyboardState.compareIds, stable.compareIds)
  await handle.c.shot('360-keyboard-selected.png')

  const network = await networkSummary(handle.c)
  const report = {
    status: 'pass',
    mergeSha: MERGE_SHA,
    page: PAGE,
    viewport: { width: 360, height: 844 },
    current: {
      currentProductId: stable.currentProductId,
      variantSelection: stable.variantSelection,
      compareIds: stable.compareIds,
    },
    chosen,
    initial,
    pointer: {
      open: pointerOpen,
      closed: pointerClosed,
      state: afterPointerState,
    },
    keyboard: {
      tabPath,
      beforeScrollY: beforeKeyboardScroll,
      enterOpen,
      optionTab,
      spaceSelect,
      closed: keyboardClosed,
      state: afterKeyboardState,
    },
    network,
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR41_POSTDEPLOY_360_PASS')
  console.log(JSON.stringify({
    current: report.current,
    chosen: chosen.map((item) => `${item.brand} · ${item.name}`),
    pointer: { initial: initial.toggleText, selected: pointerClosed.toggleText, horizontalOverflow: pointerOpen.listScrollWidth > pointerOpen.listClientWidth + 1 },
    keyboard: { tabCount: tabPath.count, beforeScrollY: beforeKeyboardScroll, afterScrollY: keyboardClosed.scrollY, selected: keyboardClosed.toggleText },
    network,
  }, null, 2))
} catch (error) {
  writeFileSync(`${OUT}/diagnostic.json`, JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    active: await activeSnapshot(handle.c).catch(() => null),
    keyboard: diagnostics.keyboard,
    blocked: await handle.c.eval('window.__qaBlocked').catch(() => null),
  }, null, 2))
  throw error
} finally {
  await cleanup(handle)
}
