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
    order: 'brand.asc,canonical_name.asc', limit: 1000,
  })
  const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어')
  assert.ok(current, 'AATU 연어 not found')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,units_per_sale,display_rank',
    product_id: `eq.${current.product_id}`, order: 'display_rank.asc,variant_id.asc', limit: 100,
  })
  const sku = variants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? ''))
  assert.ok(sku, 'AATU 연어 1 kg SKU not found')
  const eligible = products.filter((row) => row.product_id !== current.product_id)
  const byBrand = new Map()
  for (const row of eligible) {
    const list = byBrand.get(row.brand) ?? []
    list.push(row); byBrand.set(row.brand, list)
  }
  const sameBrandEntry = [...byBrand.entries()].filter(([, rows]) => rows.length >= 2).sort((a,b)=>a[0].localeCompare(b[0],'ko-KR'))[0]
  assert.ok(sameBrandEntry, 'same-brand pair unavailable')
  const sameBrandTwo = sameBrandEntry[1].slice(0,2)
  const longestSorted = [...eligible].sort((a,b)=>b.canonical_name.length-a.canonical_name.length || a.canonical_name.localeCompare(b.canonical_name,'ko-KR'))
  const longest = longestSorted[0]
  const unknown = eligible.find((row)=>row.product_id!==longest.product_id && (!row.feed_type || !row.life_stage || !(row.manufacturing_country_codes?.length)))
  assert.ok(longest && unknown, 'longest/unknown unavailable')
  const five=[unknown]
  for(const row of longestSorted.slice(1)){
    if(row.product_id===unknown.product_id) continue
    if(!five.some((item)=>item.product_id===row.product_id)) five.push(row)
    if(five.length===4) break
  }
  five.push(longest)
  assert.equal(five.length,5); assert.equal(new Set(five.map(r=>r.product_id)).size,5)
  return { current, sku, sameBrand:sameBrandEntry[0], sameBrandTwo, five, longestId:longest.product_id, unknownId:unknown.product_id }
}

class Browser {
  constructor(wsUrl){this.wsUrl=wsUrl;this.ws=null;this.id=1;this.pending=new Map();this.requests=[]}
  async connect(){
    this.ws=new WebSocket(this.wsUrl)
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('websocket timeout')),15000);this.ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});this.ws.addEventListener('error',reject,{once:true})})
    this.ws.addEventListener('message',(event)=>{const m=JSON.parse(event.data);if(m.method==='Network.requestWillBeSent')this.requests.push({url:m.params.request.url,method:m.params.request.method});if(!m.id)return;const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)})
    for(const domain of ['Page.enable','Runtime.enable','Network.enable']) await this.send(domain)
    await this.send('Emulation.setLocaleOverride',{locale:'ko-KR'})
    await this.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const nativeFetch=window.fetch.bind(window);window.__qaBlocked={analytics:0,writes:0};window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}return nativeFetch(input,init)}})();`})
  }
  send(method,params={}){const id=this.id++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value}
  async wait(expression,label,timeout=40000){const end=Date.now()+timeout;while(Date.now()<end){if(await this.eval(`Boolean(${expression})`).catch(()=>false))return;await sleep(100)}throw new Error(`timeout: ${label}`)}
  async nav(url){await this.send('Page.navigate',{url});await this.wait(`document.readyState==='complete'`,'document ready');await this.wait(`document.querySelector('#root')&&document.body.innerText.length`,'root');await this.eval('document.fonts?.ready');await sleep(250)}
  async shot(name){await this.eval('document.fonts?.ready');await sleep(100);const r=await this.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(`${OUT}/${name}`,Buffer.from(r.data,'base64'))}
  close(){try{this.ws?.close()}catch{}}
}

let launchNo=0
async function launch(width,height){
  const chrome='/usr/bin/google-chrome';assert.ok(existsSync(chrome),'Chrome unavailable')
  const port=14100+(process.pid%80)+launchNo++*40,dir=`/tmp/pr39-compare-readability-v2-${process.pid}-${launchNo}`
  rmSync(dir,{recursive:true,force:true})
  const proc=spawn(chrome,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'})
  for(let i=0;i<200;i++){
    try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),page=pages.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(!page)throw new Error('no page');const browser=new Browser(page.webSocketDebuggerUrl);await browser.connect();await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:height});await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});await browser.send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',acceptLanguage:'ko-KR,ko;q=0.9,en;q=0.8',platform:'Android'});return{browser,proc,dir}}
    catch{}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}
async function cleanup(h){h.browser.close();h.proc.kill('SIGTERM');await sleep(100);if(h.proc.exitCode==null)h.proc.kill('SIGKILL');try{rmSync(h.dir,{recursive:true,force:true})}catch{}}

async function state(c){return c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`)}
async function pressKey(c,key,code,keyCode,text=''){const p={key,code,windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode,...(text?{text,unmodifiedText:text}:{})};await c.send('Input.dispatchKeyEvent',{type:'keyDown',...p});await c.send('Input.dispatchKeyEvent',{type:'keyUp',...p});await sleep(80)}
async function pressTab(c){await pressKey(c,'Tab','Tab',9)}

