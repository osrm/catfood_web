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
    // Installed before the first navigation in every browser instance.
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
  async wait(expression, label, timeout = 40000) {
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

async function launch(width, height, mobile) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const index = launchIndex++
  const port = 16000 + (process.pid % 200) + index * 20
  const dir = `/tmp/compare-dock-clearance-${process.pid}-${index}`
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
  rmSync(handle.dir, { recursive: true, force: true })
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
  await sleep(130)
  assert.equal(await c.eval('window.__qaTrustedClick'), true)
  return point
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

async function pressKey(c, key, code, keyCode, modifiers = 0, text = '') {
  const payload = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) }
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload })
  await sleep(45)
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
  assert.ok((await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)) > 0)
}

async function addFirstCandidate(c) {
  const initial = await c.eval(`(()=>{const row=document.querySelector('.switch-candidate-row');return{brand:row?.querySelector('.switch-candidate-identity span')?.textContent.trim(),name:row?.querySelector('.switch-candidate-identity strong')?.textContent.trim()}})()`)
  assert.ok(initial.name)
  await trustedPointClick(c, '.switch-candidate-row')
  await c.wait(`document.querySelector('.switch-candidate-inspector h1')`, 'inspector')
  const inspectorName = await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
  assert.equal(inspectorName, initial.name)
  await trustedPointClick(c, '.switch-inspector-actions .switch-compare-action', '비교에 추가')
  await c.wait(`document.querySelector('.switch-compare-dock')`, 'compare dock')
  const afterAdd = stableState(await state(c))
  assert.equal(afterAdd.compareIds.length, 1)
  const candidateId = afterAdd.compareIds[0]
  await trustedPointClick(c, '.switch-preview-topline button')
  await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'inspector closed')
  return { ...initial, productId: candidateId, stable: afterAdd }
}

function ownerExpression(selector) {
  return `(()=>{const n=document.querySelector(${q(selector)});if(!n)return null;for(let p=n.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(/auto|scroll/.test(s.overflowY)&&p.scrollHeight>p.clientHeight+1)return p}return document.scrollingElement})()`
}

async function ownerSnapshot(c, selector) {
  return c.eval(`(()=>{const o=${ownerExpression(selector)};if(!o)return null;const r=o===document.scrollingElement?{left:0,right:innerWidth,top:0,bottom:innerHeight}:o.getBoundingClientRect();return{tag:o.tagName,className:o.className,scrollTop:o.scrollTop,scrollHeight:o.scrollHeight,clientHeight:o.clientHeight,maxScroll:o.scrollHeight-o.clientHeight,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}}})()`)
}

async function wheel(c, x, y, deltaY) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 0, pointerType: 'mouse' })
  await sleep(70)
}

async function wheelToEnd(c, selector) {
  let last = null
  for (let i = 0; i < 30; i++) {
    const owner = await ownerSnapshot(c, selector)
    assert.ok(owner)
    if (owner.maxScroll - owner.scrollTop <= 1) return owner
    const x = Math.max(4, Math.min(outerWidth - 4, (owner.rect.left + owner.rect.right) / 2))
    const y = Math.max(4, Math.min(innerHeight - 4, (owner.rect.top + owner.rect.bottom) / 2))
    await wheel(c, x, y, 5000)
    const after = await ownerSnapshot(c, selector)
    if (last === after.scrollTop && after.scrollTop < after.maxScroll) throw new Error(`scroll owner stalled for ${selector}`)
    last = after.scrollTop
  }
  const final = await ownerSnapshot(c, selector)
  assert.ok(final.maxScroll - final.scrollTop <= 1, `did not reach scroll end: ${JSON.stringify(final)}`)
  return final
}

async function wheelToStart(c, selector) {
  for (let i = 0; i < 30; i++) {
    const owner = await ownerSnapshot(c, selector)
    assert.ok(owner)
    if (owner.scrollTop <= 1) return owner
    const x = Math.max(4, Math.min(innerWidth - 4, (owner.rect.left + owner.rect.right) / 2))
    const y = Math.max(4, Math.min(innerHeight - 4, (owner.rect.top + owner.rect.bottom) / 2))
    await wheel(c, x, y, -5000)
  }
  return ownerSnapshot(c, selector)
}

