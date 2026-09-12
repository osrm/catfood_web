import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE='https://osrm.github.io/catfood_web/'
const DEPLOY_SHA=process.env.DEPLOY_SHA
const EXPECTED_ASSET=process.env.EXPECTED_ASSET
const OUT='qa-artifacts'
const STORAGE_KEY='catfood.switch-session.v1'
const LONG_NAME='울트라 프로틴+ 스킨 & 코트 & 다이제스티브 캣 레시피'
mkdirSync(OUT,{recursive:true})
assert.ok(DEPLOY_SHA&&EXPECTED_ASSET)
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const js=v=>JSON.stringify(v)

class Cdp{
  constructor(url){this.url=url;this.ws=null;this.id=1;this.pending=new Map();this.requests=[]}
  async connect(){
    this.ws=new WebSocket(this.url)
    await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('ws timeout')),15000);this.ws.addEventListener('open',()=>{clearTimeout(t);r()},{once:true});this.ws.addEventListener('error',()=>j(new Error('ws error')),{once:true})})
    this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Network.requestWillBeSent')this.requests.push({url:m.params.request.url,method:m.params.request.method});const p=m.id?this.pending.get(m.id):null;if(!p)return;this.pending.delete(m.id);m.error?p.j(new Error(m.error.message)):p.r(m.result)})
    for(const x of ['Page.enable','Runtime.enable','DOM.enable','CSS.enable','Network.enable'])await this.send(x)
    await this.send('Emulation.setLocaleOverride',{locale:'ko-KR'})
    await this.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const nativeFetch=window.fetch.bind(window);window.__qaBlockedAnalytics=0;window.__qaBlockedWrites=0;window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1;return Promise.resolve(new Response(null,{status:204}))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1;return Promise.resolve(new Response(null,{status:204}))}return nativeFetch(input,init)}})();`})
  }
  send(method,params={}){const id=this.id++;return new Promise((r,j)=>{this.pending.set(id,{r,j});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expression){const x=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(x.exceptionDetails)throw new Error(x.exceptionDetails.exception?.description||x.exceptionDetails.text);return x.result?.value}
  async wait(expression,label,ms=40000){const end=Date.now()+ms;while(Date.now()<end){try{if(await this.eval(`Boolean(${expression})`))return}catch{}await sleep(120)}throw new Error(`timeout ${label}`)}
  async nav(url){await this.send('Page.navigate',{url});await this.wait(`document.readyState==='complete'`,'ready');await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`,'root');await this.eval('document.fonts?.ready');await sleep(250)}
  async shot(path){await this.eval('document.fonts?.ready');await sleep(100);const x=await this.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(path,Buffer.from(x.data,'base64'))}
  async fonts(selector){const {root}=await this.send('DOM.getDocument',{depth:1});const {nodeId}=await this.send('DOM.querySelector',{nodeId:root.nodeId,selector});assert.ok(nodeId,`font node missing ${selector}`);return (await this.send('CSS.getPlatformFontsForNode',{nodeId})).fonts??[]}
  close(){try{this.ws?.close()}catch{}}
}

async function launch(width,height){
  const chrome='/usr/bin/google-chrome';assert.ok(existsSync(chrome),'Chrome unavailable')
  const port=9800+(process.pid%70)+(width%23),dir=`/tmp/mobile-compare-${width}-${process.pid}`
  rmSync(dir,{recursive:true,force:true})
  const proc=spawn(chrome,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'})
  for(let i=0;i<200;i++){try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),p=pages.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p){const c=new Cdp(p.webSocketDebuggerUrl);await c.connect();await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenWidth:width,screenHeight:height});await c.send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',acceptLanguage:'ko-KR,ko;q=0.9,en;q=0.8',platform:'Android'});return{c,proc,dir,version:execFileSync(chrome,['--version'],{encoding:'utf8'}).trim()}}}catch{}await sleep(100)}
  throw new Error('chrome launch timeout')
}

