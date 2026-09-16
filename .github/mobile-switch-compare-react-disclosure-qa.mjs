import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASELINE = process.env.BASELINE_URL ?? 'https://osrm.github.io/catfood_web/'
const TARGET = process.env.TARGET_URL ?? 'http://127.0.0.1:4173/'
const PRODUCT_SHA = process.env.PRODUCT_SHA
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
const q = JSON.stringify
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })
assert.ok(PRODUCT_SHA)

let launchIndex = 0
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
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch=window.fetch.bind(window)
      window.__qaBlocked={analytics:0,writes:0}
      window.__qaKeyEvents=[]
      const push=(event)=>window.__qaKeyEvents.push({type:event.type,key:event.key||null,code:event.code||null,trusted:event.isTrusted,target:event.target?.className||event.target?.tagName||null,expanded:document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')??null})
      window.addEventListener('keydown',push,true)
      window.addEventListener('keyup',push,true)
      window.addEventListener('click',push,true)
      window.fetch=(input,init={})=>{
        const url=typeof input==='string'?input:(input&&input.url)||''
        const method=String(init.method||(input&&input.method)||'GET').toUpperCase()
        if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}
        if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}
        return nativeFetch(input,init)
      }
    })();` })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
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
    await this.eval('document.fonts?.ready')
    await sleep(220)
  }
  async shot(name) {
    await this.eval('document.fonts?.ready'); await sleep(80)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile = true) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const index = launchIndex++
  const port = 17100 + (process.pid % 200) + index * 20
  const dir = `/tmp/compare-react-disclosure-${process.pid}-${index}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const c = new CDP(page.webSocketDebuggerUrl)
      await c.connect()
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
      return { c, proc, dir }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}

async function cleanup(handle) {
  handle.c.close(); handle.proc.kill('SIGTERM'); await sleep(80)
  if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL')
  try { rmSync(handle.dir, { recursive: true, force: true }) } catch {}
}

