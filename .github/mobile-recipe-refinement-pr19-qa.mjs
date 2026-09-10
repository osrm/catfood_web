import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'

const PREVIEW='http://127.0.0.1:4173/'
const PR_SHA='88bae394e1de166aceaa2c835a650889b69171f8'
const KEY='skipjack_tuna'
const LABEL='가다랑어(Skipjack tuna)'
const EXPECTED_IDS=[
  'product_1dbe295704557258',
  'product_b41eecd6fdc295e8',
  'product_c5aec16eea0cc24d',
  'product_c874d6b2acf9ea6b',
  'product_d99605a0a35f0fb7',
].sort()
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms))

class Cdp {
  constructor(url){this.url=url;this.ws=null;this.id=1;this.pending=new Map()}
  async connect(){this.ws=new WebSocket(this.url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('ws timeout')),15000);this.ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});this.ws.addEventListener('error',()=>reject(new Error('ws error')),{once:true})});this.ws.addEventListener('message',(event)=>{const msg=JSON.parse(event.data);if(!msg.id)return;const pending=this.pending.get(msg.id);if(!pending)return;this.pending.delete(msg.id);msg.error?pending.reject(new Error(msg.error.message)):pending.resolve(msg.result)});for(const method of ['Page.enable','Runtime.enable'])await this.send(method)}
  send(method,params={}){const id=this.id++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expression){const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value}
  async wait(expression,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){try{if(await this.eval(`Boolean(${expression})`))return}catch{}await sleep(120)}throw new Error(`timeout ${label}`)}
  async nav(url){await this.send('Page.navigate',{url});await this.wait(`document.readyState==='complete'`,'ready');await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`,'root')}
  async reload(){await this.send('Page.reload',{ignoreCache:true});await this.wait(`document.readyState==='complete'`,'reload ready');await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`,'reload root')}
  async viewport(width,height){await this.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<=390})}
  async shot(path){const result=await this.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(path,Buffer.from(result.data,'base64'))}
  close(){try{this.ws?.close()}catch{}}
}

