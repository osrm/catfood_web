import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'https://osrm.github.io/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
const q = JSON.stringify
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })
assert.ok(PRODUCT_SHA && SUPABASE_URL && SUPABASE_KEY, 'QA env missing')

async function apiRows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view} GET failed: ${response.status}`)
  return response.json()
}

async function catalogContext() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,manufacturing_country_codes,variant_count',
    order: 'brand.asc,canonical_name.asc',
    limit: 1000,
  })
  const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어')
  assert.ok(current, 'AATU 연어 not found')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,units_per_sale,display_rank',
    product_id: `eq.${current.product_id}`,
    order: 'display_rank.asc,variant_id.asc',
    limit: 100,
  })
  const sku = variants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? ''))
  assert.ok(sku, 'AATU 연어 1 kg SKU not found')

  const eligible = products.filter((row) => row.product_id !== current.product_id)
  const byBrand = new Map()
  for (const row of eligible) {
    const list = byBrand.get(row.brand) ?? []
    list.push(row)
    byBrand.set(row.brand, list)
  }
  const sameBrandEntry = [...byBrand.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .sort((a, b) => a[0].localeCompare(b[0], 'ko-KR'))[0]
  assert.ok(sameBrandEntry, 'same-brand pair unavailable')
  const sameBrandTwo = sameBrandEntry[1].slice(0, 2)

  const longestSorted = [...eligible].sort((a, b) => b.canonical_name.length - a.canonical_name.length || a.canonical_name.localeCompare(b.canonical_name, 'ko-KR'))
  const longest = longestSorted[0]
  const unknown = eligible.find((row) => row.product_id !== longest.product_id && (!row.feed_type || !row.life_stage || !(row.manufacturing_country_codes?.length)))
  assert.ok(longest && unknown, 'longest/unknown candidates unavailable')
  const five = [unknown]
  for (const row of longestSorted.slice(1)) {
    if (row.product_id === unknown.product_id) continue
    if (!five.some((item) => item.product_id === row.product_id)) five.push(row)
    if (five.length === 4) break
  }
  five.push(longest)
  assert.equal(five.length, 5)
  assert.equal(new Set(five.map((row) => row.product_id)).size, 5)
  return { current, sku, sameBrand: sameBrandEntry[0], sameBrandTwo, five, longestId: longest.product_id, unknownId: unknown.product_id }
}

class Browser {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(domain)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch=window.fetch.bind(window)
      window.__qaBlocked={analytics:0,writes:0}
      window.fetch=(input,init={})=>{
        const url=typeof input==='string'?input:(input&&input.url)||''
        const method=String(init.method||(input&&input.method)||'GET').toUpperCase()
        if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}
        if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}
        return nativeFetch(input,init)
      }
    })();` })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, timeout = 40000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await this.eval(`Boolean(${expression})`).catch(() => false)) return; await sleep(100) } throw new Error(`timeout: ${label}`) }
  async nav(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState==='complete'`, 'document ready'); await this.wait(`document.querySelector('#root')&&document.body.innerText.length`, 'root'); await this.eval('document.fonts?.ready'); await sleep(250) }
  async shot(name) { await this.eval('document.fonts?.ready'); await sleep(100); const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(`${OUT}/${name}`, Buffer.from(image.data, 'base64')) }
  close() { try { this.ws?.close() } catch {} }
}

let launchNo = 0
async function launch(width, height) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 13600 + (process.pid % 100) + launchNo++ * 50
  const dir = `/tmp/pr39-compare-readability-${process.pid}-${launchNo}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const browser = new Browser(page.webSocketDebuggerUrl)
      await browser.connect()
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height })
      await browser.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' })
      return { browser, proc, dir }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}
async function cleanup(handle) {
  handle.browser.close(); handle.proc.kill('SIGTERM'); await sleep(100); if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL'); try { rmSync(handle.dir, { recursive: true, force: true }) } catch {}
}

