import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const ORIGIN = 'https://osrm.github.io/catfood_web/'
const TARGET_SHA = process.env.TARGET_SHA || 'b5218c85269e25a2250de88d65a15a4f27fae98c'
const OUT = 'qa-artifacts/search-input-path-review-v2'
const GO = { id: 'product_31bc515d78d43d5d', query: '카니보 치킨&칠면조&오리', name: '카니보 치킨&칠면조&오리' }
const MONGE = { id: 'product_11dc2e0bf60b0874', query: '몬지 비와일드 그레인프리 어덜트 연어', name: '몬지 비와일드 그레인프리 어덜트 연어' }
const ENGLISH = 'go!'
const NO_MATCH = 'zzqa-no-catfood-9f3e'
const HOME_INPUT = '.home-search-console-form input[type="search"]'
const LOOKUP_INPUT = '.lookup-input'
const SWITCH_INPUT = '.switch-find-search input[type="search"]'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
let launchSequence = 0

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.id = 1
    this.pending = new Map()
    this.requests = []
    this.responses = []
    this.loadingFailures = []
    this.exceptions = []
    this.console = []
    this.logEntries = []
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
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ requestId: message.params.requestId, url: message.params.request.url, method: message.params.request.method })
      if (message.method === 'Network.responseReceived') this.responses.push({ requestId: message.params.requestId, url: message.params.response.url, status: message.params.response.status, type: message.params.type })
      if (message.method === 'Network.loadingFailed') this.loadingFailures.push({ requestId: message.params.requestId, errorText: message.params.errorText, canceled: Boolean(message.params.canceled), type: message.params.type })
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push({ text: message.params.exceptionDetails?.text ?? null, description: message.params.exceptionDetails?.exception?.description ?? null, url: message.params.exceptionDetails?.url ?? null, lineNumber: message.params.exceptionDetails?.lineNumber ?? null })
      if (message.method === 'Runtime.consoleAPICalled') this.console.push({ type: message.params.type, values: (message.params.args ?? []).map((item) => item.value ?? item.description ?? item.type) })
      if (message.method === 'Log.entryAdded') this.logEntries.push({ level: message.params.entry.level, text: message.params.entry.text, source: message.params.entry.source, url: message.params.entry.url ?? null })
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch=window.fetch.bind(window),nativeBeacon=navigator.sendBeacon?.bind(navigator);
      window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;window.__qaInputEvents=[];
      for(const type of ['beforeinput','input','change','keydown','keyup']) document.addEventListener(type,(event)=>{const t=event.target;if(!(t instanceof HTMLInputElement))return;window.__qaInputEvents.push({type,value:t.value,inputType:event.inputType??null,data:event.data??null,key:event.key??null,isTrusted:event.isTrusted,className:t.className||'',ariaLabel:t.getAttribute('aria-label'),placeholder:t.getAttribute('placeholder')});},true);
      window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'',method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return Promise.resolve(new Response(null,{status:204}))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1;return Promise.resolve(new Response(null,{status:204}))}return nativeFetch(input,init)};
      if(nativeBeacon){navigator.sendBeacon=(url,data)=>{const u=String(url||'');if(u.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return true}return nativeBeacon(url,data)}}
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
    await sleep(150)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(40)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const sequence = ++launchSequence
  const port = 9800 + (process.pid % 100) + sequence
  const dir = `/tmp/catfood-search-input-v2-${width}-${height}-${process.pid}-${sequence}`
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let index = 0; index < 200; index++) {
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

function cleanup(launched) {
  launched?.c?.close()
  try { launched?.proc?.kill('SIGTERM') } catch {}
  setTimeout(() => {
    try { if (launched?.proc?.exitCode == null) launched.proc.kill('SIGKILL') } catch {}
    try { rmSync(launched?.dir, { recursive: true, force: true }) } catch {}
  }, 250)
}

async function clickVisible(c, selector, text = null) {
  const metric = await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${js(selector)})],n=${text == null ? 'nodes[0]??null' : `nodes.find(x=>(x.textContent||'').includes(${js(text)}))??null`};if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],text:(n.textContent||'').replace(/\\s+/g,' ').trim(),x,y,hit:Boolean(h&&(h===n||n.contains(h))),disabled:Boolean(n.disabled)}})()`)
  assert.ok(metric && metric.rect[2] > 0 && metric.rect[3] > 0 && metric.hit && !metric.disabled, `pointer target unavailable ${selector}${text ? ` text=${text}` : ''}: ${JSON.stringify(metric)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: metric.x, y: metric.y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: metric.x, y: metric.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: metric.x, y: metric.y, button: 'left', clickCount: 1 })
  await sleep(40)
  return metric
}

