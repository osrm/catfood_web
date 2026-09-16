import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PAGE = process.env.PAGE_URL ?? 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.MERGE_SHA
const OUT = 'qa-artifacts-pr42-postdeploy'
const STORAGE = 'catfood.switch-session.v1'
const TARGET_CANDIDATE = '오리지날 울트라 그레인프리 인도어 닭 & 연어 레시피'
const q = JSON.stringify
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })
assert.equal(MERGE_SHA, '83e4ca5acb8ac4f44b28c840260c63c679403195')

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = new Map()
    this.responses = new Map()
    this.failures = new Map()
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
        const request = message.params.request
        this.requests.set(message.params.requestId, { url: request.url, method: request.method })
      }
      if (message.method === 'Network.responseReceived') {
        const response = message.params.response
        this.responses.set(message.params.requestId, { url: response.url, status: response.status, statusText: response.statusText, mimeType: response.mimeType })
      }
      if (message.method === 'Network.loadingFailed') {
        this.failures.set(message.params.requestId, { errorText: message.params.errorText, canceled: message.params.canceled ?? false })
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
    await this.eval('document.fonts?.ready.then(()=>true)')
    await sleep(220)
  }

  async shot(name) {
    await this.eval('document.fonts?.ready.then(()=>true)')
    await sleep(80)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }

  async failedApiDetails() {
    const rows = []
    for (const [requestId, request] of this.requests) {
      if (!request.url.includes('gnosbstdatkytsyxuapt.supabase.co')) continue
      const response = this.responses.get(requestId) ?? null
      const failure = this.failures.get(requestId) ?? null
      if (failure?.canceled) continue
      if (!(failure || (response && response.status >= 400))) continue
      let body = null
      if (response) {
        try { body = (await this.send('Network.getResponseBody', { requestId })).body.slice(0, 1200) } catch {}
      }
      rows.push({ method: request.method, url: request.url, status: response?.status ?? null, statusText: response?.statusText ?? null, failure, body })
    }
    return rows
  }

  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const port = 17600 + (process.pid % 240)
  const dir = `/tmp/pr42-postdeploy-${process.pid}`
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
      await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844 })
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
    if(!hit||!(hit===node||node.contains(hit)))return{blocked:true,hit:hit?.className||hit?.tagName,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}
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
  const catalogError = await c.eval(`document.body.innerText.includes('제품 데이터를 불러오지 못했습니다.')||document.body.innerText.includes('제품 목록을 불러오지 못했습니다.')`)
  if (catalogError) throw new Error(`catalog load failed: ${await c.eval('document.body.innerText.slice(0,1200)')}`)
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
  await c.wait(`[...document.querySelectorAll('.switch-candidate-row')].some(x=>x.textContent.includes(${q(TARGET_CANDIDATE)}))`, 'long candidate')
}

async function addLongCandidateAndOpenCompare(c) {
  await trustedPointClick(c, '.switch-candidate-row', TARGET_CANDIDATE)
  await c.wait(`document.querySelector('.switch-candidate-inspector h1')?.textContent.includes(${q(TARGET_CANDIDATE)})`, 'candidate inspector')
  const brand = await c.eval(`document.querySelector('.switch-candidate-inspector')?.textContent.includes('내추럴발란스')`)
  assert.equal(brand, true)
  await trustedPointClick(c, '.switch-inspector-actions .switch-compare-action', '비교에 추가')
  await c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});const s=raw?JSON.parse(raw).state:null;return s?.compareIds?.length===1})()`, 'compare count 1')
  await trustedPointClick(c, '.switch-preview-topline button')
  await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'inspector closed')
  await trustedPointClick(c, '.switch-compare-dock > button', '비교 보기')
  await c.wait(`document.querySelector('.compare-stage.is-switch-overview')`, 'switch compare overview')
  await c.wait(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.includes(${q(TARGET_CANDIDATE)})`, 'long candidate header')
}

async function alignHeader(c) {
  await c.eval(`(()=>{const n=document.querySelector('.compare-mobile-head-grid');n?.scrollIntoView({block:'start',inline:'nearest'});scrollBy(0,-8);return true})()`)
  await sleep(100)
}

