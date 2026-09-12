import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const js = (value) => JSON.stringify(value)
export const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

export class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = []
    this.responses = []
    this.finished = new Set()
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
      if (message.method === 'Network.requestWillBeSent') {
        this.requests.push({ requestId: message.params.requestId, url: message.params.request.url, method: message.params.request.method, headers: message.params.request.headers ?? {} })
      } else if (message.method === 'Network.responseReceived') {
        this.responses.push({ requestId: message.params.requestId, url: message.params.response.url, status: message.params.response.status, mimeType: message.params.response.mimeType })
      } else if (message.method === 'Network.loadingFinished') {
        this.finished.add(message.params.requestId)
      }
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'CSS.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const nativeFetch=window.fetch.bind(window);const nativeBeacon=navigator.sendBeacon?.bind(navigator);window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return Promise.resolve(new Response(null,{status:204}))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1;return Promise.resolve(new Response(null,{status:204}))}return nativeFetch(input,init)};if(nativeBeacon){navigator.sendBeacon=(url,data)=>{const u=String(url||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return true}return nativeBeacon(url,data)}}})();` })
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
  async wait(expression, label, ms = 60000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'root')
    await this.eval('document.fonts?.ready')
    await sleep(220)
  }
  async shot(path) {
    mkdirSync(path.split('/').slice(0, -1).join('/') || '.', { recursive: true })
    await this.eval('document.fonts?.ready')
    await sleep(80)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }
  async fonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) return []
    return (await this.send('CSS.getPlatformFontsForNode', { nodeId })).fonts ?? []
  }
  responseMark() { return this.responses.length }
  async waitResponse(fragment, productId = null, since = 0, ms = 60000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const matches = this.responses.slice(since).filter((item) => {
        const decoded = decodeURIComponent(item.url)
        return decoded.includes(fragment) && (!productId || decoded.includes(productId)) && this.finished.has(item.requestId)
      })
      if (matches.length) {
        const item = matches.at(-1)
        const body = await this.send('Network.getResponseBody', { requestId: item.requestId })
        return { ...item, body: body.body, json: JSON.parse(body.body) }
      }
      await sleep(120)
    }
    throw new Error(`timeout response ${fragment} ${productId ?? ''}`)
  }
  requestFor(requestId) { return this.requests.find((item) => item.requestId === requestId) ?? null }
  close() { try { this.ws?.close() } catch {} }
}

export async function launch(width, height) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9700 + (process.pid % 180) + (width % 19)
  const dir = `/tmp/catfood-detail-${width}-${height}-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let index = 0; index < 220; index++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height })
        await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' })
        return { c, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

export async function info(c, selector, text = null, index = 0) {
  return c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim(),all=[...document.querySelectorAll(${js(selector)})],list=${text === null ? 'all' : `all.filter(n=>nrm(n.textContent).includes(${js(text)}))`},n=list[${index}];if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=r.width>0&&r.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight?document.elementFromPoint(x,y):null;return{text:nrm(n.textContent),rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,overflowX:s.overflowX,overflowY:s.overflowY,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,position:s.position,zIndex:s.zIndex,rendered:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,inViewport:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,centerHit:Boolean(h&&(h===n||n.contains(h))),disabled:Boolean(n.disabled)}})()`)
}

export async function pointer(c, selector, text = null, index = 0) {
  const found = await c.eval(`(()=>{const nrm=v=>(v||'').replace(/\\s+/g,' ').trim(),all=[...document.querySelectorAll(${js(selector)})],list=${text === null ? 'all' : `all.filter(n=>nrm(n.textContent).includes(${js(text)}))`},n=list[${index}];if(!n)return false;n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});return true})()`)
  assert.equal(found, true, `missing control ${selector} ${text ?? ''}`)
  await sleep(100)
  const metric = await info(c, selector, text, index)
  assert.ok(metric?.rendered && metric.inViewport && metric.centerHit && !metric.disabled, `unavailable control ${JSON.stringify(metric)}`)
  const [left, top, width, height] = metric.rect
  const x = left + width / 2, y = top + height / 2
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(220)
  return { ...metric, x, y }
}

export async function typeInput(c, selector, value) {
  await pointer(c, selector)
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' })
  await c.send('Input.insertText', { text: value })
  await sleep(300)
}

export async function wheelTo(c, targetY) {
  for (let index = 0; index < 30; index++) {
    const current = await c.eval('window.scrollY')
    const max = await c.eval('Math.max(0,document.documentElement.scrollHeight-innerHeight)')
    const target = Math.max(0, Math.min(Number(targetY), Number(max)))
    const delta = target - current
    if (Math.abs(delta) <= 3) return Number(current)
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 10, y: 300, deltaX: 0, deltaY: Math.sign(delta) * Math.min(520, Math.abs(delta)) })
    await sleep(100)
  }
  return c.eval('window.scrollY')
}

export async function network(c) {
  const sentAnalytics = c.requests.filter((item) => item.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(item.method))
  return {
    blocked: await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`),
    sentAnalytics,
    sentWrites,
    publicReads: c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co') && item.method === 'GET').length,
  }
}

export function cleanup(proc, dir, c) {
  c?.close()
  try { proc?.kill('SIGTERM') } catch {}
  setTimeout(() => { try { if (proc?.exitCode == null) proc.kill('SIGKILL') } catch {}; rmSync(dir, { recursive: true, force: true }) }, 150)
}