async function launch(){const bin='/usr/bin/google-chrome';assert.ok(existsSync(bin));const version=execFileSync(bin,['--version'],{encoding:'utf8'}).trim();const port=9950+(process.pid%40);const dir=`/tmp/catfood-mobile-refine-${process.pid}`;rmSync(dir,{recursive:true,force:true});const proc=spawn(bin,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'});for(let i=0;i<220;i++){try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const page=pages.find((item)=>item.type==='page'&&item.webSocketDebuggerUrl);if(page)return{version,proc,dir,c:new Cdp(page.webSocketDebuggerUrl)}}catch{}await sleep(100)}throw new Error('chrome start timeout')}

const visibleExpr=(selector)=>`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth})()`
const renderedExpr=(selector)=>`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0})()`

async function pointerClick(c,selector,text=null){
  const point=await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const n=${text===null?'nodes[0]':`nodes.find((x)=>x.textContent?.trim().includes(${JSON.stringify(text)}))`};if(!n)return null;n.scrollIntoView({block:'center',inline:'nearest'});const r=n.getBoundingClientRect(),s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||r.width<=0||r.height<=0)return null;return{x:r.left+r.width/2,y:r.top+r.height/2,text:n.textContent?.trim()||''}})()`)
  assert.ok(point,`visible click target missing: ${text??selector}`)
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1})
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1})
  await sleep(180)
}
async function setInput(c,selector,value){const ok=await c.eval(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);assert.equal(ok,true,`input missing: ${selector}`);await sleep(220)}
async function scrollTop(c){await c.eval('window.scrollTo(0,0)');await sleep(120)}
async function resultIds(c){return JSON.parse(await c.eval(`JSON.stringify([...document.querySelectorAll('.research-result-card')].map((n)=>n.dataset.productId).filter(Boolean).sort())`))}
async function waitResults(c){await c.wait(`document.querySelectorAll('.research-result-card').length>0`,'results')}
async function reachAppliedResults(c,width){await c.viewport(width,width>=981?1000:900);await c.nav(PREVIEW+'?view=workspace');await c.wait(`[...document.querySelectorAll('.condition-actions button')].some((x)=>x.textContent?.includes('이 조건으로 찾기'))`,'condition action');await pointerClick(c,'.condition-actions button','이 조건으로 찾기');await c.wait(`new URLSearchParams(location.search).get('applied')==='1'`,'applied URL');await waitResults(c);await scrollTop(c)}
async function optionExists(c){return c.eval(`[...document.querySelectorAll('.recipe-detail-grid .choice')].some((x)=>x.textContent?.trim()===${JSON.stringify(LABEL)})`)}
async function panelState(c){return c.eval(`(()=>{const toggle=document.querySelector('.mobile-refine-entry button'),panel=document.getElementById('mobile-recipe-refine-panel'),results=document.querySelector('.research-results'),topbar=document.querySelector('.research-topbar'),nav=document.querySelector('.mode-nav'),criteria=document.querySelector('.criteria-bar');const rect=(n)=>n?(()=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}})():null;const visible=(n)=>{if(!n)return false;const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};return{url:location.href,toggleText:toggle?.textContent?.trim()||null,expanded:toggle?.getAttribute('aria-expanded')||null,controls:toggle?.getAttribute('aria-controls')||null,toggleVisible:visible(toggle),panelVisible:visible(panel),resultsVisible:visible(results),recipeSearchVisible:visible(document.querySelector('.recipe-search')),summaryVisible:visible(document.querySelector('.condition-summary')),summaryActionsVisible:visible(document.querySelector('.summary-actions')),activeClass:document.activeElement?.className||document.activeElement?.tagName||null,activeIsToggle:document.activeElement===toggle,activeIsRecipeSearch:document.activeElement===document.querySelector('.recipe-search'),topbar:rect(topbar),nav:rect(nav),criteria:rect(criteria),innerWidth,docWidth:document.documentElement.scrollWidth,panelCount:document.querySelectorAll('#mobile-recipe-refine-panel').length,recipeSearchCount:document.querySelectorAll('.recipe-search').length}})()`)}
async function assertShell(c,label){const s=await panelState(c);assert.equal(s.docWidth,s.innerWidth,`${label} horizontal overflow`);if(s.nav&&s.criteria){assert.ok(s.nav.bottom<=s.criteria.y+0.5,`${label} nav/criteria overlap`)}return s}

async function runMobile(c,width){
  const prefix=`candidate-${PR_SHA.slice(0,8)}-${width}`
  await reachAppliedResults(c,width)
  let state=await panelState(c)
  assert.equal(state.toggleVisible,true,`${width} mobile refine entry not visible`)
  assert.equal(state.toggleText,'더 좁혀보기',`${width} initial toggle text`)
  assert.equal(state.expanded,'false',`${width} initial aria-expanded`)
  assert.equal(state.controls,'mobile-recipe-refine-panel',`${width} aria-controls`)
  assert.equal(state.panelVisible,false,`${width} closed panel should be hidden`)
  assert.equal(state.resultsVisible,true,`${width} closed results should be visible`)
  await assertShell(c,`${width} closed`)
  await c.shot(`qa-artifacts/${prefix}-entry.png`)

  await pointerClick(c,'.mobile-refine-entry button','더 좁혀보기')
  await c.wait(`${visibleExpr('#mobile-recipe-refine-panel .recipe-search')}&&document.querySelector('.mobile-refine-entry button')?.getAttribute('aria-expanded')==='true'`,'mobile refine open')
  await scrollTop(c)
  state=await panelState(c)
  assert.equal(state.panelVisible,true,`${width} open panel invisible`)
  assert.equal(state.resultsVisible,false,`${width} results should yield to refine panel`)
  assert.equal(state.summaryVisible,false,`${width} duplicate condition summary visible`)
  assert.equal(state.summaryActionsVisible,false,`${width} duplicate condition action visible`)
  assert.equal(state.activeIsRecipeSearch,true,`${width} opening should focus recipe search`)

  for(const query of ['가다랑어',KEY]){
    await setInput(c,'.recipe-search',query)
    await c.wait(`${await optionExists(c) ? 'true' : `[...document.querySelectorAll('.recipe-detail-grid .choice')].some((x)=>x.textContent?.trim()===${JSON.stringify(LABEL)})`}`,'recipe option')
    assert.equal(await optionExists(c),true,`${width} query failed: ${query}`)
  }
  await scrollTop(c)
  await assertShell(c,`${width} open`)
  await c.shot(`qa-artifacts/${prefix}-open-search.png`)

  await pointerClick(c,'.recipe-detail-grid .choice',LABEL)
  await c.wait(`new URLSearchParams(location.search).get('recipeDetails')?.split(',').includes('${KEY}')`,'raw recipe key selected')
  await c.wait(`[...document.querySelectorAll('.selected-refinement')].some((x)=>x.textContent?.includes(${JSON.stringify(LABEL)}))`,'selected refinement chip')
  const selectedIds=await resultIds(c)
  assert.deepEqual(selectedIds,EXPECTED_IDS,`${width} selected product IDs changed`)

  await pointerClick(c,'.mobile-refine-entry button','목록으로 돌아가기')
  await c.wait(`document.querySelector('.mobile-refine-entry button')?.getAttribute('aria-expanded')==='false'&&${visibleExpr('.research-results')}`,'return to results')
  await scrollTop(c)
  state=await panelState(c)
  assert.equal(state.activeIsToggle,true,`${width} close should restore toggle focus`)
  assert.ok((await c.eval(`JSON.stringify([...document.querySelectorAll('.criteria-chips span')].map((x)=>x.textContent?.trim()))`)).includes(LABEL),`${width} selected criterion not visible`)
  await assertShell(c,`${width} selected results`)
  await c.shot(`qa-artifacts/${prefix}-selected-results.png`)

  await pointerClick(c,'.mobile-refine-entry button','더 좁혀보기')
  await c.wait(`${visibleExpr('.selected-refinement')}`,'reopen selected refinement')
  assert.ok((await c.eval(`document.querySelector('.selected-refinement')?.textContent||''`)).includes(LABEL),`${width} selection not preserved on reopen`)
  await pointerClick(c,'.selected-refinement',LABEL)
  await c.wait(`!new URLSearchParams(location.search).has('recipeDetails')`,'recipe deselected')
  assert.equal((await resultIds(c)).length>EXPECTED_IDS.length,true,`${width} deselect did not broaden results`)
  await pointerClick(c,'.mobile-refine-entry button','목록으로 돌아가기')
  await c.wait(`${visibleExpr('.research-results')}`,'results after deselect')
  await scrollTop(c)
  await c.shot(`qa-artifacts/${prefix}-deselected-results.png`)

  return{selectedIds}
}

async function testReloadAndBack(c){
  await reachAppliedResults(c,390)
  await pointerClick(c,'.mobile-refine-entry button','더 좁혀보기')
  await c.wait(`${visibleExpr('.recipe-search')}`,'reload flow open')
  await setInput(c,'.recipe-search','가다랑어')
  await c.wait(`[...document.querySelectorAll('.recipe-detail-grid .choice')].some((x)=>x.textContent?.trim()===${JSON.stringify(LABEL)})`,'reload choice')
  await pointerClick(c,'.recipe-detail-grid .choice',LABEL)
  await c.wait(`new URLSearchParams(location.search).get('recipeDetails')==='${KEY}'`,'reload selected URL')
  await pointerClick(c,'.mobile-refine-entry button','목록으로 돌아가기')
  const selectedUrl=await c.eval('location.href')
  await c.reload();await waitResults(c)
  assert.equal(await c.eval(`new URLSearchParams(location.search).get('recipeDetails')`),KEY,'reload lost raw key')
  assert.ok((await c.eval(`document.body.innerText`)).includes(LABEL),'reload lost Korean selected label')
  await pointerClick(c,'.mobile-refine-entry button','더 좁혀보기')
  await c.wait(`${visibleExpr('.selected-refinement')}`,'reload selected chip')
  await pointerClick(c,'.mobile-refine-entry button','목록으로 돌아가기')
  await pointerClick(c,'.research-result-card')
  await c.wait(`${visibleExpr('.research-quick-view')}`,'quick view')
  await pointerClick(c,'.quick-view-actions button','상세 보기')
  await c.wait(`new URLSearchParams(location.search).has('detail')`,'detail URL')
  await c.eval('history.back()')
  await c.wait(`!new URLSearchParams(location.search).has('detail')&&new URLSearchParams(location.search).get('recipeDetails')==='${KEY}'`,'back restores selected refine')
  assert.ok((await c.eval(`document.body.innerText`)).includes(LABEL),'back lost selected recipe label')
  return{selectedUrl,backUrl:await c.eval('location.href')}
}

async function testBreakpoints(c){
  const url=PREVIEW+`?view=workspace&applied=1&recipeDetails=${KEY}`
  await c.viewport(980,900);await c.nav(url);await waitResults(c);await scrollTop(c)
  let state=await panelState(c)
  assert.equal(state.toggleVisible,true,'980 mobile entry should be visible')
  assert.equal(state.panelVisible,false,'980 panel should be closed initially')
  await pointerClick(c,'.mobile-refine-entry button','더 좁혀보기')
  await c.wait(`${visibleExpr('.recipe-search')}`,'980 open')
  await scrollTop(c)
  await c.shot('qa-artifacts/candidate-breakpoint-980-open.png')
  await pointerClick(c,'.mobile-refine-entry button','목록으로 돌아가기')
  await c.wait(`document.querySelector('.mobile-refine-entry button')?.getAttribute('aria-expanded')==='false'`,'980 close')
  assert.equal((await panelState(c)).activeIsToggle,true,'980 toggle should own focus before resize')

  await c.viewport(981,900);await sleep(300)
  state=await panelState(c)
  assert.equal(state.toggleVisible,false,'981 mobile entry should be hidden')
  assert.equal(state.panelVisible,true,'981 desktop filter rail should be visible')
  assert.equal(state.resultsVisible,true,'981 results should coexist with desktop rail')
  assert.equal(state.panelCount,1,'981 duplicate filter panel')
  assert.equal(state.recipeSearchCount,1,'981 duplicate recipe search')
  assert.equal(state.activeIsRecipeSearch,true,'981 focus should move off hidden mobile toggle')
  await c.shot('qa-artifacts/candidate-breakpoint-981-desktop.png')

  await c.viewport(980,900);await sleep(300)
  state=await panelState(c)
  assert.equal(state.toggleVisible,true,'980 return entry hidden')
  assert.equal(state.expanded,'true','desktop-to-mobile with filter focus should keep panel accessible')
  assert.equal(state.panelVisible,true,'980 return panel hidden while focus remains inside')
  assert.equal(state.resultsVisible,false,'980 return should show one mobile refine surface')

  await c.viewport(1440,1000);await sleep(300);await scrollTop(c)
  state=await panelState(c)
  assert.equal(state.toggleVisible,false,'1440 mobile entry visible')
  assert.equal(state.panelVisible,true,'1440 desktop refine rail hidden')
  assert.equal(state.resultsVisible,true,'1440 results hidden')
  assert.equal(state.panelCount,1,'1440 duplicate panel')
  await setInput(c,'.recipe-search',KEY)
  await c.wait(`[...document.querySelectorAll('.recipe-detail-grid .choice')].some((x)=>x.textContent?.trim()===${JSON.stringify(LABEL)})`,'1440 recipe search')
  await scrollTop(c)
  await c.shot('qa-artifacts/candidate-desktop-1440-refine.png')
  return state
}

const {version,proc,dir,c}=await launch()
const report={browserVersion:version,qaHead:process.env.GITHUB_SHA??null,candidate:{sourceSha:PR_SHA,base:PREVIEW},rawKey:KEY,label:LABEL,reusedBaseline:{run:34479276361,productIds:EXPECTED_IDS,note:'Existing raw-key/Korean-search equivalence baseline; this candidate run verifies the new mobile access path does not change that set.'},checks:{}}
try{
  await c.connect()
  report.checks.mobile360=await runMobile(c,360)
  report.checks.mobile390=await runMobile(c,390)
  report.checks.reloadBack=await testReloadAndBack(c)
  report.checks.breakpoints=await testBreakpoints(c)
  writeFileSync('qa-artifacts/report.json',JSON.stringify(report,null,2))
  console.log('MOBILE_RECIPE_REFINEMENT_PR19 PASS')
}catch(error){
  let state=null
  try{state=await panelState(c);await c.shot('qa-artifacts/failure-current-screen.png')}catch{}
  writeFileSync('qa-artifacts/report.json',JSON.stringify({...report,failure:{error:String(error),state}},null,2))
  throw error
}finally{
  c.close();proc.kill('SIGTERM');await sleep(200);if(proc.exitCode==null)proc.kill('SIGKILL');rmSync(dir,{recursive:true,force:true})
}