async function focusInput(c, selector) {
  const click = await clickVisible(c, selector)
  const active = await c.eval(`(()=>{const n=document.querySelector(${js(selector)}),a=document.activeElement;return{matches:a===n,tag:a?.tagName??null,className:a?.className??null,ariaLabel:a?.getAttribute?.('aria-label')??null,placeholder:a?.getAttribute?.('placeholder')??null,value:n?.value??null}})()`)
  assert.equal(active.matches, true, `pointer click did not focus ${selector}: ${JSON.stringify(active)}`)
  return { click, active }
}

async function eventCount(c) { return c.eval('(window.__qaInputEvents||[]).length') }
async function eventSlice(c, start) { return c.eval(`(window.__qaInputEvents||[]).slice(${Number(start)})`) }

async function insertKorean(c, selector, text, label) {
  const focus = await focusInput(c, selector)
  const start = await eventCount(c)
  await c.send('Input.insertText', { text })
  try { await c.wait(`document.querySelector(${js(selector)})?.value===${js(text)}`, `${label} DOM value`, 4000) } catch (error) {
    const events = await eventSlice(c, start)
    const value = await c.eval(`document.querySelector(${js(selector)})?.value??null`)
    const category = events.some((item) => item.type === 'input') ? 'event_delivered_app_value_not_updated' : 'automation_event_not_delivered'
    throw new Error(`${category}: ${label}; value=${JSON.stringify(value)} events=${JSON.stringify(events)} cause=${String(error)}`)
  }
  const events = await eventSlice(c, start)
  assert.ok(events.some((item) => item.type === 'input'), `${label}: Korean insert produced no input event`)
  return { method: 'CDP Input.insertText (Korean text insertion; not OS Korean IME composition)', focus, events }
}

async function typeAscii(c, selector, text, label) {
  const focus = await focusInput(c, selector)
  const start = await eventCount(c)
  for (const char of text) {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char, unmodifiedText: char })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
  try { await c.wait(`document.querySelector(${js(selector)})?.value===${js(text)}`, `${label} DOM value`, 4000) } catch (error) {
    const events = await eventSlice(c, start)
    const value = await c.eval(`document.querySelector(${js(selector)})?.value??null`)
    const category = events.some((item) => item.type === 'input') ? 'event_delivered_app_value_not_updated' : 'automation_event_not_delivered'
    throw new Error(`${category}: ${label}; value=${JSON.stringify(value)} events=${JSON.stringify(events)} cause=${String(error)}`)
  }
  const events = await eventSlice(c, start)
  assert.ok(events.some((item) => item.type === 'input'), `${label}: ASCII key events produced no input event`)
  return { method: 'CDP Input.dispatchKeyEvent text/key events', focus, events }
}

async function selectAll(c) {
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', modifiers: 2, windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 })
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 })
}

