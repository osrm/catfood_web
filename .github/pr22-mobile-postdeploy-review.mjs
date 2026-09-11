import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'https://osrm.github.io/catfood_web/'
const DEPLOY_SHA = process.env.DEPLOY_SHA ?? 'unknown'
const EXPECTED_ASSET = process.env.EXPECTED_ASSET ?? ''
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const OUT = 'qa-artifacts'
const STORAGE_KEY = 'catfood.switch-session.v1'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
assert.ok(SUPABASE_URL && SUPABASE_KEY, 'public Supabase read config missing')

async function apiRows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view} read failed: ${response.status}`)
  return response.json()
}

async function chooseCurrentProduct() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,variant_count,has_variants',
    order: 'brand.asc,canonical_name.asc',
    limit: 1000,
  })
  const candidates = products.filter((row) => row?.product_id && row?.canonical_name && row?.brand && row?.feed_type && Number(row?.variant_count) >= 2)
  for (const product of candidates) {
    const hasPeer = products.some((row) => row?.product_id !== product.product_id && row?.brand !== product.brand && row?.feed_type === product.feed_type)
    if (!hasPeer) continue
    const variants = await apiRows('switch_current_variant_options', {
      select: 'product_id,variant_id,package_size_text,package_weight_g,display_rank',
      product_id: `eq.${product.product_id}`,
      order: 'display_rank.asc,variant_id.asc',
      limit: 100,
    })
    if (variants.length >= 2) return { product, variants }
  }
  throw new Error('no suitable multi-SKU current product found')
}

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
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
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('DOM.enable')
    await this.send('CSS.enable')
    await this.send('Network.enable')
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const originalFetch = window.fetch.bind(window)
      window.__qaBlockedAnalytics = 0
      window.__qaBlockedWrites = 0
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
        if (url.includes('/functions/v1/decision-intake')) {
          window.__qaBlockedAnalytics += 1
          return Promise.reject(new TypeError('QA blocked analytics before network send'))
        }
        if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          window.__qaBlockedWrites += 1
          return Promise.reject(new TypeError('QA blocked production write before network send'))
        }
        return originalFetch(input, init)
      }
    })();` })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, ms = 30000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, 'document ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'root content')
    await this.eval('document.fonts?.ready')
    await sleep(300)
  }
  async reload() {
    await this.send('Page.reload', { ignoreCache: true })
    await this.wait(`document.readyState === 'complete'`, 'reload ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'reload root')
    await this.eval('document.fonts?.ready')
    await sleep(350)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(120)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }
  async platformFonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId, `missing node for font check: ${selector}`)
    const result = await this.send('CSS.getPlatformFontsForNode', { nodeId })
    return result.fonts ?? []
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height) {
  const bin = '/usr/bin/google-chrome'
  assert.ok(existsSync(bin), 'hosted runner Chrome unavailable')
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
  const port = 9950 + (process.pid % 30) + (width % 7)
  const dir = `/tmp/pr22-mobile-${width}-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const cdp = new Cdp(page.webSocketDebuggerUrl)
        await cdp.connect()
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height })
        await cdp.send('Emulation.setUserAgentOverride', {
          userAgent: `Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36`,
          acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8',
          platform: 'Android',
        })
        return { cdp, version, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function setInput(cdp, selector, value) {
  const ok = await cdp.eval(`(() => { const n=document.querySelector(${js(selector)}); if(!n)return false; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(n,${js(value)}); n.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(ok, true, `missing input ${selector}`)
  await sleep(220)
}
async function clickExact(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${js(text)}); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing exact button: ${text}`)
  await sleep(180)
}
async function clickContains(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing button containing: ${text}`)
  await sleep(180)
}
async function clickSelectorContaining(cdp, selector, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll(${js(selector)})].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing ${selector} containing: ${text}`)
  await sleep(180)
}
async function sessionState(cdp) {
  return cdp.eval(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`)
}

