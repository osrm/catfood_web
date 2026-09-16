import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PAGE = process.env.PAGE_URL ?? 'http://127.0.0.1:4173/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA
const OUT = 'qa-artifacts-lookup-guidance'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })
assert.equal(PRODUCT_SHA, '9372f37c8bbf7279ac64ab7145ea15ddd6c2ed0f')

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = []
    this.responses = []
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
        this.requests.push({ id: message.params.requestId, url: request.url, method: request.method })
      }
      if (message.method === 'Network.responseReceived') {
        const response = message.params.response
        this.responses.push({ id: message.params.requestId, url: response.url, status: response.status })
      }
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(domain)
    await this.send('Network.setCacheDisabled', { cacheDisabled: true })
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch=window.fetch.bind(window)
      window.__qaBlocked={analytics:0,writes:0,delayedReads:0}
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
        if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&method==='GET'){
          window.__qaBlocked.delayedReads++
          return new Promise(resolve=>setTimeout(resolve,900)).then(()=>nativeFetch(input,init))
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

  async wait(expression, label, timeout = 30000, interval = 40) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`).catch(() => false)) return
      await sleep(interval)
    }
    throw new Error(`timeout: ${label}`)
  }

  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length`, 'root')
    await this.eval('document.fonts?.ready.then(()=>true)')
  }

  async shot(name) {
    await this.eval('document.fonts?.ready.then(()=>true)')
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }

  close() { try { this.ws?.close() } catch {} }
}

async function launchChrome() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const port = 18400 + (process.pid % 200)
  const dir = `/tmp/lookup-guidance-${process.pid}`
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
      return { c, proc, dir }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}

async function stopProcess(proc) {
  if (proc.exitCode != null) return
  proc.kill('SIGTERM')
  for (let i = 0; i < 20 && proc.exitCode == null; i++) await sleep(50)
  if (proc.exitCode == null) {
    proc.kill('SIGKILL')
    for (let i = 0; i < 20 && proc.exitCode == null; i++) await sleep(50)
  }
}

async function setViewport(c, width, height) {
  await c.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width <= 760, screenWidth: width, screenHeight: height,
  })
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: width <= 760, maxTouchPoints: 5 })
}

async function trustedClickText(c, selector, text) {
  const point = await c.eval(`(()=>{
    const node=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim()===${JSON.stringify(text)})
    if(!node)return null
    const r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y)
    return{x,y,hit:Boolean(hit&&(hit===node||node.contains(hit)))}
  })()`)
  assert.ok(point?.hit, `target not hittable: ${text}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
}

async function typeLookup(c, text) {
  const point = await c.eval(`(()=>{const n=document.querySelector('.lookup-input');if(!n)return null;const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  assert.ok(point, 'lookup input missing')
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  await c.send('Input.insertText', { text })
}

async function guidanceMetrics(c) {
  return c.eval(`(()=>{
    const el=document.querySelector('.research-results-heading > div > span')
    const label=document.querySelector('.research-results-heading > div > strong')
    if(!el||!label)return null
    const r=el.getBoundingClientRect(),lr=label.getBoundingClientRect(),s=getComputedStyle(el)
    const overlap=Math.max(0,Math.min(r.right,lr.right)-Math.max(r.left,lr.left))*Math.max(0,Math.min(r.bottom,lr.bottom)-Math.max(r.top,lr.top))
    return{
      text:el.textContent.trim(),
      rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},
      fontSize:s.fontSize,lineHeight:s.lineHeight,whiteSpace:s.whiteSpace,
      clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,
      fullyInViewport:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,
      clipped:el.scrollWidth>el.clientWidth+1||el.scrollHeight>el.clientHeight+1,
      labelOverlapArea:overlap,
      viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth},
    }
  })()`)
}

const handle = await launchChrome()
const report = { productSha: PRODUCT_SHA, page: PAGE, viewports: {}, network: null }
try {
  for (const viewport of [{ name: '360', width: 360, height: 844 }, { name: '1280', width: 1280, height: 900 }]) {
    await setViewport(handle.c, viewport.width, viewport.height)
    await handle.c.nav(`${PAGE}?view=workspace&mode=lookup`)
    await handle.c.wait(`document.querySelector('.research-results-heading > div > span')?.textContent.trim()==='브랜드나 제품명을 입력하면 결과가 표시됩니다.'`, 'LOOKUP initial guidance', 5000)
    const lookupInitial = await guidanceMetrics(handle.c)
    assert.equal(lookupInitial.text, '브랜드나 제품명을 입력하면 결과가 표시됩니다.')
    assert.equal(lookupInitial.clipped, false)
    assert.equal(lookupInitial.fullyInViewport, true)
    assert.equal(lookupInitial.labelOverlapArea, 0)
    await handle.c.shot(`${viewport.name}-lookup-initial.png`)

    await handle.c.wait(`!document.body.innerText.includes('제품 데이터를 불러오는 중입니다.')`, 'catalog settled')
    await handle.c.wait(`document.body.innerText.includes('브랜드 또는 제품명을 입력해 주세요.')`, 'blank lookup state')
    const blankState = await handle.c.eval(`({body:document.body.innerText.includes('브랜드 또는 제품명을 입력해 주세요.')&&document.body.innerText.includes('일부만 입력해도 검색할 수 있습니다.'),heading:document.querySelector('.research-results-heading > div > span')?.textContent.trim()})`)
    assert.equal(blankState.body, true)

    await typeLookup(handle.c, 'zzzz-no-such-catfood-product')
    await handle.c.wait(`document.body.innerText.includes('검색 결과가 없습니다.')`, 'lookup no results')
    const noResults = await handle.c.eval(`document.body.innerText.includes('검색어를 다시 확인해 주세요.')`)
    assert.equal(noResults, true)

    await trustedClickText(handle.c, '.mode-button', '조건으로 찾기')
    await handle.c.wait(`document.querySelector('.research-results-heading > div > span')?.textContent.trim()==='조건을 고르면 결과가 표시됩니다.'`, 'EXPLORE guidance')
    await handle.c.wait(`document.body.innerText.includes('조건을 골라 주세요.')`, 'EXPLORE initial state')
    const explore = await guidanceMetrics(handle.c)
    assert.equal(explore.text, '조건을 고르면 결과가 표시됩니다.')
    assert.equal(explore.clipped, false)
    assert.equal(explore.labelOverlapArea, 0)
    await handle.c.shot(`${viewport.name}-explore.png`)

    report.viewports[viewport.name] = { lookupInitial, blankState, noResults, explore }
  }

  const supabase = handle.c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co'))
  const nonRead = supabase.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  const badStatuses = handle.c.responses.filter((response) => response.url.includes('gnosbstdatkytsyxuapt.supabase.co') && response.status >= 400)
  report.network = {
    supabaseRequests: supabase.length,
    methods: [...new Set(supabase.map((request) => request.method))],
    nonRead,
    badStatuses,
    blocked: await handle.c.eval('window.__qaBlocked'),
  }
  assert.equal(nonRead.length, 0)
  assert.equal(badStatuses.length, 0)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('LOOKUP_GUIDANCE_BROWSER_PASS')
  console.log(JSON.stringify(report, null, 2))
} finally {
  handle.c.close()
  await stopProcess(handle.proc)
  try { rmSync(handle.dir, { recursive: true, force: true }) } catch (error) {
    console.warn(`QA cleanup warning: ${error instanceof Error ? error.message : String(error)}`)
  }
}
