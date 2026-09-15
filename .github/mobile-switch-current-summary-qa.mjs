import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASELINE = process.env.QA_BASELINE ?? 'http://127.0.0.1:4173/catfood_web/'
const CANDIDATE = process.env.QA_CANDIDATE ?? 'http://127.0.0.1:4174/catfood_web/'
const BASE_SHA = process.env.BASE_SHA ?? 'unknown'
const PRODUCT_SHA = process.env.PRODUCT_SHA ?? 'unknown'
const QA_SHA = process.env.GITHUB_SHA ?? 'unknown'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const STORAGE_KEY = 'catfood.switch-session.v1'
const OUT = 'qa-artifacts'
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

async function variantsFor(productId) {
  return apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,units_per_sale,display_rank',
    product_id: `eq.${productId}`,
    order: 'display_rank.asc,variant_id.asc',
    limit: 100,
  })
}

async function makeContext() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,variant_count,has_variants',
    order: 'brand.asc,canonical_name.asc',
    limit: 1000,
  })
  const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어' && Number(row.variant_count) >= 2)
  assert.ok(current, 'AATU 연어 multi-SKU current food not found')
  const currentVariants = await variantsFor(current.product_id)
  const sku = currentVariants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? ''))
  assert.ok(sku, 'AATU 연어 1 kg SKU not found')

  const longCandidates = products
    .filter((row) => row.brand && row.canonical_name && Number(row.variant_count) >= 1)
    .sort((a, b) => b.canonical_name.length - a.canonical_name.length)
  let longCurrent = null
  let longSku = null
  for (const product of longCandidates.slice(0, 30)) {
    const variants = await variantsFor(product.product_id)
    if (variants.length) {
      longCurrent = product
      longSku = variants[0]
      break
    }
  }
  assert.ok(longCurrent && longSku, 'long-name current product with SKU not found')
  return { products, current, sku, longCurrent, longSku }
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
  const port = 9500 + (process.pid % 100) + (width % 37)
  const dir = `/tmp/switch-summary-${width}-${process.pid}-${Math.random().toString(16).slice(2)}`
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

async function state(browser) { return browser.eval(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`) }
async function waitState(browser, expression, label) { await browser.wait(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); if(!raw)return false; const s=JSON.parse(raw).state; return ${expression} })()`, label) }
async function setQuery(browser, value) {
  const changed = await browser.eval(`(() => { const input=document.querySelector('.switch-find-search input'); if(!input)return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${js(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(changed, true, 'search input missing'); await sleep(220)
}
async function clickExact(browser, scope, text) {
  await browser.wait(`(() => { const root=document.querySelector(${js(scope)}); if(!root)return false; return [...root.querySelectorAll('button')].some((button)=>button.textContent.trim()===${js(text)}&&!button.disabled) })()`, `enabled ${text}`)
  const clicked = await browser.eval(`(() => { const root=document.querySelector(${js(scope)}); const button=[...root.querySelectorAll('button')].find((item)=>item.textContent.trim()===${js(text)}&&!item.disabled); if(!button)return false; button.click(); return true })()`)
  assert.equal(clicked, true, `cannot click ${text}`); await sleep(180)
}
async function clickContains(browser, selector, text) { const clicked = await browser.eval(`(() => { const item=[...document.querySelectorAll(${js(selector)})].find((node)=>node.textContent.includes(${js(text)})); if(!item)return false; item.click(); return true })()`); assert.equal(clicked, true, `${selector} missing ${text}`); await sleep(180) }
async function network(browser) { return { blocked: await browser.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`), sentAnalytics: browser.requests.filter((r)=>r.url.includes('/functions/v1/decision-intake')), sentWrites: browser.requests.filter((r)=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(r.method)), publicReads: browser.requests.filter((r)=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&r.method==='GET').length } }

async function selectCurrent(browser, product) {
  await browser.wait(`!document.body.innerText.includes('제품 데이터를 불러오는 중입니다.')`, 'catalog ready')
  await setQuery(browser, `${product.brand} ${product.canonical_name}`)
  await browser.wait(`document.querySelectorAll('.switch-find-result').length > 0`, 'current search result')
  await clickContains(browser, '.switch-find-result', product.canonical_name)
  await browser.wait(`document.querySelector('.switch-current-preview')`, 'current preview')
  await clickExact(browser, '.switch-current-preview', '이 제품을 현재 사료로 선택 →')
  await waitState(browser, `s.step==='sku'&&s.currentProductId===${js(product.product_id)}`, 'SKU session')
  await browser.wait(`!document.body.innerText.includes('판매 규격을 불러오는 중입니다.')`, 'SKU load')
}
async function chooseSku(browser, sku) {
  const label = sku.package_size_text || `${Math.round(Number(sku.package_weight_g))} g`
  await clickContains(browser, '.switch-sku-option', label)
  await waitState(browser, `s.variantSelection?.kind==='variant'&&s.variantSelection.variantId===${js(sku.variant_id)}`, 'SKU stored')
}
async function gotoChange(browser) { await clickExact(browser, '.switch-step-actions', '다음 →'); await waitState(browser, `s.step==='change'`, 'CHANGE session'); await browser.wait(`document.querySelector('.switch-no-change')`, 'CHANGE render'); await browser.eval(`document.scrollingElement.scrollTop=0`); await sleep(180) }

