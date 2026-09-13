import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.MERGE_SHA || ''
const GUIDANCE = '선택한 조건이 미확인인 제품도 후보에 포함될 수 있습니다. 제품별 ‘확인됨’과 ‘미확인’을 확인하세요.'
const OUT = 'qa-artifacts/pr34-postdeploy-guidance'
mkdirSync(OUT, { recursive: true })
assert.equal(MERGE_SHA, '361e96b430b1034aa3ef0ba311c32691c7b694bf')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = []
  }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') {
        this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      }
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(method)
    await this.send('Network.setCacheDisabled', { cacheDisabled: true })
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const nativeFetch=window.fetch.bind(window);const nativeBeacon=navigator.sendBeacon?.bind(navigator);window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return Promise.resolve(url.endsWith('/search-runs')?Response.json({search_run_id:'qa-run'}):Response.json({ok:true}))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1;return Promise.resolve(Response.json({ok:true}))}return nativeFetch(input,init)};if(nativeBeacon){navigator.sendBeacon=(url,data)=>{const u=String(url||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return true}return nativeBeacon(url,data)}}})();` })
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, ms = 45000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout ${label}`)
  }
  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height })
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('.research-status span:last-child')?.textContent.includes('데이터 연결됨')`, 'catalog loaded')
    await this.wait(`document.querySelector('.research-result-card')`, 'result cards')
    await this.eval('document.fonts?.ready')
    await sleep(220)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(100)
    const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(image.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launchBrowser() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9940 + (process.pid % 50)
  const dir = `/tmp/pr34-postdeploy-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    '--disable-features=OverlayScrollbar', '--force-device-scale-factor=1', `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Linux x86_64' })
        return { c, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

const report = { mergeSha: MERGE_SHA, base: BASE, status: 'running' }
let browser
try {
  browser = await launchBrowser()
  const { c } = browser
  await c.viewport(360, 844)
  const url = new URL(BASE)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('applied', '1')
  url.searchParams.set('feed', '건식')
  url.searchParams.set('targets', 'indoor')
  await c.nav(url.toString())

  const top = await c.eval(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};const criteria=document.querySelector('.criteria-bar');const heading=document.querySelector('.research-results-heading');const count=heading?.querySelector('div>span');const context=document.querySelector('.research-results-context');const first=document.querySelector('.research-result-card');const cs=getComputedStyle(context);return{href:location.href,criteria:[...document.querySelectorAll('.criteria-chips span')].map(n=>n.textContent.trim()),count:count?.textContent?.trim()||'',context:context?.textContent?.trim()||'',contextScrollWidth:context?.scrollWidth||0,contextClientWidth:context?.clientWidth||0,contextScrollHeight:context?.scrollHeight||0,contextClientHeight:context?.clientHeight||0,textOverflow:cs.textOverflow,whiteSpace:cs.whiteSpace,overflowX:cs.overflowX,overflowY:cs.overflowY,viewport:{width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth},document:{scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth},rects:{criteria:rect(criteria),heading:rect(heading),count:rect(count),context:rect(context),first:rect(first)}}})()`)
  assert.deepEqual(top.criteria, ['건식', '실내묘'])
  assert.equal(top.context, GUIDANCE)
  assert.ok(top.count.length > 0, 'candidate count missing')
  assert.ok(top.contextScrollWidth <= top.contextClientWidth + 1, 'guidance horizontally clipped')
  assert.ok(top.contextScrollHeight <= top.contextClientHeight + 1, 'guidance vertically clipped')
  assert.notEqual(top.textOverflow, 'ellipsis', 'guidance uses ellipsis')
  assert.notEqual(top.whiteSpace, 'nowrap', 'guidance forced to one line')
  assert.ok(top.document.scrollWidth <= top.document.clientWidth + 1, 'horizontal document overflow')
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  assert.equal(overlaps(top.rects.criteria, top.rects.heading), false, 'criteria overlaps result heading')
  assert.equal(overlaps(top.rects.count, top.rects.context), false, 'candidate count overlaps guidance')
  assert.equal(overlaps(top.rects.context, top.rects.first), false, 'guidance overlaps first card')
  assert.ok(top.rects.context.bottom <= top.viewport.height + 1, 'guidance not fully visible in viewport')
  assert.ok(top.rects.first.top < top.viewport.height, 'first card not visible in viewport')

  await c.shot(`${OUT}/01-360-postdeploy-guidance.png`)

  const blocker = await c.eval(`({blockedAnalytics:window.__qaBlockedAnalytics||0,blockedWrites:window.__qaBlockedWrites||0})`)
  const actualDecisionRequests = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const actualProductionWrites = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(request.method))
  const publicGets = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && request.method === 'GET')
  assert.equal(actualDecisionRequests.length, 0, `analytics escaped blocker: ${JSON.stringify(actualDecisionRequests)}`)
  assert.equal(actualProductionWrites.length, 0, `production write escaped blocker: ${JSON.stringify(actualProductionWrites)}`)
  assert.ok(publicGets.length > 0, 'expected public Supabase GET requests')

  Object.assign(report, { status: 'pass', top, network: { blocker, actualDecisionRequests, actualProductionWrites, publicGetCount: publicGets.length } })
  console.log('PR34_POSTDEPLOY_GUIDANCE_PASS', JSON.stringify({ mergeSha: MERGE_SHA, publicGetCount: publicGets.length, blocker }))
} catch (error) {
  Object.assign(report, { status: 'failed', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
  throw error
} finally {
  writeFileSync(`${OUT}/report.json`, `${JSON.stringify(report, null, 2)}\n`)
  if (browser) {
    browser.c.close()
    try { browser.proc.kill('SIGTERM') } catch {}
    await sleep(250)
    try { rmSync(browser.dir, { recursive: true, force: true }) } catch {}
  }
}
