import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/catfood_web/'
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const q = (value) => JSON.stringify(value)
let launchNo = 0

class CDP {
  constructor(ws) { this.url = ws; this.ws = null; this.i = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((ok, no) => { const t = setTimeout(() => no(new Error('websocket timeout')), 15000); this.ws.addEventListener('open', () => { clearTimeout(t); ok() }, { once: true }); this.ws.addEventListener('error', no, { once: true }) })
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
  send(method, params = {}) { const id = this.i++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, timeoutMs = 30000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (await this.eval(`Boolean(${expression})`).catch(() => false)) return; await sleep(80) } throw new Error(`timeout: ${label}`) }
  async nav(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState==='complete'`, 'document ready'); await this.wait(`document.querySelector('#root') && document.body.innerText.length`, 'root content'); await this.eval('document.fonts?.ready'); await sleep(250) }
  async shot(name) { const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64')) }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile, snapshot = null) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome))
  const port = 10100 + (process.pid % 100) + launchNo++ * 70
  const dir = `/tmp/pr38-scroll-${process.pid}-${launchNo}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((value) => value.type === 'page' && value.webSocketDebuggerUrl)
      if (page) {
        const c = new CDP(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const original=window.fetch.bind(window);window.__qaBlocked={analytics:0,writes:0};window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}return original(input,init)};${snapshot ? `sessionStorage.setItem(${q(STORAGE)},${q(snapshot)});` : ''}})();` })
        return { c, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}
async function cleanup(handle) { handle.c.close(); handle.proc.kill('SIGTERM'); await sleep(80); if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL'); rmSync(handle.dir, { recursive: true, force: true }) }

async function pointerClick(c, selector, index = 0, texts = []) {
  const point = await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${q(selector)})].filter(n=>${q(texts)}.every(t=>n.textContent?.includes(t)));const node=nodes[${index}];if(!node)return null;const rect=node.getBoundingClientRect();if(rect.bottom<=0||rect.top>=innerHeight||rect.right<=0||rect.left>=innerWidth)return{offscreen:true,rect:{top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right},text:node.textContent.trim()};window.__qaTrustedClick=null;node.addEventListener('click',e=>window.__qaTrustedClick=e.isTrusted,{once:true,capture:true});return{x:Math.max(2,Math.min(innerWidth-2,rect.left+rect.width/2)),y:Math.max(2,Math.min(innerHeight-2,rect.top+rect.height/2)),text:node.textContent.trim()}})()`)
  assert.ok(point, `missing ${selector} ${texts.join('+')} [${index}]`)
  assert.ok(!point.offscreen, `offscreen click ${selector}: ${JSON.stringify(point)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(120)
  assert.equal(await c.eval('window.__qaTrustedClick'), true)
  return point
}

async function typeText(c, selector, text) {
  await pointerClick(c, selector)
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector(${q(selector)})?.value===${q(text)}`, 'typed input')
}

async function wheel(c, selector, deltaY) {
  const point = await c.eval(`(()=>{const node=document.querySelector(${q(selector)})||document.body;const rect=node.getBoundingClientRect();return{x:Math.max(8,Math.min(innerWidth-8,rect.left+Math.min(rect.width,innerWidth)/2)),y:Math.max(60,Math.min(innerHeight-8,rect.top+Math.min(rect.height,innerHeight)/2))}})()`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, pointerType: 'mouse' })
  await sleep(90)
}

async function makeVisible(c, selector, index = 0, container = 'body') {
  for (let i = 0; i < 30; i++) {
    const state = await c.eval(`(()=>{const node=document.querySelectorAll(${q(selector)})[${index}];if(!node)return null;const r=node.getBoundingClientRect();return{visible:r.top>=46&&r.bottom<=innerHeight-6,top:r.top,bottom:r.bottom}})()`)
    assert.ok(state, `missing while scrolling: ${selector} [${index}]`)
    if (state.visible) return i
    await wheel(c, container, state.top < 46 ? -420 : 520)
  }
  throw new Error(`could not make visible: ${selector} [${index}]`)
}