async function trustedPointerClick(c,selector,matcher=null){
  const t=await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${q(selector)})];const n=${matcher?`nodes.find(el=>el.textContent.includes(${q(matcher)}))`:'nodes[0]'};if(!n)return null;n.scrollIntoView({block:'center',inline:'nearest'});const r=n.getBoundingClientRect(),x=Math.max(2,Math.min(innerWidth-2,r.left+r.width/2)),y=Math.max(2,Math.min(innerHeight-2,r.top+r.height/2)),hit=document.elementFromPoint(x,y);if(!hit||!(hit===n||n.contains(hit)))return{blocked:true,hit:hit?.tagName||null,hitClass:hit?.className||'',rect:{left:r.left,top:r.top,width:r.width,height:r.height}};window.__qaTrustedPointer=[];for(const type of ['pointerdown','pointerup','click'])n.addEventListener(type,e=>window.__qaTrustedPointer.push({type,isTrusted:e.isTrusted}),{once:true,capture:true});return{x,y,text:n.textContent.trim(),rect:{left:r.left,top:r.top,width:r.width,height:r.height}}})()`)
  assert.ok(t,`missing pointer target ${selector} ${matcher??''}`);assert.ok(!t.blocked,`blocked pointer target ${JSON.stringify(t)}`)
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:t.x,y:t.y,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:t.x,y:t.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:t.x,y:t.y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});await sleep(150)
  const events=await c.eval('window.__qaTrustedPointer');assert.ok(events?.some(e=>e.type==='click'&&e.isTrusted),`trusted click missing ${selector}`);return{...t,events}
}
async function typeSearch(c,text){await trustedPointerClick(c,'.switch-find-search input');await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,nativeVirtualKeyCode:17,modifiers:2});await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,nativeVirtualKeyCode:65,modifiers:2});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,nativeVirtualKeyCode:65,modifiers:2});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,nativeVirtualKeyCode:17});await c.send('Input.insertText',{text});await c.wait(`document.querySelector('.switch-find-search input')?.value===${q(text)}`,'search input');await sleep(200)}

async function establishResults(c,ctx){
  await c.nav(`${BASE}?view=workspace&mode=switch`);await c.wait(`document.querySelector('.switch-find-search input')`,'switch search');await c.wait(`!document.body.innerText.includes('제품 목록을 불러오는 중입니다.')`,'catalog loaded');await typeSearch(c,`${ctx.current.brand} ${ctx.current.canonical_name}`);await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes(${q(ctx.current.canonical_name)}))`,'current result');await trustedPointerClick(c,'.switch-find-result',ctx.current.canonical_name);await c.wait(`document.querySelector('.switch-current-preview')`,'preview');await trustedPointerClick(c,'.switch-current-preview .switch-primary-action');await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`,'sku options',30000);await trustedPointerClick(c,'.switch-sku-option','1 kg');await trustedPointerClick(c,'.switch-step-actions .switch-primary-action');await c.wait(`document.querySelector('.switch-no-change')`,'CHANGE');await trustedPointerClick(c,'.switch-no-change');await trustedPointerClick(c,'.switch-step-actions .switch-primary-action');await c.wait(`document.querySelector('.switch-current-facts-strip')`,'KEEP');await trustedPointerClick(c,'.switch-step-actions .switch-primary-action');await c.wait(`document.querySelector('.switch-results-stage')`,'results');await c.wait(`document.querySelectorAll('.switch-candidate-row').length>0`,'candidate rows');const s=await state(c);assert.equal(s.currentProductId,ctx.current.product_id);assert.equal(s.variantSelection.variantId,ctx.sku.variant_id);assert.equal(s.noChangeIntent,true);assert.deepEqual(s.compareIds,[]);return s
}
async function ensureCandidateVisible(c,p){for(let i=0;i<30;i++){if(await c.eval(`[...document.querySelectorAll('.switch-candidate-row')].some(n=>n.querySelector('.switch-candidate-identity strong')?.textContent.trim()===${q(p.canonical_name)}&&n.textContent.includes(${q(p.brand)}))`))return;if(!await c.eval(`Boolean(document.querySelector('.load-more'))`))throw new Error(`candidate not found: ${p.brand} ${p.canonical_name}`);await trustedPointerClick(c,'.load-more')}throw new Error(`candidate load limit: ${p.canonical_name}`)}
async function clickCandidateRow(c,p){const t=await c.eval(`(()=>{const n=[...document.querySelectorAll('.switch-candidate-row')].find(n=>n.querySelector('.switch-candidate-identity strong')?.textContent.trim()===${q(p.canonical_name)}&&n.textContent.includes(${q(p.brand)}));if(!n)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);assert.ok(t);await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:t.x,y:t.y,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:t.x,y:t.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:t.x,y:t.y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});await sleep(150)}
async function addCandidate(c,p){await ensureCandidateVisible(c,p);await clickCandidateRow(c,p);await c.wait(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()===${q(p.canonical_name)}`,'inspector target');const before=await state(c);await trustedPointerClick(c,'.switch-inspector-actions .switch-compare-action','비교에 추가');await c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});if(!raw)return false;return JSON.parse(raw).state.compareIds.length===${before.compareIds.length+1}})()`,'compare add');const after=await state(c);assert.equal(after.compareIds.at(-1),p.product_id);await trustedPointerClick(c,'.switch-preview-topline button');return p.product_id}
async function openCompare(c,ids){assert.deepEqual((await state(c)).compareIds,ids);await trustedPointerClick(c,'.switch-compare-dock > button');await c.wait(`document.querySelector('.compare-stage')`,'compare');await c.wait(`getComputedStyle(document.querySelector('.compare-switch-mobile-overview')).display!=='none'`,'mobile overview');await c.wait(`document.querySelector('.compare-mobile-product-head.is-current')?.textContent.includes('사용 규격 · 1 kg')`,'current SKU')}

