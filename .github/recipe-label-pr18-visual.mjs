import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'

const PROD='https://osrm.github.io/catfood_web/'
const PREVIEW='http://127.0.0.1:4173/'
const BASE_SHA='41346569f410d8caf9540f5e7be04a1de9847ec9'
const PR_SHA='1ff2d936f35b6f69e9dd25eec6318a2e169d40c7'
const EDIT='?view=workspace'
const KEY='skipjack_tuna'
const LABEL='가다랑어(Skipjack tuna)'
const BEFORE_LABEL='skipjack tuna'
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms))

class Cdp {
  constructor(url){this.url=url;this.ws=null;this.id=1;this.pending=new Map()}
  async connect(){this.ws=new WebSocket(this.url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('ws timeout')),15000);this.ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});this.ws.addEventListener('error',()=>reject(new Error('ws error')),{once:true})});this.ws.addEventListener('message',(event)=>{const msg=JSON.parse(event.data);if(!msg.id)return;const p=this.pending.get(msg.id);if(!p)return;this.pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result)});for(const method of ['Page.enable','Runtime.enable','Network.enable'])await this.send(method)}
  send(method,params={}){const id=this.id++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expression){const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value}
  async wait(expression,label,ms=60000){const end=Date.now()+ms;while(Date.now()<end){try{if(await this.eval(`Boolean(${expression})`))return}catch{}await sleep(120)}throw new Error(`timeout ${label}`)}
  async nav(url){await this.send('Page.navigate',{url});await this.wait(`document.readyState==='complete'`,'ready');await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`,'root')}
  async viewport(width,height){await this.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<800})}
  async shot(path){const result=await this.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(path,Buffer.from(result.data,'base64'))}
  close(){try{this.ws?.close()}catch{}}
}

async function launch(){const bin='/usr/bin/google-chrome';assert.ok(existsSync(bin));const version=execFileSync(bin,['--version'],{encoding:'utf8'}).trim();const port=9900+(process.pid%80);const dir=`/tmp/catfood-recipe-pr18-${process.pid}`;rmSync(dir,{recursive:true,force:true});const proc=spawn(bin,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'});for(let i=0;i<220;i++){try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const page=pages.find((item)=>item.type==='page'&&item.webSocketDebuggerUrl);if(page)return{version,proc,dir,c:new Cdp(page.webSocketDebuggerUrl)}}catch{}await sleep(120)}throw new Error('chrome start timeout')}

const renderedExpr=(selector)=>`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0})()`
const visibleExpr=(selector)=>`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth})()`
async function scrollToSelector(c,selector){await c.eval(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;n.scrollIntoView({block:'center',inline:'nearest'});return true})()`);await sleep(180)}
async function clickVisible(c,selector,text){await c.eval(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find((x)=>x.textContent?.trim().includes(${JSON.stringify(text)}));if(!n)return false;n.scrollIntoView({block:'center',inline:'nearest'});return true})()`);await sleep(180);const point=await c.eval(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find((x)=>x.textContent?.trim().includes(${JSON.stringify(text)}));if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect();if(s.display==='none'||s.visibility==='hidden'||r.width<=0||r.height<=0||r.bottom<=0||r.top>=innerHeight)return null;return{x:r.left+r.width/2,y:r.top+r.height/2,text:n.textContent.trim()}})()`);assert.ok(point,`visible control not found after scroll: ${text}`);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});await sleep(180)}
async function setSearch(c,value){await scrollToSelector(c,'.recipe-search');assert.equal(await c.eval(visibleExpr('.recipe-search')),true,'recipe search not visible after user scroll');await c.eval(`(()=>{const input=document.querySelector('.recipe-search');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await sleep(220)}
async function resultIds(c){return JSON.parse(await c.eval(`JSON.stringify([...document.querySelectorAll('.research-result-card')].map((node)=>node.dataset.productId).sort())`))}
async function screenState(c){return c.eval(`(()=>({url:location.href,scrollY,visibleText:document.body.innerText.slice(0,3500),recipeSearchRendered:${renderedExpr('.recipe-search')},recipeSearchVisible:${visibleExpr('.recipe-search')},conditionActionsRendered:${renderedExpr('.condition-actions')},conditionActionsVisible:${visibleExpr('.condition-actions')},criteriaButton:[...document.querySelectorAll('.criteria-bar button')].find((x)=>getComputedStyle(x).display!=='none')?.textContent?.trim()||null,innerWidth,docWidth:document.documentElement.scrollWidth}))()`)}

async function reachResults(c){
  await c.wait(`${renderedExpr('.condition-actions')}&&[...document.querySelectorAll('.condition-actions button')].some((x)=>x.textContent?.includes('이 조건으로 찾기'))`,'basic condition editor rendered')
  assert.equal(await c.eval(renderedExpr('.recipe-search')),false,'recipe refine must not be conflated with basic condition editor')
  await clickVisible(c,'.condition-actions button','이 조건으로 찾기')
  await c.wait(`new URLSearchParams(location.search).get('applied')==='1'`,'basic conditions applied')
  await c.wait(`document.querySelectorAll('.research-result-card').length>0`,'results after basic conditions')
  await sleep(250)
}

async function runCase(c,{base,width,prefix,query,label}){
  await c.viewport(width,width===1440?1000:900)
  await c.nav(base+EDIT)
  await reachResults(c)

  const refineRendered=await c.eval(renderedExpr('.recipe-search'))
  let refineVisible=false
  if(refineRendered){await scrollToSelector(c,'.recipe-search');refineVisible=await c.eval(visibleExpr('.recipe-search'))}
  const atResults=await screenState(c)

  if(!refineRendered||!refineVisible){
    await c.eval(`window.scrollTo(0,0)`);await sleep(120)
    await c.shot(`qa-artifacts/${prefix}-${width}-results-no-refine.png`)
    const editButtonRendered=Boolean(atResults.criteriaButton?.includes('조건 수정'))
    let afterEdit=null
    if(editButtonRendered){
      await clickVisible(c,'.criteria-bar button','조건 수정')
      await c.wait(`${renderedExpr('.condition-actions')}`,'condition editor after edit')
      afterEdit=await screenState(c)
      await c.shot(`qa-artifacts/${prefix}-${width}-condition-editor.png`)
    }
    return{accessible:false,atResults,editButtonRendered,afterEdit}
  }

  await setSearch(c,query)
  await c.wait(`[...document.querySelectorAll('.recipe-detail-grid .choice')].some((node)=>node.textContent?.trim()===${JSON.stringify(label)}&&${renderedExpr('.recipe-detail-grid .choice')})`,'recipe option rendered')
  const optionSelector='.recipe-detail-grid .choice'
  await c.eval(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(optionSelector)})].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});if(!n)return false;n.scrollIntoView({block:'center',inline:'nearest'});return true})()`);await sleep(160)
  const metric=await c.eval(`(()=>{const node=[...document.querySelectorAll('.recipe-detail-grid .choice')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});const style=getComputedStyle(node),r=node.getBoundingClientRect();return{text:node.textContent.trim(),visible:r.bottom>0&&r.top<innerHeight,rect:{x:r.x,y:r.y,width:r.width,height:r.height},clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,whiteSpace:style.whiteSpace,textOverflow:style.textOverflow,fontSize:style.fontSize}})()`)
  assert.equal(metric.visible,true,`${prefix}-${width} recipe option not visible after scroll`)
  assert.notEqual(metric.whiteSpace,'nowrap',`${prefix}-${width} nowrap`)
  assert.notEqual(metric.textOverflow,'ellipsis',`${prefix}-${width} ellipsis`)
  assert.ok(metric.scrollWidth<=metric.clientWidth+1,`${prefix}-${width} horizontal clipping`)
  await c.shot(`qa-artifacts/${prefix}-${width}-filter.png`)
  await clickVisible(c,optionSelector,label)
  await c.wait(`new URLSearchParams(location.search).get('recipeDetails')?.split(',').includes('${KEY}')`,'raw recipe key after immediate refinement')
  await c.wait(`[...document.querySelectorAll('.selected-refinement')].some((x)=>x.textContent?.replace('×','').trim()===${JSON.stringify(label)})`,'selected refinement')
  await c.wait(`document.querySelectorAll('.research-result-card').length>0`,'refined results')
  const ids=await resultIds(c)
  const resultState=await c.eval(`(()=>({url:location.href,criteria:[...document.querySelectorAll('.criteria-chips span')].map((x)=>x.textContent?.trim()),relations:[...document.querySelectorAll('.result-relations')].map((x)=>x.innerText.replace(/\\s+/g,' ').trim()).slice(0,5),innerWidth,docWidth:document.documentElement.scrollWidth}))()`)
  assert.ok(resultState.url.includes(`recipeDetails=${KEY}`),`${prefix}-${width} URL lost raw recipe key`)
  assert.ok(resultState.criteria.includes(label),`${prefix}-${width} criteria label missing`)
  assert.ok(resultState.relations.every((text)=>text.includes(label)),`${prefix}-${width} result relation label inconsistent`)
  assert.equal(resultState.docWidth,resultState.innerWidth,`${prefix}-${width} horizontal overflow`)
  await c.eval(`document.querySelector('.research-result-card')?.scrollIntoView({block:'start'})`);await sleep(160)
  await c.shot(`qa-artifacts/${prefix}-${width}-results.png`)
  return{accessible:true,ids,metric,resultState}
}