async function state(c) {
  return c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`)
}
function stableState(value) {
  return { currentProductId: value.currentProductId, variantSelection: value.variantSelection, compareIds: value.compareIds, compareOpen: value.compareOpen, compareTab: value.compareTab }
}

async function trustedPointClick(c, selector, matcher = null) {
  const point = await c.eval(`(()=>{
    const nodes=[...document.querySelectorAll(${q(selector)})]
    const node=${matcher ? `nodes.find(x=>x.textContent.includes(${q(matcher)}))` : 'nodes[0]'}
    if(!node)return null
    node.scrollIntoView({block:'center',inline:'nearest'})
    const r=node.getBoundingClientRect(),x=Math.max(3,Math.min(innerWidth-3,r.left+r.width/2)),y=Math.max(3,Math.min(innerHeight-3,r.top+r.height/2)),hit=document.elementFromPoint(x,y)
    if(!hit||!(hit===node||node.contains(hit)))return{blocked:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},hit:hit?.className||hit?.tagName}
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
  return c.eval(`(()=>{const n=document.activeElement,t=document.querySelector('.compare-mobile-candidate-toggle');const s=n?getComputedStyle(n):null;return{tag:n?.tagName??null,className:n?.className??null,text:n?.textContent?.replace(/\\s+/g,' ').trim()??null,expanded:t?.getAttribute('aria-expanded')??null,focusVisible:Boolean(t?.matches(':focus-visible')),outlineStyle:s?.outlineStyle??null,outlineWidth:s?.outlineWidth??null,scrollY}})()`)
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
  await sleep(140)
  return { before, after: await activeSnapshot(c), events: await c.eval('window.__qaKeyEvents') }
}

async function typeSearch(c, text) {
  await trustedPointClick(c, '.switch-find-search input')
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector('.switch-find-search input')?.value===${q(text)}`, 'typed search')
}

async function enterResults(c, base) {
  await c.nav(`${base}?view=workspace&mode=switch`)
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
  return c.eval(`[...document.querySelectorAll('.switch-candidate-row')].map((row,index)=>({index,brand:row.querySelector('.switch-candidate-identity span')?.textContent.trim()||'',name:row.querySelector('.switch-candidate-identity strong')?.textContent.trim()||''})).filter(x=>x.name)`)
}

function chooseSameBrandTwo(rows) {
  const groups = new Map()
  for (const row of rows) { const values = groups.get(row.brand) ?? []; values.push(row); groups.set(row.brand, values) }
  const group = [...groups.values()].filter((values) => values.length >= 2).sort((a,b) => (b[0].name.length+b[1].name.length)-(a[0].name.length+a[1].name.length))[0]
  assert.ok(group, 'same-brand candidate pair required')
  return group.slice(0, 2)
}
function chooseLongFive(rows) {
  const chosen = [...rows].sort((a,b) => b.name.length-a.name.length).slice(0, 5)
  assert.equal(chosen.length, 5)
  return chosen
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
async function prepare(c, base, count, strategy) {
  await enterResults(c, base)
  const rows = await inventory(c)
  const chosen = strategy === 'same-brand' ? chooseSameBrandTwo(rows) : chooseLongFive(rows)
  assert.equal(chosen.length, count)
  const stable = await addCandidates(c, chosen)
  await openCompare(c)
  return { chosen, stable }
}

async function pickerSnapshot(c) {
  return c.eval(`(()=>{
    const picker=document.querySelector('.compare-mobile-candidate-picker'),toggle=document.querySelector('.compare-mobile-candidate-toggle'),list=document.querySelector('.compare-mobile-candidate-options'),firstRow=document.querySelector('.compare-switch-mobile-overview .compare-mobile-overview-row')
    const rect=(n)=>n?(()=>{const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})():null
    const buttons=list?[...list.querySelectorAll('button[data-product-id]')].map(b=>({text:b.textContent.trim(),pressed:b.getAttribute('aria-pressed'),rect:rect(b),scrollWidth:b.scrollWidth,clientWidth:b.clientWidth,scrollHeight:b.scrollHeight,clientHeight:b.clientHeight,whiteSpace:getComputedStyle(b).whiteSpace})):[]
    return{picker:rect(picker),toggle:rect(toggle),expanded:toggle?.getAttribute('aria-expanded')??null,controls:toggle?.getAttribute('aria-controls')??null,list:rect(list),listHidden:list?.hidden??null,listScrollWidth:list?.scrollWidth??null,listClientWidth:list?.clientWidth??null,buttons,firstRow:rect(firstRow),activeText:buttons.find(x=>x.pressed==='true')?.text??null,activeElement:document.activeElement?.className||document.activeElement?.tagName,focusVisible:toggle?.matches(':focus-visible')??false,outline:toggle?getComputedStyle(toggle).outlineStyle:null}
  })()`)
}
async function oldPickerSnapshot(c) {
  return c.eval(`(()=>{const picker=document.querySelector('.compare-mobile-candidate-picker'),strip=picker?.querySelector(':scope > div'),firstRow=document.querySelector('.compare-switch-mobile-overview .compare-mobile-overview-row');const rect=n=>n?(()=>{const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})():null;return{picker:rect(picker),strip:rect(strip),scrollWidth:strip?.scrollWidth??null,clientWidth:strip?.clientWidth??null,firstRow:rect(firstRow),buttonCount:strip?.querySelectorAll('button').length??0}})()`)
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
  await c.eval(`document.activeElement?.blur()`)
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
  return { total: c.requests.length, supabaseGet: supabase.length, nonRead: nonRead.length, analyticsNetwork: analytics.length, blocked }
}

async function runBaseline390() {
  const handle = await launch(390, 900, true)
  try {
    const { chosen } = await prepare(handle.c, BASELINE, 5, 'long-five')
    const metrics = await oldPickerSnapshot(handle.c)
    assert.equal(metrics.buttonCount, 5)
    assert.ok(metrics.scrollWidth > metrics.clientWidth)
    return { chosen, metrics, network: await networkSummary(handle.c) }
  } finally { await cleanup(handle) }
}

async function run360() {
  const handle = await launch(360, 844, true)
  const diagnostics = { keyboard: [] }
  try {
    const { chosen, stable } = await prepare(handle.c, TARGET, 2, 'same-brand')
    await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')`, 'disclosure toggle')
    const closed = await pickerSnapshot(handle.c)
    assert.equal(closed.expanded, 'false'); assert.equal(closed.listHidden, true); assert.ok(closed.controls)
    await handle.c.shot('360-closed.png')

    await trustedPointClick(handle.c, '.compare-mobile-candidate-toggle')
    await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='true'`, 'open pointer')
    const open = await assertNamesFullyReadable(handle.c, chosen)
    await handle.c.shot('360-open.png')

    await trustedPointClick(handle.c, '.compare-mobile-candidate-options button', chosen[1].name)
    await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'close after pointer selection')
    await handle.c.wait(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.includes(${q(chosen[1].name)})`, 'second candidate displayed')
    const afterPointer = stableState(await state(handle.c))
    assert.deepEqual(afterPointer.compareIds, stable.compareIds); assert.equal(afterPointer.currentProductId, stable.currentProductId); assert.deepEqual(afterPointer.variantSelection, stable.variantSelection)

    const tabPath = await tabToToggle(handle.c)
    const enterOpen = await pressKey(handle.c, 'Enter', 'Enter', 13); diagnostics.keyboard.push({ action: 'toggle-enter-open', ...enterOpen })
    try { await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='true'`, 'keyboard open', 5000) }
    catch (error) { throw new Error(`${error.message}; diagnostic=${JSON.stringify(enterOpen)}`) }

    const optionTab = await pressKey(handle.c, 'Tab', 'Tab', 9); diagnostics.keyboard.push({ action: 'tab-to-option', ...optionTab })
    assert.ok(String(optionTab.after.className).includes('compare-mobile-candidate-options') || await handle.c.eval(`document.activeElement?.matches('.compare-mobile-candidate-options button')`), `option focus missing: ${JSON.stringify(optionTab)}`)
    const spaceSelect = await pressKey(handle.c, ' ', 'Space', 32); diagnostics.keyboard.push({ action: 'option-space-select', ...spaceSelect })
    try { await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'keyboard selection closes', 5000) }
    catch (error) { throw new Error(`${error.message}; diagnostic=${JSON.stringify(spaceSelect)}`) }
    const keyboardFocus = await pickerSnapshot(handle.c)
    assert.ok(String(keyboardFocus.activeElement).includes('compare-mobile-candidate-toggle'))
    assert.equal(keyboardFocus.focusVisible, true)
    assert.notEqual(keyboardFocus.outline, 'none')
    const selectedAfterKeyboard = await handle.c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.trim()`)

    const enterReopen = await pressKey(handle.c, 'Enter', 'Enter', 13); diagnostics.keyboard.push({ action: 'toggle-enter-reopen', ...enterReopen })
    await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='true'`, 'keyboard reopen', 5000)
    const beforeDirectClose = await handle.c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.trim()`)
    const spaceClose = await pressKey(handle.c, ' ', 'Space', 32); diagnostics.keyboard.push({ action: 'toggle-space-close', ...spaceClose })
    await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'keyboard direct close', 5000)
    const afterDirectClose = await handle.c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.trim()`)
    assert.equal(afterDirectClose, beforeDirectClose)

    await trustedPointClick(handle.c, '.compare-mobile-head-actions button', '상세 보기')
    await handle.c.wait(`document.querySelector('.detail-stage')`, 'detail')
    await trustedPointClick(handle.c, '.detail-topbar button')
    await handle.c.wait(`document.querySelector('.compare-stage.is-switch-overview')`, 'compare after detail')
    await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')`, 'toggle restored after detail')
    assert.equal(await handle.c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.trim()`), selectedAfterKeyboard)
    assert.deepEqual((await state(handle.c)).compareIds, stable.compareIds)

    await trustedPointClick(handle.c, '.compare-mobile-head-actions button', '비교에서 제거')
    await handle.c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});const s=raw?JSON.parse(raw).state:null;return s?.compareIds?.length===1})()`, '2 to 1')
    await handle.c.wait(`!document.querySelector('.compare-mobile-candidate-picker')`, 'picker omitted for one candidate')
    assert.ok(await handle.c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate strong')`))
    await trustedPointClick(handle.c, '.compare-mobile-head-actions button', '비교에서 제거')
    await handle.c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});const s=raw?JSON.parse(raw).state:null;return s?.compareIds?.length===0})()`, '1 to 0')
    await handle.c.wait(`!document.querySelector('.compare-stage')`, 'compare closes at zero')

    return { chosen, closed, open, afterPointer, tabPath, keyboardFocus, selectedAfterKeyboard, diagnostics, network: await networkSummary(handle.c) }
  } catch (error) {
    writeFileSync(`${OUT}/keyboard-diagnostic.json`, JSON.stringify({ error: error instanceof Error ? error.message : String(error), diagnostics }, null, 2))
    throw error
  } finally { await cleanup(handle) }
}

async function run390AndBoundaries() {
  const handle = await launch(390, 900, true)
  try {
    const { chosen, stable } = await prepare(handle.c, TARGET, 5, 'long-five')
    await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')`, '390 toggle')
    const closed = await pickerSnapshot(handle.c)
    await handle.c.shot('390-closed.png')
    await trustedPointClick(handle.c, '.compare-mobile-candidate-toggle')
    await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='true'`, '390 open')
    const open = await assertNamesFullyReadable(handle.c, chosen)
    assert.equal(open.buttons.filter((button) => button.pressed === 'true').length, 1)
    await handle.c.shot('390-open.png')
    const last = chosen[chosen.length - 1]
    await trustedPointClick(handle.c, '.compare-mobile-candidate-options button', last.name)
    await handle.c.wait(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.includes(${q(last.name)})`, 'last candidate displayed')
    await handle.c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'last selection closes')
    await handle.c.shot('390-last-selected.png')
    const after = stableState(await state(handle.c))
    assert.deepEqual(after.compareIds, stable.compareIds); assert.equal(after.currentProductId, stable.currentProductId); assert.deepEqual(after.variantSelection, stable.variantSelection)

    async function boundary(width, mobile) {
      await handle.c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: 900 })
      await handle.c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
      await sleep(240)
      return handle.c.eval(`(()=>{const t=document.querySelector('.compare-mobile-candidate-toggle'),mobile=document.querySelector('.compare-switch-mobile-overview'),desktop=document.querySelector('.compare-switch-overview-desktop'),wrap=document.querySelector('.compare-table-wrap');const visible=n=>{if(!n)return false;const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};return{width:innerWidth,toggleInDom:Boolean(t),toggleVisible:visible(t),mobileDisplay:mobile?getComputedStyle(mobile).display:null,desktopDisplay:desktop?getComputedStyle(desktop).display:null,wrapOverflowX:wrap?getComputedStyle(wrap).overflowX:null,desktopMinWidth:desktop?getComputedStyle(desktop).minWidth:null}})()`)
    }
    const at760 = await boundary(760, true)
    assert.equal(at760.toggleVisible, true); assert.notEqual(at760.mobileDisplay, 'none'); assert.equal(at760.desktopDisplay, 'none')
    const at761 = await boundary(761, false)
    assert.equal(at761.toggleVisible, false); assert.equal(at761.mobileDisplay, 'none'); assert.notEqual(at761.desktopDisplay, 'none')
    const at1280 = await boundary(1280, false)
    assert.equal(at1280.toggleVisible, false); assert.equal(at1280.mobileDisplay, 'none'); assert.notEqual(at1280.desktopDisplay, 'none')

    return { chosen, closed, open, lastSelected: last, stableAfter: after, boundaries: { at760, at761, at1280 }, network: await networkSummary(handle.c) }
  } finally { await cleanup(handle) }
}