const state= c=>c.eval(`(()=>{const r=sessionStorage.getItem(${js(STORAGE_KEY)});return r?JSON.parse(r).state:null})()`)
const waitState=(c,expr,label)=>c.wait(`(()=>{const r=sessionStorage.getItem(${js(STORAGE_KEY)});if(!r)return false;const s=JSON.parse(r).state;return ${expr}})()`,label)
async function setQuery(c,value){const ok=await c.eval(`(()=>{const e=document.querySelector('.switch-find-search input');if(!e)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${js(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);assert.equal(ok,true);await c.wait(`document.querySelector('.switch-find-search input')?.value===${js(value)}`,'query');await sleep(250)}
async function clickExact(c,scope,text){await c.wait(`(()=>{const r=document.querySelector(${js(scope)});return r&&[...r.querySelectorAll('button')].some(b=>b.textContent.trim()===${js(text)}&&!b.disabled)})()`,`button ${text}`);const ok=await c.eval(`(()=>{const r=document.querySelector(${js(scope)}),b=[...r.querySelectorAll('button')].find(x=>x.textContent.trim()===${js(text)}&&!x.disabled);if(!b)return false;b.scrollIntoView({block:'center',inline:'nearest'});b.click();return true})()`);assert.equal(ok,true);await sleep(180)}
async function clickContains(c,selector,text){await c.wait(`[...document.querySelectorAll(${js(selector)})].some(n=>n.textContent.includes(${js(text)}))`,`contains ${text}`);const ok=await c.eval(`(()=>{const n=[...document.querySelectorAll(${js(selector)})].find(x=>x.textContent.includes(${js(text)}));if(!n)return false;n.scrollIntoView({block:'center',inline:'nearest'});n.click();return true})()`);assert.equal(ok,true);await sleep(180)}
async function clickButtonContains(c,scope,text){await c.wait(`(()=>{const r=document.querySelector(${js(scope)});return r&&[...r.querySelectorAll('button')].some(b=>b.textContent.includes(${js(text)})&&!b.disabled)})()`,`button contains ${text}`);const info=await c.eval(`(()=>{const r=document.querySelector(${js(scope)}),b=[...r.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)})&&!x.disabled);b.scrollIntoView({block:'center',inline:'nearest'});const q=b.getBoundingClientRect(),x=Math.min(innerWidth-1,Math.max(0,q.left+q.width/2)),y=Math.min(innerHeight-1,Math.max(0,q.top+q.height/2)),hit=document.elementFromPoint(x,y);return{text:b.textContent.trim(),rect:[q.left,q.top,q.width,q.height],centerHit:hit===b||b.contains(hit)}})()`);const ok=await c.eval(`(()=>{const r=document.querySelector(${js(scope)}),b=[...r.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)})&&!x.disabled);if(!b)return false;b.click();return true})()`);assert.equal(ok,true);await sleep(180);return info}
async function capture(c,prefix,name,arr){const file=`${prefix}-${name}.png`;await c.shot(`${OUT}/${file}`);arr.push(file);return file}
function finding(result,kind,path,expected,actual){result.findings.push({kind,path,expected,actual})}

async function establishResults(c,result){
  await c.nav(`${BASE}?view=workspace&mode=switch`)
  await c.wait(`document.querySelector('.switch-find-search input')`,'switch search')
  await c.wait(`!document.body.innerText.includes('제품 목록을 불러오는 중입니다.')`,'catalog load')
  await setQuery(c,'AATU 연어')
  await c.wait(`document.querySelectorAll('.switch-find-result').length>0`,'AATU result')
  await clickContains(c,'.switch-find-result','연어');await c.wait(`document.querySelector('.switch-current-preview')`,'preview')
  await clickExact(c,'.switch-current-preview','이 제품을 현재 사료로 선택 →');await waitState(c,`s.step==='sku'`,'sku step')
  await c.wait(`document.querySelector('.switch-sku-option')&&!document.body.innerText.includes('판매 규격을 불러오는 중입니다.')`,'sku loaded')
  await clickContains(c,'.switch-sku-option','1 kg');await waitState(c,`s.variantSelection?.kind==='variant'`,'variant state')
  const picked=await state(c);result.current={productId:picked.currentProductId,variantId:picked.variantSelection.variantId}
  await clickExact(c,'.switch-step-actions','다음 →');await waitState(c,`s.step==='change'`,'change step')
  await clickExact(c,'.switch-step-main','다른 브랜드로 보기');await waitState(c,`s.changeBrand===true`,'change brand')
  await clickExact(c,'.switch-step-actions','다음 →');await waitState(c,`s.step==='keep'`,'keep step')
  await clickExact(c,'.switch-step-main','건식 유지');await waitState(c,`s.keep?.feedType==='건식'`,'keep dry')
  await clickExact(c,'.switch-step-actions','후보 제품 보기 →');await waitState(c,`s.step==='results'`,'results step')
  await c.wait(`document.querySelectorAll('.switch-candidate-row').length>=5`,'candidate rows')
  result.resultsInitial=await state(c)
}

async function addSelected(c,result){
  const before=await state(c),n=before.compareIds.length
  const info=await clickButtonContains(c,'.switch-inspector-actions','비교에 추가')
  await waitState(c,`s.compareIds.length===${n+1}`,'compare add')
  const after=await state(c);return{button:info,id:after.compareIds[after.compareIds.length-1]}
}
async function addCandidates(c,target,result){
  const added=[]
  await clickContains(c,'.switch-candidate-row',LONG_NAME);await c.wait(`document.querySelector('.switch-inspector h1')?.textContent.includes(${js(LONG_NAME)})`,'long inspector')
  added.push({name:LONG_NAME,...await addSelected(c,result)})
  const count=await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)
  for(let i=0;i<count&&added.length<target;i++){
    const row=await c.eval(`(()=>{const n=document.querySelectorAll('.switch-candidate-row')[${i}];return n?{name:n.querySelector('.switch-candidate-identity strong')?.textContent.trim()||'',text:n.textContent}:null})()`)
    if(!row||row.name===LONG_NAME)continue
    await c.eval(`(()=>{const n=document.querySelectorAll('.switch-candidate-row')[${i}];n.scrollIntoView({block:'center'});n.click();return true})()`);await sleep(150)
    const s=await state(c);if(s.compareIds.includes(s.selectedCandidateId))continue
    added.push({name:row.name,...await addSelected(c,result)})
  }
  assert.equal(added.length,target,`could not add ${target} candidates`)
  result.added=added;return added
}

async function tableMetrics(c){return c.eval(`(()=>{const w=document.querySelector('.compare-table-wrap'),t=document.querySelector('.compare-table'),heads=[...document.querySelectorAll('.compare-product-head')],names=[...document.querySelectorAll('.compare-product-copy>strong')],labels=[...document.querySelectorAll('.compare-row-label')];const info=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{text:n.textContent.trim().replace(/\\s+/g,' '),rect:[r.left,r.top,r.width,r.height],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,overflow:s.overflow,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace,position:s.position,zIndex:s.zIndex}};return{innerWidth,docWidth:document.documentElement.scrollWidth,scrollY,wrap:{clientWidth:w.clientWidth,scrollWidth:w.scrollWidth,scrollLeft:w.scrollLeft,maxScroll:w.scrollWidth-w.clientWidth,overflowX:getComputedStyle(w).overflowX},table:{clientWidth:t.clientWidth,scrollWidth:t.scrollWidth},heads:heads.map(info),names:names.map(info),labels:labels.map(info),corner:info(document.querySelector('.compare-corner'))}})()`)}
async function scrollTable(c,side){return c.eval(`(()=>{const w=document.querySelector('.compare-table-wrap');w.scrollLeft=${side==='right'?'w.scrollWidth-w.clientWidth':'0'};return{left:w.scrollLeft,max:w.scrollWidth-w.clientWidth}})()`)}
async function controlInfo(c,selector,index=0){return c.eval(`(()=>{const n=document.querySelectorAll(${js(selector)})[${index}];if(!n)return null;n.scrollIntoView({block:'center',inline:'center'});const r=n.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)),h=document.elementFromPoint(x,y);return{text:n.textContent.trim(),rect:[r.left,r.top,r.width,r.height],centerHit:h===n||n.contains(h),hit:h?.className||h?.tagName}})()`)}
async function clickSelector(c,selector,index=0){const info=await controlInfo(c,selector,index);assert.ok(info);const ok=await c.eval(`(()=>{const n=document.querySelectorAll(${js(selector)})[${index}];if(!n)return false;n.click();return true})()`);assert.equal(ok,true);await sleep(200);return info}
async function selectCompareTab(c,label,key){const info=await clickButtonContains(c,'.compare-tabs',label);await waitState(c,`s.compareTab===${js(key)}`,'tab state');if(key==='nutrition')await c.wait(`!document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&document.querySelector('.compare-row.is-metric')`,'nutrition loaded');if(key==='ingredients')await c.wait(`!document.body.innerText.includes('원재료 정보를 불러오는 중입니다.')&&document.querySelector('.compare-ingredient-text')`,'ingredients loaded');await sleep(250);return info}
async function contentMetrics(c){return c.eval(`(()=>{const cells=[...document.querySelectorAll('.compare-cell')],ings=[...document.querySelectorAll('.compare-ingredient-text')],metrics=[...document.querySelectorAll('.compare-row.is-metric .compare-cell')];const f=n=>({text:n.textContent.trim().replace(/\\s+/g,' '),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,overflow:getComputedStyle(n).overflow,overflowY:getComputedStyle(n).overflowY});return{cells:cells.map(f),ingredients:ings.map(f),metrics:metrics.map(f),tokens:[...new Set(cells.flatMap(n=>(n.textContent.match(/미확인|확인된 목록 없음|건물 기준 자료만 확인|다른 기준 자료만 확인|kcal\\/kg|kcal\\/100g|이상|이하|평균값|%/g)||[])))]}})()`)}
async function longestIngredient(c){return c.eval(`(()=>{const nodes=[...document.querySelectorAll('.compare-ingredient-text')];if(!nodes.length)return null;let n=nodes[0];for(const x of nodes)if(x.textContent.length>n.textContent.length)n=x;const cell=n.closest('.compare-cell'),row=n.closest('.compare-row'),all=[...row.querySelectorAll('.compare-cell')],index=all.indexOf(cell),w=document.querySelector('.compare-table-wrap');cell.scrollIntoView({block:'center',inline:'center'});const before={scrollTop:n.scrollTop,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,max:n.scrollHeight-n.clientHeight,overflowY:getComputedStyle(n).overflowY,text:n.textContent.trim().slice(0,500),column:index};n.scrollTop=n.scrollHeight;const heads=[...document.querySelectorAll('.compare-product-head')].map(h=>{const r=h.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight});const labels=[...document.querySelectorAll('.compare-row-label')].map(h=>{const r=h.getBoundingClientRect();return r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight});return{...before,afterScrollTop:n.scrollTop,wrapScrollLeft:w.scrollLeft,visibleProductHeaders:heads.filter(Boolean).length,visibleRowLabels:labels.filter(Boolean).length}})()`)}

async function inspectCompare(c,result,prefix,count){
  await clickButtonContains(c,'.switch-compare-dock','비교 보기');await waitState(c,`s.compareOpen===true&&s.compareIds.length===${count}`,'compare open');await c.wait(`document.querySelectorAll('.compare-product-head').length===${count}`,'compare heads')
  result.compareOpenState=await state(c);result.fonts=await c.fonts('.compare-product-copy>strong');assert.ok(result.fonts.some(x=>x.familyName.includes('Noto Sans CJK KR')),'Korean font mismatch')
  result.overviewLeft=await tableMetrics(c);await capture(c,prefix,'01-overview-left',result.captures)
  if(result.overviewLeft.docWidth>result.overviewLeft.innerWidth+1)finding(result,'document-overflow','비교 개요','문서 전체는 viewport 너비 안에 있고 표만 가로 스크롤','document '+result.overviewLeft.docWidth+' > viewport '+result.overviewLeft.innerWidth)
  if(result.overviewLeft.wrap.maxScroll<=0)finding(result,'table-scroll','비교 개요','표에 의도된 가로 스크롤이 존재','maxScroll='+result.overviewLeft.wrap.maxScroll)
  result.overviewRightScroll=await scrollTable(c,'right');await sleep(150);result.overviewRight=await tableMetrics(c);result.lastHeadControls={detail:await controlInfo(c,'.compare-detail-link',count-1),remove:await controlInfo(c,'.compare-remove',count-1)};await capture(c,prefix,'02-overview-right',result.captures)
  const last=result.overviewRight.heads.at(-1);if(!last||last.rect[0]>=result.overviewRight.innerWidth||last.rect[0]+last.rect[2]<=0)finding(result,'last-column','비교 개요 → 오른쪽 끝','마지막 제품 열에 도달 가능',JSON.stringify(last?.rect))
  if(!result.lastHeadControls.detail?.centerHit||!result.lastHeadControls.remove?.centerHit)finding(result,'control-occlusion','비교 오른쪽 끝','상세/제거 버튼 중심이 다른 요소에 가려지지 않음',JSON.stringify(result.lastHeadControls))
  if(result.overviewRight.names.some(n=>n.scrollWidth>n.clientWidth+1||n.scrollHeight>n.clientHeight+1))finding(result,'name-clipping','비교 제품 헤더','제품명 전체를 줄바꿈으로 읽을 수 있음','name box overflow detected')

  await selectCompareTab(c,'영양','nutrition');result.nutritionState=await state(c);result.nutrition=await contentMetrics(c);await scrollTable(c,'right');await capture(c,prefix,'03-nutrition-right',result.captures)
  await selectCompareTab(c,'원재료','ingredients');result.ingredientsState=await state(c);result.ingredients=await contentMetrics(c);await scrollTable(c,'right');await capture(c,prefix,'04-ingredients-right',result.captures)
  result.longIngredient=await longestIngredient(c);await sleep(150);await capture(c,prefix,'05-long-ingredient',result.captures)
  if(result.longIngredient&&result.longIngredient.max>0&&result.longIngredient.afterScrollTop<=0)finding(result,'ingredient-scroll','원재료 출처 원문','긴 원재료 원문 끝까지 내부 스크롤 가능',JSON.stringify(result.longIngredient))
  if(result.longIngredient&&result.longIngredient.visibleProductHeaders===0)finding(result,'column-context','긴 원재료 행','긴 행을 읽을 때 제품명과 열 대응을 계속 확인 가능','원재료 위치에서 제품 헤더가 viewport 밖에 있음')

  await scrollTable(c,'left');const beforeDetail=await state(c);result.detailButton=await clickSelector(c,'.compare-detail-link',0);await c.wait(`document.querySelector('.detail-stage')`,'detail stage');const detailState=await state(c);result.detailRoundTrip={before:{compareIds:beforeDetail.compareIds,compareTab:beforeDetail.compareTab},detail:{compareIds:detailState.compareIds,compareTab:detailState.compareTab,detailProductId:detailState.detailProductId}};await capture(c,prefix,'06-detail',result.captures)
  result.detailBackButton=await clickButtonContains(c,'.detail-topbar','돌아가기');await c.wait(`document.querySelector('.compare-stage')`,'compare return');await waitState(c,`s.compareOpen===true&&s.compareTab==='ingredients'`,'compare tab preserved');const afterDetail=await state(c);result.detailRoundTrip.after={compareIds:afterDetail.compareIds,compareTab:afterDetail.compareTab,detailProductId:afterDetail.detailProductId};await capture(c,prefix,'07-detail-return',result.captures)
  if(JSON.stringify(beforeDetail.compareIds)!==JSON.stringify(afterDetail.compareIds)||afterDetail.compareTab!=='ingredients')finding(result,'detail-preservation','비교 → 상세 → 비교','비교 제품과 원재료 탭 보존',JSON.stringify(result.detailRoundTrip))
}

async function removalFlow(c,result,prefix,initialCount,removeLast){
  await scrollTable(c,'left');const before=await state(c),removed=before.compareIds[0];result.removeOne={removed,before:[...before.compareIds],button:await clickSelector(c,'.compare-remove',0)};await waitState(c,`s.compareIds.length===${initialCount-1}`,'one removed');const oneAfter=await state(c);result.removeOne.after=[...oneAfter.compareIds];await capture(c,prefix,'08-after-remove-one',result.captures)
  if(oneAfter.compareIds.includes(removed))finding(result,'remove','비교 항목 제거','제거 ID가 즉시 사라짐',JSON.stringify(oneAfter.compareIds))
  result.listBackButton=await clickButtonContains(c,'.compare-header','제품 목록으로');await c.wait(`document.querySelector('.switch-results-stage')`,'results return');await waitState(c,`s.compareOpen===false&&s.compareIds.length===${initialCount-1}`,'results preserves compare');result.resultsAfterRemove=await state(c);await capture(c,prefix,'09-results-after-remove',result.captures)
  if(initialCount-1>0){await clickButtonContains(c,'.switch-compare-dock','비교 보기');await c.wait(`document.querySelector('.compare-stage')`,'compare reentry');await waitState(c,`s.compareIds.length===${initialCount-1}`,'reentry ids');result.reentry=await state(c);await capture(c,prefix,'10-compare-reentry',result.captures)}
  if(removeLast){
    assert.equal(initialCount-1,1,'last removal flow expects one item');const remaining=(await state(c)).compareIds[0];result.removeLast={removed:remaining,button:await clickSelector(c,'.compare-remove',0)};await c.wait(`document.querySelector('.switch-results-stage')`,'auto close empty compare');await waitState(c,`s.compareIds.length===0&&s.compareOpen===false`,'empty compare state');result.emptyAfterLast=await state(c);await capture(c,prefix,'11-after-last-remove',result.captures)
    await c.eval('history.back()');await sleep(500);result.afterBrowserBack=await state(c);result.afterBrowserBackStage=await c.eval(`document.querySelector('.compare-stage')?'compare':document.querySelector('.switch-results-stage')?'results':document.querySelector('.switch-step-stage')?'step':'other'`);await capture(c,prefix,'12-browser-back-after-empty',result.captures)
    if(result.afterBrowserBack?.compareIds?.length)finding(result,'browser-back-revival','마지막 비교 제거 → browser back','제거한 비교 제품이 되살아나지 않음',JSON.stringify(result.afterBrowserBack.compareIds))
  }else{
    await c.eval('history.back()');await sleep(500);result.afterBrowserBack=await state(c);result.afterBrowserBackStage=await c.eval(`document.querySelector('.compare-stage')?'compare':document.querySelector('.switch-results-stage')?'results':document.querySelector('.switch-step-stage')?'step':'other'`);await capture(c,prefix,'11-browser-back-after-reentry',result.captures)
    if(result.afterBrowserBack?.compareIds?.includes(removed))finding(result,'browser-back-revival','항목 제거 → 목록 복귀 → 비교 재진입 → browser back','제거 ID가 되살아나지 않음',JSON.stringify(result.afterBrowserBack.compareIds))
  }
}

async function runViewport(width,height,target){
  const prefix=`mobile-compare-${DEPLOY_SHA.slice(0,8)}-${width}x${height}`,result={viewport:{width,height},targetCount:target,captures:[],findings:[]}
  const {c,proc,dir,version}=await launch(width,height);result.browserVersion=version
  try{
    await establishResults(c,result);await addCandidates(c,target,result);result.compareIds=[...(await state(c)).compareIds]
    await capture(c,prefix,'00-results-with-compare',result.captures)
    await inspectCompare(c,result,prefix,target)
    await removalFlow(c,result,prefix,target,target===2)
    const sentAnalytics=c.requests.filter(r=>r.url.includes('/functions/v1/decision-intake'))
    const sentWrites=c.requests.filter(r=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(r.method))
    result.network={blocked:await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`),sentAnalytics,sentWrites,publicReads:c.requests.filter(r=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&r.method==='GET').length}
    assert.equal(sentAnalytics.length,0,'analytics escaped interceptor');assert.equal(sentWrites.length,0,'production write escaped interceptor')
    return result
  }finally{c.close();proc.kill('SIGTERM');await sleep(200);if(proc.exitCode==null)proc.kill('SIGKILL');rmSync(dir,{recursive:true,force:true})}
}

