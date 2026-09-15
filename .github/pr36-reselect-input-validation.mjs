import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA ?? 'unknown'
const QA_SHA = process.env.GITHUB_SHA ?? 'unknown'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const STORAGE_KEY = 'catfood.switch-session.v1'
const OUT = 'qa-artifacts'
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

async function makeContext() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,variant_count,has_variants',
    brand: 'eq.AATU',
    canonical_name: 'eq.연어',
    limit: 10,
  })
  const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어')
  assert.ok(current, 'AATU 연어 current product not found')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,units_per_sale,display_rank',
    product_id: `eq.${current.product_id}`,
    order: 'display_rank.asc,variant_id.asc',
    limit: 100,
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
      window.__qaBlockedAnalytics = 0
      window.__qaBlockedWrites = 0
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
        if (url.includes('/functions/v1/decision-intake')) { window.__qaBlockedAnalytics += 1; return Promise.reject(new TypeError('QA blocked analytics before send')) }
        if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(method)) { window.__qaBlockedWrites += 1; return Promise.reject(new TypeError('QA blocked production write before send')) }
        return nativeFetch(input, init)
      }
    })();` })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await this.eval(`Boolean(${expression})`)) return } catch {} await sleep(120) } throw new Error(`timeout: ${label}`) }
  async navigate(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState === 'complete'`, 'document ready'); await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'app root'); await this.eval('document.fonts?.ready'); await sleep(250) }
  async shot(path) { await this.eval('document.fonts?.ready'); await sleep(100); const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(path, Buffer.from(image.data, 'base64')) }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9700 + (process.pid % 100)
  const dir = `/tmp/pr36-input-${process.pid}-${Math.random().toString(16).slice(2)}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const browser = new Browser(page.webSocketDebuggerUrl)
        await browser.connect()
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
  const changed = await browser.eval(`(() => { const input=document.querySelector('.switch-find-search input'); if(!input)return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${js(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(changed, true, 'search input missing')
  await sleep(220)
}
async function setupClickExact(browser, scope, text) {
  await browser.wait(`(() => { const root=document.querySelector(${js(scope)}); if(!root)return false; return [...root.querySelectorAll('button')].some((button)=>button.textContent.trim()===${js(text)}&&!button.disabled) })()`, `setup enabled ${text}`)
  const clicked = await browser.eval(`(() => { const root=document.querySelector(${js(scope)}); const button=[...root.querySelectorAll('button')].find((item)=>item.textContent.trim()===${js(text)}&&!item.disabled); if(!button)return false; button.click(); return true })()`)
  assert.equal(clicked, true, `setup cannot click ${text}`)
  await sleep(180)
}
async function setupClickContains(browser, selector, text) {
  const clicked = await browser.eval(`(() => { const item=[...document.querySelectorAll(${js(selector)})].find((node)=>node.textContent.includes(${js(text)})); if(!item)return false; item.click(); return true })()`)
  assert.equal(clicked, true, `setup ${selector} missing ${text}`)
  await sleep(180)
}

async function prepareChange(browser, ctx) {
  await browser.navigate(`${BASE}?view=workspace&mode=switch`)
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
  await setupClickExact(browser, '.switch-step-main', '다른 브랜드로 보기')
  await waitState(browser, `s.changeBrand===true`, 'CHANGE condition stored')
  await browser.eval(`document.scrollingElement.scrollTop=0`)
  await sleep(180)
  const before = await state(browser)
  assert.equal(before.currentProductId, ctx.current.product_id)
  assert.deepEqual(before.variantSelection, { kind: 'variant', variantId: ctx.sku.variant_id })
  assert.equal(before.step, 'change')
  assert.equal(before.changeBrand, true)
  return before
}

function assertResetState(after, expectedQuery) {
  assert.equal(after.query, expectedQuery)
  assert.equal(after.currentProductId, null)
  assert.deepEqual(after.variantSelection, { kind: 'unselected', variantId: null })
  assert.deepEqual(after.change, { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false })
  assert.deepEqual(after.keep, { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false })
  assert.equal(after.changeBrand, false)
  assert.equal(after.keepBrand, false)
  assert.deepEqual(after.ingredientAvoidTerms, [])
  assert.equal(after.noChangeIntent, false)
  assert.equal(after.step, 'current')
  assert.equal(after.selectedCandidateId, null)
  assert.deepEqual(after.compareIds, [])
  assert.equal(after.compareOpen, false)
  assert.equal(after.detailProductId, null)
}

async function targetGeometry(browser) {
  return browser.eval(`(() => {
    const button=document.querySelector('.switch-change-current'); if(!button)return null;
    const r=button.getBoundingClientRect(); const x=r.left+r.width/2; const y=r.top+r.height/2; const top=document.elementFromPoint(x,y);
    return { text:button.textContent.trim(), rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}, center:{x,y}, centerHit:Boolean(top&&(top===button||button.contains(top))), topTag:top?.tagName??null, topClass:top?.className??null };
  })()`)
}

async function installEventRecorder(browser) {
  await browser.eval(`(() => {
    window.__qaTargetEvents=[];
    const button=document.querySelector('.switch-change-current');
    if(!button) return false;
    for(const type of ['pointerdown','pointerup','mousedown','mouseup','click','keydown','keyup']) button.addEventListener(type,(event)=>window.__qaTargetEvents.push({type,isTrusted:event.isTrusted,key:event.key||null,button:event.button??null,buttons:event.buttons??null}),true);
    return true;
  })()`)
}

async function network(browser) {
  return {
    blocked: await browser.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`),
    sentAnalytics: browser.requests.filter((r)=>r.url.includes('/functions/v1/decision-intake')),
    sentWrites: browser.requests.filter((r)=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(r.method)),
    publicReads: browser.requests.filter((r)=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&r.method==='GET').length,
  }
}

async function pointerPath(ctx) {
  const { browser, proc, dir } = await launch()
  const result = { status: 'running', before: null, geometry: null, events: null, after: null, network: null, capture: null }
  try {
    result.before = await prepareChange(browser, ctx)
    result.geometry = await targetGeometry(browser)
    assert.ok(result.geometry, 'reselect button missing')
    assert.equal(result.geometry.text, '현재 사료 다시 선택')
    assert.equal(result.geometry.centerHit, true, 'reselect center is occluded')
    assert.ok(result.geometry.rect.width >= 44 && result.geometry.rect.height >= 40, 'reselect target is too small')
    await installEventRecorder(browser)
    result.capture = 'pointer-before-360x844.png'
    await browser.shot(`${OUT}/${result.capture}`)
    const { x, y } = result.geometry.center
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
    await waitState(browser, `s.step==='current'&&s.currentProductId===null`, 'pointer reset')
    result.events = await browser.eval(`window.__qaTargetEvents`)
    assert.ok(result.events.some((event)=>event.type==='pointerdown'&&event.isTrusted), 'trusted pointerdown missing')
    assert.ok(result.events.some((event)=>event.type==='pointerup'&&event.isTrusted), 'trusted pointerup missing')
    assert.ok(result.events.some((event)=>event.type==='click'&&event.isTrusted), 'trusted pointer click missing')
    result.after = await state(browser)
    assertResetState(result.after, `${ctx.current.brand} ${ctx.current.canonical_name}`)
    result.network = await network(browser)
    assert.equal(result.network.sentAnalytics.length, 0)
    assert.equal(result.network.sentWrites.length, 0)
    result.status = 'pass'
    return result
  } finally {
    browser.close(); proc.kill('SIGTERM'); await sleep(100); try { rmSync(dir,{recursive:true,force:true}) } catch {}
  }
}

async function pressKey(browser, key, code, vk) {
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await sleep(120)
}

async function keyboardPath(ctx) {
  const { browser, proc, dir } = await launch()
  const result = { status: 'running', before: null, tabs: [], focus: null, events: null, after: null, network: null, capture: null }
  try {
    result.before = await prepareChange(browser, ctx)
    await installEventRecorder(browser)
    for (let i = 0; i < 30; i += 1) {
      await pressKey(browser, 'Tab', 'Tab', 9)
      const active = await browser.eval(`(() => { const el=document.activeElement; return {tag:el?.tagName??null,className:el?.className??null,text:el?.textContent?.trim()??null,isTarget:Boolean(el?.classList?.contains('switch-change-current'))} })()`)
      result.tabs.push(active)
      if (active.isTarget) break
    }
    assert.ok(result.tabs.at(-1)?.isTarget, 'real Tab did not reach reselect button')
    result.focus = await browser.eval(`(() => {
      const button=document.querySelector('.switch-change-current'); const r=button.getBoundingClientRect(); const s=getComputedStyle(button);
      return {activeElement:document.activeElement===button,focusVisible:button.matches(':focus-visible'),rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineColor:s.outlineColor,outlineOffset:s.outlineOffset,boxShadow:s.boxShadow};
    })()`)
    assert.equal(result.focus.activeElement, true, 'activeElement is not reselect button')
    assert.equal(result.focus.focusVisible, true, ':focus-visible is not active after real Tab')
    assert.notEqual(result.focus.outlineStyle, 'none', 'focused button has no computed outline')
    result.capture = 'keyboard-focus-360x844.png'
    await browser.shot(`${OUT}/${result.capture}`)
    await pressKey(browser, 'Enter', 'Enter', 13)
    await waitState(browser, `s.step==='current'&&s.currentProductId===null`, 'keyboard reset')
    result.events = await browser.eval(`window.__qaTargetEvents`)
    assert.ok(result.events.some((event)=>event.type==='keydown'&&event.key==='Enter'&&event.isTrusted), 'trusted Enter keydown missing')
    assert.ok(result.events.some((event)=>event.type==='keyup'&&event.key==='Enter'&&event.isTrusted), 'trusted Enter keyup missing')
    assert.ok(result.events.some((event)=>event.type==='click'&&event.isTrusted), 'trusted keyboard activation click missing')
    result.after = await state(browser)
    assertResetState(result.after, `${ctx.current.brand} ${ctx.current.canonical_name}`)
    result.network = await network(browser)
    assert.equal(result.network.sentAnalytics.length, 0)
    assert.equal(result.network.sentWrites.length, 0)
    result.status = 'pass'
    return result
  } finally {
    browser.close(); proc.kill('SIGTERM'); await sleep(100); try { rmSync(dir,{recursive:true,force:true}) } catch {}
  }
}

const ctx = await makeContext()
const report = {
  productSha: PRODUCT_SHA,
  qaSha: QA_SHA,
  status: 'running',
  browserVersion: execFileSync('/usr/bin/google-chrome',['--version'],{encoding:'utf8'}).trim(),
  koreanFont: execFileSync('fc-match',[':lang=ko'],{encoding:'utf8'}).trim(),
  context: ctx,
  pointer: null,
  keyboard: null,
  error: null,
}
const save = () => writeFileSync(`${OUT}/report.json`, JSON.stringify(report,null,2))
try {
  report.pointer = await pointerPath(ctx); save()
  report.keyboard = await keyboardPath(ctx); save()
  report.status = 'pass'
} catch (error) {
  report.status = 'fail'; report.error = String(error?.stack || error); throw error
} finally { save() }
console.log('PR36_RESELECT_INPUT_QA_PASS', JSON.stringify({productSha:PRODUCT_SHA,pointer:{rect:report.pointer?.geometry?.rect,centerHit:report.pointer?.geometry?.centerHit,events:report.pointer?.events?.filter((e)=>['pointerdown','pointerup','click'].includes(e.type)),after:report.pointer?.after},keyboard:{tabs:report.keyboard?.tabs?.length,focus:report.keyboard?.focus,events:report.keyboard?.events?.filter((e)=>['keydown','keyup','click'].includes(e.type)),after:report.keyboard?.after}}))