async function replaceKorean(c, selector, text, label) {
  await focusInput(c, selector); await selectAll(c)
  const start = await eventCount(c)
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector(${js(selector)})?.value===${js(text)}`, `${label} replaced value`, 4000)
  const events = await eventSlice(c, start)
  assert.ok(events.some((item) => item.type === 'input'), `${label}: replacement input event absent`)
  return { method: 'pointer focus + Ctrl+A raw key events + CDP Input.insertText', events }
}

async function replaceAscii(c, selector, text, label) {
  await focusInput(c, selector); await selectAll(c)
  const start = await eventCount(c)
  for (const char of text) {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char, unmodifiedText: char })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
  await c.wait(`document.querySelector(${js(selector)})?.value===${js(text)}`, `${label} replaced value`, 4000)
  const events = await eventSlice(c, start)
  assert.ok(events.some((item) => item.type === 'input'), `${label}: replacement key events produced no input event`)
  return { method: 'pointer focus + Ctrl+A raw key events + CDP text/key events', events }
}

async function clearInput(c, selector, label) {
  await focusInput(c, selector); await selectAll(c)
  const start = await eventCount(c)
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await c.wait(`document.querySelector(${js(selector)})?.value===''`, `${label} cleared value`, 4000)
  const events = await eventSlice(c, start)
  assert.ok(events.some((item) => item.type === 'input'), `${label}: clear produced no input event`)
  return { method: 'pointer focus + Ctrl+A + Backspace raw key events', events }
}

async function pressEnterRaw(c) {
  const before = await c.eval(`({url:location.href,active:document.activeElement?.className||document.activeElement?.tagName||null})`)
  const start = await eventCount(c)
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await sleep(180)
  return { method: 'CDP rawKeyDown/keyUp Enter with native/Windows VK 13', before, after: await c.eval(`({url:location.href,active:document.activeElement?.className||document.activeElement?.tagName||null})`), events: await eventSlice(c, start) }
}

async function waitCatalog(c) {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    const request = c.requests.find((item) => item.method === 'GET' && item.url.includes('/rest/v1/effective_product_catalog_summary'))
    if (request) {
      const response = c.responses.find((item) => item.requestId === request.requestId)
      if (response) { assert.equal(response.status, 200, `catalog GET HTTP ${response.status}`); return { request, response } }
      const failure = c.loadingFailures.find((item) => item.requestId === request.requestId)
      if (failure) throw new Error(`catalog GET failed: ${JSON.stringify(failure)}`)
    }
    await sleep(80)
  }
  throw new Error('catalog GET response not observed')
}

async function state(c, { input, resultSelector, targetText = null, headingSelector = null } = {}) {
  return c.eval(`(()=>{const input=document.querySelector(${js(input ?? '__none__')}),results=[...document.querySelectorAll(${js(resultSelector ?? '__none__')})],params=Object.fromEntries(new URLSearchParams(location.search));let switchStored=null;try{const raw=sessionStorage.getItem('catfood.switch-session.v1');switchStored=raw?JSON.parse(raw)?.state?.query??null:null}catch{};const active=document.activeElement;return{url:location.href,params,inputValue:input?.value??null,activeElement:{tag:active?.tagName??null,className:active?.className??null,id:active?.id??null,ariaLabel:active?.getAttribute?.('aria-label')??null,placeholder:active?.getAttribute?.('placeholder')??null,value:active instanceof HTMLInputElement?active.value:null},resultCount:results.length,targetExists:${targetText == null ? 'null' : `results.some(n=>(n.textContent||'').includes(${js(targetText)}))`},resultTitles:results.slice(0,8).map(n=>(n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,220)),heading:${headingSelector == null ? 'null' : `document.querySelector(${js(headingSelector)})?.textContent?.replace(/\\s+/g,' ').trim()??null`},messages:[...document.querySelectorAll('.state-message,.switch-state-message')].map(n=>(n.textContent||'').replace(/\\s+/g,' ').trim()),switchStoredQuery:switchStored,hasForm:Boolean(input?.closest('form')),searchButtons:input?[...((input.closest('form')||input.parentElement||document).querySelectorAll('button'))].map(n=>(n.textContent||'').replace(/\\s+/g,' ').trim()):[]}})()`)
}

async function cleanNetwork(c, label) {
  const sentAnalytics = c.requests.filter((item) => item.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(item.method))
  const blocked = await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`)
  assert.equal(sentAnalytics.length, 0, `${label}: analytics escaped blocker`)
  assert.equal(sentWrites.length, 0, `${label}: production write observed`)
  assert.equal(blocked.writes, 0, `${label}: production write was attempted and blocked`)
  return { sentAnalytics, sentWrites, blocked, publicReads: c.requests.filter((item) => item.method === 'GET' && item.url.includes('gnosbstdatkytsyxuapt.supabase.co')).length }
}

