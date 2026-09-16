import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PAGE = 'https://osrm.github.io/catfood_web/'
const OUT = 'qa-artifacts-zoom200'
const PORT = 18477
const PROFILE = `/tmp/catfood-zoom200-${process.pid}`
const LONG_CANDIDATE = '오리지날 울트라 그레인프리 인도어 닭 & 연어 레시피'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const switchSnapshot = {
  version: 1,
  state: {
    query: '',
    currentProductId: 'product_d99406c26240b263',
    variantSelection: { kind: 'variant', variantId: 'variant_6e426a0abf2e1a43' },
    change: { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false },
    keep: { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false },
    changeBrand: false,
    keepBrand: false,
    ingredientAvoidTerms: [],
    noChangeIntent: true,
    step: 'results',
    visibleCandidateCount: 40,
    selectedCandidateId: 'product_b47d3ae674773585',
    compareIds: ['product_b47d3ae674773585', 'product_99c5ee4eb9211a75'],
    compareOpen: true,
    compareTab: 'overview',
    detailProductId: null,
    detailTab: 'overview',
  },
}

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
        this.requests.push({ url: request.url, method: request.method, type: message.params.type })
      }
      if (message.method === 'Network.responseReceived') {
        const response = message.params.response
        this.responses.push({ url: response.url, status: response.status, type: message.params.type })
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
      window.__qaBlocked={analytics:0,writes:0,beacons:0}
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
      if(navigator.sendBeacon){navigator.sendBeacon=()=>{window.__qaBlocked.beacons++;return false}}
      if(location.hostname==='osrm.github.io'){
        sessionStorage.setItem('catfood.switch-session.v1',JSON.stringify(${JSON.stringify(switchSnapshot)}))
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

  async wait(expression, label, timeout = 30000, interval = 60) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`).catch(() => false)) return
      await sleep(interval)
    }
    throw new Error(`timeout: ${label}`)
  }

  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length`, 'root', 30000)
    await this.eval('document.fonts?.ready.then(()=>true)')
  }

  async shot(name) {
    await this.eval('document.fonts?.ready.then(()=>true)')
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }

  close() { try { this.ws?.close() } catch {} }
}