async function state(c) { return c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`) }
async function pressKey(c, key, code, keyCode, text = '') {
  const payload = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) }
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload }); await sleep(80)
}
async function pressTab(c) { await pressKey(c, 'Tab', 'Tab', 9) }

async function trustedPointerClick(c, selector, matcher = null) {
  const target = await c.eval(`(()=>{
    const nodes=[...document.querySelectorAll(${q(selector)})]
    const n=${matcher ? `nodes.find(el=>el.textContent.includes(${q(matcher)}))` : 'nodes[0]'}
    if(!n)return null
    n.scrollIntoView({block:'center',inline:'nearest'})
    const r=n.getBoundingClientRect(),x=Math.max(2,Math.min(innerWidth-2,r.left+r.width/2)),y=Math.max(2,Math.min(innerHeight-2,r.top+r.height/2)),hit=document.elementFromPoint(x,y)
    if(!hit||!(hit===n||n.contains(hit)))return{blocked:true,hit:hit?.tagName||null,hitClass:hit?.className||'',rect:{left:r.left,top:r.top,width:r.width,height:r.height}}
    window.__qaTrustedPointer=[]
    for(const type of ['pointerdown','pointerup','click'])n.addEventListener(type,e=>window.__qaTrustedPointer.push({type,isTrusted:e.isTrusted}),{once:true,capture:true})
    return{x,y,text:n.textContent.trim(),rect:{left:r.left,top:r.top,width:r.width,height:r.height}}
  })()`)
  assert.ok(target, `missing pointer target ${selector} ${matcher ?? ''}`)
  assert.ok(!target.blocked, `blocked pointer target ${JSON.stringify(target)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(160)
  const events = await c.eval('window.__qaTrustedPointer')
  assert.ok(events?.some((e) => e.type === 'click' && e.isTrusted), `trusted click missing ${selector}`)
  return { ...target, events }
}

async function typeSearch(c, text) {
  await trustedPointerClick(c, '.switch-find-search input')
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector('.switch-find-search input')?.value===${q(text)}`, 'search input')
  await sleep(200)
}

async function establishResults(c, ctx) {
  await c.nav(`${BASE}?view=workspace&mode=switch`)
  await c.wait(`document.querySelector('.switch-find-search input')`, 'switch search')
  await c.wait(`!document.body.innerText.includes('제품 목록을 불러오는 중입니다.')`, 'catalog loaded')
  await typeSearch(c, `${ctx.current.brand} ${ctx.current.canonical_name}`)
  await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes(${q(ctx.current.brand)})&&n.textContent.includes(${q(ctx.current.canonical_name)}))`, 'current result')
  await trustedPointerClick(c, '.switch-find-result', ctx.current.canonical_name)
  await c.wait(`document.querySelector('.switch-current-preview')`, 'current preview')
  await trustedPointerClick(c, '.switch-current-preview .switch-primary-action')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'sku options', 30000)
  await trustedPointerClick(c, '.switch-sku-option', '1 kg')
  await trustedPointerClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-no-change')`, 'change step')
  await trustedPointerClick(c, '.switch-no-change')
  await trustedPointerClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'keep step')
  await trustedPointerClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-results-stage')`, 'results')
  await c.wait(`document.querySelectorAll('.switch-candidate-row').length>0`, 'candidate rows')
  const s = await state(c)
  assert.equal(s.currentProductId, ctx.current.product_id)
  assert.equal(s.variantSelection.kind, 'variant')
  assert.equal(s.variantSelection.variantId, ctx.sku.variant_id)
  assert.equal(s.noChangeIntent, true)
  assert.deepEqual(s.compareIds, [])
  return s
}

