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
const LONG_NAME = '울트라 프로틴+ 스킨 & 코트 & 다이제스티브 캣 레시피'
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

async function makeContext() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,variant_count,has_variants',
    order: 'brand.asc,canonical_name.asc', limit: 1000,
  })
  const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어' && Number(row.variant_count) >= 2)
    ?? products.find((row) => row.brand && row.canonical_name && row.feed_type && Number(row.variant_count) >= 2)
  assert.ok(current, 'multi-SKU current food not found')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,display_rank',
    product_id: `eq.${current.product_id}`, order: 'display_rank.asc,variant_id.asc', limit: 100,
  })
  assert.ok(variants.length >= 2, 'real SKU options missing')
  const sku = variants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? '')) ?? variants[0]
  const brandCounts = new Map()
  for (const product of products) if (product.brand) brandCounts.set(product.brand, (brandCounts.get(product.brand) ?? 0) + 1)
  const manyBrand = [...brandCounts.entries()].sort((a, b) => b[1] - a[1]).find(([, count]) => count >= 8)?.[0]
  assert.ok(manyBrand, 'multi-result brand not found')
  return { products, current, variants, sku, manyBrand }
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
    for (const domain of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'CSS.enable', 'Network.enable']) await this.send(domain)
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
  async fonts(selector) { const { root } = await this.send('DOM.getDocument', { depth: 1 }); const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector }); assert.ok(nodeId, `font node missing: ${selector}`); return (await this.send('CSS.getPlatformFontsForNode', { nodeId })).fonts ?? [] }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9400 + (process.pid % 100) + (width % 41)
  const dir = `/tmp/pr23-final-${width}-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const browser = new Browser(page.webSocketDebuggerUrl); await browser.connect()
        await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await browser.send('Emulation.setUserAgentOverride', { userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: mobile ? 'Android' : 'Linux' })
        return { browser, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function state(browser) { return browser.eval(`(() => { const raw = sessionStorage.getItem(${js(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`) }
async function waitState(browser, expression, label) { await browser.wait(`(() => { const raw = sessionStorage.getItem(${js(STORAGE_KEY)}); if (!raw) return false; const s = JSON.parse(raw).state; return ${expression} })()`, label) }
async function setQuery(browser, value) {
  const changed = await browser.eval(`(() => { const input = document.querySelector('.switch-find-search input'); if (!input) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${js(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(changed, true, 'search input missing'); await browser.wait(`document.querySelector('.switch-find-search input')?.value === ${js(value)}`, 'query render'); await sleep(220)
}
async function clickExact(browser, scope, text) {
  await browser.wait(`(() => { const root=document.querySelector(${js(scope)}); if(!root)return false; return [...root.querySelectorAll('button')].some((button)=>button.textContent.trim()===${js(text)}&&!button.disabled) })()`, `enabled ${text}`)
  const clicked = await browser.eval(`(() => { const root=document.querySelector(${js(scope)}); const button=[...root.querySelectorAll('button')].find((item)=>item.textContent.trim()===${js(text)}&&!item.disabled); if(!button)return false; button.click(); return true })()`)
  assert.equal(clicked, true, `cannot click ${text}`); await sleep(160)
}
async function clickContains(browser, selector, text) { const clicked = await browser.eval(`(() => { const item=[...document.querySelectorAll(${js(selector)})].find((node)=>node.textContent.includes(${js(text)})); if(!item)return false; item.click(); return true })()`); assert.equal(clicked, true, `${selector} missing ${text}`); await sleep(160) }
async function capture(browser, prefix, name) { const file = `${prefix}-${name}.png`; await browser.shot(`${OUT}/${file}`); return file }
async function network(browser) { return { blocked: await browser.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`), sentAnalytics: browser.requests.filter((r) => r.url.includes('/functions/v1/decision-intake')), sentWrites: browser.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method)), publicReads: browser.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && r.method === 'GET').length } }

async function searchCount(browser, query) {
  await browser.wait(`!document.body.innerText.includes('제품 데이터를 불러오는 중입니다.')`, 'catalog ready before search')
  await setQuery(browser, query)
  await browser.wait(`document.querySelector('.switch-find-results-heading span')?.textContent.includes('개 표시')`, 'search count label')
  const first = await browser.eval(`document.querySelectorAll('.switch-find-result').length`)
  await sleep(180)
  const second = await browser.eval(`document.querySelectorAll('.switch-find-result').length`)
  assert.equal(second, first, `unstable search count: ${query}`)
  return second
}
async function uniqueQuery(browser, products) { for (const product of products.slice(0, 160)) { for (const query of [`${product.brand} ${product.canonical_name}`, product.canonical_name]) { if (query?.trim() && await searchCount(browser, query) === 1) return query } } throw new Error('one-result query not found') }
async function selectCurrent(browser, ctx) {
  await browser.wait(`!document.body.innerText.includes('제품 데이터를 불러오는 중입니다.')`, 'catalog ready before current selection')
  await setQuery(browser, `${ctx.current.brand} ${ctx.current.canonical_name}`); await browser.wait(`document.querySelectorAll('.switch-find-result').length > 0`, 'current result'); await clickContains(browser, '.switch-find-result', ctx.current.canonical_name); await browser.wait(`document.querySelector('.switch-current-preview')`, 'current preview'); await clickExact(browser, '.switch-current-preview', '이 제품을 현재 사료로 선택 →'); await waitState(browser, `s.step==='sku'&&s.currentProductId===${js(ctx.current.product_id)}`, 'SKU session'); await browser.wait(`document.querySelector('.switch-sku-option')`, 'SKU render'); await browser.wait(`!document.body.innerText.includes('판매 규격을 불러오는 중입니다.')`, 'SKU load')
}
async function chooseSku(browser, ctx) { const label = ctx.sku.package_size_text || '1 kg'; await clickContains(browser, '.switch-sku-option', label); await waitState(browser, `s.variantSelection?.kind==='variant'&&s.variantSelection.variantId===${js(ctx.sku.variant_id)}`, 'SKU stored'); await browser.wait(`document.querySelector('.switch-sku-option.is-selected')`, 'SKU selected render'); return label }
async function skuNext(browser) { await clickExact(browser, '.switch-step-actions', '다음 →'); await waitState(browser, `s.step==='change'`, 'CHANGE session'); await browser.wait(`document.querySelector('.switch-no-change')`, 'CHANGE render') }

async function progress(browser) {
  return browser.eval(`(() => { const list=document.querySelector('.switch-progress'),items=[...list.querySelectorAll('li')];return{clientWidth:list.clientWidth,scrollWidth:list.scrollWidth,items:items.map((item)=>{const num=item.querySelector(':scope>span'),label=item.querySelector('strong'),nr=num.getBoundingClientRect(),lr=label.getBoundingClientRect(),style=getComputedStyle(label);return{text:label.textContent.trim(),current:item.getAttribute('aria-current'),classes:item.className,numberAbove:nr.bottom<=lr.top+1,labelRect:[lr.left,lr.top,lr.width,lr.height],client:[label.clientWidth,label.clientHeight],scroll:[label.scrollWidth,label.scrollHeight],whiteSpace:style.whiteSpace,textOverflow:style.textOverflow}})}})()`)
}
function assertMobileProgress(value) { assert.equal(value.clientWidth, value.scrollWidth, 'progress horizontally scrolls'); assert.deepEqual(value.items.map((item) => item.text), STEP_LABELS); assert.equal(value.items.filter((item) => item.current === 'step').length, 1); for (const item of value.items) { assert.equal(item.numberAbove, true, `${item.text}: number not above label`); assert.notEqual(item.whiteSpace, 'nowrap'); assert.notEqual(item.textOverflow, 'ellipsis'); assert.ok(item.scroll[0] <= item.client[0] + 1, `${item.text}: horizontal clipping`); assert.ok(item.scroll[1] <= item.client[1] + 1, `${item.text}: vertical clipping`) } }

async function mobileSearch(browser, prefix, ctx) {
  const evidence = {}
  await browser.wait(`!document.body.innerText.includes('제품 데이터를 불러오는 중입니다.')`, 'catalog ready before mobile search')
  await setQuery(browser, '__qa_no_match_9f31c__'); await browser.wait(`document.querySelectorAll('.switch-find-result').length===0&&document.body.innerText.includes('검색 결과가 없습니다.')`, 'zero results'); evidence.zero = await browser.eval(`(() => { const body=document.querySelector('.switch-find-body'),list=document.querySelector('.switch-find-results-list'),bs=getComputedStyle(body),ls=getComputedStyle(list);return{bodyHeight:body.getBoundingClientRect().height,bodyMinHeight:bs.minHeight,listHeight:list.getBoundingClientRect().height,listOverflow:ls.overflowY,listMaxHeight:ls.maxHeight}})()`); assert.equal(evidence.zero.bodyMinHeight, '0px'); assert.ok(evidence.zero.bodyHeight < 320); evidence.zero.capture = await capture(browser, prefix, '01-zero-results')
  evidence.uniqueQuery = await uniqueQuery(browser, ctx.products); evidence.oneCount = await searchCount(browser, evidence.uniqueQuery); assert.equal(evidence.oneCount, 1); evidence.one = await browser.eval(`(() => { const body=document.querySelector('.switch-find-body'),list=document.querySelector('.switch-find-results-list'),bs=getComputedStyle(body),ls=getComputedStyle(list);return{bodyHeight:body.getBoundingClientRect().height,bodyMinHeight:bs.minHeight,listHeight:list.getBoundingClientRect().height,listOverflow:ls.overflowY,listMaxHeight:ls.maxHeight}})()`); assert.equal(evidence.one.bodyMinHeight, '0px'); assert.ok(evidence.one.bodyHeight < 330); evidence.one.capture = await capture(browser, prefix, '02-one-result')
  const manyCount = await searchCount(browser, ctx.manyBrand); assert.ok(manyCount >= 2, 'many-result search unexpectedly small'); evidence.manyCount = manyCount; evidence.manyQuery = ctx.manyBrand; evidence.list = await browser.eval(`(() => { const list=document.querySelector('.switch-find-results-list'),style=getComputedStyle(list);return{clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,overflowY:style.overflowY,maxHeight:style.maxHeight}})()`); assert.equal(evidence.list.overflowY, 'visible'); assert.equal(evidence.list.maxHeight, 'none'); assert.ok(evidence.list.scrollHeight <= evidence.list.clientHeight + 1)
  const selector = `.switch-find-result:nth-child(${evidence.manyCount})`; await browser.eval(`document.querySelector(${js(selector)}).scrollIntoView({block:'center',inline:'nearest'})`); await sleep(180); const reached = await browser.eval(`(() => { const row=document.querySelector(${js(selector)}),rect=row.getBoundingClientRect();return{scrollY,visible:rect.top>=0&&rect.bottom<=innerHeight,centerHit:(()=>{const top=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return Boolean(top&&(top===row||row.contains(top)))})(),name:row.querySelector('.switch-find-result-copy strong').textContent.trim(),rect:[rect.left,rect.top,rect.width,rect.height]}})()`); assert.equal(reached.visible, true); assert.equal(reached.centerHit, true); evidence.lastReached = reached; evidence.lastCapture = await capture(browser, prefix, '03-last-result-reached')
  const beforeY = reached.scrollY; await browser.eval(`document.querySelector(${js(selector)}).click()`); await browser.wait(`document.querySelector('.switch-current-preview h2')?.textContent.trim()===${js(reached.name)}`, 'last preview identity'); evidence.previewCapture = await capture(browser, prefix, '04-last-result-preview'); await clickExact(browser, '.switch-current-preview', '닫기 ×'); await browser.wait(`!document.querySelector('.switch-current-preview')`, 'preview close')
  evidence.return = await browser.eval(`(() => { const query=document.querySelector('.switch-find-search input')?.value??null,row=[...document.querySelectorAll('.switch-find-result')].find((item)=>item.querySelector('.switch-find-result-copy strong')?.textContent.trim()===${js(reached.name)});if(!row)return{query,scrollY,row:null};const rect=row.getBoundingClientRect();return{query,scrollY,row:{name:row.querySelector('.switch-find-result-copy strong').textContent.trim(),rect:[rect.left,rect.top,rect.width,rect.height],visible:rect.bottom>0&&rect.top<innerHeight,fullyVisible:rect.top>=0&&rect.bottom<=innerHeight}}})()`); evidence.return.beforeY = beforeY; evidence.return.deltaY = Math.round(evidence.return.scrollY - beforeY); assert.equal(evidence.return.query, ctx.manyBrand); assert.equal(evidence.return.row?.name, reached.name); assert.equal(evidence.return.row?.visible, true); evidence.returnCapture = await capture(browser, prefix, '05-preview-return-position')
  return evidence
}

async function exactInspectorAction(browser) {
  await browser.wait(`(() => { const root=document.querySelector('.switch-candidate-inspector');if(!root)return false;const button=[...root.querySelectorAll('button')].find((item)=>item.textContent.trim()==='상세 보기 →');if(!button||button.disabled)return false;const r=button.getBoundingClientRect(),s=getComputedStyle(button);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden' })()`, 'exact detail button rendered and enabled')
  const before = await browser.eval(`(() => { const root=document.querySelector('.switch-candidate-inspector'),button=[...root.querySelectorAll('button')].find((item)=>item.textContent.trim()==='상세 보기 →'),r=button.getBoundingClientRect();return{text:button.textContent.trim(),className:button.className,disabled:button.disabled,rect:[r.left,r.top,r.width,r.height],scrollY}})()`); assert.equal(before.text, '상세 보기 →'); assert.ok(before.className.split(/\s+/).includes('switch-compare-action')); assert.equal(before.disabled, false)
  await browser.eval(`(() => { const root=document.querySelector('.switch-candidate-inspector'),button=[...root.querySelectorAll('button')].find((item)=>item.textContent.trim()==='상세 보기 →');button.scrollIntoView({block:'center',inline:'nearest'}) })()`); await sleep(180)
  const after = await browser.eval(`(() => { const root=document.querySelector('.switch-candidate-inspector'),button=[...root.querySelectorAll('button')].find((item)=>item.textContent.trim()==='상세 보기 →'),r=button.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)),top=document.elementFromPoint(x,y);return{text:button.textContent.trim(),rect:[r.left,r.top,r.width,r.height],visible:r.top>=0&&r.bottom<=innerHeight,centerHit:Boolean(top&&(top===button||button.contains(top))),scrollY}})()`); assert.equal(after.visible, true); assert.equal(after.centerHit, true); return { before, after }
}

async function mobileFlow(width, height, ctx, result) {
  const prefix = `pr23-${PRODUCT_SHA.slice(0,8)}-${width}x${height}`; const { browser, proc, dir } = await launch(width, height, true)
  try {
    await browser.navigate(`${BASE}?view=workspace&mode=switch`); await browser.wait(`document.querySelector('.switch-find-search input')`, 'search input'); result.search = await mobileSearch(browser, prefix, ctx)
    await selectCurrent(browser, ctx); result.sku = { id: ctx.sku.variant_id, label: await chooseSku(browser, ctx) }; result.progress = await progress(browser); assertMobileProgress(result.progress); result.fonts = await browser.fonts('.switch-progress li[aria-current="step"] strong'); assert.ok(result.fonts.some((font) => font.familyName.includes('Noto Sans CJK KR'))); result.captures.push(await capture(browser, prefix, '06-sku-progress'))
    await skuNext(browser); await clickExact(browser, '.switch-step-main', '다른 브랜드로 보기'); await waitState(browser, `s.changeBrand===true`, 'change brand stored'); await clickExact(browser, '.switch-step-actions', '다음 →'); await waitState(browser, `s.step==='keep'`, 'KEEP session'); const keepLabel = `${ctx.current.feed_type} 유지`; await clickExact(browser, '.switch-step-main', keepLabel); await waitState(browser, `s.keep?.feedType===${js(ctx.current.feed_type)}`, 'KEEP feed stored'); result.roundtrip.beforeKeepBack = await state(browser); result.captures.push(await capture(browser, prefix, '07-keep-before-explicit-back'))
    await clickExact(browser, '.switch-step-actions', '← 바꿀 것 수정'); await waitState(browser, `s.step==='change'`, 'KEEP to CHANGE explicit back'); result.roundtrip.afterKeepBack = await state(browser); assert.equal(result.roundtrip.afterKeepBack.variantSelection.variantId, ctx.sku.variant_id); assert.equal(result.roundtrip.afterKeepBack.changeBrand, true); assert.equal(result.roundtrip.afterKeepBack.keep.feedType, ctx.current.feed_type); result.captures.push(await capture(browser, prefix, '08-change-after-keep-back'))
    await clickExact(browser, '.switch-step-actions', '다음 →'); await waitState(browser, `s.step==='keep'`, 'KEEP re-entry'); await browser.wait(`(() => { const b=[...document.querySelectorAll('.switch-step-main button')].find((item)=>item.textContent.trim()===${js(keepLabel)});return b?.getAttribute('aria-pressed')==='true' })()`, 'KEEP selection rendered'); result.roundtrip.afterKeepReentry = await state(browser); assert.equal(result.roundtrip.afterKeepReentry.variantSelection.variantId, ctx.sku.variant_id); assert.equal(result.roundtrip.afterKeepReentry.changeBrand, true); assert.equal(result.roundtrip.afterKeepReentry.keep.feedType, ctx.current.feed_type); result.captures.push(await capture(browser, prefix, '09-keep-reentry'))
    await clickExact(browser, '.switch-step-actions', '후보 제품 보기 →'); await waitState(browser, `s.step==='results'`, 'results session'); await browser.wait(`document.querySelector('.switch-results-stage')`, 'results render'); result.captures.push(await capture(browser, prefix, '10-results'))
    const exists = await browser.eval(`[...document.querySelectorAll('.switch-candidate-row')].some((row)=>row.textContent.includes(${js(LONG_NAME)}))`); assert.equal(exists, true, 'long-name candidate missing'); await clickContains(browser, '.switch-candidate-row', LONG_NAME); await browser.wait(`document.querySelector('.switch-candidate-inspector .switch-inspector-identity h1')?.textContent.trim()===${js(LONG_NAME)}`, 'long-name inspector')
    result.candidate = await browser.eval(`(() => { const box=document.querySelector('.switch-inspector-identity'),image=box.querySelector('.switch-inspector-image'),title=box.querySelector('h1'),br=box.getBoundingClientRect(),ir=image.getBoundingClientRect(),tr=title.getBoundingClientRect(),style=getComputedStyle(title);return{name:title.textContent.trim(),box:[br.left,br.top,br.width,br.height],image:[ir.left,ir.top,ir.width,ir.height],title:[tr.left,tr.top,tr.width,tr.height],titleBelowImage:tr.top>=ir.bottom-1,titleWidthRatio:tr.width/br.width,whiteSpace:style.whiteSpace,textOverflow:style.textOverflow,lineClamp:style.webkitLineClamp||null,overflowX:style.overflowX,overflowY:style.overflowY,client:[title.clientWidth,title.clientHeight],scroll:[title.scrollWidth,title.scrollHeight],imageFit:getComputedStyle(image).objectFit,natural:image.tagName==='IMG'?[image.naturalWidth,image.naturalHeight]:null}})()`); result.captures.push(await capture(browser, prefix, '11-long-candidate-inspector'))
    assert.equal(result.candidate.name, LONG_NAME); assert.equal(result.candidate.titleBelowImage, true); assert.ok(result.candidate.titleWidthRatio > .85); assert.notEqual(result.candidate.whiteSpace, 'nowrap'); assert.notEqual(result.candidate.textOverflow, 'ellipsis'); assert.ok(!result.candidate.lineClamp || result.candidate.lineClamp === 'none'); assert.notEqual(result.candidate.overflowY, 'hidden'); assert.ok(result.candidate.scroll[0] <= result.candidate.client[0] + 1); assert.ok(result.candidate.scroll[1] <= result.candidate.client[1] + 3, `title height metric ${result.candidate.client[1]} -> ${result.candidate.scroll[1]}`); assert.ok(result.candidate.image[2] <= 180 && result.candidate.image[3] <= 180); result.detailAction = await exactInspectorAction(browser)
    await clickExact(browser, '.switch-candidate-inspector', '닫기 ×'); await browser.wait(`!document.querySelector('.switch-candidate-inspector')`, 'inspector close'); await clickExact(browser, '.switch-session-bar', '조건 수정'); await waitState(browser, `s.step==='change'`, 'results to CHANGE'); result.roundtrip.beforeSkuBack = await state(browser); await clickExact(browser, '.switch-step-actions', '← 사용 규격'); await waitState(browser, `s.step==='sku'`, 'CHANGE to SKU explicit back'); await browser.wait(`document.querySelector('.switch-sku-option.is-selected')`, 'restored SKU render'); result.roundtrip.afterSkuBack = await state(browser); assert.equal(result.roundtrip.afterSkuBack.variantSelection.variantId, ctx.sku.variant_id); assert.equal(result.roundtrip.afterSkuBack.changeBrand, true); assert.equal(result.roundtrip.afterSkuBack.keep.feedType, ctx.current.feed_type); result.captures.push(await capture(browser, prefix, '12-explicit-back-sku'))
    await skuNext(browser); result.roundtrip.afterChangeReentry = await state(browser); assert.equal(result.roundtrip.afterChangeReentry.variantSelection.variantId, ctx.sku.variant_id); assert.equal(result.roundtrip.afterChangeReentry.changeBrand, true); assert.equal(result.roundtrip.afterChangeReentry.keep.feedType, ctx.current.feed_type); result.captures.push(await capture(browser, prefix, '13-change-reentry'))
    result.network = await network(browser); assert.equal(result.network.sentAnalytics.length, 0); assert.equal(result.network.sentWrites.length, 0); result.status = 'pass'
  } catch (error) { result.status = 'fail'; result.error = String(error?.stack || error); throw error } finally { browser.close(); proc.kill('SIGTERM'); await sleep(80); try { rmSync(dir,{recursive:true,force:true}) } catch {} }
}

async function boundaryFlow(width, height, ctx, result) {
  const prefix = `pr23-${PRODUCT_SHA.slice(0,8)}-${width}x${height}`; const { browser, proc, dir } = await launch(width, height, width < 1024)
  try {
    await browser.navigate(`${BASE}?view=workspace&mode=switch`); await browser.wait(`document.querySelector('.switch-find-search input')`, 'boundary search'); result.count = await searchCount(browser, ctx.manyBrand); assert.ok(result.count >= 2, `${width}: multi-result search did not populate`); result.search = await browser.eval(`(() => { const list=document.querySelector('.switch-find-results-list'),style=getComputedStyle(list);return{clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,overflowY:style.overflowY,maxHeight:style.maxHeight}})()`)
    if (width === 760) { assert.equal(result.search.overflowY, 'visible'); assert.equal(result.search.maxHeight, 'none'); assert.ok(result.search.scrollHeight <= result.search.clientHeight + 1) } else { assert.equal(result.search.overflowY, 'auto'); assert.notEqual(result.search.maxHeight, 'none'); assert.ok(result.search.scrollHeight > result.search.clientHeight, `${width}: desktop result list is not actually scrollable`) } result.captures.push(await capture(browser, prefix, 'boundary-search'))
    await selectCurrent(browser, ctx); await chooseSku(browser, ctx); result.progress = await progress(browser); if (width === 760) assertMobileProgress(result.progress); else assert.ok(result.progress.items.some((item) => !item.numberAbove), `${width}: mobile stacked progress leaked across boundary`); result.captures.push(await capture(browser, prefix, 'boundary-progress')); result.network = await network(browser); assert.equal(result.network.sentAnalytics.length, 0); assert.equal(result.network.sentWrites.length, 0); result.status = 'pass'
  } catch (error) { result.status = 'fail'; result.error = String(error?.stack || error); throw error } finally { browser.close(); proc.kill('SIGTERM'); await sleep(80); try { rmSync(dir,{recursive:true,force:true}) } catch {} }
}

const ctx = await makeContext()
const report = {
  productSha: PRODUCT_SHA, qaSha: QA_SHA, status: 'running',
  browserVersion: execFileSync('/usr/bin/google-chrome',['--version'],{encoding:'utf8'}).trim(),
  koreanFont: execFileSync('fc-match',[':lang=ko'],{encoding:'utf8'}).trim(),
  context: { current: ctx.current, sku: ctx.sku, manyBrand: ctx.manyBrand, longName: LONG_NAME },
  mobile: [], boundary: [], error: null,
}
const save = () => writeFileSync(`${OUT}/report.json`, JSON.stringify(report,null,2))
try {
  for (const [width,height] of [[360,844],[390,900]]) { const item={viewport:[width,height],status:'running',captures:[],roundtrip:{}}; report.mobile.push(item); save(); await mobileFlow(width,height,ctx,item); save() }
  for (const [width,height] of [[760,900],[761,900],[1280,900]]) { const item={viewport:[width,height],status:'running',captures:[]}; report.boundary.push(item); save(); await boundaryFlow(width,height,ctx,item); save() }
  report.status='pass'
} catch (error) { report.status='fail'; report.error=String(error?.stack||error); throw error } finally { save() }
console.log('PR23_MOBILE_SWITCH_DESIGN_QA_PASS', JSON.stringify({ productSha: PRODUCT_SHA, qaSha: QA_SHA, browserVersion: report.browserVersion, koreanFont: report.koreanFont, mobile: report.mobile.map((item)=>({viewport:item.viewport,returnDeltaY:item.search?.return?.deltaY,returnVisible:item.search?.return?.row?.visible,steps:item.progress?.items.map((step)=>[step.text,step.current,step.numberAbove]),candidate:item.candidate?.name,detail:item.detailAction?.after?.text,sku:item.sku,afterSkuBack:item.roundtrip?.afterSkuBack?.variantSelection,writes:item.network?.sentWrites?.length,analytics:item.network?.sentAnalytics?.length})), boundary: report.boundary.map((item)=>({viewport:item.viewport,count:item.count,search:item.search,steps:item.progress?.items.map((step)=>[step.text,step.numberAbove]),writes:item.network?.sentWrites?.length,analytics:item.network?.sentAnalytics?.length})) }))