async function summaryMetrics(browser) {
  return browser.eval(`(() => {
    const rect=(el)=>{const r=el?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}:null}
    const rail=document.querySelector('.switch-reference-rail'); const name=document.querySelector('.switch-reference-product strong'); const sku=document.querySelector('.switch-reference-sku strong'); const reselect=document.querySelector('.switch-change-current'); const question=document.querySelector('.switch-step-header h1');
    const brand=[...document.querySelectorAll('.switch-criterion-section')].find((section)=>section.querySelector('.switch-criterion-heading strong')?.textContent.trim()==='브랜드')?.querySelector('button');
    const progress=document.querySelector('.switch-progress'); const steps=[...progress.querySelectorAll('li')].map((item)=>{const label=item.querySelector('strong'),r=label.getBoundingClientRect(),s=getComputedStyle(label);return{text:label.textContent.trim(),current:item.getAttribute('aria-current'),rect:[r.left,r.top,r.width,r.height],client:[label.clientWidth,label.clientHeight],scroll:[label.scrollWidth,label.scrollHeight],overflow:s.overflow,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace}})
    const ns=getComputedStyle(name), rs=getComputedStyle(rail), layout=document.querySelector('.switch-step-layout'), main=document.querySelector('.switch-step-main'), doc=document.scrollingElement;
    return {viewport:[innerWidth,innerHeight],rail:rect(rail),railDisplay:rs.display,railFlexWrap:rs.flexWrap,name:name.textContent.trim(),nameRect:rect(name),nameClient:[name.clientWidth,name.clientHeight],nameScroll:[name.scrollWidth,name.scrollHeight],nameOverflow:ns.overflow,nameTextOverflow:ns.textOverflow,nameWhiteSpace:ns.whiteSpace,nameLineClamp:ns.webkitLineClamp,sku:sku.textContent.trim(),skuRect:rect(sku),reselect:rect(reselect),question:rect(question),brandButton:rect(brand),brandText:brand?.textContent.trim()??null,progress:{clientWidth:progress.clientWidth,scrollWidth:progress.scrollWidth,steps},document:{clientHeight:doc.clientHeight,scrollHeight:doc.scrollHeight,scrollTop:doc.scrollTop},layout:{clientHeight:layout.clientHeight,scrollHeight:layout.scrollHeight},main:{clientHeight:main.clientHeight,scrollHeight:main.scrollHeight}};
  })()`)
}
function assertProgress(metrics) {
  assert.equal(metrics.progress.clientWidth, metrics.progress.scrollWidth, 'step list horizontally scrolls')
  assert.deepEqual(metrics.progress.steps.map((item)=>item.text), STEP_LABELS)
  assert.equal(metrics.progress.steps.filter((item)=>item.current==='step').length, 1)
  for (const item of metrics.progress.steps) {
    assert.notEqual(item.textOverflow, 'ellipsis', `${item.text}: ellipsis`)
    assert.ok(item.scroll[0] <= item.client[0] + 1, `${item.text}: horizontal clipping`)
    assert.ok(item.scroll[1] <= item.client[1] + 1, `${item.text}: vertical clipping`)
  }
}
function assertFullName(metrics, expected) {
  assert.equal(metrics.name, expected)
  assert.notEqual(metrics.nameOverflow, 'hidden')
  assert.notEqual(metrics.nameTextOverflow, 'ellipsis')
  assert.ok(!metrics.nameLineClamp || metrics.nameLineClamp === 'none')
  assert.ok(metrics.nameScroll[0] <= metrics.nameClient[0] + 1, 'current product name horizontally clipped')
  assert.ok(metrics.nameScroll[1] <= metrics.nameClient[1] + 1, 'current product name vertically clipped')
}

async function openChange(url, width, height, product, sku) {
  const launched = await launch(width, height, width <= 900)
  const { browser } = launched
  await browser.navigate(`${url}?view=workspace&mode=switch`)
  await selectCurrent(browser, product)
  await chooseSku(browser, sku)
  await gotoChange(browser)
  return launched
}