async function ensureCandidateVisible(c, product) {
  for (let i = 0; i < 30; i++) {
    const found = await c.eval(`[...document.querySelectorAll('.switch-candidate-row')].some(n=>n.textContent.includes(${q(product.brand)})&&n.querySelector('.switch-candidate-identity strong')?.textContent.trim()===${q(product.canonical_name)})`)
    if (found) return
    const more = await c.eval(`Boolean(document.querySelector('.load-more'))`)
    assert.equal(more, true, `candidate not found: ${product.brand} ${product.canonical_name}`)
    await trustedPointerClick(c, '.load-more')
    await sleep(100)
  }
  throw new Error(`candidate load limit: ${product.canonical_name}`)
}

async function addCandidate(c, product) {
  await ensureCandidateVisible(c, product)
  const index = await c.eval(`[...document.querySelectorAll('.switch-candidate-row')].findIndex(n=>n.textContent.includes(${q(product.brand)})&&n.querySelector('.switch-candidate-identity strong')?.textContent.trim()===${q(product.canonical_name)})`)
  assert.ok(index >= 0)
  await trustedPointerClick(c, `.switch-candidate-row:nth-of-type(${index + 1})`)
  await c.wait(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()===${q(product.canonical_name)}`, 'inspector target')
  const before = await state(c)
  await trustedPointerClick(c, '.switch-inspector-actions .switch-compare-action', '비교에 추가')
  await c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});if(!raw)return false;const s=JSON.parse(raw).state;return s.compareIds.length===${before.compareIds.length + 1}})()`, 'compare add')
  const after = await state(c)
  assert.equal(after.compareIds.at(-1), product.product_id)
  await trustedPointerClick(c, '.switch-preview-topline button')
  return product.product_id
}

async function openCompare(c, expectedIds) {
  const s = await state(c)
  assert.deepEqual(s.compareIds, expectedIds)
  await trustedPointerClick(c, '.switch-compare-dock > button')
  await c.wait(`document.querySelector('.compare-stage')`, 'compare stage')
  await c.wait(`getComputedStyle(document.querySelector('.compare-switch-mobile-overview')).display!=='none'`, 'mobile compare overview')
  await c.wait(`document.querySelector('.compare-mobile-product-head.is-current')?.textContent.includes('사용 규격 · 1 kg')`, 'current SKU in compare')
}

