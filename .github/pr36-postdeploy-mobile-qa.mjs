import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PAGE = process.env.QA_PAGE ?? 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.MERGE_SHA ?? 'unknown'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const STORAGE_KEY = 'catfood.switch-session.v1'
const OUT = 'qa-artifacts'
const STEP_LABELS = ['현재 제품', '사용 규격', '바꿀 것', '유지할 것', '후보']
mkdirSync(OUT, { recursive: true })
assert.ok(SUPABASE_URL && SUPABASE_KEY, 'public Supabase read config missing')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)

async function apiRows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view} read failed: ${response.status}`)
  return response.json()
}

async function context() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,variant_count',
    brand: 'eq.AATU', canonical_name: 'eq.연어', limit: 10,
  })
  const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어')
  assert.ok(current, 'AATU 연어 not found')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,display_rank',
    product_id: `eq.${current.product_id}`, order: 'display_rank.asc,variant_id.asc', limit: 100,
  })
  const sku = variants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? ''))
  assert.ok(sku, 'AATU 연어 1 kg SKU not found')
  return { current, sku }
}

class Browser {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(domain)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const nativeFetch = window.fetch.bind(window)
      const nativeBeacon = navigator.sendBeacon?.bind(navigator)
      window.__qaBlockedAnalytics = 0
      window.__qaBlockedWrites = 0
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
        if (url.includes('/functions/v1/decision-intake')) { window.__qaBlockedAnalytics += 1; return Promise.reject(new TypeError('QA blocked analytics before send')) }
        if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(method)) { window.__qaBlockedWrites += 1; return Promise.reject(new TypeError('QA blocked production write before send')) }
        return nativeFetch(input, init)
      }
      if (nativeBeacon) navigator.sendBeacon = (url, data) => {
        if (String(url).includes('/functions/v1/decision-intake')) { window.__qaBlockedAnalytics += 1; return false }
        return nativeBeacon(url, data)
      }
    })();` })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await this.eval(`Boolean(${expression})`)) return } catch {} await sleep(120) } throw new Error(`timeout: ${label}`) }
  async navigate(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState === 'complete'`, 'document ready'); await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'app root'); await this.eval('document.fonts?.ready'); await sleep(350) }
  async shot(path) { await this.eval('document.fonts?.ready'); await sleep(120); const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(path, Buffer.from(image.data, 'base64')) }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9800 + (process.pid % 100)
  const dir = `/tmp/pr36-postdeploy-${process.pid}-${Math.random().toString(16).slice(2)}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const browser = new Browser(page.webSocketDebuggerUrl); await browser.connect()
        await browser.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844 })
        await browser.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' })
        return { browser, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function state(browser) { return browser.eval(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`)}
async function waitState(browser, expression, label) { await browser.wait(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); if(!raw)return false; const s=JSON.parse(raw).state; return ${expression} })()`, label) }
async function setQuery(browser, value) {
  const ok = await browser.eval(`(() => { const input=document.querySelector('.switch-find-search input'); if(!input)return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${js(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(ok, true, 'search input missing'); await sleep(220)
}
async function setupClickContains(browser, selector, text) {
  const ok = await browser.eval(`(() => { const item=[...document.querySelectorAll(${js(selector)})].find((node)=>node.textContent.includes(${js(text)})); if(!item)return false; item.click(); return true })()`)
  assert.equal(ok, true, `${selector} missing ${text}`); await sleep(180)
}
async function setupClickExact(browser, scope, text) {
  await browser.wait(`(() => { const root=document.querySelector(${js(scope)}); return root&&[...root.querySelectorAll('button')].some((b)=>b.textContent.trim()===${js(text)}&&!b.disabled) })()`, `enabled ${text}`)
  const ok = await browser.eval(`(() => { const root=document.querySelector(${js(scope)}); const b=[...root.querySelectorAll('button')].find((x)=>x.textContent.trim()===${js(text)}&&!x.disabled); if(!b)return false; b.click(); return true })()`)
  assert.equal(ok, true, `cannot click ${text}`); await sleep(180)
}

async function prepareChange(browser, ctx) {
  const url = `${PAGE}?view=workspace&mode=switch&qa=${Date.now()}`
  await browser.navigate(url)
  await browser.wait(`!document.body.innerText.includes('제품 데이터를 불러오는 중입니다.')`, 'catalog ready')
  await setQuery(browser, `${ctx.current.brand} ${ctx.current.canonical_name}`)
  await browser.wait(`document.querySelectorAll('.switch-find-result').length > 0`, 'AATU result')
  await setupClickContains(browser, '.switch-find-result', ctx.current.canonical_name)
  await browser.wait(`document.querySelector('.switch-current-preview')`, 'preview')
  await setupClickExact(browser, '.switch-current-preview', '이 제품을 현재 사료로 선택 →')
  await waitState(browser, `s.step==='sku'&&s.currentProductId===${js(ctx.current.product_id)}`, 'SKU state')
  await browser.wait(`!document.body.innerText.includes('판매 규격을 불러오는 중입니다.')`, 'SKU load')
  await setupClickContains(browser, '.switch-sku-option', ctx.sku.package_size_text || '1 kg')
  await waitState(browser, `s.variantSelection?.kind==='variant'&&s.variantSelection.variantId===${js(ctx.sku.variant_id)}`, 'SKU selected')
  await setupClickExact(browser, '.switch-step-actions', '다음 →')
  await waitState(browser, `s.step==='change'`, 'CHANGE state')
  await browser.eval(`document.scrollingElement.scrollTop=0`); await sleep(180)
}

async function metrics(browser) {
  return browser.eval(`(() => {
    const rect=(el)=>{const r=el?.getBoundingClientRect();return r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null}
    const rail=document.querySelector('.switch-reference-rail')
    const brand=document.querySelector('.switch-reference-product > div > span')
    const name=document.querySelector('.switch-reference-product > div > strong')
    const sku=document.querySelector('.switch-reference-sku strong')
    const question=document.querySelector('.switch-step-header h1')
    const brandSection=[...document.querySelectorAll('.switch-criterion-section')].find((s)=>s.querySelector('.switch-criterion-heading strong')?.textContent.trim()==='브랜드')
    const firstBrand=brandSection?.querySelector('button')
    const steps=[...document.querySelectorAll('.switch-progress li')].map((li)=>{const s=li.querySelector('strong');return{text:s?.textContent.trim()??'',current:li.getAttribute('aria-current'),client:s?[s.clientWidth,s.clientHeight]:[0,0],scroll:s?[s.scrollWidth,s.scrollHeight]:[0,0]}})
    const reselect=document.querySelector('.switch-change-current'); const rr=reselect?.getBoundingClientRect(); const cx=rr?rr.left+rr.width/2:null; const cy=rr?rr.top+rr.height/2:null; const hit=rr?document.elementFromPoint(cx,cy):null
    return {viewport:[innerWidth,innerHeight],rail:rect(rail),brand:brand?.textContent.trim()??null,name:name?.textContent.trim()??null,sku:sku?.textContent.trim()??null,question:rect(question),firstBrand:rect(firstBrand),steps,reselect:rect(reselect),center:rr?{x:cx,y:cy,hit:Boolean(hit&&(hit===reselect||reselect.contains(hit)))}:null}
  })()`)
}

const ctx = await context()
const { browser, proc, dir } = await launch()
const report = { mergeSha: MERGE_SHA, page: PAGE, status: 'running', metrics: null, pointerEvents: null, resetState: null, network: null, screenshot: 'pages-360x844-change.png' }
try {
  await prepareChange(browser, ctx)
  report.metrics = await metrics(browser)
  assert.deepEqual(report.metrics.viewport, [360, 844])
  assert.equal(report.metrics.brand, 'AATU')
  assert.equal(report.metrics.name, '연어')
  assert.match(report.metrics.sku, /1\s*kg/i)
  assert.deepEqual(report.metrics.steps.map((s)=>s.text), STEP_LABELS)
  assert.equal(report.metrics.steps.filter((s)=>s.current==='step').length, 1)
  for (const step of report.metrics.steps) { assert.ok(step.scroll[0] <= step.client[0] + 1, `${step.text} clipped horizontally`); assert.ok(step.scroll[1] <= step.client[1] + 1, `${step.text} clipped vertically`) }
  assert.ok(report.metrics.rail.height >= 220 && report.metrics.rail.height <= 250, `summary height unexpected: ${report.metrics.rail.height}`)
  assert.ok(report.metrics.question.top >= 0 && report.metrics.question.bottom <= 844, 'question not fully inside first viewport')
  assert.ok(report.metrics.firstBrand.top >= 0 && report.metrics.firstBrand.bottom <= 844, 'first brand button not fully inside first viewport')
  assert.equal(report.metrics.center?.hit, true, 'reselect center occluded')
  await browser.shot(`${OUT}/${report.screenshot}`)
  await browser.eval(`(() => { window.__qaPointerEvents=[]; const b=document.querySelector('.switch-change-current'); for(const t of ['pointerdown','pointerup','click']) b.addEventListener(t,e=>window.__qaPointerEvents.push({type:t,isTrusted:e.isTrusted}),true) })()`)
  const { x, y } = report.metrics.center
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await waitState(browser, `s.step==='current'&&s.currentProductId===null`, 'reselect reset')
  report.pointerEvents = await browser.eval(`window.__qaPointerEvents`)
  assert.ok(report.pointerEvents.some((e)=>e.type==='pointerdown'&&e.isTrusted), 'trusted pointerdown missing')
  assert.ok(report.pointerEvents.some((e)=>e.type==='pointerup'&&e.isTrusted), 'trusted pointerup missing')
  assert.ok(report.pointerEvents.some((e)=>e.type==='click'&&e.isTrusted), 'trusted click missing')
  report.resetState = await state(browser)
  assert.equal(report.resetState.currentProductId, null)
  assert.deepEqual(report.resetState.variantSelection, { kind: 'unselected', variantId: null })
  report.network = {
    blocked: await browser.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`),
    sentAnalytics: browser.requests.filter((r)=>r.url.includes('/functions/v1/decision-intake')),
    sentWrites: browser.requests.filter((r)=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(r.method)),
    publicReads: browser.requests.filter((r)=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&r.method==='GET').length,
  }
  assert.equal(report.network.sentAnalytics.length, 0)
  assert.equal(report.network.sentWrites.length, 0)
  report.status = 'success'
} finally {
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  browser.close(); proc.kill('SIGTERM'); await sleep(200); try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
console.log(JSON.stringify(report, null, 2))
