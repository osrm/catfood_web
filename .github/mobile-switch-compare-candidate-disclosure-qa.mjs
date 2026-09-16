import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASELINE = process.env.BASELINE_URL ?? 'https://osrm.github.io/catfood_web/'
const TARGET = process.env.TARGET_URL ?? 'http://127.0.0.1:4173/catfood_web/'
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
    await sleep(250)
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
  const port = 17000 + (process.pid % 300) + index * 20
  const dir = `/tmp/mobile-compare-disclosure-${process.pid}-${index}`
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
  handle.c.close(); handle.proc.kill('SIGTERM'); await sleep(100)
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

async function trustedPointClick(c, selector, matcher = null, allowScrollIntoView = true) {
  const point = await c.eval(`(()=>{
    const nodes=[...document.querySelectorAll(${q(selector)})]
    const node=${matcher ? `nodes.find(x=>x.textContent.includes(${q(matcher)}))` : 'nodes[0]'}
    if(!node)return null
    if(${allowScrollIntoView ? 'true' : 'false'})node.scrollIntoView({block:'center',inline:'nearest'})
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
  await sleep(140)
  assert.equal(await c.eval('window.__qaTrustedClick'), true)
  return point
}

async function pressKey(c, key, code, keyCode, text = '') {
  const payload = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) }
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload })
  await sleep(90)
}

async function typeSearch(c, text) {
  await trustedPointClick(c, '.switch-find-search input')
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 })
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
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'SKU options')
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

async function candidateRows(c) {
  return c.eval(`[...document.querySelectorAll('.switch-candidate-row')].map((row,index)=>({index,brand:row.querySelector('.switch-candidate-identity span')?.textContent.trim()||'',name:row.querySelector('.switch-candidate-identity strong')?.textContent.trim()||''})).filter(x=>x.name)`)
}

function sameBrandPair(rows) {
  const grouped = new Map()
  rows.forEach((row) => { const arr = grouped.get(row.brand) ?? []; arr.push(row); grouped.set(row.brand, arr) })
  const pair = [...grouped.values()].find((group) => group.length >= 2)
  assert.ok(pair, 'same-brand candidate pair not found in visible results')
  return pair.slice(0, 2)
}

function longestFive(rows) {
  const selected = [...rows].sort((a, b) => b.name.length - a.name.length || a.index - b.index).slice(0, 5)
  assert.equal(selected.length, 5)
  return selected
}

async function addCandidate(c, candidate) {
  const before = stableState(await state(c))
  assert.ok(!before.compareIds.includes(candidate.productId ?? ''))
  await trustedPointClick(c, '.switch-candidate-row', candidate.name)
  await c.wait(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()===${q(candidate.name)}`, `inspector ${candidate.name}`)
  await trustedPointClick(c, '.switch-inspector-actions .switch-compare-action', '비교에 추가')
  await c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});const s=raw?JSON.parse(raw).state:null;return s&&s.compareIds.length===${before.compareIds.length + 1}})()`, 'compare id added')
  const after = stableState(await state(c))
  assert.deepEqual({ currentProductId: after.currentProductId, variantSelection: after.variantSelection }, { currentProductId: before.currentProductId, variantSelection: before.variantSelection })
  await trustedPointClick(c, '.switch-preview-topline button')
  await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'inspector closed')
  return after.compareIds.at(-1)
}

async function addCandidates(c, candidates) {
  const resolved = []
  for (const candidate of candidates) resolved.push({ ...candidate, productId: await addCandidate(c, candidate) })
  return resolved
}

async function openCompare(c) {
  await trustedPointClick(c, '.switch-compare-dock > button', '비교 보기')
  await c.wait(`document.querySelector('.compare-stage.is-switch-overview')`, 'compare overview')
  await c.wait(`document.querySelector('.compare-switch-mobile-overview')`, 'mobile compare overview')
  const s = stableState(await state(c))
  assert.equal(s.compareOpen, true)
  assert.equal(s.compareTab, 'overview')
  return s
}

async function networkSummary(c) {
  const blocked = await c.eval('window.__qaBlocked')
  const supabase = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co'))
  const nonRead = supabase.filter((request) => !['GET','HEAD','OPTIONS'].includes(request.method))
  assert.equal(nonRead.length, 0, `non-read Supabase requests: ${JSON.stringify(nonRead)}`)
  assert.equal(blocked?.writes ?? 0, 0)
  return { total: c.requests.length, supabase: supabase.length, nonRead: nonRead.length, blocked }
}

async function baseline360() {
  const handle = await launch(360, 844, true)
  const { c } = handle
  try {
    await enterResults(c, BASELINE)
    const rows = await candidateRows(c)
    const chosen = sameBrandPair(rows)
    await addCandidates(c, chosen)
    await openCompare(c)
    const metrics = await c.eval(`(()=>{
      const picker=document.querySelector('.compare-mobile-candidate-picker')
      const first=document.querySelector('.compare-mobile-overview-row')
      const strip=picker?.querySelector(':scope > div')
      const pr=picker?.getBoundingClientRect(),fr=first?.getBoundingClientRect()
      return {pickerHeight:pr?.height??null,pickerTop:pr?.top??null,firstRowTop:fr?.top??null,stripClientWidth:strip?.clientWidth??null,stripScrollWidth:strip?.scrollWidth??null}
    })()`)
    await c.shot('360-baseline-existing-picker.png')
    return { candidates: chosen, metrics, network: await networkSummary(c) }
  } finally { await cleanup(handle) }
}

async function target360() {
  const handle = await launch(360, 844, true)
  const { c } = handle
  try {
    await enterResults(c, TARGET)
    const chosen = sameBrandPair(await candidateRows(c))
    const added = await addCandidates(c, chosen)
    const openedState = await openCompare(c)
    assert.deepEqual(openedState.compareIds, added.map((item) => item.productId))

    const closed = await c.eval(`(()=>{
      const toggle=document.querySelector('.compare-mobile-candidate-toggle'),picker=document.querySelector('.compare-mobile-candidate-picker'),first=document.querySelector('.compare-mobile-overview-row')
      const tr=toggle?.getBoundingClientRect(),pr=picker?.getBoundingClientRect(),fr=first?.getBoundingClientRect()
      return {expanded:toggle?.getAttribute('aria-expanded'),controls:toggle?.getAttribute('aria-controls'),text:toggle?.textContent.trim(),toggleHeight:tr?.height??null,pickerHeight:pr?.height??null,firstRowTop:fr?.top??null,options:Boolean(document.querySelector('.compare-mobile-candidate-options'))}
    })()`)
    assert.equal(closed.expanded, 'false')
    assert.equal(closed.options, false)
    assert.ok(closed.text.includes('후보 2개'))
    assert.ok(closed.text.includes('1/2'))
    assert.ok(closed.text.includes(chosen[0].brand) && closed.text.includes(chosen[0].name))
    await c.shot('360-target-closed-2.png')

    await trustedPointClick(c, '.compare-mobile-candidate-toggle')
    await c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='true'`, 'picker open')
    const expanded = await c.eval(`(()=>{
      const box=document.querySelector('.compare-mobile-candidate-options'),r=box?.getBoundingClientRect(),buttons=[...document.querySelectorAll('.compare-mobile-candidate-option')]
      return {clientWidth:box?.clientWidth??null,scrollWidth:box?.scrollWidth??null,buttons:buttons.map(b=>{const br=b.getBoundingClientRect(),strong=b.querySelector('strong'),s=strong?getComputedStyle(strong):null;return{text:b.textContent.trim(),pressed:b.getAttribute('aria-pressed'),left:br.left,right:br.right,whiteSpace:s?.whiteSpace,textOverflow:s?.textOverflow,lineClamp:s?.webkitLineClamp}}),rect:r?{left:r.left,right:r.right}:null}
    })()`)
    assert.equal(expanded.buttons.length, 2)
    assert.ok(expanded.buttons[0].text.includes(chosen[0].brand) && expanded.buttons[0].text.includes(chosen[0].name))
    assert.ok(expanded.buttons[1].text.includes(chosen[1].brand) && expanded.buttons[1].text.includes(chosen[1].name))
    assert.deepEqual(expanded.buttons.map((button) => button.pressed), ['true','false'])
    assert.ok(expanded.scrollWidth <= expanded.clientWidth + 1)
    expanded.buttons.forEach((button) => { assert.equal(button.whiteSpace, 'normal'); assert.notEqual(button.textOverflow, 'ellipsis'); assert.ok(button.left >= expanded.rect.left - 1 && button.right <= expanded.rect.right + 1) })
    await c.shot('360-target-expanded-2.png')

    const beforePointer = stableState(await state(c))
    await trustedPointClick(c, '.compare-mobile-candidate-option', chosen[1].name)
    await c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'picker closed after pointer selection')
    const afterPointer = stableState(await state(c))
    assert.deepEqual(afterPointer, beforePointer, 'displayed candidate selection must not alter SWITCH session state')
    assert.ok(await c.eval(`document.querySelector('.compare-mobile-candidate-toggle')?.textContent.includes(${q(chosen[1].name)})`))
    assert.ok(await c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate')?.textContent.includes(${q(chosen[1].name)})`))

    await c.eval('document.activeElement?.blur()')
    let reachedToggle = false
    for (let i = 0; i < 20; i++) {
      await pressKey(c, 'Tab', 'Tab', 9)
      if (await c.eval(`document.activeElement?.classList.contains('compare-mobile-candidate-toggle')`)) { reachedToggle = true; break }
    }
    assert.equal(reachedToggle, true, 'real Tab should reach disclosure toggle')
    await pressKey(c, 'Enter', 'Enter', 13)
    await c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='true'`, 'keyboard open')
    await pressKey(c, 'Tab', 'Tab', 9)
    await pressKey(c, 'Tab', 'Tab', 9)
    assert.equal(await c.eval(`document.activeElement?.classList.contains('compare-mobile-candidate-option') && document.activeElement?.textContent.includes(${q(chosen[1].name)})`), true)
    await pressKey(c, ' ', 'Space', 32, ' ')
    await c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'keyboard select closes')
    const focus = await c.eval(`(()=>{const t=document.querySelector('.compare-mobile-candidate-toggle'),s=t?getComputedStyle(t):null;return{active:document.activeElement===t,focusVisible:t?.matches(':focus-visible')??false,outlineWidth:s?.outlineWidth,outlineStyle:s?.outlineStyle,text:t?.textContent.trim()}})()`)
    assert.equal(focus.active, true)
    assert.equal(focus.focusVisible, true)
    assert.notEqual(focus.outlineStyle, 'none')
    assert.notEqual(focus.outlineWidth, '0px')

    const beforeDirectClose = focus.text
    await pressKey(c, 'Enter', 'Enter', 13)
    await c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='true'`, 'keyboard reopen')
    await pressKey(c, ' ', 'Space', 32, ' ')
    await c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'keyboard direct close')
    assert.equal(await c.eval(`document.querySelector('.compare-mobile-candidate-toggle')?.textContent.trim()`), beforeDirectClose)

    const selectedName = chosen[1].name
    await trustedPointClick(c, '.compare-mobile-head-actions button', '상세 보기')
    await c.wait(`document.querySelector('.detail-stage')`, 'detail open')
    assert.ok(await c.eval(`document.querySelector('.detail-identity h1')?.textContent.includes(${q(selectedName)})`))
    await trustedPointClick(c, '.detail-topbar button', '돌아가기')
    await c.wait(`document.querySelector('.compare-switch-mobile-overview')`, 'detail return')
    assert.ok(await c.eval(`document.querySelector('.compare-mobile-candidate-toggle')?.textContent.includes(${q(selectedName)})`))

    await trustedPointClick(c, '.compare-mobile-head-actions button', '비교에서 제거')
    await c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});const s=raw?JSON.parse(raw).state:null;return s?.compareIds?.length===1})()`, '2 to 1')
    assert.equal(await c.eval(`Boolean(document.querySelector('.compare-mobile-candidate-picker'))`), false)
    const remainingName = chosen[0].name
    assert.ok(await c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate')?.textContent.includes(${q(remainingName)})`))
    await trustedPointClick(c, '.compare-mobile-head-actions button', '비교에서 제거')
    await c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});const s=raw?JSON.parse(raw).state:null;return s?.compareIds?.length===0 && s?.compareOpen===false})()`, '1 to 0')
    await c.wait(`document.querySelector('.switch-results-stage')`, 'results after zero compare')

    return { candidates: chosen, closed, expanded, focus, stateAfterZero: stableState(await state(c)), network: await networkSummary(c) }
  } finally { await cleanup(handle) }
}

async function target390Five() {
  const handle = await launch(390, 900, true)
  const { c } = handle
  try {
    await enterResults(c, TARGET)
    const chosen = longestFive(await candidateRows(c))
    const added = await addCandidates(c, chosen)
    const opened = await openCompare(c)
    assert.deepEqual(opened.compareIds, added.map((item) => item.productId))
    await c.shot('390-target-closed-5.png')
    const closed = await c.eval(`(()=>{const t=document.querySelector('.compare-mobile-candidate-toggle'),r=t?.getBoundingClientRect(),first=document.querySelector('.compare-mobile-overview-row')?.getBoundingClientRect();return{text:t?.textContent.trim(),height:r?.height??null,firstRowTop:first?.top??null,expanded:t?.getAttribute('aria-expanded')}})()`)
    assert.equal(closed.expanded, 'false')
    assert.ok(closed.text.includes('후보 5개') && closed.text.includes('1/5'))

    await trustedPointClick(c, '.compare-mobile-candidate-toggle')
    await c.wait(`document.querySelectorAll('.compare-mobile-candidate-option').length===5`, 'five options')
    const open = await c.eval(`(()=>{const box=document.querySelector('.compare-mobile-candidate-options'),r=box.getBoundingClientRect(),buttons=[...box.querySelectorAll('.compare-mobile-candidate-option')];return{clientWidth:box.clientWidth,scrollWidth:box.scrollWidth,docClientWidth:document.documentElement.clientWidth,docScrollWidth:document.documentElement.scrollWidth,buttons:buttons.map(b=>{const br=b.getBoundingClientRect(),strong=b.querySelector('strong'),s=getComputedStyle(strong);return{text:b.textContent.trim(),pressed:b.getAttribute('aria-pressed'),left:br.left,right:br.right,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,lineClamp:s.webkitLineClamp}}),rect:{left:r.left,right:r.right}}})()`)
    assert.equal(open.buttons.length, 5)
    assert.equal(open.buttons.filter((button) => button.pressed === 'true').length, 1)
    assert.ok(open.scrollWidth <= open.clientWidth + 1, `options should not require horizontal scrolling: ${JSON.stringify(open)}`)
    assert.ok(open.docScrollWidth <= open.docClientWidth + 1, `document should not require horizontal scrolling: ${JSON.stringify(open)}`)
    chosen.forEach((candidate, index) => {
      const button = open.buttons[index]
      assert.ok(button.text.includes(candidate.brand) && button.text.includes(candidate.name), `full candidate name missing: ${candidate.name}`)
      assert.equal(button.whiteSpace, 'normal')
      assert.notEqual(button.textOverflow, 'ellipsis')
      assert.ok(button.left >= open.rect.left - 1 && button.right <= open.rect.right + 1)
    })
    await c.shot('390-target-expanded-5.png')

    const before = stableState(await state(c))
    const last = chosen.at(-1)
    await trustedPointClick(c, '.compare-mobile-candidate-option', last.name)
    await c.wait(`document.querySelector('.compare-mobile-candidate-toggle')?.getAttribute('aria-expanded')==='false'`, 'last selected')
    const after = stableState(await state(c))
    assert.deepEqual(after, before)
    assert.ok(await c.eval(`document.querySelector('.compare-mobile-candidate-toggle')?.textContent.includes('5/5') && document.querySelector('.compare-mobile-candidate-toggle')?.textContent.includes(${q(last.name)})`))
    assert.ok(await c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate')?.textContent.includes(${q(last.name)})`))
    assert.equal(await c.eval(`document.activeElement?.classList.contains('compare-mobile-candidate-toggle')`), true)
    await c.shot('390-target-selected-last.png')
    return { candidates: chosen, closed, open, selected: last, state: after, network: await networkSummary(c) }
  } finally { await cleanup(handle) }
}