async function captureChange(label, url, width, height, product, sku) {
  const launched = await openChange(url,width,height,product,sku)
  try {
    const metrics = await summaryMetrics(launched.browser); assertProgress(metrics); assertFullName(metrics, product.canonical_name)
    const file = `${OUT}/${label}-${width}x${height}-change.png`; await launched.browser.shot(file)
    const net = await network(launched.browser); assert.equal(net.sentAnalytics.length,0); assert.equal(net.sentWrites.length,0); assert.ok(net.publicReads>0)
    return { metrics, file, network: net }
  } finally { launched.browser.close(); launched.proc.kill('SIGTERM'); rmSync(launched.dir,{recursive:true,force:true}) }
}

async function candidateMobileFlow(ctx) {
  const launched = await launch(360,844,true); const { browser } = launched; const result={captures:{},steps:{},roundtrip:{}}
  try {
    await browser.navigate(`${CANDIDATE}?view=workspace&mode=switch`); await selectCurrent(browser,ctx.current); await chooseSku(browser,ctx.sku)
    await browser.eval(`document.scrollingElement.scrollTop=0`); await sleep(150)
    result.steps.sku=await summaryMetrics(browser); assertProgress(result.steps.sku); assertFullName(result.steps.sku,ctx.current.canonical_name); result.captures.sku=`${OUT}/candidate-360x844-sku.png`; await browser.shot(result.captures.sku)
    await gotoChange(browser); result.steps.change=await summaryMetrics(browser); assertProgress(result.steps.change); assertFullName(result.steps.change,ctx.current.canonical_name); assert.equal(result.steps.change.sku.includes('1 kg'),true); assert.ok(result.steps.change.question.bottom <= 844,'CHANGE question not in first viewport'); assert.ok(result.steps.change.brandButton.bottom <= 844,'entire brand choice button not in first viewport'); assert.equal(result.steps.change.brandText,'다른 브랜드로 보기'); result.captures.change=`${OUT}/candidate-360x844-change.png`; await browser.shot(result.captures.change)
    assert.ok(result.steps.change.document.scrollHeight > result.steps.change.document.clientHeight,'document no longer scrolls')
    assert.ok(result.steps.change.layout.scrollHeight <= result.steps.change.layout.clientHeight + 1,'nested layout scroll introduced')
    await clickExact(browser,'.switch-step-main','다른 브랜드로 보기'); await waitState(browser,`s.changeBrand===true`,'change brand stored'); await clickExact(browser,'.switch-step-actions','다음 →'); await waitState(browser,`s.step==='keep'`,'KEEP session')
    const keepLabel=`${ctx.current.feed_type} 유지`; await clickExact(browser,'.switch-step-main',keepLabel); await waitState(browser,`s.keep?.feedType===${js(ctx.current.feed_type)}`,'KEEP feed stored'); await browser.eval(`document.scrollingElement.scrollTop=0`); result.steps.keep=await summaryMetrics(browser); assertProgress(result.steps.keep); assertFullName(result.steps.keep,ctx.current.canonical_name); result.captures.keep=`${OUT}/candidate-360x844-keep.png`; await browser.shot(result.captures.keep)
    result.roundtrip.before=await state(browser); await clickExact(browser,'.switch-step-actions','← 바꿀 것 수정'); await waitState(browser,`s.step==='change'`,'KEEP to CHANGE'); result.roundtrip.change=await state(browser); assert.equal(result.roundtrip.change.variantSelection.variantId,ctx.sku.variant_id); assert.equal(result.roundtrip.change.changeBrand,true); assert.equal(result.roundtrip.change.keep.feedType,ctx.current.feed_type)
    await clickExact(browser,'.switch-step-actions','← 사용 규격'); await waitState(browser,`s.step==='sku'`,'CHANGE to SKU'); result.roundtrip.sku=await state(browser); assert.equal(result.roundtrip.sku.variantSelection.variantId,ctx.sku.variant_id); assert.equal(result.roundtrip.sku.changeBrand,true); assert.equal(result.roundtrip.sku.keep.feedType,ctx.current.feed_type)
    await gotoChange(browser); await clickExact(browser,'.switch-reference-rail','현재 사료 다시 선택'); await waitState(browser,`s.step==='current'&&s.currentProductId===null`,'reselect reset'); result.roundtrip.reselect=await state(browser); await browser.wait(`document.querySelector('.switch-find-search input')`, 'current search after reset')
    const net=await network(browser); assert.equal(net.sentAnalytics.length,0); assert.equal(net.sentWrites.length,0); assert.ok(net.publicReads>0); result.network=net; return result
  } finally { browser.close(); launched.proc.kill('SIGTERM'); rmSync(launched.dir,{recursive:true,force:true}) }
}