async function audit(cdp, selectors = []) {
  return cdp.eval(`(() => {
    const vw=window.innerWidth, vh=window.innerHeight
    const visible=(el)=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0}
    const label=(el)=>{const cls=typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\\s+/).slice(0,3).join('.'):'';return (el.id?'#'+el.id:el.tagName.toLowerCase()+cls).slice(0,140)}
    const all=[...document.querySelectorAll('body *')].filter(visible)
    const horizontal=all.filter(el=>{const r=el.getBoundingClientRect();return r.left < -1 || r.right > vw + 1}).slice(0,30).map(el=>{const r=el.getBoundingClientRect();return {el:label(el),left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width),text:(el.textContent||'').trim().slice(0,90)}})
    const clipped=all.filter(el=>{if(!((el.textContent||'').trim()))return false;const s=getComputedStyle(el);const x=el.scrollWidth>el.clientWidth+1&&s.overflowX!=='visible';const y=el.scrollHeight>el.clientHeight+1&&s.overflowY!=='visible';return x||y}).slice(0,30).map(el=>({el:label(el),client:[el.clientWidth,el.clientHeight],scroll:[el.scrollWidth,el.scrollHeight],overflow:[getComputedStyle(el).overflowX,getComputedStyle(el).overflowY],text:(el.textContent||'').trim().slice(0,110)}))
    const nested=all.filter(el=>{const s=getComputedStyle(el);return el.scrollHeight>el.clientHeight+2 && ['auto','scroll'].includes(s.overflowY) && el.clientHeight>60}).slice(0,20).map(el=>({el:label(el),clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,overflowY:getComputedStyle(el).overflowY}))
    const fixed=all.filter(el=>['fixed','sticky'].includes(getComputedStyle(el).position)).slice(0,20).map(el=>{const r=el.getBoundingClientRect();return {el:label(el),position:getComputedStyle(el).position,rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]}})
    const targets=${js(selectors)}.map(sel=>{const el=document.querySelector(sel);if(!el)return {selector:sel,missing:true};const r=el.getBoundingClientRect();return {selector:sel,text:(el.textContent||'').trim().slice(0,180),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],client:[el.clientWidth,el.clientHeight],scroll:[el.scrollWidth,el.scrollHeight],position:getComputedStyle(el).position,overflow:[getComputedStyle(el).overflowX,getComputedStyle(el).overflowY]}})
    return {viewport:{width:vw,height:vh},scroll:{x:scrollX,y:scrollY,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight},horizontalOverflow:horizontal,clippedTextCandidates:clipped,nestedScrollContainers:nested,fixedOrSticky:fixed,targets}
  })()`)
}

async function capture(cdp, prefix, step, selectors = []) {
  const metrics = await audit(cdp, selectors)
  await cdp.shot(`${OUT}/${prefix}-${step}.png`)
  return { file: `${prefix}-${step}.png`, metrics }
}