function sh(command, args = [], options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

async function launchChrome() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Google Chrome required')
  const proc = spawn(chrome, [
    '--no-sandbox', '--no-first-run', '--disable-sync', '--disable-dev-shm-usage', '--disable-gpu',
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${PROFILE}`, '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore', env: process.env })

  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const c = new CDP(page.webSocketDebuggerUrl)
      await c.connect()
      return { c, proc }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}

async function stopProcess(proc) {
  if (proc.exitCode != null) return
  proc.kill('SIGTERM')
  for (let i = 0; i < 30 && proc.exitCode == null; i++) await sleep(50)
  if (proc.exitCode == null) proc.kill('SIGKILL')
}

function findChromeWindow(proc) {
  const ids = sh('xdotool', ['search', '--onlyvisible', '--pid', String(proc.pid)]).split(/\s+/).filter(Boolean)
  for (const id of ids) {
    const geometry = sh('xdotool', ['getwindowgeometry', '--shell', id])
    const width = Number(geometry.match(/WIDTH=(\d+)/)?.[1] ?? 0)
    const height = Number(geometry.match(/HEIGHT=(\d+)/)?.[1] ?? 0)
    if (width > 1000 && height > 700) return id
  }
  throw new Error(`Chrome window not found for pid ${proc.pid}; ids=${ids.join(',')}`)
}

async function main() {
  const handle = await launchChrome()
  const report = {
    page: PAGE,
    browser: 'headed Google Chrome in Xvfb; OS-level X11 input through xdotool',
    zoomEvidence: {},
    screens: {},
    network: null,
  }

  try {
    const c = handle.c
    const windowId = findChromeWindow(handle.proc)
    sh('xdotool', ['windowfocus', '--sync', windowId])

    const browserKey = async (key) => {
      sh('xdotool', ['key', '--clearmodifiers', key])
      await sleep(220)
    }
    const zoomMetrics = () => c.eval(`({
      dpr:devicePixelRatio,
      innerWidth,
      innerHeight,
      visualScale:visualViewport.scale,
      visualWidth:visualViewport.width,
      visualHeight:visualViewport.height,
      screenWidth:screen.width,
      screenHeight:screen.height,
      rootZoom:getComputedStyle(document.documentElement).zoom||'normal',
      rootTransform:getComputedStyle(document.documentElement).transform
    })`)
    const zoom100 = async () => {
      await browserKey('ctrl+0')
      for (let i = 0; i < 30; i++) {
        const metrics = await zoomMetrics()
        if (Math.abs(metrics.dpr - 1) < 0.02) return metrics
        await sleep(80)
      }
      throw new Error('failed to reset Chrome browser zoom to 100%')
    }
    const zoom200 = async () => {
      await browserKey('ctrl+0')
      for (let i = 0; i < 5; i++) await browserKey('ctrl+plus')
      for (let i = 0; i < 30; i++) {
        const metrics = await zoomMetrics()
        if (Math.abs(metrics.dpr - 2) < 0.02) return metrics
        await sleep(80)
      }
      throw new Error(`failed to reach 200% browser zoom: ${JSON.stringify(await zoomMetrics())}`)
    }
    const globalMetrics = () => c.eval(`({innerWidth,innerHeight,docWidth:document.documentElement.scrollWidth,docHeight:document.documentElement.scrollHeight,scrollX,scrollY})`)
    const elementMetrics = (selector) => c.eval(`(()=>{
      const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null
      const r=e.getBoundingClientRect(),s=getComputedStyle(e)
      return {text:e.textContent.trim(),rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},display:s.display,visibility:s.visibility,overflowX:s.overflowX,overflowY:s.overflowY,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,clipped:e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1}
    })()`)
    const activeElement = () => c.eval(`(()=>{const e=document.activeElement;if(!e)return null;const r=e.getBoundingClientRect();return{tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').trim(),class:String(e.className||''),rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},scrollY}})()`)
    const focusPage = async () => {
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 180, button: 'left', buttons: 1, clickCount: 1 })
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 180, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(100)
    }
    const tabUntil = async (predicate, maxTabs = 80) => {
      await c.eval('window.scrollTo(0,0)')
      await focusPage()
      const seen = []
      for (let i = 0; i < maxTabs; i++) {
        await browserKey('Tab')
        const active = await activeElement()
        seen.push(active)
        if (active && predicate(active)) return { tabs: i + 1, active, seen }
      }
      return { tabs: null, active: null, seen }
    }

    await c.nav(PAGE)
    await c.wait(`document.querySelector('.home-shell')`, 'home')
    const z100 = await zoom100()
    const z200 = await zoom200()
    report.zoomEvidence = { '100': z100, '200': z200 }
    assert.ok(Math.abs(z100.dpr - 1) < 0.02)
    assert.ok(Math.abs(z200.dpr - 2) < 0.02)
    assert.equal(z100.visualScale, 1)
    assert.equal(z200.visualScale, 1)
    assert.ok(z200.innerWidth < z100.innerWidth * 0.55)

    // HOME
    await zoom100(); await c.eval('window.scrollTo(0,0)'); await c.shot('home-100.png')
    const home100 = { zoom: await zoomMetrics(), global: await globalMetrics() }
    await zoom200(); await c.eval('window.scrollTo(0,0)'); await sleep(250); await c.shot('home-200-top.png')
    const homeButtons = await c.eval(`[...document.querySelectorAll('.home-start-path button')].map(e=>e.textContent.trim())`)
    const home200 = {
      zoom: await zoomMetrics(), global: await globalMetrics(), buttons: homeButtons,
      searchInput: await elementMetrics('.home-search-console input'),
      switchButton: await elementMetrics('.home-start-path:first-of-type button'),
      exploreButton: await elementMetrics('.home-start-path:last-of-type button'),
    }
    assert.ok(home200.global.docWidth <= home200.global.innerWidth + 1)
    assert.ok(homeButtons.includes('현재 사료로 시작하기 →'))
    assert.ok(homeButtons.includes('조건 고르기 →'))
    home200.keyboard = {
      search: await tabUntil((a) => a.tag === 'INPUT' && a.text.includes('브랜드'), 20),
      switch: await tabUntil((a) => a.text.includes('현재 사료로 시작하기'), 30),
      explore: await tabUntil((a) => a.text.includes('조건 고르기'), 40),
    }
    assert.ok(home200.keyboard.search.active && home200.keyboard.switch.active && home200.keyboard.explore.active)
    report.screens.home = { '100': home100, '200': home200 }

    // EXPLORE condition editor
    await zoom100(); await c.nav(`${PAGE}?view=workspace&mode=explore`)
    await c.wait(`document.querySelector('.condition-actions .primary-action')`, 'EXPLORE editor')
    await c.eval('window.scrollTo(0,0)'); await c.shot('explore-100.png')
    const explore100 = { zoom: await zoomMetrics(), global: await globalMetrics() }
    await zoom200(); await c.eval('window.scrollTo(0,0)'); await sleep(250); await c.shot('explore-200-top.png')
    const explore200 = {
      zoom: await zoomMetrics(), global: await globalMetrics(),
      disclosure: await elementMetrics('.mobile-additional-toggle'),
      apply: await elementMetrics('.condition-actions .primary-action'),
    }
    assert.ok(explore200.global.docWidth <= explore200.global.innerWidth + 1)
    assert.ok(explore200.disclosure && explore200.disclosure.display !== 'none')
    explore200.disclosureKeyboard = await tabUntil((a) => a.class.includes('mobile-additional-toggle'), 40)
    assert.ok(explore200.disclosureKeyboard.active)
    explore200.expandedBefore = await c.eval(`document.querySelector('.mobile-additional-toggle').getAttribute('aria-expanded')`)
    await browserKey('Return'); await sleep(180)
    explore200.expandedAfter = await c.eval(`document.querySelector('.mobile-additional-toggle').getAttribute('aria-expanded')`)
    explore200.additionalVisibleAfterOpen = await c.eval(`(()=>{const e=document.querySelector('#explore-additional-conditions');const r=e.getBoundingClientRect();return getComputedStyle(e).display!=='none'&&r.height>0})()`)
    assert.equal(explore200.expandedAfter, 'true')
    assert.equal(explore200.additionalVisibleAfterOpen, true)
    await browserKey('Return'); await sleep(120)
    explore200.applyKeyboard = await tabUntil((a) => a.text.includes('이 조건으로 찾기'), 55)
    assert.ok(explore200.applyKeyboard.active)
    await c.shot('explore-200-apply.png')
    report.screens.explore = { '100': explore100, '200': explore200 }

    // SWITCH overview compare. Browser session is preseeded only to reach the live-data state; all product facts still come from public GETs.
    await zoom100(); await c.nav(`${PAGE}?view=workspace&mode=switch`)
    await c.wait(`document.querySelector('.compare-header')&&document.body.innerText.includes('제품 비교')`, 'SWITCH compare', 45000)
    await c.wait(`document.body.innerText.includes(${JSON.stringify(LONG_CANDIDATE)})`, 'long SWITCH candidate', 45000)
    await c.eval('window.scrollTo(0,0)'); await c.shot('switch-100.png')
    const switch100 = { zoom: await zoomMetrics(), global: await globalMetrics() }
    await zoom200(); await c.eval('window.scrollTo(0,0)'); await sleep(300); await c.shot('switch-200-top.png')
    const switch200 = {
      zoom: await zoomMetrics(), global: await globalMetrics(),
      picker: await elementMetrics('.compare-mobile-candidate-toggle'),
      candidateName: await elementMetrics('.compare-mobile-product-head.is-candidate > strong'),
      currentHead: await elementMetrics('.compare-mobile-product-head.is-current'),
      candidateHead: await elementMetrics('.compare-mobile-product-head.is-candidate'),
      heads: await c.eval(`[...document.querySelectorAll('.compare-switch-mobile-overview .compare-mobile-product-head')].map(e=>e.innerText)`),
      actions: await c.eval(`[...document.querySelectorAll('.compare-mobile-head-actions button')].map(e=>{const r=e.getBoundingClientRect();return{text:e.textContent.trim(),rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}})`),
    }
    assert.ok(switch200.global.docWidth <= switch200.global.innerWidth + 1)
    assert.ok(switch200.picker && !switch200.picker.clipped)
    assert.ok(switch200.candidateName && switch200.candidateName.text.includes(LONG_CANDIDATE) && !switch200.candidateName.clipped)
    assert.ok(switch200.heads.some((text) => text.includes('사용 규격') && text.includes('판매 규격')))
    assert.ok(switch200.actions.some((a) => a.text === '상세 보기 →'))
    assert.ok(switch200.actions.some((a) => a.text === '비교에서 제거'))
    switch200.keyboard = {}
    switch200.keyboard.picker = await tabUntil((a) => a.class.includes('compare-mobile-candidate-toggle'), 45)
    assert.ok(switch200.keyboard.picker.active)
    await browserKey('Return'); await sleep(180)
    switch200.keyboard.pickerExpanded = await c.eval(`document.querySelector('.compare-mobile-candidate-toggle').getAttribute('aria-expanded')`)
    assert.equal(switch200.keyboard.pickerExpanded, 'true')
    await browserKey('Tab')
    switch200.keyboard.firstPickerOption = await activeElement()
    assert.ok(switch200.keyboard.firstPickerOption?.text.includes('내추럴발란스'))

    // Reload the same persisted state instead of changing/removing products.
    await c.nav(`${PAGE}?view=workspace&mode=switch`)
    await c.wait(`document.querySelector('.compare-mobile-candidate-toggle')`, 'SWITCH compare reload', 45000)
    await zoom200(); await sleep(220)
    switch200.keyboard.detail = await tabUntil((a) => a.text === '상세 보기 →', 70)
    switch200.keyboard.remove = await tabUntil((a) => a.text === '비교에서 제거', 75)
    assert.ok(switch200.keyboard.detail.active && switch200.keyboard.remove.active)
    await c.shot('switch-200-actions.png')
    report.screens.switch = { '100': switch100, '200': switch200 }

    const supabase = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co'))
    const nonRead = supabase.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
    const badStatuses = c.responses.filter((response) => response.url.includes('gnosbstdatkytsyxuapt.supabase.co') && response.status >= 400)
    report.network = {
      supabaseRequests: supabase.length,
      methods: [...new Set(supabase.map((request) => request.method))],
      nonRead,
      badStatuses,
      finalDocumentBlocked: await c.eval('window.__qaBlocked'),
    }
    assert.equal(nonRead.length, 0)

    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
    console.log('ZOOM200_REVIEW_PASS')
    console.log(JSON.stringify({ zoomEvidence: report.zoomEvidence, home: report.screens.home['200'].global, explore: { global: report.screens.explore['200'].global, expanded: report.screens.explore['200'].expandedAfter, applyFocus: report.screens.explore['200'].applyKeyboard.active }, switch: { global: report.screens.switch['200'].global, candidate: report.screens.switch['200'].candidateName.text, heads: report.screens.switch['200'].heads, actions: report.screens.switch['200'].actions }, network: report.network }, null, 2))
  } finally {
    handle.c.close()
    await stopProcess(handle.proc)
    try { rmSync(PROFILE, { recursive: true, force: true }) } catch {}
  }
}

await main()