const report={deploySha:DEPLOY_SHA,expectedAsset:EXPECTED_ASSET,environment:{kind:'hosted headless Chrome mobile emulation; not a physical device',locale:'ko-KR',viewports:['360x844','390x900']},status:'running',viewports:[],findings:[]}
const save=()=>writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))
try{
  const html=await(await fetch(BASE,{cache:'no-store'})).text();assert.ok(html.includes(EXPECTED_ASSET),`live asset mismatch: ${EXPECTED_ASSET}`)
  report.viewports.push(await runViewport(360,844,2));save();report.viewports.push(await runViewport(390,900,5));report.findings=report.viewports.flatMap(v=>v.findings.map(f=>({viewport:`${v.viewport.width}x${v.viewport.height}`,...f})));report.status='pass';save()
}catch(e){report.status='fail';report.error=String(e?.stack||e);save();throw e}
console.log('MOBILE_COMPARE_POSTDEPLOY_PASS '+JSON.stringify({deploySha:report.deploySha,status:report.status,viewports:report.viewports.map(v=>({viewport:v.viewport,compareIds:v.compareIds,findings:v.findings.length,docWidth:v.overviewLeft?.docWidth,tableMaxScroll:v.overviewLeft?.wrap?.maxScroll,longIngredient:v.longIngredient&&{max:v.longIngredient.max,headers:v.longIngredient.visibleProductHeaders},network:v.network})),findings:report.findings}))
