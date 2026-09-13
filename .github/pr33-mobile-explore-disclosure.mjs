import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:4173/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA
const OUT = 'qa-artifacts/pr33-mobile-explore-disclosure'
const OLD_APPLY_SCROLL = 521
mkdirSync(OUT, { recursive: true })
assert.ok(PRODUCT_SHA, 'PRODUCT_SHA is required')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

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
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'app root')
    await this.eval('document.fonts?.ready')
    await this.wait(`document.querySelector('.research-status span:last-child')?.textContent.includes('데이터 연결됨')`, 'catalog loaded')
    await sleep(180)
  }
  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height })
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
  const port = 9820 + (process.pid % 100)
  const dir = `/tmp/pr33-explore-${process.pid}`
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

async function launchServer() {
  const proc = spawn('python3', ['-m', 'http.server', '4173', '--bind', '127.0.0.1', '--directory', 'qa-server'], { stdio: 'ignore' })
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(BASE)
      if (response.ok) return proc
    } catch {}
    await sleep(100)
  }
  proc.kill('SIGTERM')
  throw new Error('candidate server timeout')
}

async function pointer(c, text) {
  const target = await c.eval(`(()=>{const n=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').replace(/\\s+/g,' ').trim()===${js(text)});if(!n)return null;n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,disabled:Boolean(n.disabled),centerHit:Boolean(h&&(h===n||n.contains(h))),text:(n.textContent||'').replace(/\\s+/g,' ').trim()}})()`)
  assert.ok(target, `missing button ${text}`)
  assert.equal(target.disabled, false, `disabled button ${text}`)
  assert.equal(target.centerHit, true, `pointer center unavailable ${text}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await sleep(120)
}

async function key(c, keyName, { shift = false } = {}) {
  const code = keyName === 'Tab' ? 'Tab' : keyName === 'Enter' ? 'Enter' : keyName
  const vk = keyName === 'Tab' ? 9 : keyName === 'Enter' ? 13 : 0
  const modifiers = shift ? 8 : 0
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await sleep(100)
}

async function focus(c, selector) {
  const ok = await c.eval(`(()=>{const n=document.querySelector(${js(selector)});if(!n)return false;n.scrollIntoView({block:'center',behavior:'instant'});n.focus();return document.activeElement===n})()`)
  assert.equal(ok, true, `could not focus ${selector}`)
}

async function measureEditor(c) {
  await c.eval('window.scrollTo(0,0)')
  await sleep(60)
  return c.eval(`(()=>{const apply=[...document.querySelectorAll('.condition-actions button')].find(n=>(n.textContent||'').includes('이 조건으로 찾기'));const toggle=document.querySelector('.mobile-additional-toggle');const desktop=document.querySelector('.desktop-additional-title');const panel=document.querySelector('#explore-additional-conditions');const summary=document.querySelector('.mobile-additional-summary');const count=document.querySelector('.condition-draft-count');const ar=apply?.getBoundingClientRect();const sr=summary?.getBoundingClientRect();const summaryChildren=summary?[...summary.children].map(n=>n.getBoundingClientRect()):[];return{href:location.href,viewport:{innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight},document:{scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},apply:ar?{docTop:ar.top+scrollY,docBottom:ar.bottom+scrollY,height:ar.height,minScrollForFull:Math.max(0,ar.bottom+scrollY-innerHeight)}:null,toggle:toggle?{display:getComputedStyle(toggle.closest('.mobile-additional-disclosure')).display,ariaExpanded:toggle.getAttribute('aria-expanded'),text:(toggle.textContent||'').replace(/\\s+/g,' ').trim()}:null,desktopTitle:desktop?{display:getComputedStyle(desktop).display}:null,panel:{visibleButtons:panel?[...panel.querySelectorAll('button')].filter(n=>n.getClientRects().length>0).length:0},countText:(count?.textContent||'').replace(/\\s+/g,' ').trim(),summary:summary?{clientWidth:summary.clientWidth,scrollWidth:summary.scrollWidth,width:sr.width,rows:new Set(summaryChildren.map(r=>Math.round(r.top))).size,text:(summary.textContent||'').replace(/\\s+/g,' ').trim(),whiteSpaces:[...summary.children].map(n=>getComputedStyle(n).whiteSpace)}:null,filterScroll:{overflowY:getComputedStyle(document.querySelector('.research-filter-scroll')).overflowY,clientHeight:document.querySelector('.research-filter-scroll').clientHeight,scrollHeight:document.querySelector('.research-filter-scroll').scrollHeight}}})()`)
}

async function networkState(c) {
  return c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`)
}

function assertNoHorizontal(value, label) {
  assert.ok(value.document.scrollWidth <= value.viewport.clientWidth + 1, `${label} horizontal overflow: ${JSON.stringify(value)}`)
}

