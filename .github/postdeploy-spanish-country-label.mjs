import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const MERGE_SHA = '5cddc26b559851a12e65a327c169a6836ddf24b0'
const PRODUCT_ID = 'product_c277594a66531d32'
const QUERY = '어드밴스 캣 센시티브'
const ORIGIN = 'https://osrm.github.io/catfood_web/'
const OUT = 'qa-artifacts/postdeploy-spanish-country-label'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const env = readFileSync('.env.example', 'utf8')
const API = env.match(/^VITE_SUPABASE_URL=(.+)$/m)?.[1]?.trim()?.replace(/\/$/, '')
const KEY = env.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.+)$/m)?.[1]?.trim()
assert.ok(API && KEY, 'public API config unavailable')

const apiUrl = new URL(`${API}/rest/v1/product_detail_markets`)
apiUrl.searchParams.set('select', 'product_id,country_code,distribution_status,formula_correspondence_status,assessed_at,display_rank')
apiUrl.searchParams.set('product_id', `eq.${PRODUCT_ID}`)
apiUrl.searchParams.set('country_code', 'eq.ES')
const apiResponse = await fetch(apiUrl, { method: 'GET', headers: { apikey: KEY, 'Accept-Profile': 'api' } })
assert.ok(apiResponse.ok, `public API ${apiResponse.status}`)
const apiRows = await apiResponse.json()
assert.equal(apiRows.length, 1, `expected one ES row, got ${apiRows.length}`)
const apiRow = apiRows[0]
assert.equal(apiRow.distribution_status, 'current_product_confirmed')
assert.equal(apiRow.formula_correspondence_status, 'exact_same')
assert.ok(apiRow.assessed_at, 'assessed_at missing')

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data)
      if (m.method === 'Network.requestWillBeSent') this.requests.push({ url: m.params.request.url, method: m.params.request.method })
      if (!m.id) return
      const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const nf=window.fetch.bind(window),nb=navigator.sendBeacon?.bind(navigator);window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;window.fetch=(input,init={})=>{const u=typeof input==='string'?input:(input&&input.url)||'',m=String(init.method||(input&&input.method)||'GET').toUpperCase();if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics++;return Promise.resolve(new Response(null,{status:204}))}if(u.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(m)){window.__qaBlockedWrites++;return Promise.resolve(new Response(null,{status:204}))}return nf(input,init)};if(nb)navigator.sendBeacon=(u,d)=>{u=String(u||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics++;return true}return nb(u,d)}})();` })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value }
  async wait(expression, label, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { if (await this.eval(`Boolean(${expression})`)) return; await sleep(100) } throw new Error(`timeout ${label}`) }
  close() { try { this.ws?.close() } catch {} }
}

const chrome = '/usr/bin/google-chrome'
assert.ok(existsSync(chrome), 'Chrome unavailable')
const dir = `/tmp/catfood-postdeploy-${process.pid}`
rmSync(dir, { recursive: true, force: true })
const port = 9820 + (process.pid % 80)
const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
let c
try {
  for (let i = 0; i < 200 && !c; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (page) { c = new Cdp(page.webSocketDebuggerUrl); await c.connect() }
    } catch {}
    if (!c) await sleep(100)
  }
  assert.ok(c, 'Chrome launch timeout')
  await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844 })
  await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' })
  const params = new URLSearchParams({ view: 'workspace', mode: 'lookup', q: QUERY, selected: PRODUCT_ID, detail: PRODUCT_ID, detailTab: 'context' })
  await c.send('Page.navigate', { url: `${ORIGIN}?${params}` })
  await c.wait(`document.readyState==='complete'&&document.querySelector('.detail-stage')`, 'detail stage')
  await c.wait(`document.querySelector('#detail-tab-context')?.getAttribute('aria-selected')==='true'`, 'context tab')
  await c.wait(`![...document.querySelectorAll('.detail-state')].some(n=>n.textContent.includes('불러오는 중'))`, 'context resources')
  const visible = await c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim();const row=[...document.querySelectorAll('.detail-market-row')].find(n=>nrm(n.querySelector(':scope>div:first-child strong')?.textContent)==='스페인');if(!row)return null;row.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=row.getBoundingClientRect();return{rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},inViewport:r.top>=0&&r.bottom<=innerHeight,parts:[...row.children].map(n=>({label:nrm(n.querySelector('span')?.textContent),value:nrm(n.querySelector('strong')?.textContent)})),text:nrm(row.textContent)}})()`)
  assert.ok(visible, 'Spain row not found')
  await sleep(150)
  const row = await c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim();const row=[...document.querySelectorAll('.detail-market-row')].find(n=>nrm(n.querySelector(':scope>div:first-child strong')?.textContent)==='스페인');const r=row.getBoundingClientRect();return{rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},inViewport:r.top>=0&&r.bottom<=innerHeight,parts:[...row.children].map(n=>({label:nrm(n.querySelector('span')?.textContent),value:nrm(n.querySelector('strong')?.textContent)})),text:nrm(row.textContent)}})()`)
  assert.equal(row.inViewport, true, `Spain row not fully visible: ${JSON.stringify(row.rect)}`)
  const parts = Object.fromEntries(row.parts.map((x, i) => [i === 0 ? 'country' : x.label, x.value]))
  assert.equal(parts.country, '스페인')
  assert.equal(parts['유통'], '현재 제품 유통 확인')
  assert.equal(parts['한국 제품과의 배합 비교'], '동일 배합 확인')
  assert.equal(row.parts[0].label, `${apiRow.assessed_at} 확인`)
  const shot = await c.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const screenshot = `${OUT}/advance-spain-row-360x844.png`
  writeFileSync(screenshot, Buffer.from(shot.data, 'base64'))
  const safety = await c.eval(`({blockedAnalytics:window.__qaBlockedAnalytics||0,blockedWrites:window.__qaBlockedWrites||0})`)
  const sentAnalytics = c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method))
  assert.equal(sentAnalytics.length, 0, 'analytics reached network')
  assert.equal(sentWrites.length, 0, 'production write reached network')
  const report = { status: 'passed', mergeSha: MERGE_SHA, origin: ORIGIN, chrome: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim(), viewport: { width: 360, height: 844 }, product: { productId: PRODUCT_ID, query: QUERY }, apiRow, ui: row, safety: { ...safety, sentAnalytics, sentWrites }, screenshot }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  c?.close(); try { proc.kill('SIGTERM') } catch {}; await sleep(250); try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
