import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'https://osrm.github.io/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
const q = JSON.stringify
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })
assert.ok(PRODUCT_SHA)

const CURRENT = { productId: 'product_d99406c26240b263', brand: 'AATU', name: '연어', variantId: 'variant_6e426a0abf2e1a43', sku: '1 kg' }
const CANDIDATES = [
  { productId: 'product_c277594a66531d32', brand: 'Advance', name: '어드밴스 캣 센시티브' },
  { productId: 'product_71d80e22240d1f3c', brand: 'Wellness', name: 'CORE Signature Selects Pate Kitten Chicken & Turkey Entree' },
  { productId: 'product_55e236971267b091', brand: 'Wellness', name: 'CORE Signature Selects Shredded Chicken & Chicken Liver' },
  { productId: 'product_57ebb79328370017', brand: 'Almo Nature', name: 'HFC Our Adult Sterilised Fresh Sea Bass & Sea Bream' },
  { productId: 'product_d5e01ae1b52eac81', brand: 'Wellness', name: 'CORE Signature Selects Pate Boneless Chicken & Beef Entree' },
]

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
      const original=window.fetch.bind(window)
      window.__qaBlocked={analytics:0,writes:0}
      window.fetch=(input,init={})=>{
        const url=typeof input==='string'?input:(input&&input.url)||''
        const method=String(init.method||(input&&input.method)||'GET').toUpperCase()
        if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}
        if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}
        return original(input,init)
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
    await this.eval('document.fonts?.ready'); await sleep(100)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const port = 15300 + (process.pid % 200)
  const dir = `/tmp/pr39-compare-390-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const c = new CDP(page.webSocketDebuggerUrl)
      await c.connect()
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 900 })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
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
  return { currentProductId: value.currentProductId, variantSelection: value.variantSelection, compareIds: value.compareIds, compareOpen: value.compareOpen, compareTab: value.compareTab }
}

async function pointerClick(c, selector, matcher = null) {
  const point = await c.eval(`(()=>{
    const nodes=[...document.querySelectorAll(${q(selector)})]
    const n=${matcher ? `nodes.find(x=>x.textContent.includes(${q(matcher)}))` : 'nodes[0]'}
    if(!n)return null
    n.scrollIntoView({block:'center',inline:'nearest'})
    const r=n.getBoundingClientRect(),x=Math.max(3,Math.min(innerWidth-3,r.left+r.width/2)),y=Math.max(3,Math.min(innerHeight-3,r.top+r.height/2))
    const hit=document.elementFromPoint(x,y)
    if(!hit||!(hit===n||n.contains(hit)))return{blocked:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},hit:hit?.className||hit?.tagName}
    window.__qaTrustedClick=null
    n.addEventListener('click',e=>window.__qaTrustedClick=e.isTrusted,{once:true,capture:true})
    return{x,y,text:n.textContent.trim()}
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
  await pointerClick(c, '.switch-find-search input')
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector('.switch-find-search input')?.value===${q(text)}`, 'typed search')
}

async function pressKey(c, key, code, keyCode, text = '') {
  const payload = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) }
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload })
  await sleep(80)
}

async function enterResults(c) {
  await c.nav(`${BASE}?view=workspace&mode=switch`)
  await c.wait(`document.querySelector('.switch-find-search input')`, 'switch search')
  await c.wait(`!document.body.innerText.includes('제품 목록을 불러오는 중입니다.')`, 'catalog loaded')
  await typeSearch(c, 'AATU 연어')
  await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(x=>x.textContent.includes('AATU')&&x.textContent.includes('연어'))`, 'AATU result')
  await pointerClick(c, '.switch-find-result', '연어')
  await c.wait(`document.querySelector('.switch-current-preview')`, 'preview')
  await pointerClick(c, '.switch-current-preview .switch-primary-action')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'SKU options', 30000)
  await pointerClick(c, '.switch-sku-option', '1 kg')
  await pointerClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-no-change')`, 'CHANGE')
  await pointerClick(c, '.switch-no-change')
  await pointerClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'KEEP')
  await pointerClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-results-stage')`, 'RESULTS')
  const s = await state(c)
  assert.equal(s.currentProductId, CURRENT.productId)
  assert.equal(s.variantSelection.variantId, CURRENT.variantId)
  assert.equal(s.noChangeIntent, true)
}