async function readabilityMetrics(c) {
  return c.eval(`(()=>{
    const rect=(n)=>{const r=n.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}
    const style=(n)=>{if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect();return{text:n.textContent.trim().replace(/\\s+/g,' '),fontSize:s.fontSize,lineHeight:s.lineHeight,color:s.color,fontWeight:s.fontWeight,textOverflow:s.textOverflow,overflow:s.overflow,whiteSpace:s.whiteSpace,wordBreak:s.wordBreak,overflowWrap:s.overflowWrap,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,rect:rect(n)}}
    const heads=[...document.querySelectorAll('.compare-mobile-product-head')]
    const current=heads.find(n=>n.classList.contains('is-current')),candidate=heads.find(n=>n.classList.contains('is-candidate'))
    const currentSmalls=current?[...current.querySelectorAll('small')]:[], candidateSmalls=candidate?[...candidate.querySelectorAll('small')]:[]
    const rows=[...document.querySelectorAll('.compare-mobile-overview-row')]
    const unknownCell=[...document.querySelectorAll('.compare-mobile-pair > div > div')].find(n=>/미확인|확인된 값 없음|공식 표기 미확인/.test(n.textContent))
    const header=document.querySelector('.compare-header'),scope=document.querySelector('.compare-scope-note'),tabs=document.querySelector('.compare-tabs'),picker=document.querySelector('.compare-mobile-candidate-picker'),headGrid=document.querySelector('.compare-mobile-head-grid')
    const firstRow=rows[0]
    const fullyVisibleRows=rows.filter(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}).length
    const intersectingRows=rows.filter(n=>{const r=n.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).length
    const headRects=heads.map(rect)
    const pairOverlap=headRects.length===2?Math.max(0,headRects[0].right-headRects[1].left):null
    return {
      viewport:{width:innerWidth,height:innerHeight,scrollY,docClientWidth:document.documentElement.clientWidth,docScrollWidth:document.documentElement.scrollWidth,horizontalOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth},
      textStyles:{
        pickerLabel:style(document.querySelector('.compare-mobile-candidate-picker > span')),
        activePickerButton:style(document.querySelector('.compare-mobile-candidate-picker button[aria-pressed="true"]')),
        currentRole:style(current?.querySelector(':scope > span')),
        currentBrand:style(current?.querySelector('.compare-mobile-product-brand')),
        currentName:style(current?.querySelector(':scope > strong')),
        currentUsage:style(currentSmalls[1]),
        currentSale:style(currentSmalls[2]),
        candidateBrand:style(candidate?.querySelector('.compare-mobile-product-brand')),
        candidateName:style(candidate?.querySelector(':scope > strong')),
        candidateSale:style(candidateSmalls[1]),
        rowLabel:style(document.querySelector('.compare-mobile-row-label')),
        currentValue:style(document.querySelector('.compare-mobile-pair > div:first-child > div')),
        candidateValue:style(document.querySelector('.compare-mobile-pair > div:last-child > div')),
        unknownValue:style(unknownCell),
      },
      layout:{
        compareHeader:header?rect(header):null,scopeNote:scope?rect(scope):null,tabs:tabs?rect(tabs):null,picker:picker?rect(picker):null,headGrid:headGrid?rect(headGrid):null,firstRow:firstRow?rect(firstRow):null,
        firstRowTop:firstRow?.getBoundingClientRect().top??null,fullyVisibleRows,intersectingRows,totalRows:rows.length,pairOverlap,
      },
      rowLabels:rows.map(n=>n.querySelector('.compare-mobile-row-label')?.textContent.trim()),
      clipping:{
        currentName:style(current?.querySelector(':scope > strong')),
        candidateName:style(candidate?.querySelector(':scope > strong')),
        valueCells:[...document.querySelectorAll('.compare-mobile-pair > div > div')].map(style),
      }
    }
  })()`)
}

async function pickerMetrics(c) {
  return c.eval(`(()=>{
    const scroller=document.querySelector('.compare-mobile-candidate-picker > div'),buttons=[...scroller.querySelectorAll('button')],sr=scroller.getBoundingClientRect()
    const info=(b,i)=>{const r=b.getBoundingClientRect(),s=getComputedStyle(b);return{index:i,productId:b.dataset.productId,text:b.textContent.trim(),ariaPressed:b.getAttribute('aria-pressed'),left:r.left,right:r.right,width:r.width,fullyVisible:r.left>=sr.left&&r.right<=sr.right,clientWidth:b.clientWidth,scrollWidth:b.scrollWidth,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace}}
    return{label:document.querySelector('.compare-mobile-candidate-picker > span')?.textContent.trim(),clientWidth:scroller.clientWidth,scrollWidth:scroller.scrollWidth,scrollLeft:scroller.scrollLeft,maxScroll:scroller.scrollWidth-scroller.clientWidth,overflowX:getComputedStyle(scroller).overflowX,buttons:buttons.map(info),fullyVisibleCount:buttons.filter(b=>{const r=b.getBoundingClientRect();return r.left>=sr.left&&r.right<=sr.right}).length}
  })()`)
}

