import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PAGE = process.env.PAGE_URL ?? 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.MERGE_SHA
const OUT = 'qa-artifacts-first-visit-review'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })
assert.equal(MERGE_SHA, '83e4ca5acb8ac4f44b28c840260c63c679403195')

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

  async wait(expression, label, timeout = 30000) {
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
    await this.wait(`!document.body.innerText.includes('제품 목록을 불러오는 중입니다.')`, 'catalog settled').catch(() => {})
    await this.eval('document.fonts?.ready.then(()=>true)')
    await sleep(450)
  }

  async shot(name) {
    await this.eval('document.fonts?.ready.then(()=>true)')
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }

  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const port = 18100 + (process.pid % 200)
  const dir = `/tmp/first-visit-${process.pid}`
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

async function setViewport(c, width, height) {
  await c.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width <= 760, screenWidth: width, screenHeight: height,
  })
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: width <= 760, maxTouchPoints: 5 })
}

async function snapshot(c) {
  return c.eval(`(()=>{
    const rect=n=>{const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    const visible=n=>{const r=n.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth}
    const items=[...document.querySelectorAll('h1,h2,h3,p,button,input,.home-search-console,.home-start-path')]
      .filter(visible)
      .slice(0,100)
      .map(n=>({tag:n.tagName,className:n.className||'',text:(n.placeholder||n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,260),rect:rect(n)}))
    return{
      url:location.href,
      viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth},
      bodyText:document.body.innerText.replace(/\\n{3,}/g,'\\n\\n').slice(0,7000),
      items,
      blocked:window.__qaBlocked,
    }
  })()`)
}

const handle = await launch()
const report = { mergeSha: MERGE_SHA, page: PAGE, views: {}, network: null }
try {
  const routes = {
    home: PAGE,
    lookup: `${PAGE}?view=workspace&mode=lookup`,
    switch: `${PAGE}?view=workspace&mode=switch`,
    explore: `${PAGE}?view=workspace&mode=explore`,
  }
  for (const viewport of [{ name: '360', width: 360, height: 844 }, { name: '1280', width: 1280, height: 900 }]) {
    await setViewport(handle.c, viewport.width, viewport.height)
    const views = {}
    for (const [name, url] of Object.entries(routes)) {
      await handle.c.nav(url)
      views[name] = await snapshot(handle.c)
      await handle.c.shot(`${viewport.name}-${name}.png`)
    }
    report.views[viewport.name] = views
  }

  const supabase = handle.c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co'))
  const nonRead = supabase.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  const badStatuses = handle.c.responses.filter((response) => response.url.includes('gnosbstdatkytsyxuapt.supabase.co') && response.status >= 400)
  report.network = {
    supabaseRequests: supabase.length,
    nonRead,
    badStatuses,
    blocked: await handle.c.eval('window.__qaBlocked'),
  }
  assert.equal(nonRead.length, 0)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('FIRST_VISIT_REVIEW_CAPTURE_PASS')
  console.log(JSON.stringify({
    network: report.network,
    home360: report.views['360'].home.items,
    home1280: report.views['1280'].home.items,
  }, null, 2))
} finally {
  handle.c.close()
  handle.proc.kill('SIGTERM')
  await sleep(80)
  if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL')
  rmSync(handle.dir, { recursive: true, force: true })
}