async function scrollInfo(c, anchorSelector) {
  return c.eval(`(()=>{let node=document.querySelector(${q(anchorSelector)});while(node){const style=getComputedStyle(node);if((style.overflowY==='auto'||style.overflowY==='scroll')&&node.scrollHeight>node.clientHeight+1)return{owner:'.'+[...node.classList].join('.'),top:node.scrollTop,max:node.scrollHeight-node.clientHeight,documentTop:document.scrollingElement?.scrollTop||0};node=node.parentElement}const root=document.scrollingElement;return{owner:'document',top:root?.scrollTop||0,max:root?root.scrollHeight-root.clientHeight:0,documentTop:root?.scrollTop||0}})()`)
}
async function rect(c, selector) { return c.eval(`(()=>{const n=document.querySelector(${q(selector)});if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,text:n.textContent.trim()}})()`) }
function network(c) { return { writes: c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method)), analytics: c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake')), nonRead: c.requests.filter((r) => !['GET','HEAD','OPTIONS'].includes(r.method)), gets: c.requests.filter((r) => r.method === 'GET').length } }

async function mobileJourney() {
  const h = await launch(360, 844, true)
  const c = h.c
  const report = { viewport: '360x844', transitions: {}, restores: {}, loading: {} }
  try {
    await c.nav(BASE)
    await c.wait(`document.querySelector('.home-start-path button')`, 'home switch entry')
    await makeVisible(c, '.home-start-path button', 0)
    await pointerClick(c, '.home-start-path button', 0, ['현재 사료로 시작하기'])
    await c.wait(`document.querySelector('.switch-find-search input')`, 'switch current search')

    await typeText(c, '.switch-find-search input', 'AATU 연어')
    await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes('AATU')&&n.textContent.includes('연어'))`, 'AATU salmon result')
    const productIndex = await c.eval(`[...document.querySelectorAll('.switch-find-result')].findIndex(n=>n.textContent.includes('AATU')&&n.textContent.includes('연어'))`)
    await makeVisible(c, '.switch-find-result', productIndex)
    await pointerClick(c, '.switch-find-result', productIndex, ['AATU','연어'])
    await c.wait(`document.querySelector('.switch-current-preview')`, 'current preview')
    await makeVisible(c, '.switch-current-preview .switch-primary-action')
    const product = await c.eval(`({brand:document.querySelector('.switch-current-preview .switch-preview-identity>div>span')?.textContent.trim()||'AATU',name:document.querySelector('.switch-current-preview h2')?.textContent.trim()})`)

    await c.send('Network.emulateNetworkConditions', { offline: false, latency: 750, downloadThroughput: 10_000_000, uploadThroughput: 10_000_000, connectionType: 'wifi' })
    await pointerClick(c, '.switch-current-preview .switch-primary-action')
    await c.wait(`document.body.innerText.includes('현재 먹이는 규격을 골라주세요.')`, 'SKU step')
    const loadingSeen = await c.eval(`document.body.innerText.includes('판매 규격을 불러오는 중입니다.')`)
    const loadingBefore = await scrollInfo(c, '.switch-step-main')
    if (loadingSeen && loadingBefore.max > 0) await wheel(c, '.switch-step-main', 260)
    const loadingScrolled = await scrollInfo(c, '.switch-step-main')
    await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'SKU options', 20000)
    const loadingAfter = await scrollInfo(c, '.switch-step-main')
    if (loadingScrolled.top > 1) assert.ok(Math.abs(loadingAfter.top - loadingScrolled.top) <= 2, JSON.stringify({ loadingScrolled, loadingAfter }))
    report.loading = { loadingSeen, before: loadingBefore, scrolled: loadingScrolled, after: loadingAfter }
    await c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi' })

    const sku = await c.eval(`document.querySelector('.switch-sku-option')?.textContent.trim()`)
    assert.ok(sku)
    await makeVisible(c, '.switch-sku-option', 0)
    await pointerClick(c, '.switch-sku-option', 0)
    await makeVisible(c, '.switch-step-actions .switch-primary-action')
    await pointerClick(c, '.switch-step-actions .switch-primary-action')
    await c.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE step')
    await makeVisible(c, '.switch-no-change')
    await pointerClick(c, '.switch-no-change')
    const changeSnapshot = await c.eval(`sessionStorage.getItem(${q(STORAGE)})`)
    assert.ok(changeSnapshot)

    const changeScrollEvents = await makeVisible(c, '.switch-step-actions .switch-primary-action')
    const changeBefore = await scrollInfo(c, '.switch-step-main')
    assert.ok(changeBefore.top > 0, JSON.stringify(changeBefore))
    await pointerClick(c, '.switch-step-actions .switch-primary-action')
    await c.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP step')
    const keepAfter = await scrollInfo(c, '.switch-step-main')
    const keepHeading = await rect(c, '.switch-step-header h1')
    const keepProgress = await rect(c, '.switch-progress [aria-current="step"]')
    assert.ok(keepAfter.top <= 1, JSON.stringify(keepAfter))
    assert.ok(keepHeading && keepHeading.top >= 0 && keepHeading.top < 844, JSON.stringify(keepHeading))
    assert.ok(keepProgress && keepProgress.top >= 0 && keepProgress.top < 844, JSON.stringify(keepProgress))
    await c.shot('360-keep-immediate.png')
    report.transitions.changeToKeep = { scrollEventsToAction: changeScrollEvents, before: changeBefore, after: keepAfter, heading: keepHeading, progress: keepProgress, screenshot: '360-keep-immediate.png' }

    const keepScrollEvents = await makeVisible(c, '.switch-step-actions .switch-primary-action')
    const keepBefore = await scrollInfo(c, '.switch-step-main')
    await pointerClick(c, '.switch-step-actions .switch-primary-action')
    await c.wait(`document.querySelector('.switch-results-stage')&&document.querySelectorAll('.switch-candidate-row').length>=2`, 'results')
    const resultsAfter = await scrollInfo(c, '.switch-candidate-list')
    const sessionBar = await rect(c, '.switch-session-bar')
    const candidateHeading = await rect(c, '.switch-candidate-heading')
    assert.ok(resultsAfter.top <= 1, JSON.stringify(resultsAfter))
    assert.ok(sessionBar && sessionBar.top >= 0 && sessionBar.top < 844, JSON.stringify(sessionBar))
    assert.ok(candidateHeading && candidateHeading.top >= 0 && candidateHeading.top < 844, JSON.stringify(candidateHeading))
    await c.shot('360-results-immediate.png')
    report.transitions.keepToResults = { scrollEventsToAction: keepScrollEvents, before: keepBefore, after: resultsAfter, sessionBar, candidateHeading, screenshot: '360-results-immediate.png' }

    await makeVisible(c, '.switch-candidate-row', 0)
    await pointerClick(c, '.switch-candidate-row', 0)
    await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'first inspector')
    const firstCandidate = await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
    await makeVisible(c, '.switch-candidate-inspector .switch-compare-action', 0)
    await pointerClick(c, '.switch-candidate-inspector .switch-compare-action', 0, ['비교에 추가'])

    await c.send('Network.emulateNetworkConditions', { offline: false, latency: 700, downloadThroughput: 10_000_000, uploadThroughput: 10_000_000, connectionType: 'wifi' })
    await wheel(c, 'body', 120)
    const detailParentBefore = await scrollInfo(c, '.switch-candidate-inspector')
    await makeVisible(c, '.switch-candidate-inspector .switch-compare-action', 1)
    const detailParentAtClick = await scrollInfo(c, '.switch-candidate-inspector')
    await pointerClick(c, '.switch-candidate-inspector .switch-compare-action', 1, ['상세 보기'])
    await c.wait(`document.querySelector('.detail-stage')`, 'detail')
    const detailLoadingSeen = await c.eval(`document.body.innerText.includes('불러오는 중')`)
    const detailLoadBefore = await scrollInfo(c, '.detail-stage')
    if (detailLoadingSeen && detailLoadBefore.max > 0) await wheel(c, '.detail-stage', 220)
    const detailLoadScrolled = await scrollInfo(c, '.detail-stage')
    await c.wait(`!document.body.innerText.includes('불러오는 중')`, 'detail data settled', 20000)
    const detailLoadAfter = await scrollInfo(c, '.detail-stage')
    if (detailLoadScrolled.top > 1) assert.ok(Math.abs(detailLoadAfter.top - detailLoadScrolled.top) <= 2, JSON.stringify({ detailLoadScrolled, detailLoadAfter }))
    report.loading.detail = { loadingSeen: detailLoadingSeen, before: detailLoadBefore, scrolled: detailLoadScrolled, after: detailLoadAfter }
    await c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi' })
    await makeVisible(c, '.detail-topbar button', 0, '.detail-stage')
    await pointerClick(c, '.detail-topbar button', 0)
    await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'detail return')
    await sleep(180)
    const detailReturn = await scrollInfo(c, '.switch-candidate-inspector')
    const selectedAfterDetail = await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
    assert.equal(selectedAfterDetail, firstCandidate)
    assert.ok(Math.abs(detailReturn.top - detailParentAtClick.top) <= 2, JSON.stringify({ detailParentBefore, detailParentAtClick, detailReturn }))
    await c.shot('360-detail-return-preserved.png')
    report.restores.detailReturn = { before: detailParentAtClick, after: detailReturn, selected: selectedAfterDetail, screenshot: '360-detail-return-preserved.png' }

    await makeVisible(c, '.switch-preview-topline button')
    await pointerClick(c, '.switch-preview-topline button')
    await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'close first inspector')
    await makeVisible(c, '.switch-candidate-row', 1)
    await pointerClick(c, '.switch-candidate-row', 1)
    await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'second inspector')
    const secondCandidate = await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
    await makeVisible(c, '.switch-candidate-inspector .switch-compare-action', 0)
    await pointerClick(c, '.switch-candidate-inspector .switch-compare-action', 0, ['비교에 추가'])
    await makeVisible(c, '.switch-preview-topline button')
    await pointerClick(c, '.switch-preview-topline button')
    await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'close second inspector')

    await wheel(c, 'body', 360)
    const resultsBeforeCompare = await scrollInfo(c, '.switch-candidate-list')
    assert.ok(resultsBeforeCompare.top > 0, JSON.stringify(resultsBeforeCompare))
    await pointerClick(c, '.switch-compare-dock > button', 0, ['비교 보기'])
    await c.wait(`document.querySelector('.compare-stage')`, 'compare')
    const compareAfter = await scrollInfo(c, '.compare-stage')
    const compareTitle = await rect(c, '.compare-header h1')
    assert.ok(compareAfter.top <= 1, JSON.stringify(compareAfter))
    assert.ok(compareTitle && compareTitle.top >= 0 && compareTitle.top < 844, JSON.stringify(compareTitle))
    await c.shot('360-compare-immediate.png')
    report.transitions.resultsToCompare = { before: resultsBeforeCompare, after: compareAfter, title: compareTitle, screenshot: '360-compare-immediate.png' }

    await pointerClick(c, '.compare-header > button')
    await c.wait(`document.querySelector('.switch-results-stage')&&!document.querySelector('.compare-stage')`, 'compare UI return')
    await sleep(180)
    const resultsAfterCompareClose = await scrollInfo(c, '.switch-candidate-list')
    assert.ok(Math.abs(resultsAfterCompareClose.top - resultsBeforeCompare.top) <= 2, JSON.stringify({ resultsBeforeCompare, resultsAfterCompareClose }))
    const compareCountAfterReturn = await c.eval(`document.querySelector('.switch-compare-dock strong')?.textContent.trim()`)
    assert.ok(compareCountAfterReturn?.includes('2/5'))
    await c.shot('360-results-compare-return-preserved.png')
    report.restores.compareClose = { before: resultsBeforeCompare, after: resultsAfterCompareClose, compareCount: compareCountAfterReturn, screenshot: '360-results-compare-return-preserved.png' }

    let nav = await c.send('Page.getNavigationHistory')
    const forwardEntry = nav.entries[nav.currentIndex + 1]
    assert.ok(forwardEntry, 'expected app-created compare entry ahead after UI close')
    await c.send('Page.navigateToHistoryEntry', { entryId: forwardEntry.id })
    await c.wait(`document.querySelector('.compare-stage')`, 'browser forward compare')
    await sleep(180)
    await wheel(c, 'body', 260)
    const compareRead = await scrollInfo(c, '.compare-stage')
    assert.ok(compareRead.top > 0, JSON.stringify(compareRead))

    nav = await c.send('Page.getNavigationHistory')
    const compareIndex = nav.currentIndex
    const backEntry = nav.entries[compareIndex - 1]
    const compareEntry = nav.entries[compareIndex]
    assert.ok(backEntry && compareEntry)
    await c.send('Page.navigateToHistoryEntry', { entryId: backEntry.id })
    await c.wait(`document.querySelector('.switch-results-stage')&&!document.querySelector('.compare-stage')`, 'browser back results')
    await sleep(180)
    const browserBackResults = await scrollInfo(c, '.switch-candidate-list')
    assert.ok(Math.abs(browserBackResults.top - resultsBeforeCompare.top) <= 2, JSON.stringify({ resultsBeforeCompare, browserBackResults }))
    await c.send('Page.navigateToHistoryEntry', { entryId: compareEntry.id })
    await c.wait(`document.querySelector('.compare-stage')`, 'browser forward compare again')
    await sleep(180)
    const browserForwardCompare = await scrollInfo(c, '.compare-stage')
    assert.ok(Math.abs(browserForwardCompare.top - compareRead.top) <= 2, JSON.stringify({ compareRead, browserForwardCompare }))
    await c.shot('360-compare-browser-forward-preserved.png')
    report.restores.browserHistory = { resultsBeforeCompare, backResults: browserBackResults, compareRead, forwardCompare: browserForwardCompare, screenshot: '360-compare-browser-forward-preserved.png' }

    const net = network(c)
    assert.equal(net.writes.length, 0)
    assert.equal(net.analytics.length, 0)
    assert.equal(net.nonRead.length, 0)
    report.product = product
    report.sku = sku
    report.conditions = { change: '특별히 바꾸고 싶은 점 없음', keep: '추가 조건 없음' }
    report.candidates = [firstCandidate, secondCandidate]
    report.network = { writes: 0, analytics: 0, nonRead: 0, gets: net.gets }
    report.changeSnapshot = changeSnapshot
    return report
  } finally { await cleanup(h) }
}

async function desktopCheck(snapshot) {
  const h = await launch(1280, 900, false, snapshot)
  const c = h.c
  try {
    await c.nav(`${BASE}?view=workspace&mode=switch`)
    await c.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'desktop CHANGE')
    const initial = await scrollInfo(c, '.switch-step-main')
    assert.ok(initial.owner.includes('switch-step-main'), JSON.stringify(initial))
    assert.equal(initial.documentTop, 0)
    await makeVisible(c, '.switch-step-actions .switch-primary-action', 0, '.switch-step-main')
    const before = await scrollInfo(c, '.switch-step-main')
    assert.ok(before.top > 0, JSON.stringify(before))
    await pointerClick(c, '.switch-step-actions .switch-primary-action')
    await c.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'desktop KEEP')
    const after = await scrollInfo(c, '.switch-step-main')
    assert.ok(after.owner.includes('switch-step-main'), JSON.stringify(after))
    assert.ok(after.top <= 1, JSON.stringify(after))
    assert.equal(after.documentTop, 0)
    await c.shot('1280-keep-internal-owner-immediate.png')
    const net = network(c)
    assert.equal(net.writes.length, 0); assert.equal(net.analytics.length, 0); assert.equal(net.nonRead.length, 0)
    return { viewport: '1280x900', initial, before, after, screenshot: '1280-keep-internal-owner-immediate.png', network: { writes: 0, analytics: 0, nonRead: 0, gets: net.gets } }
  } finally { await cleanup(h) }
}

const report = { productSha: process.env.PRODUCT_SHA, status: 'running' }
try {
  report.mobile = await mobileJourney()
  report.desktop = await desktopCheck(report.mobile.changeSnapshot)
  delete report.mobile.changeSnapshot
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR38_SWITCH_SCROLL PASS', JSON.stringify({ mobile: report.mobile.transitions, restores: report.mobile.restores, desktop: report.desktop }))
} catch (error) {
  report.status = 'fail'
  report.error = String(error?.stack ?? error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}
