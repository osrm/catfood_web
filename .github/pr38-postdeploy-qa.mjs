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
  const port = 11000 + (process.pid % 500)
  const dir = `/tmp/pr38-postdeploy-${process.pid}`
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
        source: `(()=>{const original=window.fetch.bind(window);window.__qaBlocked={analytics:0,writes:0};window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}return original(input,init)}})();`,
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
    try {
      rmSync(handle.dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) {
        console.warn('QA cleanup warning:', String(error))
        return
      }
      await sleep(100)
    }
  }
}

async function click(c, selector, index = 0, contains = []) {
  const point = await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${q(selector)})].filter(n=>${q(contains)}.every(t=>n.textContent?.includes(t)));const n=nodes[${index}];if(!n)return null;const r=n.getBoundingClientRect();if(r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth)return{offscreen:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},text:n.textContent.trim()};window.__qaTrustedClick=null;n.addEventListener('click',e=>window.__qaTrustedClick=e.isTrusted,{once:true,capture:true});return{x:Math.max(2,Math.min(innerWidth-2,r.left+r.width/2)),y:Math.max(2,Math.min(innerHeight-2,r.top+r.height/2)),text:n.textContent.trim()}})()`)
  assert.ok(point, `missing ${selector} ${contains.join('+')} [${index}]`)
  assert.ok(!point.offscreen, `offscreen ${selector}: ${JSON.stringify(point)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(90)
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

async function scrollInfo(c, anchor) {
  return c.eval(`(()=>{let n=document.querySelector(${q(anchor)});while(n){const s=getComputedStyle(n);if((s.overflowY==='auto'||s.overflowY==='scroll')&&n.scrollHeight>n.clientHeight+1)return{owner:'.'+[...n.classList].join('.'),top:n.scrollTop,max:n.scrollHeight-n.clientHeight,documentTop:document.scrollingElement?.scrollTop||0};n=n.parentElement}const d=document.scrollingElement;return{owner:'document',top:d?.scrollTop||0,max:d?d.scrollHeight-d.clientHeight:0,documentTop:d?.scrollTop||0}})()`)
}

async function wheelOwner(c, anchor, deltaY) {
  const point = await c.eval(`(()=>{let n=document.querySelector(${q(anchor)});while(n){const s=getComputedStyle(n);if((s.overflowY==='auto'||s.overflowY==='scroll')&&n.scrollHeight>n.clientHeight+1){const r=n.getBoundingClientRect();return{x:Math.max(8,Math.min(innerWidth-8,r.left+Math.min(r.width,innerWidth)/2)),y:Math.max(8,Math.min(innerHeight-8,r.top+Math.min(r.height,innerHeight)/2))}}n=n.parentElement}return{x:innerWidth/2,y:innerHeight/2}})()`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, pointerType: 'mouse' })
  await sleep(80)
}

async function visible(c, selector, index = 0, anchor = selector, minTop = 6) {
  for (let i = 0; i < 40; i++) {
    const r = await c.eval(`(()=>{const n=document.querySelectorAll(${q(selector)})[${index}];if(!n)return null;const r=n.getBoundingClientRect();return{ok:r.top>=${minTop}&&r.bottom<=innerHeight-6,top:r.top,bottom:r.bottom}})()`)
    assert.ok(r, `missing ${selector} [${index}]`)
    if (r.ok) return
    await wheelOwner(c, anchor, r.top < minTop ? -480 : 560)
  }
  throw new Error(`could not make visible ${selector} [${index}]`)
}

async function nextFrame(c) {
  await c.eval(`new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))`)
  await sleep(10)
}

async function sampleFrame(c, anchor) {
  const immediate = await scrollInfo(c, anchor)
  await nextFrame(c)
  const afterFrame = await scrollInfo(c, anchor)
  return { immediate, afterFrame }
}

