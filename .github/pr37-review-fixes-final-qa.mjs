import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE
const BEFORE = process.env.BASELINE_BASE
const API = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
mkdirSync(OUT, { recursive: true })
assert.ok(BASE && BEFORE && API && KEY)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (v) => JSON.stringify(v)
let launchNo = 0

async function api(view, params = {}) {
  const u = new URL(`${API.replace(/\/$/, '')}/rest/v1/${view}`)
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)))
  const r = await fetch(u, { headers: { apikey: KEY, 'Accept-Profile': 'api' } })
  assert.equal(r.ok, true, `${view}: ${r.status}`)
  return r.json()
}

async function dataContext() {
  const products = await api('effective_product_catalog_summary', { select: 'product_id,brand,canonical_name,feed_type,life_stage,manufacturing_country_codes', order: 'brand.asc,canonical_name.asc', limit: 1000 })
  const current = products.find((p) => p.brand === 'AATU' && p.canonical_name === '연어')
  assert.ok(current)
  const variants = await api('switch_current_variant_options', { select: 'product_id,variant_id,package_size_text,display_rank', product_id: `eq.${current.product_id}`, order: 'display_rank.asc', limit: 100 })
  const sku = variants.find((v) => /1\s*kg/i.test(v.package_size_text ?? ''))
  assert.ok(sku)
  const eligible = products.filter((p) => p.product_id !== current.product_id)
  const longest = [...eligible].sort((a, b) => b.canonical_name.length - a.canonical_name.length)[0]
  const unknown = eligible.find((p) => !p.feed_type || !p.life_stage || !p.manufacturing_country_codes?.length)
  const five = []
  for (const p of [longest, unknown, ...eligible]) {
    if (p && !five.some((x) => x.product_id === p.product_id)) five.push(p)
    if (five.length === 5) break
  }
  assert.equal(five.length, 5)
  return { current, sku, five, longest, unknown }
}

const empty = () => ({ feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false })
function fixture(ctx, ids) {
  return { version: 1, state: { query: 'AATU 연어', currentProductId: ctx.current.product_id, variantSelection: { kind: 'variant', variantId: ctx.sku.variant_id }, change: empty(), keep: empty(), changeBrand: false, keepBrand: false, ingredientAvoidTerms: [], noChangeIntent: true, step: 'results', visibleCandidateCount: 40, selectedCandidateId: null, compareIds: ids, compareOpen: true, compareTab: 'overview', detailProductId: null, detailTab: 'overview' } }
}

