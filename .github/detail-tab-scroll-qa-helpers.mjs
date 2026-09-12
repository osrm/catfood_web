import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const js = (value) => JSON.stringify(value)
let launchSequence = 0

export class Cdp {
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
      const timer = setTimeout(() => reject(new Error('ws timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') {
        this.requests.push({ requestId: message.params.requestId, url: message.params.request.url, method: message.params.request.method })
      }
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'CSS.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const nativeFetch=window.fetch.bind(window),nativeBeacon=navigator.sendBeacon?.bind(navigator);window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'',method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return Promise.resolve(new Response(null,{status:204}))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1;return Promise.resolve(new Response(null,{status:204}))}return nativeFetch(input,init)};if(nativeBeacon){navigator.sendBeacon=(url,data)=>{const u=String(url||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return true}return nativeBeacon(url,data)}}})();` })
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
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'root')
    await this.eval('document.fonts?.ready')
    await sleep(180)
  }
  async wait(expression, label, ms = 60000) {
    const end = Date.now() + ms
    let firstError = null
    while (Date.now() < end) {
      try {
        if (await this.eval(`Boolean(${expression})`)) return
      } catch (error) {
        firstError ??= String(error?.stack || error)
        throw new Error(`evaluation failed while waiting for ${label}: ${firstError}`)
      }
      await sleep(100)
    }
    throw new Error(`timeout ${label}${firstError ? `; first evaluation error: ${firstError}` : ''}`)
  }
  async shot(path) {
    mkdirSync(path.split('/').slice(0, -1).join('/') || '.', { recursive: true })
    await this.eval('document.fonts?.ready')
    await sleep(50)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }
  async fonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) return []
    return (await this.send('CSS.getPlatformFontsForNode', { nodeId })).fonts ?? []
  }
  close() { try { this.ws?.close() } catch {} }
}

export async function launch(width, height, mobile = true) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const sequence = ++launchSequence
  const port = 9700 + (process.pid % 180) + (width % 19) + sequence
  const dir = `/tmp/catfood-detail-tab-${width}-${height}-${process.pid}-${sequence}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let index = 0; index < 220; index++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await c.send('Emulation.setUserAgentOverride', mobile
          ? { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' }
          : { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Linux x86_64' })
        return { c, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

export async function clickVisibleNoScroll(c, selector) {
  const metric = await c.eval(`(()=>{const n=document.querySelector(${js(selector)});if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n),x=r.left+r.width/2,y=r.top+r.height/2,h=r.width>0&&r.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight?document.elementFromPoint(x,y):null;return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],rendered:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,inViewport:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,centerHit:Boolean(h&&(h===n||n.contains(h))),disabled:Boolean(n.disabled),x,y}})()`)
  assert.ok(metric?.rendered && metric.inViewport && metric.centerHit && !metric.disabled, `click target unavailable without scrolling ${selector}: ${JSON.stringify(metric)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: metric.x, y: metric.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: metric.x, y: metric.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: metric.x, y: metric.y, button: 'left', clickCount: 1 })
  return metric
}

export async function detailGeometry(c) {
  return c.eval(`(()=>{const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],height:r.height,topStyle:s.top,position:s.position}},stage=document.querySelector('.detail-stage'),topbar=document.querySelector('.detail-topbar'),tabs=document.querySelector('.detail-tabs'),heading=document.querySelector('.detail-body>.detail-section .detail-section-heading'),title=heading?.querySelector('h2'),description=heading?.querySelector('p'),sr=stage?.getBoundingClientRect(),ts=topbar?getComputedStyle(topbar):null,ns=tabs?getComputedStyle(tabs):null,stickyBottom=stage&&topbar&&tabs&&sr?sr.top+Math.max((parseFloat(ts.top)||0)+topbar.getBoundingClientRect().height,(parseFloat(ns.top)||0)+tabs.getBoundingClientRect().height):null;return{scrollTop:stage?.scrollTop??null,maxScrollTop:stage?Math.max(0,stage.scrollHeight-stage.clientHeight):null,stage:rect(stage),topbar:rect(topbar),tabs:rect(tabs),heading:rect(heading),title:rect(title),description:rect(description),stickyBottom,activeTab:document.querySelector('.detail-tabs [aria-selected="true"]')?.id??null,activePanel:document.querySelector('.detail-body')?.id??null,activeElement:document.activeElement?.id||document.activeElement?.className||document.activeElement?.tagName||null,url:location.href}})()`)
}

export async function setStageScroll(c, value) {
  return c.eval(`(()=>{const n=document.querySelector('.detail-stage');if(!n)return null;n.scrollTop=Math.max(0,Math.min(${Number(value)},n.scrollHeight-n.clientHeight));return{scrollTop:n.scrollTop,max:Math.max(0,n.scrollHeight-n.clientHeight)}})()`)
}

export async function setStageBottom(c) {
  return c.eval(`(()=>{const n=document.querySelector('.detail-stage');if(!n)return null;n.scrollTop=Math.max(0,n.scrollHeight-n.clientHeight);return{scrollTop:n.scrollTop,max:Math.max(0,n.scrollHeight-n.clientHeight)}})()`)
}

export async function network(c) {
  const sentAnalytics = c.requests.filter((item) => item.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(item.method))
  return { blocked: await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`), sentAnalytics, sentWrites, publicReads: c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co') && item.method === 'GET').length }
}

export function cleanup(proc, dir, c) {
  c?.close()
  try { proc?.kill('SIGTERM') } catch {}
  setTimeout(() => { try { if (proc?.exitCode == null) proc.kill('SIGKILL') } catch {}; rmSync(dir, { recursive: true, force: true }) }, 150)
}