async function headerMetrics(c) {
  return c.eval(`(()=>{
    const rect=n=>n?(()=>{const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})():null
    const info=n=>{if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect();return{text:n.textContent.replace(/\\s+/g,' ').trim(),fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,overflow:s.overflow,textOverflow:s.textOverflow,lineClamp:s.webkitLineClamp,whiteSpace:s.whiteSpace,rect:rect(n),scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight}}
    const current=document.querySelector('.compare-mobile-product-head.is-current')
    const candidate=document.querySelector('.compare-mobile-product-head.is-candidate')
    const actions=[...document.querySelectorAll('.compare-mobile-head-actions button')]
    const actionInfo=actions.map(b=>{const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y),s=getComputedStyle(b);return{...info(b),minHeight:s.minHeight,hit:Boolean(h&&(h===b||b.contains(h)))}})
    const sequence=[candidate?.querySelector(':scope > span'),candidate?.querySelector('.compare-mobile-product-brand'),candidate?.querySelector(':scope > strong'),candidate?.querySelector(':scope > small:nth-of-type(2)'),candidate?.querySelector('.compare-mobile-head-actions')].filter(Boolean).map(rect)
    const nonOverlap=sequence.every((r,i)=>i===0||r.top>=sequence[i-1].bottom-1)
    return{
      viewport:{innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body.scrollWidth},
      headGrid:rect(document.querySelector('.compare-mobile-head-grid')),
      current:{role:info(current?.querySelector(':scope > span')),brand:info(current?.querySelector('.compare-mobile-product-brand')),name:info(current?.querySelector(':scope > strong')),usage:info(current?.querySelector(':scope > small:nth-of-type(2)')),sale:info(current?.querySelector(':scope > small:nth-of-type(3)'))},
      candidate:{role:info(candidate?.querySelector(':scope > span')),brand:info(candidate?.querySelector('.compare-mobile-product-brand')),name:info(candidate?.querySelector(':scope > strong')),sale:info(candidate?.querySelector(':scope > small:nth-of-type(2)'))},
      actions:actionInfo,
      nonOverlap
    }
  })()`)
}

async function pressTab(c) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await sleep(60)
}

async function focusActions(c) {
  await c.eval('document.activeElement?.blur()')
  const found = []
  for (let i = 0; i < 32 && found.length < 2; i++) {
    await pressTab(c)
    const snap = await c.eval(`(()=>{const n=document.activeElement,s=n?getComputedStyle(n):null;return{matches:Boolean(n?.matches('.compare-mobile-head-actions button')),text:n?.textContent?.trim()??null,focusVisible:Boolean(n?.matches(':focus-visible')),outlineStyle:s?.outlineStyle??null,outlineWidth:s?.outlineWidth??null}})()`)
    if (snap.matches) found.push(snap)
  }
  assert.equal(found.length, 2)
  for (const item of found) {
    assert.equal(item.focusVisible, true)
    assert.notEqual(item.outlineStyle, 'none')
    assert.notEqual(item.outlineWidth, '0px')
  }
  return found
}

async function pointerDetailRoundTrip(c) {
  const before = await c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.trim()`)
  await trustedPointClick(c, '.compare-mobile-head-actions button', '상세 보기')
  await c.wait(`document.querySelector('.detail-stage')`, 'candidate detail')
  const detailName = await c.eval(`document.querySelector('.detail-identity h1')?.textContent.trim()`)
  assert.equal(detailName, TARGET_CANDIDATE)
  await trustedPointClick(c, '.detail-topbar button', '돌아가기')
  await c.wait(`document.querySelector('.compare-stage.is-switch-overview')`, 'compare after detail')
  await c.wait(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.includes(${q(TARGET_CANDIDATE)})`, 'candidate restored')
  const after = await c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate strong')?.textContent.trim()`)
  assert.equal(after, before)
  return { before, detailName, after }
}

async function networkSummary(c) {
  const blocked = await c.eval('window.__qaBlocked')
  const requests = [...c.requests.values()]
  const supabase = requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co'))
  const nonRead = supabase.filter((request) => !['GET','HEAD','OPTIONS'].includes(request.method))
  const analytics = requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const statuses = [...c.responses.values()].filter((response) => response.url.includes('gnosbstdatkytsyxuapt.supabase.co')).map((response) => ({ status: response.status, path: new URL(response.url).pathname }))
  assert.equal(nonRead.length, 0)
  assert.equal(analytics.length, 0)
  assert.equal(blocked.writes, 0)
  return { total: requests.length, supabaseRead: supabase.length, nonRead: 0, analyticsNetwork: 0, blocked, statuses }
}

