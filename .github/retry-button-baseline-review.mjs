import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const ORIGIN = 'http://127.0.0.1:4173/'
const TARGET_SHA = process.env.TARGET_SHA || 'b5218c85269e25a2250de88d65a15a4f27fae98c'
const OUT = 'qa-artifacts/retry-button-baseline'
const API_HOST = 'gnosbstdatkytsyxuapt.supabase.co'
const GO = { id: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리' }
const MONGE = { id: 'product_11dc2e0bf60b0874' }
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
let launchSequence = 0

function viewFromUrl(url) {
  try {
    const parsed = new URL(url)
    const marker = '/rest/v1/'
    const index = parsed.pathname.indexOf(marker)
    return index >= 0 ? parsed.pathname.slice(index + marker.length).split('/')[0] || null : null
  } catch { return null }
}

function detailUrl(tab) {
  const params = new URLSearchParams({ view: 'workspace', mode: 'lookup', q: GO.query, selected: GO.id, detail: GO.id, detailTab: tab })
  return `${ORIGIN}?${params.toString()}`
}
function compareUrl(tab) {
  const params = new URLSearchParams({ view: 'workspace', mode: 'lookup', q: 'go!', selected: GO.id, compare: `${GO.id},${MONGE.id}`, compareOpen: '1', compareTab: tab })
  return `${ORIGIN}?${params.toString()}`
}

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.rules = new Map()
    this.requests = []
    this.exceptions = []
    this.console = []
  }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method, view: viewFromUrl(message.params.request.url) })
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push({ text: message.params.exceptionDetails?.text ?? null, description: message.params.exceptionDetails?.exception?.description ?? null })
      if (message.method === 'Runtime.consoleAPICalled') this.console.push({ type: message.params.type, values: (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type) })
      if (message.method === 'Fetch.requestPaused') void this.handlePaused(message.params)
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(method)
    await this.send('Fetch.enable', { patterns: [{ urlPattern: `*${API_HOST}/rest/v1/*`, requestStage: 'Request' }] })
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch=window.fetch.bind(window),nativeBeacon=navigator.sendBeacon?.bind(navigator);
      window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;
      window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'',method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return Promise.resolve(new Response(null,{status:204}))}if(url.includes('${API_HOST}')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1;return Promise.resolve(new Response(null,{status:204}))}return nativeFetch(input,init)};
      if(nativeBeacon){navigator.sendBeacon=(url,data)=>{const u=String(url||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return true}return nativeBeacon(url,data)}}
    })();` })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, ms = 30000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`)) return
      await sleep(80)
    }
    throw new Error(`timeout ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'root')
    await this.eval('document.fonts?.ready')
    await sleep(120)
  }
  async shot(name) {
    await this.eval('document.fonts?.ready')
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    const path = `${OUT}/${name}`
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
  }
  async handlePaused(params) {
    const view = viewFromUrl(params.request.url)
    const rule = view ? this.rules.get(view) : null
    if (params.request.method === 'GET' && rule) {
      const decision = rule()
      if (decision === '503') {
        await this.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 503,
          responsePhrase: 'Service Unavailable',
          responseHeaders: [
            { name: 'content-type', value: 'application/json; charset=utf-8' },
            { name: 'access-control-allow-origin', value: ORIGIN.replace(/\/$/, '') },
          ],
          body: Buffer.from(JSON.stringify({ message: 'QA injected 503' }), 'utf8').toString('base64'),
        })
        return
      }
    }
    await this.send('Fetch.continueRequest', { requestId: params.requestId })
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const sequence = ++launchSequence
  const port = 9950 + (process.pid % 40) + sequence
  const dir = `/tmp/catfood-retry-baseline-${process.pid}-${sequence}`
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 360, screenHeight: 844 })
        await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' })
        return { c, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}
function cleanup(x) {
  x?.c?.close(); try { x?.proc?.kill('SIGTERM') } catch {}
  setTimeout(() => { try { if (x?.proc?.exitCode == null) x.proc.kill('SIGKILL') } catch {}; try { rmSync(x?.dir, { recursive: true, force: true }) } catch {} }, 250)
}

async function tabTo(c, selector) {
  const sequence = []
  for (let i = 0; i < 24; i++) {
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await sleep(25)
    const current = await c.eval(`(()=>{const a=document.activeElement;return{tag:a?.tagName??null,text:(a?.textContent||'').trim(),className:a?.className??null,matches:Boolean(a&&a.matches(${js(selector)}))}})()`)
    sequence.push(current)
    if (current.matches) return { reached: true, steps: i + 1, sequence }
  }
  return { reached: false, steps: 24, sequence }
}

async function metrics(c, selector) {
  return c.eval(`(()=>{
    const n=document.querySelector(${js(selector)});if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);
    const parse=(v)=>{const m=String(v).match(/rgba?\\(([^)]+)\\)/);if(!m)return null;const p=m[1].split(',').map(Number);return p.slice(0,3)};
    const lum=(rgb)=>{if(!rgb)return null;const a=rgb.map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*a[0]+.7152*a[1]+.0722*a[2]};
    const l1=lum(parse(s.color)),l2=lum(parse(s.backgroundColor));const contrast=l1==null||l2==null?null:(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
    const matched=[];const walk=(rules,href)=>{for(const rule of rules){try{if(rule.selectorText&&n.matches(rule.selectorText)){const st=rule.style;const props={};for(const p of ['color','background-color','min-height','height','padding','border','border-color','border-radius','outline','outline-offset','font-size','font-weight','cursor','display','gap','margin-top']){if(st.getPropertyValue(p))props[p]=st.getPropertyValue(p).trim()}if(Object.keys(props).length)matched.push({href,selector:rule.selectorText,props})}if(rule.cssRules)walk(rule.cssRules,href)}catch{}}};for(const sheet of document.styleSheets){try{walk(sheet.cssRules,sheet.href)}catch{}}
    return {rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},color:s.color,backgroundColor:s.backgroundColor,borderColor:s.borderColor,borderWidth:s.borderWidth,borderRadius:s.borderRadius,minHeight:s.minHeight,padding:s.padding,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,cursor:s.cursor,display:s.display,disabled:Boolean(n.disabled),hitCenter:Boolean(h&&(h===n||n.contains(h))),active:document.activeElement===n,contrast,matchedRules:matched};
  })()`)
}

async function scenario(name, url, failedView, selector) {
  const launched = await launch()
  const { c } = launched
  try {
    let failed = false
    c.rules.set(failedView, () => { if (!failed) { failed = true; return '503' } return 'continue' })
    await c.nav(url)
    await c.wait(`document.querySelector(${js(selector)})`, `${name} retry button`)
    const errorPng = await c.shot(`${name}-error.png`)
    const before = await metrics(c, selector)
    const focus = await tabTo(c, selector)
    assert.equal(focus.reached, true, `${name}: retry button not reachable with Tab`)
    const focused = await metrics(c, selector)
    const focusPng = await c.shot(`${name}-focus.png`)
    const safety = await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0,url:location.href})`)
    const writeRequests = c.requests.filter((entry) => entry.url.includes(API_HOST) && !['GET','HEAD','OPTIONS'].includes(entry.method))
    assert.equal(writeRequests.length, 0, `${name}: production write request observed`)
    return { name, failedView, selector, errorPng, focusPng, before, focus, focused, safety, exceptions: c.exceptions, console: c.console.filter((x) => x.type === 'error'), writeRequests }
  } finally { cleanup(launched) }
}

const report = { targetSha: TARGET_SHA, generatedAt: new Date().toISOString(), viewport: { width: 360, height: 844 }, scenarios: [] }
let status = 'passed'
let failure = null
try {
  report.scenarios.push(await scenario('detail-nutrition', detailUrl('nutrition'), 'compare_product_nutrition', '.detail-state.is-error button'))
  report.scenarios.push(await scenario('detail-ingredients', detailUrl('ingredients'), 'compare_product_ingredients', '.detail-state.is-error button'))
  report.scenarios.push(await scenario('compare-nutrition', compareUrl('nutrition'), 'compare_product_nutrition', '.compare-state.is-error button'))
  report.chrome = execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim()
} catch (error) {
  status = 'failed'; failure = String(error?.stack || error)
}
report.status = status
report.failure = failure
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
if (status !== 'passed') process.exitCode = 1