async function inspectLoadMore(c) {
  return c.eval(`(()=>{
    const b=document.querySelector('.load-more'),d=document.querySelector('.switch-compare-dock'),stage=document.querySelector('.switch-results-stage'),list=document.querySelector('.switch-candidate-list'),inspector=document.querySelector('.switch-inspector-scroll')
    if(!b||!d)return null
    const br=b.getBoundingClientRect(),dr=d.getBoundingClientRect(),x=br.left+br.width/2,y=br.top+br.height/2,hit=document.elementFromPoint(x,y),owner=${ownerExpression('.load-more')}
    const pseudo=n=>n?{content:getComputedStyle(n,'::after').content,height:getComputedStyle(n,'::after').height}:null
    return{buttonRect:{top:br.top,bottom:br.bottom,left:br.left,right:br.right,width:br.width,height:br.height},dockRect:{top:dr.top,bottom:dr.bottom,left:dr.left,right:dr.right,width:dr.width,height:dr.height},gap:dr.top-br.bottom,fullyAboveDock:br.bottom<=dr.top,fullyInViewport:br.top>=0&&br.bottom<=innerHeight,point:{x,y},hit:hit?{tag:hit.tagName,className:typeof hit.className==='string'?hit.className:'',text:hit.textContent?.trim().slice(0,90)??''}:null,pointerAccessible:Boolean(hit&&(hit===b||b.contains(hit))),owner:{tag:owner.tagName,className:owner.className,scrollTop:owner.scrollTop,scrollHeight:owner.scrollHeight,clientHeight:owner.clientHeight,maxScroll:owner.scrollHeight-owner.clientHeight},stagePaddingBottom:getComputedStyle(stage).paddingBottom,listAfter:pseudo(list),inspectorAfter:pseudo(inspector),rowCount:document.querySelectorAll('.switch-candidate-row').length}
  })()`)
}

async function clickLoadMoreAtCenter(c) {
  const beforeCount = await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)
  const beforeState = stableState(await state(c))
  const evidence = await inspectLoadMore(c)
  assert.ok(evidence?.pointerAccessible)
  await c.eval(`(()=>{const b=document.querySelector('.load-more');window.__qaLoadMoreClick=null;b.addEventListener('click',e=>window.__qaLoadMoreClick=e.isTrusted,{once:true,capture:true})})()`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: evidence.point.x, y: evidence.point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: evidence.point.x, y: evidence.point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: evidence.point.x, y: evidence.point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await c.wait(`document.querySelectorAll('.switch-candidate-row').length>${beforeCount}`, 'load-more rows increased')
  assert.equal(await c.eval('window.__qaLoadMoreClick'), true)
  const afterCount = await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)
  const afterState = stableState(await state(c))
  assert.deepEqual(afterState, beforeState)
  return { beforeCount, afterCount, trusted: true, beforeState, afterState }
}

async function elementEvidence(c, selector, matcher = null) {
  return c.eval(`(()=>{const xs=[...document.querySelectorAll(${q(selector)})],n=${matcher ? `xs.find(x=>x.textContent.includes(${q(matcher)}))` : 'xs[0]'};if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(Math.max(2,Math.min(innerWidth-2,x)),Math.max(2,Math.min(innerHeight-2,y)));return{rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},inViewport:r.top>=0&&r.bottom<=innerHeight,hit:hit?{tag:hit.tagName,className:typeof hit.className==='string'?hit.className:'',text:hit.textContent?.trim().slice(0,80)??''}:null,pointerAccessible:Boolean(hit&&(hit===n||n.contains(hit)))}})()`)
}

async function wheelUntilVisible(c, selector, matcher = null) {
  for (let i = 0; i < 30; i++) {
    const evidence = await elementEvidence(c, selector, matcher)
    assert.ok(evidence)
    if (evidence.inViewport && evidence.pointerAccessible) return evidence
    const nodeTop = evidence.rect.top
    const owner = await ownerSnapshot(c, selector)
    assert.ok(owner)
    const x = Math.max(4, Math.min(innerWidth - 4, (owner.rect.left + owner.rect.right) / 2))
    const y = Math.max(4, Math.min(innerHeight - 4, (owner.rect.top + owner.rect.bottom) / 2))
    await wheel(c, x, y, nodeTop < 0 ? -800 : 800)
  }
  throw new Error(`could not reach ${selector}`)
}

async function inspectClearanceState(c) {
  return c.eval(`(()=>{const stage=document.querySelector('.switch-results-stage'),list=document.querySelector('.switch-candidate-list'),inspector=document.querySelector('.switch-inspector-scroll'),dock=document.querySelector('.switch-compare-dock'),pseudo=n=>n?{content:getComputedStyle(n,'::after').content,height:getComputedStyle(n,'::after').height}:null;return{dock:Boolean(dock),stagePaddingBottom:getComputedStyle(stage).paddingBottom,listAfter:pseudo(list),inspectorAfter:pseudo(inspector),docScrollHeight:document.scrollingElement.scrollHeight}})()`)
}