function assertReadable(metrics) {
  assert.equal(metrics.viewport.innerWidth, 360)
  assert.ok(metrics.viewport.scrollWidth <= 361, `document horizontal overflow: ${JSON.stringify(metrics.viewport)}`)
  assert.ok(metrics.viewport.bodyScrollWidth <= 361, `body horizontal overflow: ${JSON.stringify(metrics.viewport)}`)
  assert.equal(metrics.current.name.fontSize, '14px')
  assert.equal(metrics.candidate.name.fontSize, '14px')
  for (const item of [metrics.current.role, metrics.current.brand, metrics.current.usage, metrics.current.sale, metrics.candidate.role, metrics.candidate.brand, metrics.candidate.sale]) assert.equal(item.fontSize, '11px')
  assert.ok(metrics.current.usage.text.includes('사용 규격 · 1 kg'))
  assert.ok(metrics.current.sale.text.includes('판매 규격'))
  assert.ok(metrics.candidate.sale.text.includes('판매 규격'))
  assert.equal(metrics.candidate.name.text, TARGET_CANDIDATE)
  for (const item of [metrics.current.name, metrics.current.usage, metrics.current.sale, metrics.candidate.name, metrics.candidate.sale]) {
    assert.notEqual(item.textOverflow, 'ellipsis')
    assert.ok(item.scrollWidth <= item.clientWidth + 1, `horizontal text clip: ${item.text}`)
    assert.ok(item.scrollHeight <= item.clientHeight + 1, `vertical text clip: ${item.text}`)
  }
  assert.equal(metrics.nonOverlap, true)
  assert.equal(metrics.actions.length, 2)
  for (const action of metrics.actions) {
    assert.equal(action.fontSize, '12px')
    assert.ok(action.rect.height >= 44)
    assert.equal(action.minHeight, '44px')
    assert.equal(action.hit, true)
  }
}

const handle = await launch()
try {
  await enterResults(handle.c)
  const sessionBeforeCompare = await handle.c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`)
  assert.equal(sessionBeforeCompare.currentProductId, 'product_d99406c26240b263')
  assert.deepEqual(sessionBeforeCompare.variantSelection, { kind: 'variant', variantId: 'variant_6e426a0abf2e1a43' })
  await addLongCandidateAndOpenCompare(handle.c)
  await alignHeader(handle.c)
  const metrics = await headerMetrics(handle.c)
  assertReadable(metrics)
  await handle.c.shot('postdeploy-360-header.png')
  const focus = await focusActions(handle.c)
  const detailRoundTrip = await pointerDetailRoundTrip(handle.c)
  const network = await networkSummary(handle.c)
  const apiFailures = await handle.c.failedApiDetails()
  assert.equal(apiFailures.length, 0, `public API failures: ${JSON.stringify(apiFailures)}`)
  const report = {
    status: 'pass',
    mergeSha: MERGE_SHA,
    page: PAGE,
    viewport: { width: 360, height: 844 },
    method: 'live deployed Pages with real public API reads; first-navigation analytics/non-read Supabase guard; no fixture or CSS injection',
    current: { productId: sessionBeforeCompare.currentProductId, variantSelection: sessionBeforeCompare.variantSelection, label: 'AATU 연어 · 1 kg' },
    candidate: { name: TARGET_CANDIDATE },
    metrics,
    focus,
    detailRoundTrip,
    network,
    apiFailures,
    browserZoom200: 'not verified',
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR42_POSTDEPLOY_360_PASS')
  console.log(JSON.stringify({ current: report.current, candidate: report.candidate, typography: { currentName: metrics.current.name.fontSize, supporting: metrics.current.role.fontSize, actions: metrics.actions.map((item) => ({ text: item.text, fontSize: item.fontSize, height: item.rect.height, hit: item.hit })) }, overflow: metrics.viewport, focus, detailRoundTrip, network }, null, 2))
} catch (error) {
  const apiFailures = await handle.c.failedApiDetails().catch(() => [])
  const diagnostic = {
    status: 'fail',
    mergeSha: MERGE_SHA,
    error: error instanceof Error ? error.message : String(error),
    body: await handle.c.eval('document.body.innerText.slice(0,1600)').catch(() => null),
    blocked: await handle.c.eval('window.__qaBlocked').catch(() => null),
    apiFailures,
  }
  writeFileSync(`${OUT}/diagnostic.json`, JSON.stringify(diagnostic, null, 2))
  console.error(JSON.stringify(diagnostic, null, 2))
  throw error
} finally {
  await cleanup(handle)
}