async function ensureCandidate(c, product) {
  for (let i = 0; i < 30; i++) {
    const found = await c.eval(`[...document.querySelectorAll('.switch-candidate-row')].some(x=>x.querySelector('.switch-candidate-identity strong')?.textContent.trim()===${q(product.name)}&&x.textContent.includes(${q(product.brand)}))`)
    if (found) return
    const hasMore = await c.eval(`Boolean(document.querySelector('.load-more'))`)
    assert.equal(hasMore, true, `candidate unavailable: ${product.brand} ${product.name}`)
    // Setup-only: the fixed compare dock can cover this control near the document bottom.
    // This control is not under review; invoke its real DOM button click to reveal more actual catalog rows.
    await c.eval(`document.querySelector('.load-more').click()`)
    await sleep(120)
  }
  throw new Error(`candidate load limit: ${product.name}`)
}

async function addCandidate(c, product) {
  await ensureCandidate(c, product)
  const point = await c.eval(`(()=>{
    const n=[...document.querySelectorAll('.switch-candidate-row')].find(x=>x.querySelector('.switch-candidate-identity strong')?.textContent.trim()===${q(product.name)}&&x.textContent.includes(${q(product.brand)}))
    if(!n)return null
    n.scrollIntoView({block:'center'})
    const r=n.getBoundingClientRect();window.__qaCandidateRow=null
    n.addEventListener('click',e=>window.__qaCandidateRow=e.isTrusted,{once:true,capture:true})
    return{x:r.left+r.width/2,y:r.top+r.height/2}
  })()`)
  assert.ok(point)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(130); assert.equal(await c.eval('window.__qaCandidateRow'), true)
  await c.wait(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()===${q(product.name)}`, 'candidate inspector')
  const before = (await state(c)).compareIds.length
  await pointerClick(c, '.switch-inspector-actions .switch-compare-action', '비교에 추가')
  await c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw&&JSON.parse(raw).state.compareIds.length===${before + 1}})()`, 'compare add')
  assert.equal((await state(c)).compareIds.at(-1), product.productId)
  await pointerClick(c, '.switch-preview-topline button')
}

async function openCompare(c) {
  for (const product of CANDIDATES) await addCandidate(c, product)
  assert.deepEqual((await state(c)).compareIds, CANDIDATES.map((x) => x.productId))
  await pointerClick(c, '.switch-compare-dock > button')
  await c.wait(`document.querySelector('.compare-stage')`, 'compare stage')
  await c.wait(`getComputedStyle(document.querySelector('.compare-switch-mobile-overview')).display!=='none'`, 'mobile overview')
  await c.wait(`document.querySelector('.compare-mobile-product-head.is-current')?.textContent.includes('사용 규격 · 1 kg')`, 'usage SKU')
}

async function pickerMetrics(c) {
  return c.eval(`(()=>{
    const scroller=document.querySelector('.compare-mobile-candidate-picker>div'),sr=scroller.getBoundingClientRect(),buttons=[...scroller.querySelectorAll('button')]
    return{label:document.querySelector('.compare-mobile-candidate-picker>span')?.textContent.trim(),clientWidth:scroller.clientWidth,scrollWidth:scroller.scrollWidth,scrollLeft:scroller.scrollLeft,maxScroll:scroller.scrollWidth-scroller.clientWidth,overflowX:getComputedStyle(scroller).overflowX,buttons:buttons.map((b,i)=>{const r=b.getBoundingClientRect(),s=getComputedStyle(b),left=Math.max(sr.left,r.left),right=Math.min(sr.right,r.right);return{index:i,productId:b.dataset.productId,text:b.textContent.trim(),ariaPressed:b.getAttribute('aria-pressed'),left:r.left,right:r.right,width:r.width,visibleWidth:Math.max(0,right-left),fullyVisible:r.left>=sr.left&&r.right<=sr.right,clientWidth:b.clientWidth,scrollWidth:b.scrollWidth,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace}}}
  })()`)
}