async function reachButton(cdp, text) {
  const before = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)})); if(!n)return null;const r=n.getBoundingClientRect();return {scrollY,rect:[r.left,r.top,r.width,r.height],visible:r.bottom>0&&r.top<innerHeight} })()`)
  assert.ok(before, `reach target missing: ${text}`)
  await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)}));n.scrollIntoView({block:'center',inline:'nearest'}); })()`)
  await sleep(250)
  const after = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)}));const r=n.getBoundingClientRect();const x=Math.min(innerWidth-1,Math.max(0,r.left+r.width/2)),y=Math.min(innerHeight-1,Math.max(0,r.top+r.height/2));const top=document.elementFromPoint(x,y);return {scrollY,rect:[r.left,r.top,r.width,r.height],visible:r.top>=0&&r.bottom<=innerHeight,centerHit:Boolean(top&&(top===n||n.contains(top))),topElement:top?(top.className||top.tagName):null} })()`)
  assert.equal(after.visible, true, `button not fully reachable after scroll: ${text}`)
  assert.equal(after.centerHit, true, `button center covered after scroll: ${text}`)
  return { text, before, after }
}

async function runViewport(width, height, current, variants, browserVersion) {
  const prefix = `pr22-mobile-${DEPLOY_SHA.slice(0,8)}-${width}x${height}`
  const { cdp, proc, dir } = await launch(width, height)
  const result = {
    viewport: { width, height }, browserVersion, currentProduct: current, publicVariantCount: variants.length,
    selectedSku: null, path: [], captures: [], buttonReachability: [], findings: [], network: null, font: null,
  }
  const addCapture = async (step, selectors=[]) => { const item=await capture(cdp,prefix,step,selectors); result.captures.push(item); return item }
  const addPath = (stage, expected, actual) => result.path.push({ stage, expected, actual })
  try {
    const url = new URL(BASE); url.searchParams.set('view','workspace'); url.searchParams.set('mode','switch'); url.searchParams.set('qaViewport',`${width}x${height}`)
    await cdp.nav(url.toString())
    await cdp.wait(`document.body.innerText.includes('데이터 연결됨')`, 'production catalog connected')
    await setInput(cdp, '.switch-find-search input', current.canonical_name)
    await cdp.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes(${js(current.canonical_name)})&&n.textContent.includes(${js(current.brand)}))`, 'current product search')
    addPath('current-search', 'actual public product is searchable', `${current.brand} · ${current.canonical_name}`)
    await addCapture('01-current-search', ['.research-topbar','.switch-find-hero','.switch-find-result'])

    await clickSelectorContaining(cdp,'.switch-find-result',current.canonical_name)
    await clickContains(cdp,'이 제품을 현재 사료로 선택')
    await cdp.wait(`document.body.innerText.includes('현재 먹이는 규격을 골라주세요') && document.querySelectorAll('.switch-sku-option').length>=2`, 'actual SKU options')
    const skuText = await cdp.eval(`document.querySelector('.switch-sku-option strong')?.textContent.trim()`)
    assert.ok(skuText,'actual SKU label missing')
    await clickSelectorContaining(cdp,'.switch-sku-option',skuText)
    let state = await sessionState(cdp)
    assert.equal(state?.variantSelection?.kind,'variant')
    const variantId = state.variantSelection.variantId
    assert.ok(variantId,'actual SKU id not stored')
    result.selectedSku={ text:skuText, variantId }
    addPath('sku', 'actual SKU selection is stored and visibly selected', `${skuText} · ${variantId}`)
    await addCapture('02-sku-selected-top', ['.switch-reference-rail','.switch-progress','.switch-reference-sku','.switch-sku-option.is-selected'])
    result.buttonReachability.push({ stage:'sku-next', ...(await reachButton(cdp,'다음 →')) })
    await addCapture('03-sku-next-reached', ['.switch-step-actions','.switch-sku-option.is-selected'])
    await clickExact(cdp,'다음 →')

    await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE step')
    await clickExact(cdp,'다른 브랜드로 보기')
    addPath('change', 'CHANGE selection remains editable on mobile', '다른 브랜드로 보기')
    await cdp.eval('scrollTo(0,0)'); await sleep(180)
    await addCapture('04-change-top', ['.switch-progress','.switch-reference-sku','.switch-step-header'])
    result.buttonReachability.push({ stage:'change-next', ...(await reachButton(cdp,'다음 →')) })
    await addCapture('05-change-next-reached', ['.switch-step-actions'])
    await clickExact(cdp,'다음 →')

    await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP step')
    const keepText=`${current.feed_type} 유지`
    await clickExact(cdp,keepText)
    state=await sessionState(cdp)
    assert.equal(state.changeBrand,true)
    assert.equal(state.keep.feedType,current.feed_type)
    addPath('keep','KEEP selection is stored with existing CHANGE and SKU',keepText)
    await cdp.eval('scrollTo(0,0)'); await sleep(180)
    await addCapture('06-keep-top', ['.switch-progress','.switch-reference-sku','.switch-current-facts-strip'])
    result.buttonReachability.push({ stage:'candidate-button', ...(await reachButton(cdp,'후보 제품 보기')) })
    await addCapture('07-candidate-button-reached', ['.switch-step-actions'])
    await clickContains(cdp,'후보 제품 보기')

    await cdp.wait(`document.querySelector('.switch-results-stage')`, 'candidate results')
    await cdp.wait(`document.querySelectorAll('.switch-candidate-row').length>0`, 'at least one real candidate')
    await cdp.eval('scrollTo(0,0)'); await sleep(180)
    const initialSummary=await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent.trim()`)
    addPath('results','candidate results render without using candidate count as pass criterion',initialSummary)
    await addCapture('08-results-top', ['.switch-session-bar','.switch-candidate-heading','.switch-candidate-row'])

    const candidate=await cdp.eval(`(() => {const rows=[...document.querySelectorAll('.switch-candidate-row')];const items=rows.map((row,index)=>({index,name:row.querySelector('.switch-candidate-identity strong')?.textContent.trim()||'',text:row.textContent.trim()})).filter(x=>x.name);items.sort((a,b)=>b.name.length-a.name.length);return items[0]||null})()`)
    assert.ok(candidate?.name,'candidate name missing')
    await clickSelectorContaining(cdp,'.switch-candidate-row',candidate.name)
    await cdp.wait(`document.querySelector('.switch-candidate-row.is-selected')`, 'candidate selected')
    await addCapture('09-candidate-selected', ['.switch-candidate-row.is-selected','.switch-candidate-inspector'])
    result.buttonReachability.push({ stage:'detail-button', ...(await reachButton(cdp,'상세 보기')) })
    await addCapture('10-detail-button-reached', ['.switch-candidate-inspector','.switch-inspector-actions'])
    const beforeDetail = await cdp.eval(`({scrollY,selected:document.querySelector('.switch-candidate-row.is-selected .switch-candidate-identity strong')?.textContent.trim()||null})`)
    state=await sessionState(cdp)
    const selectedCandidateId=state.selectedCandidateId
    await clickContains(cdp,'상세 보기')
    await cdp.wait(`document.querySelector('.detail-topbar') && document.querySelector('.detail-identity h1')?.textContent.includes(${js(candidate.name)})`, 'candidate detail')
    addPath('detail','long real candidate opens product detail',candidate.name)
    await cdp.eval('scrollTo(0,0)'); await sleep(180)
    await addCapture('11-detail-top', ['.detail-topbar','.detail-identity','.detail-tabs'])

    await cdp.eval('history.back()')
    await cdp.wait(`document.querySelector('.switch-results-stage') && document.querySelector('.switch-candidate-row.is-selected')`, 'browser back results')
    await sleep(250)
    const afterBack = await cdp.eval(`({scrollY,selected:document.querySelector('.switch-candidate-row.is-selected .switch-candidate-identity strong')?.textContent.trim()||null})`)
    state=await sessionState(cdp)
    assert.equal(state.selectedCandidateId,selectedCandidateId,'selected candidate state changed after browser back')
    assert.equal(afterBack.selected,candidate.name,'selected candidate visual state changed after browser back')
    result.detailReturn={candidateName:candidate.name,candidateNameLength:candidate.name.length,beforeDetail,afterBack,scrollDelta:Math.round(afterBack.scrollY-beforeDetail.scrollY),selectedCandidateId}
    addPath('browser-back','returns to results with same selected candidate',`${candidate.name}; scroll delta ${result.detailReturn.scrollDelta}px`)
    await addCapture('12-browser-back-results', ['.switch-session-bar','.switch-candidate-row.is-selected','.switch-candidate-inspector'])

    result.buttonReachability.push({ stage:'condition-edit', ...(await reachButton(cdp,'조건 수정')) })
    await addCapture('13-condition-edit-reached', ['.switch-session-bar'])
    await clickExact(cdp,'조건 수정')
    await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'condition edit')
    state=await sessionState(cdp)
    assert.equal(state.currentProductId,current.product_id)
    assert.equal(state.variantSelection.variantId,variantId)
    assert.equal(state.changeBrand,true)
    assert.equal(state.keep.feedType,current.feed_type)
    addPath('condition-edit','product, SKU, CHANGE and KEEP survive results → condition edit','preserved')
    await cdp.eval('scrollTo(0,0)'); await sleep(180)
    await addCapture('14-condition-edit-top', ['.switch-progress','.switch-reference-sku','.switch-step-header'])

    result.buttonReachability.push({ stage:'explicit-back-to-sku', ...(await reachButton(cdp,'← 사용 규격')) })
    await addCapture('15-explicit-back-reached', ['.switch-step-actions'])
    await clickExact(cdp,'← 사용 규격')
    await cdp.wait(`document.body.innerText.includes('현재 먹이는 규격을 골라주세요')`, 'explicit back SKU')
    await cdp.wait(`document.querySelector('.switch-sku-option.is-selected strong')?.textContent.trim()===${js(skuText)}`, 'restored actual SKU on explicit back')
    state=await sessionState(cdp)
    assert.equal(state.variantSelection.variantId,variantId)
    assert.equal(state.changeBrand,true)
    assert.equal(state.keep.feedType,current.feed_type)
    addPath('explicit-back','actual SKU and edited conditions remain after explicit previous-stage move',`${skuText}; changeBrand=${state.changeBrand}; keep=${state.keep.feedType}`)
    await cdp.eval('scrollTo(0,0)'); await sleep(180)
    await addCapture('16-back-sku-preserved', ['.switch-progress','.switch-reference-sku','.switch-sku-option.is-selected'])

    if (width===390) {
      await clickExact(cdp,'다음 →')
      await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`,'390 change reentry')
      await clickExact(cdp,'다음 →')
      await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`,'390 keep reentry')
      await clickContains(cdp,'후보 제품 보기')
      await cdp.wait(`document.querySelector('.switch-results-stage')`,'390 results before refresh')
      await cdp.wait(`!document.querySelector('.switch-session-current')?.textContent.includes('선택한 규격 확인 중')`,'390 SKU ready before refresh')
      const beforeRefresh=await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent.trim()`)
      await addCapture('17-before-refresh', ['.switch-session-bar'])
      await cdp.reload()
      await cdp.wait(`document.body.innerText.includes('데이터 연결됨') && document.querySelector('.switch-results-stage')`,'390 refresh restored results')
      await cdp.wait(`!document.querySelector('.switch-session-current')?.textContent.includes('선택한 규격 확인 중')`,'390 restored SKU query complete')
      const afterRefresh=await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent.trim()`)
      state=await sessionState(cdp)
      assert.equal(afterRefresh,beforeRefresh)
      assert.equal(state.currentProductId,current.product_id)
      assert.equal(state.variantSelection.variantId,variantId)
      assert.equal(state.changeBrand,true)
      assert.equal(state.keep.feedType,current.feed_type)
      result.refresh={beforeRefresh,afterRefresh,restored:{currentProductId:state.currentProductId,variantId:state.variantSelection.variantId,changeBrand:state.changeBrand,keepFeedType:state.keep.feedType}}
      addPath('refresh-390','after SKU lookup completes, product + actual SKU + conditions restore',afterRefresh)
      await addCapture('18-after-refresh-restored', ['.switch-session-bar','.switch-session-current'])
    }

    const fonts=await cdp.platformFonts('.mode-button.is-active')
    assert.ok(fonts.some((font)=>/Noto Sans CJK KR/i.test(font.familyName)&&font.glyphCount>0),`Korean UI did not use Noto Sans CJK KR: ${JSON.stringify(fonts)}`)
    result.font=fonts
    const blocked=await cdp.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`)
    const productionHost='gnosbstdatkytsyxuapt.supabase.co'
    const sentAnalytics=cdp.requests.filter(r=>r.url.includes('/functions/v1/decision-intake'))
    const sentWrites=cdp.requests.filter(r=>r.url.includes(productionHost)&&!['GET','HEAD','OPTIONS'].includes(r.method))
    const publicReads=cdp.requests.filter(r=>r.url.includes(productionHost)&&r.method==='GET')
    assert.equal(sentAnalytics.length,0,'analytics reached network')
    assert.equal(sentWrites.length,0,'production write reached network')
    result.network={blocked,analyticsSent:sentAnalytics,productionWritesSent:sentWrites,publicCatalogReadCount:publicReads.length}

    for (const shot of result.captures) {
      const m=shot.metrics
      if (m.scroll.documentWidth > width + 1) result.findings.push({type:'document-horizontal-overflow',file:shot.file,documentWidth:m.scroll.documentWidth,viewportWidth:width})
      if (m.horizontalOverflow.length) result.findings.push({type:'visible-horizontal-overflow-candidates',file:shot.file,count:m.horizontalOverflow.length,examples:m.horizontalOverflow.slice(0,5)})
      if (m.clippedTextCandidates.length) result.findings.push({type:'clipped-text-candidates',file:shot.file,count:m.clippedTextCandidates.length,examples:m.clippedTextCandidates.slice(0,5)})
      if (m.nestedScrollContainers.length) result.findings.push({type:'nested-scroll-containers',file:shot.file,count:m.nestedScrollContainers.length,examples:m.nestedScrollContainers.slice(0,5)})
    }
    if (Math.abs(result.detailReturn.scrollDelta)>height) result.findings.push({type:'detail-return-large-scroll-shift',delta:result.detailReturn.scrollDelta,viewportHeight:height})
    return result
  } finally {
    cdp.close()
    try { proc.kill('SIGTERM') } catch {}
    await sleep(150)
    try { rmSync(dir,{recursive:true,force:true}) } catch {}
  }
}