async function state(c) {
  return c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`)
}

function editSignature(value) {
  return JSON.stringify({
    variantSelection: value.variantSelection,
    change: value.change,
    keep: value.keep,
    changeBrand: value.changeBrand,
    keepBrand: value.keepBrand,
    ingredientAvoidTerms: value.ingredientAvoidTerms,
    noChangeIntent: value.noChangeIntent,
  })
}

async function historyMove(c, offset) {
  const history = await c.send('Page.getNavigationHistory')
  const entry = history.entries[history.currentIndex + offset]
  assert.ok(entry, `missing history offset ${offset}`)
  await c.send('Page.navigateToHistoryEntry', { entryId: entry.id })
}

async function textRect(c, text) {
  return c.eval(`(()=>{const nodes=[...document.querySelectorAll('h1,h2,h3,p,span,strong,div')];const n=nodes.find(x=>x.textContent?.trim()===${q(text)})||nodes.find(x=>x.textContent?.includes(${q(text)}));if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,text:n.textContent.trim()}})()`)
}

function network(c) {
  return {
    writes: c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(r.method)),
    analytics: c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake')),
    nonRead: c.requests.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method)),
    gets: c.requests.filter((r) => r.method === 'GET').length,
  }
}

const handle = await launch()
const c = handle.c
const report = { mergeSha: MERGE_SHA, page: BASE, viewport: '360x844', status: 'running', transitions: {}, restores: {} }

try {
  await c.nav(BASE)
  await c.wait(`document.querySelector('.home-start-path button')`, 'home switch entry')
  await visible(c, '.home-start-path button', 0, '.home-start-path')
  await click(c, '.home-start-path button', 0, ['현재 사료로 시작하기'])
  await c.wait(`document.querySelector('.switch-find-search input')`, 'SWITCH current search')

  await typeText(c, '.switch-find-search input', 'AATU 연어')
  await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes('AATU')&&n.textContent.includes('연어'))`, 'AATU salmon result')
  const productIndex = await c.eval(`[...document.querySelectorAll('.switch-find-result')].findIndex(n=>n.textContent.includes('AATU')&&n.textContent.includes('연어'))`)
  await visible(c, '.switch-find-result', productIndex, '.switch-find-results-list')
  await click(c, '.switch-find-result', productIndex, ['AATU', '연어'])
  await c.wait(`document.querySelector('.switch-current-preview')`, 'current preview')
  report.currentProduct = await c.eval(`document.querySelector('.switch-current-preview')?.textContent.trim()`)
  await visible(c, '.switch-current-preview .switch-primary-action', 0, '.switch-current-preview')
  await click(c, '.switch-current-preview .switch-primary-action')

  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'actual SKU options', 20000)
  report.actualSku = await c.eval(`document.querySelector('.switch-sku-option')?.textContent.trim()`)
  assert.ok(report.actualSku, 'expected an actual SKU option')
  await visible(c, '.switch-sku-option', 0, '.switch-step-main')
  await click(c, '.switch-sku-option', 0)
  await visible(c, '.switch-step-actions .switch-primary-action', 0, '.switch-step-main')
  await click(c, '.switch-step-actions .switch-primary-action')

  await c.wait(`document.querySelector('.switch-no-change')`, 'CHANGE step')
  await visible(c, '.switch-no-change', 0, '.switch-step-main')
  await click(c, '.switch-no-change')
  await visible(c, '.switch-step-actions .switch-primary-action', 0, '.switch-step-main')
  const changeBeforeKeep = await scrollInfo(c, '.switch-step-main')
  assert.ok(changeBeforeKeep.top > 0, JSON.stringify(changeBeforeKeep))
  await click(c, '.switch-step-actions .switch-primary-action')

  await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'KEEP step')
  const keepStart = await sampleFrame(c, '.switch-step-main')
  const keepQuestion = await textRect(c, '무엇을 그대로 유지할까요?')
  const keepProgress = await textRect(c, '유지할 것')
  assert.ok(keepStart.immediate.top <= 1 && keepStart.afterFrame.top <= 1, JSON.stringify(keepStart))
  assert.ok(keepQuestion && keepQuestion.top >= 0 && keepQuestion.top < 844, JSON.stringify(keepQuestion))
  assert.ok(keepProgress && keepProgress.top >= 0 && keepProgress.top < 844, JSON.stringify(keepProgress))
  await c.shot('360-keep-entry.png')
  report.transitions.changeToKeep = { before: changeBeforeKeep, ...keepStart, question: keepQuestion, progress: keepProgress, screenshot: '360-keep-entry.png' }

  assert.ok(await c.eval(`document.querySelectorAll('.switch-criteria-columns button').length>0`), 'expected KEEP edit control')
  await visible(c, '.switch-criteria-columns button', 0, '.switch-step-main')
  report.keepEditLabel = await c.eval(`document.querySelectorAll('.switch-criteria-columns button')[0]?.textContent.trim()`)
  await click(c, '.switch-criteria-columns button', 0)
  const editedState = await state(c)
  const editedSignature = editSignature(editedState)

  await visible(c, '.switch-step-actions .switch-secondary-action', 0, '.switch-step-main')
  const keepBeforePrevious = await scrollInfo(c, '.switch-step-main')
  assert.ok(keepBeforePrevious.top > 0, JSON.stringify(keepBeforePrevious))
  await click(c, '.switch-step-actions .switch-secondary-action')
  await c.wait(`document.querySelector('.switch-no-change')`, 'explicit previous to CHANGE')
  const explicitPrevious = await sampleFrame(c, '.switch-step-main')
  const backState = await state(c)
  const changeQuestion = await textRect(c, '무엇을 바꾸고 싶나요?')
  assert.ok(explicitPrevious.immediate.top <= 1 && explicitPrevious.afterFrame.top <= 1, JSON.stringify(explicitPrevious))
  assert.equal(editSignature(backState), editedSignature, 'explicit previous must preserve SWITCH conditions and SKU')
  assert.ok(changeQuestion && changeQuestion.top >= 0 && changeQuestion.top < 844, JSON.stringify(changeQuestion))
  report.transitions.keepToChangePrevious = { before: keepBeforePrevious, ...explicitPrevious, conditionsPreserved: true, question: changeQuestion }

  await historyMove(c, 1)
  await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'browser forward KEEP')
  const forwardKeep = await sampleFrame(c, '.switch-step-main')
  assert.ok(Math.abs(forwardKeep.immediate.top - keepBeforePrevious.top) <= 3, JSON.stringify({ keepBeforePrevious, forwardKeep }))
  assert.ok(Math.abs(forwardKeep.afterFrame.top - keepBeforePrevious.top) <= 3, JSON.stringify({ keepBeforePrevious, forwardKeep }))
  report.restores.browserForwardKeep = { expected: keepBeforePrevious, ...forwardKeep }

  await visible(c, '.switch-step-actions .switch-primary-action', 0, '.switch-step-main')
  await click(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-results-stage')&&document.querySelectorAll('.switch-candidate-row').length>=2`, 'results', 30000)

  await visible(c, '.switch-candidate-row', 0, '.switch-candidate-list')
  await click(c, '.switch-candidate-row', 0)
  await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'first candidate inspector')
  const firstCandidate = await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
  assert.ok(firstCandidate)
  await visible(c, '.switch-candidate-inspector .switch-compare-action', 0, '.switch-inspector-scroll')
  await click(c, '.switch-candidate-inspector .switch-compare-action', 0, ['비교에 추가'])
  await visible(c, '.switch-preview-topline button', 0, '.switch-inspector-scroll')
  await click(c, '.switch-preview-topline button')
  await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'close first inspector')

  await visible(c, '.switch-candidate-row', 1, '.switch-candidate-list')
  await click(c, '.switch-candidate-row', 1)
  await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'second candidate inspector')
  const secondCandidate = await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
  assert.ok(secondCandidate)
  await visible(c, '.switch-candidate-inspector .switch-compare-action', 0, '.switch-inspector-scroll')
  await click(c, '.switch-candidate-inspector .switch-compare-action', 0, ['비교에 추가'])

  await wheelOwner(c, '.switch-candidate-list', 420)
  const resultsBeforeCompare = await scrollInfo(c, '.switch-candidate-list')
  assert.ok(resultsBeforeCompare.top > 0, JSON.stringify(resultsBeforeCompare))
  const selectedBeforeCompare = await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
  assert.equal(selectedBeforeCompare, secondCandidate)
  await click(c, '.switch-compare-dock > button', 0, ['비교 보기'])
  await c.wait(`document.querySelector('.compare-stage')`, 'compare')
  const compareStart = await sampleFrame(c, '.compare-stage')
  const compareTitle = await textRect(c, '제품 비교')
  assert.ok(compareStart.immediate.top <= 1 && compareStart.afterFrame.top <= 1, JSON.stringify(compareStart))
  assert.ok(compareTitle && compareTitle.top >= 0 && compareTitle.top < 844, JSON.stringify(compareTitle))
  await c.shot('360-compare-entry.png')
  report.transitions.resultsToCompare = { before: resultsBeforeCompare, ...compareStart, title: compareTitle, screenshot: '360-compare-entry.png' }

  await click(c, '.compare-header > button')
  await c.wait(`document.querySelector('.switch-results-stage')&&!document.querySelector('.compare-stage')&&document.querySelector('.switch-candidate-inspector')`, 'compare return with inspector')
  const parentReturn = await sampleFrame(c, '.switch-candidate-list')
  const returnState = await state(c)
  const selectedAfterCompare = await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
  assert.ok(Math.abs(parentReturn.immediate.top - resultsBeforeCompare.top) <= 3, JSON.stringify({ resultsBeforeCompare, parentReturn }))
  assert.ok(Math.abs(parentReturn.afterFrame.top - resultsBeforeCompare.top) <= 3, JSON.stringify({ resultsBeforeCompare, parentReturn }))
  assert.equal(selectedAfterCompare, secondCandidate)
  assert.equal(returnState.compareIds.length, 2)
  await c.shot('360-results-parent-return.png')
  report.restores.compareParentReturn = { expected: resultsBeforeCompare, ...parentReturn, selected: selectedAfterCompare, compareIds: returnState.compareIds, screenshot: '360-results-parent-return.png' }

  const net = network(c)
  const blocked = await c.eval('window.__qaBlocked')
  assert.equal(net.writes.length, 0)
  assert.equal(net.analytics.length, 0)
  assert.equal(net.nonRead.length, 0)
  assert.deepEqual(blocked, { analytics: 0, writes: 0 })
  report.network = { writes: 0, analytics: 0, nonRead: 0, gets: net.gets, blocked }
  report.candidates = [firstCandidate, secondCandidate]
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR38_POSTDEPLOY PASS', JSON.stringify(report))
} finally {
  await cleanup(handle)
}