class CDP {
  constructor(ws) { this.url = ws; this.ws = null; this.i = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((ok, no) => { const t = setTimeout(() => no(new Error('ws timeout')), 15000); this.ws.addEventListener('open', () => { clearTimeout(t); ok() }, { once: true }); this.ws.addEventListener('error', no, { once: true }) })
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Network.requestWillBeSent') this.requests.push({ url: m.params.request.url, method: m.params.request.method }); if (!m.id) return; const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) })
    for (const d of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(d)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
  }
  send(method, params = {}) { const id = this.i++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(exp) { const r = await this.send('Runtime.evaluate', { expression: exp, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result?.value }
  async wait(exp, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await this.eval(`Boolean(${exp})`).catch(() => false)) return; await sleep(100) } throw new Error(`timeout ${label}`) }
  async nav(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState==='complete'`, 'ready'); await this.wait(`document.querySelector('#root')&&document.body.innerText.length`, 'root'); await this.eval('document.fonts?.ready'); await sleep(250) }
  async shot(name) { const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, 'base64')) }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile, snap = null) {
  const chrome = '/usr/bin/google-chrome'; assert.ok(existsSync(chrome))
  const port = 9700 + (process.pid % 100) + launchNo++ * 70
  const dir = `/tmp/pr37-final-${process.pid}-${launchNo}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl)
      if (page) {
        const c = new CDP(page.webSocketDebuggerUrl); await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { ${snap ? `sessionStorage.setItem(${q(STORAGE)},${q(JSON.stringify(snap))});` : ''} const f=window.fetch.bind(window);window.__blocked={analytics:0,writes:0};window.fetch=(input,init={})=>{const u=typeof input==='string'?input:(input&&input.url)||'';const m=String(init.method||(input&&input.method)||'GET').toUpperCase();if(u.includes('/functions/v1/decision-intake')){window.__blocked.analytics++;return Promise.reject(new TypeError('blocked'))}if(u.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(m)){window.__blocked.writes++;return Promise.reject(new TypeError('blocked'))}return f(input,init)}})();` })
        return { c, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}
async function cleanup(h) { h.c.close(); h.proc.kill('SIGTERM'); await sleep(120); if (h.proc.exitCode == null) h.proc.kill('SIGKILL'); try { rmSync(h.dir, { recursive: true, force: true }) } catch {} }

async function click(c, selector, { texts = [], index = 0 } = {}) {
  const p = await c.eval(`(()=>{const ns=[...document.querySelectorAll(${q(selector)})].filter(n=>${q(texts)}.every(t=>n.textContent?.includes(t)));const n=ns[${index}];if(!n)return null;n.scrollIntoView({block:'center',inline:'center'});const r=n.getBoundingClientRect();window.__trusted=null;n.addEventListener('click',e=>window.__trusted=e.isTrusted,{once:true,capture:true});return{x:r.left+r.width/2,y:r.top+r.height/2,text:n.textContent.trim()}})()`)
  assert.ok(p, `missing ${selector} ${texts.join('+')} ${index}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(160); assert.equal(await c.eval('window.__trusted'), true)
  return p
}
async function type(c, selector, text) { await click(c, selector); await c.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Control', code:'ControlLeft', windowsVirtualKeyCode:17, modifiers:2 }); await c.send('Input.dispatchKeyEvent', { type:'keyDown', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers:2 }); await c.send('Input.dispatchKeyEvent', { type:'keyUp', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers:2 }); await c.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Control', code:'ControlLeft', windowsVirtualKeyCode:17 }); await c.send('Input.insertText', { text }); await c.wait(`document.querySelector(${q(selector)})?.value===${q(text)}`, 'typed') }
async function state(c) { return c.eval(`(()=>{const v=sessionStorage.getItem(${q(STORAGE)});return v?JSON.parse(v).state:null})()`) }
function verifyNetwork(c, currentId) {
  const comp = c.requests.filter((r) => r.url.includes('/compare_product_nutrition') || r.url.includes('/compare_product_ingredients'))
  for (const r of comp) assert.equal((new URL(r.url).searchParams.get('product_id') ?? '').includes(currentId), false)
  const sentWrites = c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method))
  const sentAnalytics = c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake'))
  assert.equal(sentWrites.length, 0); assert.equal(sentAnalytics.length, 0)
  return { filters: comp.map((r) => new URL(r.url).searchParams.get('product_id')), sentWrites:0, sentAnalytics:0 }
}

async function actualJourney(ctx) {
  const h = await launch(360, 844, true); const c = h.c
  try {
    await c.nav(`${BASE}?view=workspace&mode=switch`); await c.wait(`document.querySelector('.switch-find-search input')`, 'find')
    await type(c, '.switch-find-search input', 'AATU 연어'); await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes('AATU')&&n.textContent.includes('연어'))`, 'result')
    await click(c, '.switch-find-result', { texts:['AATU','연어'] }); await c.wait(`document.querySelector('.switch-current-preview')`, 'preview'); assert.equal(await c.eval(`document.querySelector('.switch-current-preview h2')?.textContent.trim()`), '연어')
    await click(c, '.switch-current-preview .switch-primary-action'); await c.wait(`document.querySelector('.switch-sku-list')`, 'sku'); await c.wait(`[...document.querySelectorAll('.switch-sku-option')].some(n=>n.textContent.replaceAll(' ','').includes('1kg'))`, '1kg'); await click(c, '.switch-sku-option', { texts:['1','kg'] })
    await click(c, '.switch-step-actions .switch-primary-action'); await c.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'change'); await click(c, '.switch-no-change'); await click(c, '.switch-step-actions .switch-primary-action'); await c.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'keep'); await click(c, '.switch-step-actions .switch-primary-action'); await c.wait(`document.querySelectorAll('.switch-candidate-row').length>=2`, 'results')
    const names = await c.eval(`[...document.querySelectorAll('.switch-candidate-row')].slice(0,2).map(r=>({brand:r.querySelector('.switch-candidate-identity>span')?.textContent.trim(),name:r.querySelector('.switch-candidate-identity>strong')?.textContent.trim()}))`)
    for (const index of [0,1]) { await click(c, '.switch-candidate-row', { index }); await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'inspector'); await click(c, '.switch-candidate-inspector .switch-compare-action', { texts:['비교에 추가'] }); await click(c, '.switch-candidate-inspector .switch-preview-topline button'); await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'closed') }
    const before = await state(c); assert.equal(before.compareIds.length,2); await click(c, '.switch-compare-dock > button', { texts:['비교 보기'] }); await c.wait(`document.querySelectorAll('.compare-mobile-candidate-picker button').length===2`, 'compare')
    const labels = await c.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].map(b=>b.textContent.trim())`); assert.equal(labels[0].includes(names[0].brand)&&labels[0].includes(names[0].name),true); assert.equal(labels[1].includes(names[1].brand)&&labels[1].includes(names[1].name),true)
    await click(c, '.compare-mobile-candidate-picker button', { index:1 }); const selected = await c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate > strong')?.textContent.trim()`); const firstFactTop = await c.eval(`document.querySelector('.compare-mobile-overview-row')?.getBoundingClientRect().top`); await c.shot('360x844-app-journey-compare.png')
    await click(c, '.compare-mobile-head-actions button', { texts:['상세 보기'] }); await c.wait(`document.querySelector('.detail-stage')`, 'detail'); await click(c, '.detail-topbar button'); await c.wait(`document.querySelector('.compare-switch-mobile-overview')`, 'return'); assert.equal(await c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate > strong')?.textContent.trim()`),selected)
    await click(c, '.compare-mobile-head-actions button', { texts:['비교에서 제거'] }); await c.wait(`!document.querySelector('.compare-mobile-candidate-picker')`, 'one candidate'); const after = await state(c); assert.equal(after.compareIds.length,1); assert.equal(after.compareIds.includes(before.compareIds[1]),false)
    const hist = await c.send('Page.getNavigationHistory'); assert.ok(hist.currentIndex>0); const compareEntry=hist.entries[hist.currentIndex], parent=hist.entries[hist.currentIndex-1]; await c.send('Page.navigateToHistoryEntry',{entryId:parent.id}); await c.wait(`document.querySelector('.switch-results-stage')&&!document.querySelector('.compare-stage')`,'back'); const back=await state(c); assert.deepEqual(back.compareIds,after.compareIds); assert.equal((await c.eval(`document.querySelector('.switch-compare-dock')?.textContent||''`)).includes(selected),false); await c.shot('360x844-app-journey-after-back.png')
    return { names, labels, selected, firstFactTop, compareIdsBefore:before.compareIds, compareIdsAfter:after.compareIds, history:{compare:{id:compareEntry.id,url:compareEntry.url},parent:{id:parent.id,url:parent.url}}, network:verifyNetwork(c,ctx.current.product_id) }
  } finally { await cleanup(h) }
}