async function targetBoundaries() {
  const handle = await launch(760, 900, true)
  const { c } = handle
  try {
    await enterResults(c, TARGET)
    const chosen = sameBrandPair(await candidateRows(c))
    await addCandidates(c, chosen)
    await openCompare(c)
    const inspect = async () => c.eval(`(()=>{const mobile=document.querySelector('.compare-switch-mobile-overview'),desktop=document.querySelector('.compare-switch-overview-desktop'),toggle=document.querySelector('.compare-mobile-candidate-toggle'),wrap=document.querySelector('.compare-table-wrap');return{width:innerWidth,mobileDisplay:mobile?getComputedStyle(mobile).display:null,desktopDisplay:desktop?getComputedStyle(desktop).display:null,toggleDisplay:toggle?getComputedStyle(toggle).display:null,wrapOverflowX:wrap?getComputedStyle(wrap).overflowX:null,compareIds:JSON.parse(sessionStorage.getItem(${q(STORAGE)})).state.compareIds}})()`)
    const w760 = await inspect()
    assert.notEqual(w760.mobileDisplay, 'none'); assert.equal(w760.desktopDisplay, 'none'); assert.ok(w760.toggleDisplay && w760.toggleDisplay !== 'none')
    await c.send('Emulation.setDeviceMetricsOverride', { width: 761, height: 900, deviceScaleFactor: 1, mobile: true, screenWidth: 761, screenHeight: 900 }); await sleep(180)
    const w761 = await inspect()
    assert.equal(w761.mobileDisplay, 'none'); assert.notEqual(w761.desktopDisplay, 'none'); assert.equal(w761.toggleDisplay, 'none')
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1280, screenHeight: 900 }); await c.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 }); await sleep(180)
    const w1280 = await inspect()
    assert.equal(w1280.mobileDisplay, 'none'); assert.notEqual(w1280.desktopDisplay, 'none'); assert.equal(w1280.toggleDisplay, 'none')
    assert.deepEqual(w760.compareIds, w761.compareIds); assert.deepEqual(w761.compareIds, w1280.compareIds)
    return { w760, w761, w1280, network: await networkSummary(c) }
  } finally { await cleanup(handle) }
}

const report = {
  productSha: PRODUCT_SHA,
  baselineUrl: BASELINE,
  targetUrl: TARGET,
  baseline360: await baseline360(),
  target360: await target360(),
  target390Five: await target390Five(),
  boundaries: await targetBoundaries(),
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log('MOBILE_SWITCH_COMPARE_CANDIDATE_DISCLOSURE_PASS')
console.log(JSON.stringify(report, null, 2))