async function measure(c) {
  return c.eval(`(()=>{
    const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    const style=n=>{if(!n)return null;const s=getComputedStyle(n);return{text:n.textContent.trim().replace(/\\s+/g,' '),fontSize:s.fontSize,lineHeight:s.lineHeight,color:s.color,fontWeight:s.fontWeight,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace,wordBreak:s.wordBreak,overflowWrap:s.overflowWrap,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,rect:rect(n)}}
    const heads=[...document.querySelectorAll('.compare-mobile-product-head')],current=heads.find(x=>x.classList.contains('is-current')),candidate=heads.find(x=>x.classList.contains('is-candidate'))
    const currentSmalls=current?[...current.querySelectorAll(':scope>small')]:[],candidateSmalls=candidate?[...candidate.querySelectorAll(':scope>small')]:[],rows=[...document.querySelectorAll('.compare-mobile-overview-row')]
    const unknowns=[...document.querySelectorAll('.compare-mobile-overview-row')].flatMap(row=>[...row.querySelectorAll('.compare-mobile-pair>div>div')].filter(n=>/미확인|확인된 값 없음|공식 표기 미확인/.test(n.textContent)).map(n=>({row:row.querySelector('.compare-mobile-row-label')?.textContent.trim(),value:style(n)})))
    const hrs=heads.map(rect)
    return{viewport:{width:innerWidth,height:innerHeight,scrollY,docClientWidth:document.documentElement.clientWidth,docScrollWidth:document.documentElement.scrollWidth,horizontalOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth},styles:{pickerLabel:style(document.querySelector('.compare-mobile-candidate-picker>span')),activePickerButton:style(document.querySelector('.compare-mobile-candidate-picker button[aria-pressed="true"]')),currentRole:style(current?.querySelector(':scope>span')),currentBrand:style(current?.querySelector('.compare-mobile-product-brand')),currentName:style(current?.querySelector(':scope>strong')),currentUsage:style(currentSmalls[1]),currentSale:style(currentSmalls[2]),candidateBrand:style(candidate?.querySelector('.compare-mobile-product-brand')),candidateName:style(candidate?.querySelector(':scope>strong')),candidateSale:style(candidateSmalls[1]),rowLabel:style(document.querySelector('.compare-mobile-row-label')),currentValue:style(document.querySelector('.compare-mobile-pair>div:first-child>div')),candidateValue:style(document.querySelector('.compare-mobile-pair>div:last-child>div'))},unknowns,layout:{header:rect(document.querySelector('.compare-header')),tabs:rect(document.querySelector('.compare-tabs')),picker:rect(document.querySelector('.compare-mobile-candidate-picker')),headGrid:rect(document.querySelector('.compare-mobile-head-grid')),firstRow:rect(rows[0]),firstRowTop:rows[0]?.getBoundingClientRect().top??null,fullyVisibleRows:rows.filter(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}).length,intersectingRows:rows.filter(n=>{const r=n.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).length,totalRows:rows.length,pairOverlap:hrs.length===2&&hrs[0]&&hrs[1]?Math.max(0,hrs[0].right-hrs[1].left):null},rowLabels:rows.map(n=>n.querySelector('.compare-mobile-row-label')?.textContent.trim()),valueCells:[...document.querySelectorAll('.compare-mobile-pair>div>div')].map(style)}
  })()`)
}

async function touchScrollToLast(c) {
  const start = await pickerMetrics(c); const steps = []
  for (let attempt = 0; attempt < 12; attempt++) {
    const before = await pickerMetrics(c); const last = before.buttons.at(-1)
    if ((last?.visibleWidth ?? 0) > 12) return { start, steps, final: before, reached: true }
    const box = await c.eval(`(()=>{const n=document.querySelector('.compare-mobile-candidate-picker>div'),r=n.getBoundingClientRect();return{left:r.left,right:r.right,y:r.top+r.height/2}})()`)
    const y = box.y, x0 = box.right - 18, x1 = box.left + 18
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }] })
    for (let i = 1; i <= 5; i++) {
      const x = x0 + (x1 - x0) * (i / 5)
      await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }] })
      await sleep(20)
    }
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(180)
    const after = await pickerMetrics(c); steps.push(after.scrollLeft)
    if (after.scrollLeft === before.scrollLeft) break
  }
  const final = await pickerMetrics(c)
  return { start, steps, final, reached: (final.buttons.at(-1)?.visibleWidth ?? 0) > 12 }
}

async function clickVisiblePicker(c, index) {
  const point = await c.eval(`(()=>{
    const s=document.querySelector('.compare-mobile-candidate-picker>div'),b=s.querySelectorAll('button')[${index}],sr=s.getBoundingClientRect(),r=b.getBoundingClientRect()
    const left=Math.max(sr.left,r.left),right=Math.min(sr.right,r.right),top=Math.max(sr.top,r.top),bottom=Math.min(sr.bottom,r.bottom)
    if(right-left<4||bottom-top<4)return null
    const x=(left+right)/2,y=(top+bottom)/2,hit=document.elementFromPoint(x,y)
    if(!hit||!(hit===b||b.contains(hit)))return null
    window.__qaPickerPointer=null;b.addEventListener('click',e=>window.__qaPickerPointer=e.isTrusted,{once:true,capture:true})
    return{x,y,visibleWidth:right-left,buttonWidth:r.width}
  })()`)
  if (!point) return { accessible: false }
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(120)
  return { accessible: true, trusted: await c.eval('window.__qaPickerPointer'), selected: await c.eval(`document.querySelectorAll('.compare-mobile-candidate-picker button')[${index}]?.getAttribute('aria-pressed')`), ...point }
}