async function firstFact(ctx, base, label) { const h=await launch(360,844,true,fixture(ctx,ctx.five.slice(0,2).map(p=>p.product_id))); try { await h.c.nav(`${base}?view=workspace&mode=switch`); await h.c.wait(`document.querySelector('.compare-switch-mobile-overview')`,label); const r=await h.c.eval(`(()=>{const n=[...document.querySelectorAll('.compare-mobile-overview-row')].find(x=>x.querySelector('.compare-mobile-row-label')?.textContent.trim()==='사료 형태');const b=n.getBoundingClientRect();return{top:b.top,bottom:b.bottom,height:b.height}})()`); if(label==='after')await h.c.shot('360x844-first-fact-after.png'); return r } finally { await cleanup(h) } }

async function mobile390(ctx) { const h=await launch(390,900,true,fixture(ctx,ctx.five.map(p=>p.product_id)));const c=h.c;try{await c.nav(`${BASE}?view=workspace&mode=switch`);await c.wait(`document.querySelectorAll('.compare-mobile-candidate-picker button').length===5`,'five');const labels=await c.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].map(b=>b.textContent.trim())`);const selected=[];for(let i=0;i<5;i++){await click(c,'.compare-mobile-candidate-picker button',{index:i});selected.push(await c.eval(`document.querySelector('.compare-mobile-product-head.is-candidate > strong')?.textContent.trim()`))}assert.equal(new Set(selected).size,5);const li=ctx.five.findIndex(p=>p.product_id===ctx.longest.product_id);await click(c,'.compare-mobile-candidate-picker button',{index:li});const long=await c.eval(`(()=>{const n=document.querySelector('.compare-mobile-product-head.is-candidate > strong');const s=getComputedStyle(n);return{text:n.textContent.trim(),cw:n.clientWidth,sw:n.scrollWidth,ch:n.clientHeight,sh:n.scrollHeight,overflow:s.textOverflow}})()`);assert.equal(long.text,ctx.longest.canonical_name);assert.equal(long.cw,long.sw);assert.equal(long.ch,long.sh);assert.notEqual(long.overflow,'ellipsis');const ui=ctx.five.findIndex(p=>p.product_id===ctx.unknown.product_id);await click(c,'.compare-mobile-candidate-picker button',{index:ui});assert.match(await c.eval(`document.querySelector('.compare-switch-mobile-overview')?.textContent||''`),/미확인|확인된 값 없음|공식 표기 미확인/);await c.shot('390x900-five-candidates.png');return{labels,selected,long,unknown:`${ctx.unknown.brand} · ${ctx.unknown.canonical_name}`,network:verifyNetwork(c,ctx.current.product_id)}}finally{await cleanup(h)}}

async function boundary760(ctx){const h=await launch(760,900,true,fixture(ctx,ctx.five.map(p=>p.product_id)));try{await h.c.nav(`${BASE}?view=workspace&mode=switch`);await h.c.wait(`document.querySelector('.compare-switch-mobile-overview')`,'760');const d=await h.c.eval(`({mobile:getComputedStyle(document.querySelector('.compare-switch-mobile-overview')).display,desktop:getComputedStyle(document.querySelector('.compare-switch-overview-desktop')).display})`);assert.notEqual(d.mobile,'none');assert.equal(d.desktop,'none');await h.c.shot('760x900-mobile-boundary.png');return d}finally{await cleanup(h)}}

async function desktop(ctx,width){const h=await launch(width,900,false,fixture(ctx,ctx.five.map(p=>p.product_id)));const c=h.c;try{await c.nav(`${BASE}?view=workspace&mode=switch`);await c.wait(`document.querySelector('.compare-switch-overview-desktop')&&getComputedStyle(document.querySelector('.compare-switch-overview-desktop')).display!=='none'`,`${width}`);const g=await c.eval(`(()=>{const w=document.querySelector('.compare-table-wrap');w.scrollLeft=w.scrollWidth-w.clientWidth;const row=[...document.querySelectorAll('.compare-switch-overview-row')].find(n=>n.querySelector('.compare-row-label')?.textContent.trim()==='사료 형태');const label=row.querySelector('.compare-row-label'),cur=row.querySelector('.compare-cell.is-current'),last=[...row.querySelectorAll('.compare-cell:not(.is-current)')].at(-1);const heads=[...document.querySelectorAll('.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head)')],head=heads.at(-1),detail=head.querySelector('.compare-detail-link');const r=n=>{const b=n.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}};const wr=r(w),lr=r(label),cr=r(cur),vr=r(last),hr=r(head),dr=r(detail),hit=document.elementFromPoint(dr.left+dr.width/2,dr.top+dr.height/2);return{scrollLeft:w.scrollLeft,max:w.scrollWidth-w.clientWidth,wrap:wr,label:lr,current:cr,last:vr,lastHead:hr,detail:dr,hit:hit===detail||detail.contains(hit),texts:{label:label.textContent.trim(),current:cur.textContent.trim(),last:last.textContent.trim()},tableOverflow:getComputedStyle(document.querySelector('.compare-switch-overview-desktop')).overflowX}})()`);assert.equal(Math.round(g.scrollLeft),Math.round(g.max));assert.equal(g.texts.label,'사료 형태');assert.ok(g.label.left>=g.wrap.left-1&&g.label.right<=g.wrap.right+1,JSON.stringify(g));assert.ok(g.current.left>=g.label.right-1&&g.current.right<=g.wrap.right+1,JSON.stringify(g));assert.ok(g.last.left>=g.current.right-1&&g.last.right<=g.wrap.right+1,JSON.stringify(g));assert.equal(g.hit,true,JSON.stringify(g));if(width===761){await click(c,'.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head) .compare-detail-link',{index:4});await c.wait(`document.querySelector('.detail-stage')`,'last detail');await click(c,'.detail-topbar button');await c.wait(`document.querySelector('.compare-switch-overview-desktop')`,'return')}await c.shot(`${width}x900-desktop-right-edge.png`);return{geometry:g,network:verifyNetwork(c,ctx.current.product_id)}}finally{await cleanup(h)}}

const ctx=await dataContext()
const report={productSha:process.env.PRODUCT_SHA,baselineSha:process.env.BASELINE_SHA,browserVersion:execFileSync('/usr/bin/google-chrome',['--version'],{encoding:'utf8'}).trim(),koreanFont:execFileSync('fc-match',[':lang=ko'],{encoding:'utf8'}).trim().split('\n')[0],status:'running'}
try{report.actualJourney=await actualJourney(ctx);report.beforeFirstFact=await firstFact(ctx,BEFORE,'before');report.afterFirstFact=await firstFact(ctx,BASE,'after');report.firstFactDelta=report.afterFirstFact.top-report.beforeFirstFact.top;report.mobile390=await mobile390(ctx);report.boundary760=await boundary760(ctx);report.desktop761=await desktop(ctx,761);report.desktop1280=await desktop(ctx,1280);report.status='pass';writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2));console.log('PR37_FINAL_QA PASS',JSON.stringify({firstFactDelta:report.firstFactDelta,d761:report.desktop761.geometry,d1280:report.desktop1280.geometry}))}catch(error){report.status='fail';report.error=String(error?.stack??error);writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2));throw error}