async function pickerMetrics(c){return c.eval(`(()=>{const scroller=document.querySelector('.compare-mobile-candidate-picker > div'),buttons=[...scroller.querySelectorAll('button')],sr=scroller.getBoundingClientRect();const info=(b,i)=>{const r=b.getBoundingClientRect(),s=getComputedStyle(b);return{index:i,productId:b.dataset.productId,text:b.textContent.trim(),ariaPressed:b.getAttribute('aria-pressed'),left:r.left,right:r.right,width:r.width,fullyVisible:r.left>=sr.left&&r.right<=sr.right,clientWidth:b.clientWidth,scrollWidth:b.scrollWidth,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace}};return{label:document.querySelector('.compare-mobile-candidate-picker > span')?.textContent.trim(),clientWidth:scroller.clientWidth,scrollWidth:scroller.scrollWidth,scrollLeft:scroller.scrollLeft,maxScroll:scroller.scrollWidth-scroller.clientWidth,overflowX:getComputedStyle(scroller).overflowX,buttons:buttons.map(info),fullyVisibleCount:buttons.filter(b=>{const r=b.getBoundingClientRect();return r.left>=sr.left&&r.right<=sr.right}).length}})()`)}

async function readabilityMetrics(c){return c.eval(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};const style=n=>{if(!n)return null;const s=getComputedStyle(n);return{text:n.textContent.trim().replace(/\\s+/g,' '),fontSize:s.fontSize,lineHeight:s.lineHeight,color:s.color,fontWeight:s.fontWeight,textOverflow:s.textOverflow,overflow:s.overflow,whiteSpace:s.whiteSpace,wordBreak:s.wordBreak,overflowWrap:s.overflowWrap,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,rect:rect(n)}};const heads=[...document.querySelectorAll('.compare-mobile-product-head')],current=heads.find(n=>n.classList.contains('is-current')),candidate=heads.find(n=>n.classList.contains('is-candidate')),currentSmalls=current?[...current.querySelectorAll(':scope > small')]:[],candidateSmalls=candidate?[...candidate.querySelectorAll(':scope > small')]:[],rows=[...document.querySelectorAll('.compare-mobile-overview-row')],unknownCell=[...document.querySelectorAll('.compare-mobile-pair > div > div')].find(n=>/미확인|확인된 값 없음|공식 표기 미확인/.test(n.textContent)),header=document.querySelector('.compare-header'),scope=document.querySelector('.compare-scope-note'),tabs=document.querySelector('.compare-tabs'),picker=document.querySelector('.compare-mobile-candidate-picker'),headGrid=document.querySelector('.compare-mobile-head-grid'),firstRow=rows[0],headRects=heads.map(rect);return{viewport:{width:innerWidth,height:innerHeight,scrollY,docClientWidth:document.documentElement.clientWidth,docScrollWidth:document.documentElement.scrollWidth,horizontalOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth},textStyles:{pickerLabel:style(document.querySelector('.compare-mobile-candidate-picker > span')),activePickerButton:style(document.querySelector('.compare-mobile-candidate-picker button[aria-pressed="true"]')),currentRole:style(current?.querySelector(':scope > span')),currentBrand:style(current?.querySelector('.compare-mobile-product-brand')),currentName:style(current?.querySelector(':scope > strong')),currentUsage:style(currentSmalls[1]),currentSale:style(currentSmalls[2]),candidateBrand:style(candidate?.querySelector('.compare-mobile-product-brand')),candidateName:style(candidate?.querySelector(':scope > strong')),candidateSale:style(candidateSmalls[1]),rowLabel:style(document.querySelector('.compare-mobile-row-label')),currentValue:style(document.querySelector('.compare-mobile-pair > div:first-child > div')),candidateValue:style(document.querySelector('.compare-mobile-pair > div:last-child > div')),unknownValue:style(unknownCell)},layout:{compareHeader:header?rect(header):null,scopeNote:scope?rect(scope):null,tabs:tabs?rect(tabs):null,picker:picker?rect(picker):null,headGrid:headGrid?rect(headGrid):null,firstRow:firstRow?rect(firstRow):null,firstRowTop:firstRow?.getBoundingClientRect().top??null,fullyVisibleRows:rows.filter(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}).length,intersectingRows:rows.filter(n=>{const r=n.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).length,totalRows:rows.length,pairOverlap:headRects.length===2?Math.max(0,headRects[0].right-headRects[1].left):null},rowLabels:rows.map(n=>n.querySelector('.compare-mobile-row-label')?.textContent.trim()),clipping:{currentName:style(current?.querySelector(':scope > strong')),candidateName:style(candidate?.querySelector(':scope > strong')),valueCells:[...document.querySelectorAll('.compare-mobile-pair > div > div')].map(style)}}})()`)}

async function touchSwipeTowardLast(c,max=12){
  const start=await pickerMetrics(c),steps=[]
  for(let attempt=0;attempt<max;attempt++){
    const m=await pickerMetrics(c),last=m.buttons.at(-1);if(last?.fullyVisible)return{supported:true,start,steps,final:m,lastVisible:true}
    const box=await c.eval(`(()=>{const n=document.querySelector('.compare-mobile-candidate-picker > div'),r=n.getBoundingClientRect();return{left:r.left,right:r.right,y:r.top+r.height/2}})()`)
    const y=box.y,x0=box.right-18,x1=box.left+18
    await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x0,y,radiusX:2,radiusY:2,force:1,id:1}]})
    for(let i=1;i<=5;i++){const x=x0+(x1-x0)*(i/5);await c.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y,radiusX:2,radiusY:2,force:1,id:1}]});await sleep(20)}
    await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(180)
    const after=await pickerMetrics(c);steps.push(after.scrollLeft)
    if(after.scrollLeft===m.scrollLeft)break
  }
  const final=await pickerMetrics(c);return{supported:final.scrollLeft>start.scrollLeft,start,steps,final,lastVisible:final.buttons.at(-1)?.fullyVisible??false}
}

async function pointerClickPicker(c,index){const m=await pickerMetrics(c),target=m.buttons[index];assert.ok(target);assert.equal(target.fullyVisible,true,`picker ${index} not visible`);const point=await c.eval(`(()=>{const b=document.querySelectorAll('.compare-mobile-candidate-picker button')[${index}],r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);if(!b||!hit||!(hit===b||b.contains(hit)))return null;window.__qaPickerPointer=null;b.addEventListener('click',e=>window.__qaPickerPointer=e.isTrusted,{once:true,capture:true});return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);assert.ok(point);await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});await sleep(140);assert.equal(await c.eval('window.__qaPickerPointer'),true);assert.equal(await c.eval(`document.querySelectorAll('.compare-mobile-candidate-picker button')[${index}]?.getAttribute('aria-pressed')`),'true');return{index,picker:await pickerMetrics(c)}}