const html=await (await fetch(BASE,{cache:'no-store'})).text()
assert.ok(EXPECTED_ASSET && html.includes(`./assets/${EXPECTED_ASSET}`),`Pages does not serve expected merge asset ${EXPECTED_ASSET}`)
const {product:current,variants}=await chooseCurrentProduct()
const browserVersion=execFileSync('/usr/bin/google-chrome',['--version'],{encoding:'utf8'}).trim()
const report={
  deploySha:DEPLOY_SHA,pageUrl:BASE,expectedAsset:EXPECTED_ASSET,browserVersion,
  environment:{hostedHeadlessChrome:true,physicalMobileDevice:false,locale:'ko-KR',fontPackage:'fonts-noto-cjk',analyticsInterceptInstalledBeforeFirstNavigation:true,productionWritesAllowed:false},
  reproducibility:{currentProduct:current,publicVariants:variants.map(v=>({variant_id:v.variant_id,package_size_text:v.package_size_text,package_weight_g:v.package_weight_g,display_rank:v.display_rank})),path:['현재 제품 검색','실제 SKU 선택','CHANGE 다른 브랜드','KEEP 현재 사료 형태','후보 결과','긴 후보 제품 선택','후보 상세','browser back','조건 수정','명시적 이전 단계 → SKU'],expectations:['실제 SKU와 CHANGE/KEEP가 명시적 이전 단계 이동 뒤 유지','상세 browser back 후 후보 선택 상태와 목록 위치가 유지되는지 측정','버튼은 전체 페이지 캡처가 아니라 실제 스크롤 후 viewport 내에서 조작 가능','가로 overflow/텍스트 clipping/고정 요소/nested scroll을 각 viewport에서 기록','390px에서는 SKU 조회 완료 후 새로고침 복원']},
  viewports:[],
}
for (const [width,height] of [[360,844],[390,900]]) report.viewports.push(await runViewport(width,height,current,variants,browserVersion))
writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))
console.log('PR22_MOBILE_POSTDEPLOY_REVIEW_PASS',JSON.stringify({deploySha:DEPLOY_SHA,browserVersion,currentProduct:{product_id:current.product_id,brand:current.brand,canonical_name:current.canonical_name},viewports:report.viewports.map(v=>({viewport:v.viewport,sku:v.selectedSku,candidate:v.detailReturn?.candidateName,scrollDelta:v.detailReturn?.scrollDelta,findings:v.findings.length,network:v.network,refresh:Boolean(v.refresh)}))}))