const {version,proc,dir,c}=await launch()
const report={browserVersion:version,qaHead:process.env.GITHUB_SHA??null,production:{sha:BASE_SHA,base:PROD},candidate:{sourceSha:PR_SHA,base:PREVIEW},key:KEY,label:LABEL,reusedEvidence:{run:34479276361,note:'Existing English/Korean search and product-ID equivalence evidence; this run only rechecks what changed with the corrected user flow.'},checks:{}}
try{
  await c.connect()
  for(const width of [390,1440]){
    const before=await runCase(c,{base:PROD,width,prefix:`before-prod-${BASE_SHA.slice(0,8)}`,query:KEY,label:BEFORE_LABEL})
    const after=await runCase(c,{base:PREVIEW,width,prefix:`after-pr-${PR_SHA.slice(0,8)}`,query:'가다랑어',label:LABEL})
    assert.equal(after.accessible,before.accessible,`translation PR unexpectedly changed refine accessibility at ${width}`)
    if(width===1440)assert.equal(after.accessible,true,'desktop recipe refine should be reachable')
    if(before.accessible&&after.accessible)assert.deepEqual(after.ids,before.ids,`product set changed at ${width}`)
    report.checks[width]={before,after}
  }
  writeFileSync('qa-artifacts/report.json',JSON.stringify(report,null,2));console.log('RECIPE_LABEL_PR18_USER_FLOW PASS')
}catch(error){
  let failureState=null
  try{failureState=await screenState(c);await c.shot('qa-artifacts/failure-current-screen.png')}catch{}
  writeFileSync('qa-artifacts/report.json',JSON.stringify({...report,failureState,error:String(error)},null,2));throw error
}finally{c.close();proc.kill('SIGTERM');await sleep(200);if(proc.exitCode==null)proc.kill('SIGKILL');rmSync(dir,{recursive:true,force:true})}