async function longNameFlow(ctx) {
  const launched=await openChange(CANDIDATE,390,900,ctx.longCurrent,ctx.longSku)
  try {
    const metrics=await summaryMetrics(launched.browser); assertProgress(metrics); assertFullName(metrics,ctx.longCurrent.canonical_name); assert.ok(metrics.sku.length>0); assert.ok(metrics.reselect && metrics.reselect.width>0 && metrics.reselect.height>=40); assert.ok(metrics.reselect.bottom <= metrics.rail.bottom+1); const file=`${OUT}/candidate-390x900-long-current.png`; await launched.browser.shot(file); const net=await network(launched.browser); assert.equal(net.sentAnalytics.length,0); assert.equal(net.sentWrites.length,0); return {metrics,file,network:net}
  } finally { launched.browser.close(); launched.proc.kill('SIGTERM'); rmSync(launched.dir,{recursive:true,force:true}) }
}

async function boundaryCompare(ctx,width,height) {
  const before=await captureChange(`baseline-boundary`,BASELINE,width,height,ctx.current,ctx.sku)
  const after=await captureChange(`candidate-boundary`,CANDIDATE,width,height,ctx.current,ctx.sku)
  if (width===760) assert.ok(after.metrics.rail.height < before.metrics.rail.height,'760 compact summary did not reduce rail height')
  else {
    assert.ok(Math.abs(after.metrics.rail.height-before.metrics.rail.height)<1,'>760 rail height changed')
    assert.equal(after.metrics.railDisplay,before.metrics.railDisplay,'>760 rail display changed')
  }
  return {width,height,before:before.metrics,after:after.metrics,beforeFile:before.file,afterFile:after.file}
}

const ctx=await makeContext()
const report={baseSha:BASE_SHA,productSha:PRODUCT_SHA,qaSha:QA_SHA,status:'running',browserVersion:execFileSync('/usr/bin/google-chrome',['--version'],{encoding:'utf8'}).trim(),koreanFont:execFileSync('fc-match',[':lang=ko'],{encoding:'utf8'}).trim(),context:{current:ctx.current,sku:ctx.sku,longCurrent:ctx.longCurrent,longSku:ctx.longSku},comparison:null,candidate:null,longName:null,boundaries:[],error:null}
const save=()=>writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))
try {
  assert.ok(/Noto Sans CJK|Nanum|Noto Sans KR/.test(report.koreanFont),'Korean font environment missing')
  const before=await captureChange('baseline',BASELINE,360,844,ctx.current,ctx.sku)
  const after=await captureChange('candidate',CANDIDATE,360,844,ctx.current,ctx.sku)
  assert.ok(after.metrics.rail.height < before.metrics.rail.height,'mobile summary height did not improve')
  assert.ok(after.metrics.question.top < before.metrics.question.top,'CHANGE question did not move earlier')
  assert.ok(after.metrics.brandButton.top < before.metrics.brandButton.top,'brand choice did not move earlier')
  assert.ok(after.metrics.brandButton.bottom <= 844,'candidate brand button not fully visible')
  report.comparison={before,after}; save()
  report.candidate=await candidateMobileFlow(ctx); save()
  report.longName=await longNameFlow(ctx); save()
  for (const [width,height] of [[760,900],[761,900],[1280,900]]) { report.boundaries.push(await boundaryCompare(ctx,width,height)); save() }
  report.status='pass'
} catch(error) { report.status='fail'; report.error=String(error?.stack||error); throw error } finally { save() }
console.log('MOBILE_SWITCH_CURRENT_SUMMARY_QA_PASS',JSON.stringify({baseSha:BASE_SHA,productSha:PRODUCT_SHA,before:{rail:report.comparison?.before.metrics.rail.height,questionTop:report.comparison?.before.metrics.question.top,brandTop:report.comparison?.before.metrics.brandButton.top,brandBottom:report.comparison?.before.metrics.brandButton.bottom},after:{rail:report.comparison?.after.metrics.rail.height,questionTop:report.comparison?.after.metrics.question.top,brandTop:report.comparison?.after.metrics.brandButton.top,brandBottom:report.comparison?.after.metrics.brandButton.bottom},longName:report.longName?.metrics.name,boundaries:report.boundaries.map((item)=>({width:item.width,beforeRail:item.before.rail.height,afterRail:item.after.rail.height,beforeDisplay:item.before.railDisplay,afterDisplay:item.after.railDisplay}))}))