async function keyboardToLast(c){
  const count=await c.eval(`document.querySelectorAll('.compare-mobile-candidate-picker button').length`)
  assert.ok(count>1)
  const first=await c.eval(`(()=>{const b=document.querySelector('.compare-mobile-candidate-picker button');b.scrollIntoView({block:'center',inline:'nearest'});const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:first.x,y:first.y,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:first.x,y:first.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:first.x,y:first.y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});await sleep(100)
  let active=await c.eval(`document.activeElement===document.querySelector('.compare-mobile-candidate-picker button')`)
  if(!active){await c.eval(`document.querySelector('.compare-mobile-candidate-picker button').focus()`)}
  let tabs=0
  for(let i=1;i<count;i++){await pressTab(c);tabs++;const idx=await c.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].indexOf(document.activeElement)`);if(idx===count-1)break}
  const idx=await c.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].indexOf(document.activeElement)`);assert.equal(idx,count-1,'Tab did not reach last candidate')
  const beforeEnter=await pickerMetrics(c)
  await c.eval(`(()=>{const a=document.activeElement;window.__qaPickerKey=null;a.addEventListener('keydown',e=>window.__qaPickerKey={key:e.key,isTrusted:e.isTrusted},{once:true,capture:true})})()`);await pressKey(c,'Enter','Enter',13,'\r');const key=await c.eval('window.__qaPickerKey');assert.equal(key?.isTrusted,true);assert.equal(key?.key,'Enter');assert.equal(await c.eval(`document.querySelectorAll('.compare-mobile-candidate-picker button')[${count-1}]?.getAttribute('aria-pressed')`),'true');return{tabs,key,beforeEnter,afterEnter:await pickerMetrics(c)}
}

function stableState(s){return{currentProductId:s.currentProductId,variantSelection:s.variantSelection,compareIds:s.compareIds,compareOpen:s.compareOpen,compareTab:s.compareTab}}
async function networkReport(c){const writes=c.requests.filter(r=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(r.method)),analytics=c.requests.filter(r=>r.url.includes('/functions/v1/decision-intake')),nonRead=c.requests.filter(r=>!['GET','HEAD','OPTIONS'].includes(r.method)),blocked=await c.eval('window.__qaBlocked');assert.equal(writes.length,0);assert.equal(analytics.length,0);assert.equal(nonRead.length,0);assert.deepEqual(blocked,{analytics:0,writes:0});return{writes:0,analytics:0,nonRead:0,gets:c.requests.filter(r=>r.method==='GET').length,blocked}}

async function scenario360(ctx){const h=await launch(360,844),c=h.browser,result={viewport:'360x844',targets:ctx.sameBrandTwo};try{await establishResults(c,ctx);for(const p of ctx.sameBrandTwo)await addCandidate(c,p);await openCompare(c,ctx.sameBrandTwo.map(p=>p.product_id));result.initialState=stableState(await state(c));result.initialPicker=await pickerMetrics(c);result.initialReadability=await readabilityMetrics(c);await c.shot('360-compare-initial.png');assert.equal(result.initialPicker.buttons.length,2);assert.equal(result.initialPicker.buttons.filter(b=>b.ariaPressed==='true').length,1);result.touchSwipe=await touchSwipeTowardLast(c);if(result.touchSwipe.lastVisible){result.pointerLast=await pointerClickPicker(c,1)}else{result.keyboardLast=await keyboardToLast(c);result.pointerLast=await pointerClickPicker(c,1)}result.afterState=stableState(await state(c));assert.deepEqual(result.afterState,result.initialState);result.secondReadability=await readabilityMetrics(c);await c.shot('360-compare-second-candidate.png');if(!result.keyboardLast){await pointerClickPicker(c,0);result.keyboardLast=await keyboardToLast(c);assert.deepEqual(stableState(await state(c)),result.initialState)}result.network=await networkReport(c)}finally{await cleanup(h)}return result}

async function scenario390(ctx){const h=await launch(390,900),c=h.browser,result={viewport:'390x900',targets:ctx.five};try{await establishResults(c,ctx);for(const p of ctx.five)await addCandidate(c,p);await openCompare(c,ctx.five.map(p=>p.product_id));result.initialState=stableState(await state(c));result.initialPicker=await pickerMetrics(c);result.initialReadability=await readabilityMetrics(c);await c.shot('390-compare-initial.png');assert.equal(result.initialPicker.buttons.length,5);const unknownIndex=ctx.five.findIndex(p=>p.product_id===ctx.unknownId);assert.equal(unknownIndex,0);await pointerClickPicker(c,unknownIndex);result.unknownReadability=await readabilityMetrics(c);assert.ok(result.unknownReadability.textStyles.unknownValue,'unknown display missing');result.touchSwipe=await touchSwipeTowardLast(c);if(result.touchSwipe.lastVisible){result.pointerLast=await pointerClickPicker(c,4)}else{result.keyboardLast=await keyboardToLast(c);result.pointerLast=await pointerClickPicker(c,4)}if(!result.keyboardLast){await pointerClickPicker(c,0);result.keyboardLast=await keyboardToLast(c)}result.afterState=stableState(await state(c));assert.deepEqual(result.afterState,result.initialState);result.finalPicker=await pickerMetrics(c);result.finalReadability=await readabilityMetrics(c);assert.equal(ctx.five[4].product_id,ctx.longestId);const name=result.finalReadability.textStyles.candidateName;assert.equal(name.text,ctx.five[4].canonical_name);assert.notEqual(name.textOverflow,'ellipsis');assert.ok(name.scrollWidth<=name.clientWidth+1);assert.ok(name.scrollHeight<=name.clientHeight+1);await c.shot('390-compare-last-candidate.png');result.network=await networkReport(c)}finally{await cleanup(h)}return result}

const context=await catalogContext()
const report={productSha:PRODUCT_SHA,page:BASE,chrome:execFileSync('/usr/bin/google-chrome',['--version'],{encoding:'utf8'}).trim(),context,status:'running'}
try{report.mobile360=await scenario360(context);report.mobile390=await scenario390(context);report.status='pass';writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2));console.log('PR39_COMPARE_READABILITY_PASS',JSON.stringify({current:{productId:context.current.product_id,variantId:context.sku.variant_id},sameBrand:context.sameBrand,two:context.sameBrandTwo.map(p=>({id:p.product_id,name:p.canonical_name})),five:context.five.map(p=>({id:p.product_id,brand:p.brand,name:p.canonical_name})),m360:{picker:report.mobile360.initialPicker,touchSwipe:report.mobile360.touchSwipe,keyboardLast:report.mobile360.keyboardLast,layout:report.mobile360.initialReadability.layout},m390:{picker:report.mobile390.initialPicker,touchSwipe:report.mobile390.touchSwipe,keyboardLast:report.mobile390.keyboardLast,layout:report.mobile390.initialReadability.layout,styles:report.mobile390.finalReadability.textStyles,unknown:report.mobile390.unknownReadability.textStyles.unknownValue}}))}catch(error){report.status='fail';report.error=String(error?.stack||error);writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2));throw error}