const baseline390 = await runBaseline390()
const target360 = await run360()
const target390 = await run390AndBoundaries()
const heightComparison = {
  baselinePickerHeight: baseline390.metrics.picker?.height ?? null,
  targetClosedPickerHeight: target390.closed.picker?.height ?? null,
  pickerHeightDelta: baseline390.metrics.picker && target390.closed.picker ? target390.closed.picker.height - baseline390.metrics.picker.height : null,
  baselineFirstRowTop: baseline390.metrics.firstRow?.top ?? null,
  targetClosedFirstRowTop: target390.closed.firstRow?.top ?? null,
  firstRowTopDelta: baseline390.metrics.firstRow && target390.closed.firstRow ? target390.closed.firstRow.top - baseline390.metrics.firstRow.top : null,
}
const report = { productSha: PRODUCT_SHA, baselineUrl: BASELINE, targetUrl: TARGET, baseline390, target360, target390, heightComparison }
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log('MOBILE_SWITCH_COMPARE_REACT_DISCLOSURE_PASS')
console.log(JSON.stringify({ heightComparison, target360: { names: target360.chosen.map(x=>`${x.brand} · ${x.name}`), tabCount: target360.tabPath.count, keyboard: target360.diagnostics.keyboard }, target390: { names: target390.chosen.map(x=>`${x.brand} · ${x.name}`), last: target390.lastSelected, boundaries: target390.boundaries } }, null, 2))