async function mobileReview() {
  const launched = await launch(360, 844, true)
  const c = launched.c
  const out = { chrome: launched.version, viewport: '360x844', findings: [], steps: {} }
  let stage = 'initial navigation'
  try {
    await c.nav(ORIGIN)
    out.catalog = await waitCatalog(c)
    out.environment = await c.eval(`({language:navigator.language,userAgent:navigator.userAgent,url:location.href})`)

    stage = 'home Korean insertText input'
    out.steps.homeKoreanInput = await insertKorean(c, HOME_INPUT, GO.query, stage)
    out.steps.homeKoreanBeforeSubmit = await state(c, { input: HOME_INPUT })
    assert.ok(out.steps.homeKoreanBeforeSubmit.searchButtons.includes('검색'))
    stage = 'home search button submit'
    await clickVisible(c, '.home-search-console-form button[type="submit"]')
    await c.wait(`document.querySelector(${js(LOOKUP_INPUT)})?.value===${js(GO.query)}`, 'home button lookup query')
    await c.wait(`document.querySelector('.research-result-card[data-product-id=${js(GO.id)}]')`, 'GO result after home button')
    out.steps.homeButtonResult = await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: GO.name, headingSelector: '.research-results-heading span' })
    assert.equal(out.steps.homeButtonResult.params.q, GO.query); assert.equal(out.steps.homeButtonResult.targetExists, true)
    await c.shot(`${OUT}/360-home-korean-submit-result.png`)

    stage = 'return home for Enter check'
    await clickVisible(c, '.research-brand')
    await c.wait(`document.querySelector(${js(HOME_INPUT)})`, 'home after lookup')
    stage = 'home English key input'
    out.steps.homeEnglishInput = await typeAscii(c, HOME_INPUT, ENGLISH, stage)
    out.steps.homeEnglishBeforeEnter = await state(c, { input: HOME_INPUT })
    stage = 'home raw Enter check'
    out.steps.homeEnter = await pressEnterRaw(c)
    let enterSubmitted = false
    try {
      await c.wait(`document.querySelector(${js(LOOKUP_INPUT)})?.value===${js(ENGLISH)}`, 'home raw Enter lookup query', 1800)
      enterSubmitted = true
    } catch {
      const enterState = await state(c, { input: HOME_INPUT })
      out.findings.push({ kind: 'home_enter_cdp_inconclusive_or_unsupported', detail: 'Trusted raw Enter key events reached the focused home input, but this CDP sequence did not trigger the form submit default action. This is not treated as a product defect without physical/OS keyboard confirmation.', state: enterState, events: out.steps.homeEnter.events })
      await c.shot(`${OUT}/360-home-enter-no-submit.png`)
      stage = 'home button fallback after Enter diagnostic'
      await clickVisible(c, '.home-search-console-form button[type="submit"]')
      await c.wait(`document.querySelector(${js(LOOKUP_INPUT)})?.value===${js(ENGLISH)}`, 'home button fallback lookup query')
    }
    await c.wait(`document.querySelector('.research-result-card[data-product-id=${js(GO.id)}]')`, 'GO result after home English execution')
    out.steps.homeEnterResult = { submittedByRawEnter: enterSubmitted, ...(await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: GO.name, headingSelector: '.research-results-heading span' })) }
    assert.equal(out.steps.homeEnterResult.params.q, ENGLISH); assert.equal(out.steps.homeEnterResult.targetExists, true)
    await c.shot(`${OUT}/360-home-english-result.png`)

    stage = 'lookup live Enter behavior'
    const lookupBeforeEnter = await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: GO.name, headingSelector: '.research-results-heading span' })
    out.steps.lookupEnter = await pressEnterRaw(c)
    const lookupAfterEnter = await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: GO.name, headingSelector: '.research-results-heading span' })
    out.steps.lookupEnterSupport = { hasForm: lookupAfterEnter.hasForm, searchButtons: lookupAfterEnter.searchButtons, before: lookupBeforeEnter, after: lookupAfterEnter, behavior: 'live search; no form/search button and Enter caused no distinct navigation' }
    assert.equal(lookupBeforeEnter.url, lookupAfterEnter.url); assert.equal(lookupBeforeEnter.resultCount, lookupAfterEnter.resultCount)

    stage = 'lookup replace Korean Monge'
    out.steps.lookupKoreanReplaceInput = await replaceKorean(c, LOOKUP_INPUT, MONGE.query, stage)
    await c.wait(`new URL(location.href).searchParams.get('q')===${js(MONGE.query)}`, 'lookup Korean URL')
    await c.wait(`document.querySelector('.research-result-card[data-product-id=${js(MONGE.id)}]')`, 'Monge result')
    out.steps.lookupKoreanReplace = await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: MONGE.name, headingSelector: '.research-results-heading span' })
    assert.equal(out.steps.lookupKoreanReplace.targetExists, true)
    await c.shot(`${OUT}/360-lookup-korean-replace.png`)

    stage = 'lookup no-match replacement'
    out.steps.lookupNoMatchInput = await replaceAscii(c, LOOKUP_INPUT, NO_MATCH, stage)
    await c.wait(`new URL(location.href).searchParams.get('q')===${js(NO_MATCH)}`, 'lookup no-match URL')
    await c.wait(`document.querySelectorAll('.research-result-card').length===0 && document.body.innerText.includes('검색 결과가 없습니다.')`, 'lookup no-match')
    out.steps.lookupNoMatch = await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: MONGE.name, headingSelector: '.research-results-heading span' })
    assert.equal(out.steps.lookupNoMatch.resultCount, 0); assert.equal(out.steps.lookupNoMatch.targetExists, false)
    await c.shot(`${OUT}/360-lookup-no-match.png`)

    stage = 'lookup clear all'
    out.steps.lookupClearInput = await clearInput(c, LOOKUP_INPUT, stage)
    await c.wait(`document.querySelectorAll('.research-result-card').length===0 && document.body.innerText.includes('브랜드 또는 제품명을 입력해 주세요.')`, 'lookup empty contract')
    out.steps.lookupCleared = await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: MONGE.name, headingSelector: '.research-results-heading span' })
    assert.equal(out.steps.lookupCleared.inputValue, ''); assert.equal(out.steps.lookupCleared.resultCount, 0); assert.equal(out.steps.lookupCleared.params.q ?? '', '')
    await c.shot(`${OUT}/360-lookup-cleared.png`)

    stage = 'lookup quick-view preservation query'
    out.steps.lookupQuickViewInput = await replaceKorean(c, LOOKUP_INPUT, GO.query, stage)
    await c.wait(`document.querySelector('.research-result-card[data-product-id=${js(GO.id)}]')`, 'GO quick-view result')
    const beforeQuick = await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: GO.name, headingSelector: '.research-results-heading span' })
    await clickVisible(c, `.research-result-card[data-product-id=${js(GO.id)}]`)
    await c.wait(`document.querySelector('.research-quick-view')`, 'quick view open')
    const quick = await c.eval(`({title:document.querySelector('.quick-view-identity h1')?.textContent?.trim()??null,url:location.href})`)
    await clickVisible(c, '.quick-view-topline button', '닫기')
    await c.wait(`!document.querySelector('.research-quick-view') && document.querySelector(${js(LOOKUP_INPUT)})`, 'quick view closed')
    const afterQuick = await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: GO.name, headingSelector: '.research-results-heading span' })
    assert.equal(afterQuick.inputValue, GO.query); assert.equal(afterQuick.params.q, GO.query); assert.equal(afterQuick.resultCount, beforeQuick.resultCount); assert.equal(afterQuick.targetExists, true)
    out.steps.lookupQuickViewPreservation = { before: beforeQuick, open: quick, after: afterQuick }
    await c.shot(`${OUT}/360-lookup-quickview-return.png`)

    stage = 'enter SWITCH current product mode'
    await clickVisible(c, '.mode-nav .mode-button', '현재 사료')
    await c.wait(`document.querySelector(${js(SWITCH_INPUT)})`, 'SWITCH search input')
    out.steps.switchInitial = await state(c, { input: SWITCH_INPUT, resultSelector: '.switch-find-result', targetText: MONGE.name, headingSelector: '.switch-find-results-heading span' })

    stage = 'SWITCH Korean input'
    out.steps.switchKoreanInput = await insertKorean(c, SWITCH_INPUT, MONGE.query, stage)
    await c.wait(`JSON.parse(sessionStorage.getItem('catfood.switch-session.v1'))?.state?.query===${js(MONGE.query)}`, 'SWITCH stored Korean query')
    await c.wait(`document.querySelectorAll('.switch-find-result').length>0`, 'SWITCH Korean results')
    out.steps.switchKorean = await state(c, { input: SWITCH_INPUT, resultSelector: '.switch-find-result', targetText: MONGE.name, headingSelector: '.switch-find-results-heading span' })
    assert.equal(out.steps.switchKorean.targetExists, true); assert.equal(out.steps.switchKorean.switchStoredQuery, MONGE.query)
    await c.shot(`${OUT}/360-switch-korean.png`)

    stage = 'SWITCH English replacement'
    out.steps.switchEnglishInput = await replaceAscii(c, SWITCH_INPUT, ENGLISH, stage)
    await c.wait(`JSON.parse(sessionStorage.getItem('catfood.switch-session.v1'))?.state?.query===${js(ENGLISH)}`, 'SWITCH stored English query')
    await c.wait(`document.querySelectorAll('.switch-find-result').length>0`, 'SWITCH English results')
    out.steps.switchEnglish = await state(c, { input: SWITCH_INPUT, resultSelector: '.switch-find-result', targetText: GO.name, headingSelector: '.switch-find-results-heading span' })
    assert.equal(out.steps.switchEnglish.targetExists, true)
    const switchBeforeEnter = out.steps.switchEnglish
    out.steps.switchEnter = await pressEnterRaw(c)
    const switchAfterEnter = await state(c, { input: SWITCH_INPUT, resultSelector: '.switch-find-result', targetText: GO.name, headingSelector: '.switch-find-results-heading span' })
    out.steps.switchEnterSupport = { hasForm: switchAfterEnter.hasForm, searchButtons: switchAfterEnter.searchButtons, before: switchBeforeEnter, after: switchAfterEnter, behavior: 'live search; no form/search button and Enter caused no distinct navigation' }
    assert.equal(switchAfterEnter.url, switchBeforeEnter.url); assert.equal(switchAfterEnter.resultCount, switchBeforeEnter.resultCount)
    await c.shot(`${OUT}/360-switch-english.png`)

    stage = 'SWITCH no-match replacement'
    out.steps.switchNoMatchInput = await replaceAscii(c, SWITCH_INPUT, NO_MATCH, stage)
    await c.wait(`JSON.parse(sessionStorage.getItem('catfood.switch-session.v1'))?.state?.query===${js(NO_MATCH)}`, 'SWITCH stored no-match')
    await c.wait(`document.querySelectorAll('.switch-find-result').length===0 && document.body.innerText.includes('검색 결과가 없습니다.')`, 'SWITCH no-match state')
    out.steps.switchNoMatch = await state(c, { input: SWITCH_INPUT, resultSelector: '.switch-find-result', targetText: GO.name, headingSelector: '.switch-find-results-heading span' })
    assert.equal(out.steps.switchNoMatch.resultCount, 0); assert.equal(out.steps.switchNoMatch.targetExists, false)
    await c.shot(`${OUT}/360-switch-no-match.png`)

    stage = 'SWITCH clear all'
    out.steps.switchClearInput = await clearInput(c, SWITCH_INPUT, stage)
    await c.wait(`JSON.parse(sessionStorage.getItem('catfood.switch-session.v1'))?.state?.query===''`, 'SWITCH stored empty')
    await c.wait(`document.querySelectorAll('.switch-find-result').length===0`, 'SWITCH empty results')
    out.steps.switchCleared = await state(c, { input: SWITCH_INPUT, resultSelector: '.switch-find-result', targetText: GO.name, headingSelector: '.switch-find-results-heading span' })
    assert.equal(out.steps.switchCleared.inputValue, ''); assert.equal(out.steps.switchCleared.resultCount, 0); assert.equal(out.steps.switchCleared.switchStoredQuery, '')
    assert.ok(out.steps.switchCleared.heading.includes('브랜드 또는 제품명의 일부를 입력하세요.'))
    await c.shot(`${OUT}/360-switch-cleared.png`)

    out.network = await cleanNetwork(c, 'mobile search review')
    out.runtime = { exceptions: c.exceptions, console: c.console, logErrors: c.logEntries.filter((item) => item.level === 'error' && !item.url?.endsWith('/favicon.ico')) }
    assert.equal(c.exceptions.length, 0, `mobile runtime exceptions: ${JSON.stringify(c.exceptions)}`)
    return out
  } catch (error) {
    out.failure = { stage, message: String(error?.message || error), stack: String(error?.stack || '') }
    out.failureState = await c.eval(`(()=>({url:location.href,body:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,2200),active:{tag:document.activeElement?.tagName??null,className:document.activeElement?.className??null,value:document.activeElement instanceof HTMLInputElement?document.activeElement.value:null},events:(window.__qaInputEvents||[]).slice(-40)}))()`).catch(() => null)
    out.runtime = { exceptions: c.exceptions, console: c.console, logEntries: c.logEntries }
    try { await c.shot(`${OUT}/360-failure.png`) } catch {}
    throw Object.assign(error, { qaPartial: out })
  } finally { cleanup(launched) }
}