async function keyboardToLast(c) {
  await c.eval(`document.querySelector('.compare-mobile-candidate-picker>div').scrollLeft=0`); await sleep(60)
  const first = await clickVisiblePicker(c, 0)
  assert.equal(first.accessible, true); assert.equal(first.trusted, true)
  const count = await c.eval(`document.querySelectorAll('.compare-mobile-candidate-picker button').length`)
  assert.equal(await c.eval(`document.activeElement===document.querySelector('.compare-mobile-candidate-picker button')`), true)
  let tabs = 0
  while (tabs < count + 2) {
    const index = await c.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].indexOf(document.activeElement)`)
    if (index === count - 1) break
    await pressKey(c, 'Tab', 'Tab', 9); tabs++
  }
  assert.equal(await c.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].indexOf(document.activeElement)`), count - 1)
  const beforeEnter = await pickerMetrics(c)
  await c.eval(`(()=>{window.__qaPickerKey=null;document.activeElement.addEventListener('keydown',e=>window.__qaPickerKey={key:e.key,isTrusted:e.isTrusted},{once:true,capture:true})})()`)
  await pressKey(c, 'Enter', 'Enter', 13, '\r')
  const event = await c.eval('window.__qaPickerKey')
  assert.equal(event?.isTrusted, true); assert.equal(event?.key, 'Enter')
  return { tabs, event, beforeEnter, afterEnter: await pickerMetrics(c) }
}

async function networkReport(c) {
  const writes = c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method))
  const analytics = c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake'))
  const nonRead = c.requests.filter((r) => !['GET','HEAD','OPTIONS'].includes(r.method))
  const blocked = await c.eval('window.__qaBlocked')
  assert.equal(writes.length, 0); assert.equal(analytics.length, 0); assert.equal(nonRead.length, 0); assert.deepEqual(blocked, { analytics: 0, writes: 0 })
  return { gets: c.requests.filter((r) => r.method === 'GET').length, writes: 0, analytics: 0, nonRead: 0, blocked }
}

const handle = await launch(); const c = handle.c
const report = { productSha: PRODUCT_SHA, page: BASE, viewport: '390x900', current: CURRENT, candidates: CANDIDATES, status: 'running' }
try {
  await enterResults(c); await openCompare(c)
  report.initialState = stableState(await state(c))
  report.initialPicker = await pickerMetrics(c)
  report.initialMeasure = await measure(c)
  await c.shot('390-compare-initial.png')
  assert.equal(report.initialPicker.buttons.length, 5)
  assert.equal(report.initialPicker.buttons.filter((b) => b.ariaPressed === 'true').length, 1)

  report.touchScroll = await touchScrollToLast(c)
  report.pointerLast = await clickVisiblePicker(c, 4)
  if (report.pointerLast.accessible) assert.equal(report.pointerLast.trusted, true)

  report.keyboardLast = await keyboardToLast(c)
  report.afterKeyboardState = stableState(await state(c))
  assert.deepEqual(report.afterKeyboardState, report.initialState)
  assert.equal(report.keyboardLast.afterEnter.buttons[4].ariaPressed, 'true')
  report.pointerAfterKeyboard = await clickVisiblePicker(c, 4)
  assert.equal(report.pointerAfterKeyboard.accessible, true); assert.equal(report.pointerAfterKeyboard.trusted, true)
  report.afterPointerState = stableState(await state(c))
  assert.deepEqual(report.afterPointerState, report.initialState)

  report.finalPicker = await pickerMetrics(c)
  report.finalMeasure = await measure(c)
  const longName = report.finalMeasure.styles.candidateName
  assert.equal(longName.text, CANDIDATES[4].name)
  assert.notEqual(longName.textOverflow, 'ellipsis')
  assert.ok(longName.scrollWidth <= longName.clientWidth + 1)
  assert.ok(longName.scrollHeight <= longName.clientHeight + 1)
  await c.shot('390-compare-last.png')
  report.network = await networkReport(c)
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('COMPARE_390_PASS', JSON.stringify({ initialPicker: report.initialPicker, touchScroll: report.touchScroll, keyboardLast: report.keyboardLast, layout: report.initialMeasure.layout, styles: report.finalMeasure.styles, unknowns: report.initialMeasure.unknowns, network: report.network }))
} catch (error) {
  report.status = 'fail'; report.error = String(error?.stack ?? error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  await cleanup(handle)
}
