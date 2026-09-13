import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const ORIGIN = 'https://osrm.github.io/catfood_web/'
const OUT = 'qa-artifacts/mobile-mode-nav-baseline'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })

class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('ws timeout')), 15000); this.ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true }); this.ws.addEventListener('error', reject, { once: true }) })
    this.ws.addEventListener('message', (event) => { const m = JSON.parse(event.data); if (m.method === 'Network.requestWillBeSent') this.requests.push({ url: m.params.request.url, method: m.params.request.method }); if (!m.id) return; const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: false, screenWidth: 360, screenHeight: 844 })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const nf=window.fetch.bind(window),nb=navigator.sendBeacon?.bind(navigator);window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;window.fetch=(input,init={})=>{const u=typeof input==='string'?input:(input&&input.url)||'',m=String(init.method||(input&&input.method)||'GET').toUpperCase();if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics++;return Promise.resolve(new Response(null,{status:204}))}if(u.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(m)){window.__qaBlockedWrites++;return Promise.resolve(new Response(null,{status:204}))}return nf(input,init)};if(nb)navigator.sendBeacon=(u,d)=>{u=String(u||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics++;return true}return nb(u,d)}})();` })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value }
  async wait(expression, label) { for (let i = 0; i < 450; i++) { if (await this.eval(`Boolean(${expression})`)) return; await sleep(100) } throw new Error(`timeout: ${label}`) }
  close() { try { this.ws?.close() } catch {} }
}

const chrome = '/usr/bin/google-chrome'
assert.ok(existsSync(chrome), 'Chrome unavailable')
const dir = `/tmp/catfood-mode-nav-${process.pid}`
rmSync(dir, { recursive: true, force: true })
const port = 9830 + (process.pid % 50)
const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache','--disable-features=OverlayScrollbar','--force-device-scale-factor=1',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
let c
try {
  for (let i = 0; i < 200 && !c; i++) { try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = pages.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (page) { c = new Cdp(page.webSocketDebuggerUrl); await c.connect() } } catch {}; if (!c) await sleep(100) }
  assert.ok(c, 'Chrome launch timeout')
  const results = {}
  for (const mode of ['lookup', 'explore', 'switch']) {
    await c.send('Page.navigate', { url: `${ORIGIN}?view=workspace&mode=${mode}` })
    await c.wait(`document.readyState==='complete'&&document.querySelector('.mode-nav')`, `${mode} nav`)
    await sleep(600)
    results[mode] = await c.eval(`(()=>{const nav=document.querySelector('.mode-nav'),buttons=[...nav.querySelectorAll('.mode-button')],ns=getComputedStyle(nav),nr=nav.getBoundingClientRect();const measure=b=>{const r=b.getBoundingClientRect(),s=getComputedStyle(b),range=document.createRange();range.selectNodeContents(b);const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{text:b.textContent.trim(),ariaCurrent:b.getAttribute('aria-current'),rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},height:s.height,padding:s.padding,whiteSpace:s.whiteSpace,textRectCount:[...range.getClientRects()].length,pointerHit:hit===b||b.contains(hit)}};return{viewport:{innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,dpr:devicePixelRatio},nav:{rect:{x:nr.x,y:nr.y,width:nr.width,height:nr.height},clientWidth:nav.clientWidth,scrollWidth:nav.scrollWidth,clientHeight:nav.clientHeight,scrollHeight:nav.scrollHeight,overflowX:ns.overflowX,overflowY:ns.overflowY,display:ns.display,gap:ns.gap},buttons:buttons.map(measure)}})()`)
    const shot = await c.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${mode}-360x844.png`, Buffer.from(shot.data, 'base64'))
  }
  const safety = await c.eval(`({blockedAnalytics:window.__qaBlockedAnalytics||0,blockedWrites:window.__qaBlockedWrites||0})`)
  const sentAnalytics = c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method))
  assert.equal(sentAnalytics.length, 0); assert.equal(sentWrites.length, 0)
  const report = { status: 'passed', origin: ORIGIN, results, safety: { ...safety, sentAnalytics, sentWrites } }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
} finally { c?.close(); try { proc.kill('SIGTERM') } catch {}; await sleep(250); try { rmSync(dir, { recursive: true, force: true }) } catch {} }