async function desktopReview() {
  const launched = await launch(1280, 900, false)
  const c = launched.c
  const out = { chrome: launched.version, viewport: '1280x900', steps: {} }
  let stage = 'desktop navigation'
  try {
    await c.nav(ORIGIN); out.catalog = await waitCatalog(c)
    stage = 'desktop product lookup entry'
    await clickVisible(c, '.home-nav button', '제품 찾기')
    await c.wait(`document.querySelector(${js(LOOKUP_INPUT)})`, 'desktop lookup input')
    stage = 'desktop English key input'
    out.steps.input = await typeAscii(c, LOOKUP_INPUT, ENGLISH, stage)
    await c.wait(`new URL(location.href).searchParams.get('q')===${js(ENGLISH)}`, 'desktop lookup URL')
    await c.wait(`document.querySelector('.research-result-card[data-product-id=${js(GO.id)}]')`, 'desktop GO result')
    out.steps.result = await state(c, { input: LOOKUP_INPUT, resultSelector: '.research-result-card', targetText: GO.name, headingSelector: '.research-results-heading span' })
    assert.equal(out.steps.result.targetExists, true)
    await c.shot(`${OUT}/1280-lookup-english.png`)
    out.network = await cleanNetwork(c, 'desktop lookup review')
    out.runtime = { exceptions: c.exceptions, console: c.console, logErrors: c.logEntries.filter((item) => item.level === 'error' && !item.url?.endsWith('/favicon.ico')) }
    assert.equal(c.exceptions.length, 0, `desktop runtime exceptions: ${JSON.stringify(c.exceptions)}`)
    return out
  } catch (error) {
    out.failure = { stage, message: String(error?.message || error), stack: String(error?.stack || '') }
    out.failureState = await c.eval(`(()=>({url:location.href,body:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,1800),events:(window.__qaInputEvents||[]).slice(-30)}))()`).catch(() => null)
    out.runtime = { exceptions: c.exceptions, console: c.console, logEntries: c.logEntries }
    try { await c.shot(`${OUT}/1280-failure.png`) } catch {}
    throw Object.assign(error, { qaPartial: out })
  } finally { cleanup(launched) }
}

const report = {
  targetSha: TARGET_SHA,
  origin: ORIGIN,
  purpose: 'Collect real browser search-input evidence without q= navigation injection, sessionStorage injection, or direct DOM value assignment.',
  koreanInputScope: 'CDP Input.insertText verifies Korean text insertion and trusted browser input events; it is not OS Korean IME composition coverage.',
  status: 'running',
  startedAt: new Date().toISOString(),
}
try {
  report.mobile = await mobileReview()
  report.desktop = await desktopReview()
  report.status = report.mobile.findings.length ? 'completed_with_findings' : 'completed'
} catch (error) {
  report.status = 'failed'
  report.error = { message: String(error?.message || error), stack: String(error?.stack || '') }
  if (error?.qaPartial?.viewport === '360x844') report.mobile = error.qaPartial
  if (error?.qaPartial?.viewport === '1280x900') report.desktop = error.qaPartial
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  writeFileSync(`${OUT}/report.json`, `${JSON.stringify(report, null, 2)}\n`)
}