const report = { productSha: PRODUCT_SHA, base: BASE, oldApplyScroll: OLD_APPLY_SCROLL, status: 'running' }
let browser
let server
try {
  server = await launchServer()
  browser = await launchBrowser()
  const { c } = browser

  await c.viewport(360, 844)
  await c.nav(`${BASE}?view=workspace`)
  await c.wait(`document.querySelector('.mobile-additional-toggle')`, '360 editor')
  const initial360 = await measureEditor(c)
  assert.equal(initial360.viewport.innerWidth, 360)
  assert.equal(initial360.toggle.ariaExpanded, 'false')
  assert.equal(initial360.toggle.display, 'grid')
  assert.equal(initial360.panel.visibleButtons, 0)
  assert.equal(initial360.countText, '선택한 조건 0개')
  assert.match(initial360.toggle.text, /선택 없음/)
  assertNoHorizontal(initial360, '360 initial')
  await c.shot(`${OUT}/01-360-initial-collapsed.png`)

  await pointer(c, '건식')
  await c.wait(`document.querySelector('.condition-draft-count')?.textContent.includes('1개')`, 'dry draft count')
  const dry360 = await measureEditor(c)
  assert.equal(dry360.toggle.ariaExpanded, 'false')
  assert.ok(dry360.apply.minScrollForFull < OLD_APPLY_SCROLL, `360 apply scroll did not improve: ${JSON.stringify(dry360.apply)}`)
  assert.equal((await networkState(c)).analytics, 0)

  await focus(c, '.condition-actions .primary-action')
  await key(c, 'Tab', { shift: true })
  const collapsedKeyboard = await c.eval(`(()=>{const a=document.activeElement,s=getComputedStyle(a);return{className:a.className,text:(a.textContent||'').replace(/\\s+/g,' ').trim(),outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth}})()`)
  assert.match(collapsedKeyboard.className, /mobile-additional-toggle/)
  assert.notEqual(collapsedKeyboard.outlineStyle, 'none', 'keyboard-focused disclosure needs visible focus')

  await key(c, 'Enter')
  await c.wait(`document.querySelector('.mobile-additional-toggle')?.getAttribute('aria-expanded')==='true'`, 'keyboard disclosure open')
  const open360 = await measureEditor(c)
  assert.ok(open360.panel.visibleButtons > 0)
  await focus(c, '.mobile-additional-toggle')
  await key(c, 'Tab')
  const firstOpenFocus = await c.eval(`(document.activeElement?.textContent||'').replace(/\s+/g,' ').trim()`)
  assert.equal(firstOpenFocus, '실내묘', 'open disclosure adds inner controls to tab order')

  for (const text of ['실내묘', '중성화묘', '체중 관리', '피부·피모', '가금류', 'Grain-Free 표기']) {
    await pointer(c, text)
    assert.equal(await c.eval(`document.querySelector('.mobile-additional-toggle')?.getAttribute('aria-expanded')`), 'true', `selection must not auto-close after ${text}`)
  }
  assert.equal((await networkState(c)).analytics, 0, 'editing and disclosure must not create analytics search runs')
  await focus(c, '.mobile-additional-toggle')
  await key(c, 'Enter')
  await c.wait(`document.querySelector('.mobile-additional-toggle')?.getAttribute('aria-expanded')==='false'`, 'selected disclosure collapse')
  const selectedCollapsed360 = await measureEditor(c)
  assert.match(selectedCollapsed360.toggle.text, /6개 선택/)
  for (const label of ['실내묘', '중성화묘', '체중 관리', '피부·피모', '가금류', 'Grain-Free 표기']) assert.ok(selectedCollapsed360.summary.text.includes(label), `missing summary label ${label}`)
  assert.ok(selectedCollapsed360.summary.rows >= 2, `selected summary did not wrap: ${JSON.stringify(selectedCollapsed360.summary)}`)
  assert.ok(selectedCollapsed360.summary.scrollWidth <= selectedCollapsed360.summary.clientWidth + 1, `selected summary overflow: ${JSON.stringify(selectedCollapsed360.summary)}`)
  assert.ok(selectedCollapsed360.summary.whiteSpaces.every((value) => value === 'normal'), `summary hides labels: ${JSON.stringify(selectedCollapsed360.summary)}`)
  assert.equal(selectedCollapsed360.panel.visibleButtons, 0)
  assertNoHorizontal(selectedCollapsed360, '360 selected collapsed')
  await c.shot(`${OUT}/02-360-selected-collapsed.png`)

  await focus(c, '.mobile-additional-toggle')
  await key(c, 'Tab')
  const collapsedNextFocus = await c.eval(`(document.activeElement?.textContent||'').replace(/\s+/g,' ').trim()`)
  assert.equal(collapsedNextFocus, '이 조건으로 찾기', 'collapsed inner controls must leave the tab order')

  await pointer(c, '이 조건으로 찾기')
  await c.wait(`new URLSearchParams(location.search).get('applied')==='1'&&document.querySelector('.criteria-bar')`, '360 applied result')
  const applied360 = await c.eval(`({href:location.href,criteria:(document.querySelector('.criteria-bar')?.textContent||'').replace(/\s+/g,' ').trim()})`)
  const appliedParams = new URL(applied360.href).searchParams
  assert.equal(appliedParams.get('feed'), '건식')
  assert.ok((appliedParams.get('targets') || '').includes('indoor'))
  assert.ok((appliedParams.get('targets') || '').includes('sterilized'))
  assert.equal((await networkState(c)).analytics, 1, 'apply should create exactly one blocked analytics search run')
  assert.equal((await networkState(c)).writes, 0)

  await pointer(c, '조건 수정')
  await c.wait(`document.querySelector('.mobile-additional-toggle')?.getAttribute('aria-expanded')==='true'`, '360 edit restore open')
  const restored360 = await measureEditor(c)
  assert.match(restored360.toggle.text, /6개 선택/)
  assert.equal(restored360.countText, '선택한 조건 7개')
  assert.ok(restored360.panel.visibleButtons > 0)
  assertNoHorizontal(restored360, '360 restored expanded')
  await c.shot(`${OUT}/03-360-edit-restored-expanded.png`)

  await c.viewport(390, 900)
  await c.nav(`${BASE}?view=workspace`)
  await c.wait(`document.querySelector('.mobile-additional-toggle')`, '390 editor')
  await pointer(c, '건식')
  const dry390 = await measureEditor(c)
  assert.equal(dry390.toggle.ariaExpanded, 'false')
  assert.equal(dry390.panel.visibleButtons, 0)
  assert.ok(dry390.apply.minScrollForFull < OLD_APPLY_SCROLL, `390 apply scroll did not improve: ${JSON.stringify(dry390.apply)}`)
  assertNoHorizontal(dry390, '390 dry collapsed')
  await pointer(c, '이 조건으로 찾기')
  await c.wait(`new URLSearchParams(location.search).get('applied')==='1'`, '390 dry apply without disclosure')
  const dry390Params = new URL(await c.eval('location.href')).searchParams
  assert.equal(dry390Params.get('feed'), '건식')
  assert.equal(dry390Params.get('targets'), null)

  const boundaries = {}
  for (const [width, height] of [[760, 900], [761, 900], [1280, 900]]) {
    await c.viewport(width, height)
    await c.nav(`${BASE}?view=workspace`)
    await c.wait(`document.querySelector('.mobile-additional-toggle')`, `${width} editor`)
    const value = await measureEditor(c)
    boundaries[width] = value
    assertNoHorizontal(value, `${width} boundary`)
    if (width <= 760) {
      assert.notEqual(value.toggle.display, 'none', '760 keeps mobile disclosure')
      assert.equal(value.desktopTitle.display, 'none')
      assert.equal(value.panel.visibleButtons, 0)
    } else {
      assert.equal(value.toggle.display, 'none', `${width} hides mobile disclosure`)
      assert.notEqual(value.desktopTitle.display, 'none', `${width} shows desktop additional title`)
      assert.ok(value.panel.visibleButtons > 0, `${width} keeps additional controls visible regardless of mobile state`)
    }
    if (width === 1280) assert.equal(value.filterScroll.overflowY, 'auto', '1280 keeps desktop filter rail scrolling')
  }

  const sentAnalytics = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  assert.equal(sentAnalytics.length, 0, `analytics network request escaped blocker: ${JSON.stringify(sentAnalytics)}`)
  assert.equal(sentWrites.length, 0, `production write escaped blocker: ${JSON.stringify(sentWrites)}`)

  report.status = 'pass'
  report.initial360 = initial360
  report.dry360 = dry360
  report.open360 = open360
  report.selectedCollapsed360 = selectedCollapsed360
  report.applied360 = applied360
  report.restored360 = restored360
  report.dry390 = dry390
  report.boundaries = boundaries
  report.network = { sentAnalytics, sentWrites, publicReads: c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && request.method === 'GET').length }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR33_MOBILE_EXPLORE_PASS', JSON.stringify({ productSha: PRODUCT_SHA, applyScroll360: dry360.apply.minScrollForFull, applyScroll390: dry390.apply.minScrollForFull, oldApplyScroll: OLD_APPLY_SCROLL, summaryRows: selectedCollapsed360.summary.rows, boundaries: Object.fromEntries(Object.entries(boundaries).map(([width, value]) => [width, { toggleDisplay: value.toggle.display, desktopTitleDisplay: value.desktopTitle.display, visibleAdditionalButtons: value.panel.visibleButtons }])), network: report.network }))
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  if (browser) {
    browser.c.close()
    try { browser.proc.kill('SIGTERM') } catch {}
    await sleep(250)
    try { rmSync(browser.dir, { recursive: true, force: true }) } catch {}
  }
  if (server) {
    try { server.kill('SIGTERM') } catch {}
  }
}