async function verifyLastCandidateAndRemoval(c) {
  await wheelToEnd(c, '.load-more')
  const rows = await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)
  assert.ok(rows >= 2)
  const lastSelector = `.switch-candidate-row:nth-of-type(${rows})`
  const last = await elementEvidence(c, lastSelector)
  assert.ok(last?.pointerAccessible && last.inViewport, `last candidate inaccessible: ${JSON.stringify(last)}`)
  await trustedPointClick(c, lastSelector, null, false)
  await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'last candidate inspector')
  const actionEvidence = await wheelUntilVisible(c, '.switch-inspector-actions .switch-compare-action')
  assert.ok(actionEvidence.pointerAccessible)
  const lastInspectorName = await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
  await wheelUntilVisible(c, '.switch-preview-topline button')
  await trustedPointClick(c, '.switch-preview-topline button', null, false)
  await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'last inspector closed')

  await wheelToStart(c, '.switch-candidate-row')
  const first = await elementEvidence(c, '.switch-candidate-row')
  assert.ok(first?.pointerAccessible && first.inViewport)
  await trustedPointClick(c, '.switch-candidate-row', null, false)
  await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'first inspector')
  await wheelUntilVisible(c, '.switch-inspector-actions .switch-compare-action', '비교에서 제거')
  const beforeRemoval = await inspectClearanceState(c)
  await trustedPointClick(c, '.switch-inspector-actions .switch-compare-action', '비교에서 제거', false)
  await c.wait(`!document.querySelector('.switch-compare-dock')`, 'dock removed')
  const afterRemoval = await inspectClearanceState(c)
  assert.equal(afterRemoval.dock, false)
  if (innerWidth <= 760) assert.equal(afterRemoval.stagePaddingBottom, '22px')
  else assert.notEqual(afterRemoval.listAfter?.content, '""')

  await trustedPointClick(c, '.switch-inspector-actions .switch-compare-action', '비교에 추가', false)
  await c.wait(`document.querySelector('.switch-compare-dock')`, 'dock restored')
  await wheelUntilVisible(c, '.switch-preview-topline button')
  await trustedPointClick(c, '.switch-preview-topline button', null, false)
  await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'first inspector closed')
  return { rows, lastCandidate: last, lastInspectorName, inspectorAction: actionEvidence, beforeRemoval, afterRemoval }
}

async function keyboardLoadMore(c) {
  await c.eval(`(()=>{document.activeElement?.blur();window.__qaTabs=[];document.addEventListener('keydown',e=>{if(e.key==='Tab')window.__qaTabs.push(e.isTrusted)},{capture:true})})()`)
  let tabs = 0
  while (tabs < 140) {
    if (await c.eval(`document.activeElement?.classList?.contains('load-more')`)) break
    await pressKey(c, 'Tab', 'Tab', 9)
    tabs++
  }
  assert.equal(await c.eval(`document.activeElement?.classList?.contains('load-more')`), true, `load-more not reached after ${tabs} tabs`)
  const focusEvidence = await inspectLoadMore(c)
  assert.ok(focusEvidence?.fullyAboveDock && focusEvidence.pointerAccessible, JSON.stringify(focusEvidence))
  const beforeCount = await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)
  const beforeState = stableState(await state(c))
  await c.eval(`(()=>{const b=document.querySelector('.load-more');window.__qaLoadMoreKey=null;b.addEventListener('keydown',e=>window.__qaLoadMoreKey={key:e.key,isTrusted:e.isTrusted},{once:true,capture:true})})()`)
  await pressKey(c, 'Enter', 'Enter', 13, 0, '\r')
  await c.wait(`document.querySelectorAll('.switch-candidate-row').length>${beforeCount}`, 'keyboard load-more')
  const event = await c.eval('window.__qaLoadMoreKey')
  assert.deepEqual(event, { key: 'Enter', isTrusted: true })
  const afterState = stableState(await state(c))
  assert.deepEqual(afterState, beforeState)
  const tabTrust = await c.eval('window.__qaTabs')
  assert.ok(tabTrust.length >= tabs && tabTrust.every(Boolean))
  return { tabs, tabTrust, focusEvidence, beforeCount, afterCount: await c.eval(`document.querySelectorAll('.switch-candidate-row').length`), event, beforeState, afterState }
}