async function horizontalWheelToLast(c) {
  const events=[]
  for (let i=0;i<20;i++) {
    const m=await pickerMetrics(c), last=m.buttons.at(-1)
    if(last?.fullyVisible)return{events,final:m}
    const point=await c.eval(`(()=>{const n=document.querySelector('.compare-mobile-candidate-picker > div');const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,pointerType:'mouse'})
    await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX:260,deltaY:0,pointerType:'mouse'})
    await sleep(100)
    events.push((await pickerMetrics(c)).scrollLeft)
  }
  throw new Error('horizontal pointer wheel did not reveal last candidate')
}

async function clickPickerIndex(c,index) {
  const m=await pickerMetrics(c)
  const target=m.buttons[index]
  assert.ok(target)
  if(!target.fullyVisible)await horizontalWheelToLast(c)
  const point=await c.eval(`(()=>{const b=document.querySelectorAll('.compare-mobile-candidate-picker button')[${index}],r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);if(!b||!hit||!(hit===b||b.contains(hit)))return null;window.__qaCandidatePointer=null;b.addEventListener('click',e=>window.__qaCandidatePointer=e.isTrusted,{once:true,capture:true});return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  assert.ok(point,'picker pointer unavailable')
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});await sleep(140)
  assert.equal(await c.eval('window.__qaCandidatePointer'),true)
  assert.equal(await c.eval(`document.querySelectorAll('.compare-mobile-candidate-picker button')[${index}]?.getAttribute('aria-pressed')`),'true')
}

async function keyboardToLast(c) {
  await c.eval(`document.activeElement?.blur()`)
  const count=await c.eval(`document.querySelectorAll('.compare-mobile-candidate-picker button').length`)
  let tabs=0
  for(;tabs<80;tabs++){
    await pressTab(c)
    const index=await c.eval(`(()=>{const a=document.activeElement,buttons=[...document.querySelectorAll('.compare-mobile-candidate-picker button')];return buttons.indexOf(a)})()`)
    if(index===count-1)break
  }
  assert.ok(tabs<80,'Tab did not reach last candidate')
  await c.eval(`(()=>{const a=document.activeElement;window.__qaCandidateKey=null;a.addEventListener('keydown',e=>window.__qaCandidateKey={key:e.key,isTrusted:e.isTrusted},{once:true,capture:true})})()`)
  await pressKey(c,'Enter','Enter',13,'\r')
  const key=await c.eval('window.__qaCandidateKey')
  assert.equal(key?.isTrusted,true)
  assert.equal(key?.key,'Enter')
  assert.equal(await c.eval(`document.querySelectorAll('.compare-mobile-candidate-picker button')[${count-1}]?.getAttribute('aria-pressed')`),'true')
  return{tabs:tabs+1,key,scrollLeft:(await pickerMetrics(c)).scrollLeft}
}

function stableStateSubset(s){return{currentProductId:s.currentProductId,variantSelection:s.variantSelection,compareIds:s.compareIds,compareOpen:s.compareOpen,compareTab:s.compareTab}}
async function networkReport(c){
  const writes=c.requests.filter(r=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(r.method))
  const analytics=c.requests.filter(r=>r.url.includes('/functions/v1/decision-intake'))
  const nonRead=c.requests.filter(r=>!['GET','HEAD','OPTIONS'].includes(r.method))
  const blocked=await c.eval('window.__qaBlocked')
  assert.equal(writes.length,0);assert.equal(analytics.length,0);assert.equal(nonRead.length,0);assert.deepEqual(blocked,{analytics:0,writes:0})
  return{writes:0,analytics:0,nonRead:0,gets:c.requests.filter(r=>r.method==='GET').length,blocked}
}

async function scenario360(ctx){
  const handle=await launch(360,844),c=handle.browser,result={viewport:'360x844',targets:ctx.sameBrandTwo}
  try{
    await establishResults(c,ctx)
    for(const p of ctx.sameBrandTwo)await addCandidate(c,p)
    await openCompare(c,ctx.sameBrandTwo.map(p=>p.product_id))
    result.initialState=stableStateSubset(await state(c))
    result.initialPicker=await pickerMetrics(c)
    result.initialReadability=await readabilityMetrics(c)
    await c.shot('360-compare-initial.png')
    assert.equal(result.initialPicker.buttons.length,2)
    assert.equal(result.initialPicker.buttons.filter(b=>b.ariaPressed==='true').length,1)
    assert.equal(new Set(ctx.sameBrandTwo.map(p=>p.brand)).size,1)
    result.pointerScroll=await horizontalWheelToLast(c)
    await clickPickerIndex(c,1)
    result.afterPointerState=stableStateSubset(await state(c))
    assert.deepEqual(result.afterPointerState,result.initialState)
    result.secondReadability=await readabilityMetrics(c)
    await c.shot('360-compare-second-candidate.png')
    await clickPickerIndex(c,0)
    result.keyboardLast=await keyboardToLast(c)
    result.afterKeyboardState=stableStateSubset(await state(c))
    assert.deepEqual(result.afterKeyboardState,result.initialState)
    result.network=await networkReport(c)
  }finally{await cleanup(handle)}
  return result
}

async function scenario390(ctx){
  const handle=await launch(390,900),c=handle.browser,result={viewport:'390x900',targets:ctx.five}
  try{
    await establishResults(c,ctx)
    for(const p of ctx.five)await addCandidate(c,p)
    await openCompare(c,ctx.five.map(p=>p.product_id))
    result.initialState=stableStateSubset(await state(c))
    result.initialPicker=await pickerMetrics(c)
    result.initialReadability=await readabilityMetrics(c)
    await c.shot('390-compare-initial.png')
    assert.equal(result.initialPicker.buttons.length,5)
    const unknownIndex=ctx.five.findIndex(p=>p.product_id===ctx.unknownId)
    await clickPickerIndex(c,unknownIndex)
    result.unknownReadability=await readabilityMetrics(c)
    assert.ok(result.unknownReadability.textStyles.unknownValue,'expected an unknown display value')
    await clickPickerIndex(c,0)
    result.pointerScroll=await horizontalWheelToLast(c)
    await clickPickerIndex(c,4)
    result.afterPointerState=stableStateSubset(await state(c))
    assert.deepEqual(result.afterPointerState,result.initialState)
    result.longReadability=await readabilityMetrics(c)
    assert.equal(ctx.five[4].product_id,ctx.longestId)
    const lastName=result.longReadability.textStyles.candidateName
    assert.equal(lastName.text,ctx.five[4].canonical_name)
    assert.notEqual(lastName.textOverflow,'ellipsis')
    assert.ok(lastName.scrollWidth<=lastName.clientWidth+1)
    assert.ok(lastName.scrollHeight<=lastName.clientHeight+1)
    await clickPickerIndex(c,0)
    result.keyboardLast=await keyboardToLast(c)
    result.afterKeyboardState=stableStateSubset(await state(c))
    assert.deepEqual(result.afterKeyboardState,result.initialState)
    result.finalPicker=await pickerMetrics(c)
    result.finalReadability=await readabilityMetrics(c)
    await c.shot('390-compare-last-candidate.png')
    result.network=await networkReport(c)
  }finally{await cleanup(handle)}
  return result
}

const context=await catalogContext()
const report={productSha:PRODUCT_SHA,page:BASE,chrome:execFileSync('/usr/bin/google-chrome',['--version'],{encoding:'utf8'}).trim(),context,status:'running'}
try{
  report.mobile360=await scenario360(context)
  report.mobile390=await scenario390(context)
  report.status='pass'
  writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))
  console.log('PR39_COMPARE_READABILITY_PASS',JSON.stringify({
    current:{productId:context.current.product_id,variantId:context.sku.variant_id},
    sameBrand:context.sameBrand,
    two:context.sameBrandTwo.map(p=>({id:p.product_id,name:p.canonical_name})),
    five:context.five.map(p=>({id:p.product_id,brand:p.brand,name:p.canonical_name})),
    m360:{picker:report.mobile360.initialPicker,layout:report.mobile360.initialReadability.layout,styles:report.mobile360.initialReadability.textStyles},
    m390:{picker:report.mobile390.initialPicker,layout:report.mobile390.initialReadability.layout,styles:report.mobile390.finalReadability.textStyles,unknown:report.mobile390.unknownReadability.textStyles.unknownValue},
  }))
}catch(error){
  report.status='fail';report.error=String(error?.stack||error);writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2));throw error
}