async function networkReport(c) {
  const writes = c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method))
  const analytics = c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake'))
  const nonRead = c.requests.filter((r) => !['GET','HEAD','OPTIONS'].includes(r.method))
  const blocked = await c.eval('window.__qaBlocked')
  assert.equal(writes.length, 0); assert.equal(analytics.length, 0); assert.equal(nonRead.length, 0)
  return { gets: c.requests.filter((r) => r.method === 'GET').length, writes: 0, analytics: 0, nonRead: 0, blocked }
}

async function runBaseline(width, height) {
  const h = await launch(width, height, true); const c = h.c
  try {
    await enterResults(c, BASELINE)
    const candidate = await addFirstCandidate(c)
    const owner = await wheelToEnd(c, '.load-more')
    const evidence = await inspectLoadMore(c)
    await c.shot(`${width}-baseline-max.png`)
    return { candidate, owner, evidence, network: await networkReport(c) }
  } finally { await cleanup(h) }
}

async function runTarget(width, height) {
  const h = await launch(width, height, true); const c = h.c
  try {
    await enterResults(c, TARGET)
    const candidate = await addFirstCandidate(c)
    const initialStable = stableState(await state(c))
    const owner = await wheelToEnd(c, '.load-more')
    const maxEvidence = await inspectLoadMore(c)
    assert.ok(maxEvidence?.fullyAboveDock && maxEvidence.fullyInViewport && maxEvidence.pointerAccessible, JSON.stringify(maxEvidence))
    assert.ok(maxEvidence.gap >= 16, `expected >=16px dock gap, got ${maxEvidence.gap}`)
    await c.shot(`${width}-target-max.png`)
    const pointerLoadMore = await clickLoadMoreAtCenter(c)
    assert.deepEqual(pointerLoadMore.afterState, initialStable)
    await c.shot(`${width}-target-after-load-more.png`)
    const lowerAccess = await verifyLastCandidateAndRemoval(c)
    const keyboard = await keyboardLoadMore(c)
    return { candidate, owner, maxEvidence, pointerLoadMore, lowerAccess, keyboard, network: await networkReport(c) }
  } finally { await cleanup(h) }
}

async function runBoundary(width, height, mobile) {
  const h = await launch(width, height, mobile); const c = h.c
  try {
    await enterResults(c, TARGET)
    await addFirstCandidate(c)
    const owner = await wheelToEnd(c, '.load-more')
    const evidence = await inspectLoadMore(c)
    assert.ok(evidence?.fullyAboveDock && evidence.pointerAccessible, `${width}: ${JSON.stringify(evidence)}`)
    const bodyOverflow = await c.eval(`getComputedStyle(document.body).overflowY`)
    return { owner, evidence, bodyOverflow, network: await networkReport(c) }
  } finally { await cleanup(h) }
}

const report = { productSha: PRODUCT_SHA, baselineUrl: BASELINE, targetUrl: TARGET, status: 'running' }
try {
  report.baseline360 = await runBaseline(360, 844)
  report.baseline390 = await runBaseline(390, 900)
  assert.equal(report.baseline390.evidence.pointerAccessible, false, '390 baseline should reproduce dock occlusion')
  report.target360 = await runTarget(360, 844)
  report.target390 = await runTarget(390, 900)
  report.boundary760 = await runBoundary(760, 900, true)
  report.boundary761 = await runBoundary(761, 900, false)
  report.desktop1280 = await runBoundary(1280, 900, false)
  assert.equal(report.boundary760.owner.tag, 'HTML')
  assert.equal(report.boundary761.owner.className.includes('switch-candidate-list'), true)
  assert.equal(report.desktop1280.owner.className.includes('switch-candidate-list'), true)
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('SWITCH_COMPARE_DOCK_CLEARANCE_PASS', JSON.stringify({
    baseline360: report.baseline360.evidence,
    baseline390: report.baseline390.evidence,
    target360: report.target360.maxEvidence,
    target390: report.target390.maxEvidence,
    boundary760: report.boundary760.evidence.owner,
    boundary761: report.boundary761.evidence.owner,
    desktop1280: report.desktop1280.evidence.owner,
    target360Rows: [report.target360.pointerLoadMore.beforeCount, report.target360.pointerLoadMore.afterCount],
    target390Rows: [report.target390.pointerLoadMore.beforeCount, report.target390.pointerLoadMore.afterCount],
  }))
} catch (error) {
  report.status = 'fail'; report.error = String(error?.stack ?? error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}
