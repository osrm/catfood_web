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

async function setSearch(c,value){await c.eval(`(()=>{const input=document.querySelector('.recipe-search');if(!input)return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await sleep(220)}
async function waitEditor(c){await c.wait(`document.querySelector('.recipe-search')&&document.querySelector('.condition-actions')`,'condition editor');await sleep(220)}
async function resultIds(c){return JSON.parse(await c.eval(`JSON.stringify([...document.querySelectorAll('.research-result-card')].map((node)=>node.dataset.productId).sort())`))}
async function apply(c){await c.eval(`(()=>{const b=[...document.querySelectorAll('.condition-actions button')].find((x)=>x.textContent?.includes('조건 적용'));if(!b)return false;b.click();return true})()`);await c.wait(`new URLSearchParams(location.search).get('applied')==='1'`,'conditions applied');await c.wait(`document.querySelectorAll('.research-result-card').length>0`,'filtered results');await sleep(300)}

async function runCase(c,{base,width,prefix,query,label,capture}){
  await c.viewport(width,width===1440?1000:900)
  await c.nav(base+EDIT)
  await waitEditor(c)
  await setSearch(c,query)
  await c.wait(`[...document.querySelectorAll('.recipe-detail-grid .choice')].some((node)=>node.textContent?.trim()===${JSON.stringify(label)})`,'recipe option')
  const metric=await c.eval(`(()=>{const node=[...document.querySelectorAll('.recipe-detail-grid .choice')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});const style=getComputedStyle(node);const r=node.getBoundingClientRect();return{text:node.textContent.trim(),rect:{x:r.x,y:r.y,width:r.width,height:r.height},clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,whiteSpace:style.whiteSpace,textOverflow:style.textOverflow,fontSize:style.fontSize}})()`)
  assert.ok(metric.rect.width>0&&metric.rect.height>0,`${prefix}-${width} recipe option not laid out`)
  assert.notEqual(metric.whiteSpace,'nowrap',`${prefix}-${width} nowrap`)
  assert.notEqual(metric.textOverflow,'ellipsis',`${prefix}-${width} ellipsis`)
  assert.ok(metric.scrollWidth<=metric.clientWidth+1,`${prefix}-${width} horizontal clipping`)
  await c.eval(`document.querySelector('.recipe-search')?.scrollIntoView({block:'center'})`);await sleep(120)
  if(capture)await c.shot(`qa-artifacts/${prefix}-${width}-filter.png`)
  await c.eval(`(()=>{const node=[...document.querySelectorAll('.recipe-detail-grid .choice')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});node.click()})()`)
  await c.wait(`new URLSearchParams(location.search).get('recipeDetails')?.includes('${KEY}')`,'raw recipe key')
  const editorState=await c.eval(`(()=>({url:location.href,selected:[...document.querySelectorAll('.selected-refinement')].map((x)=>x.textContent?.replace('×','').trim()),innerWidth,docWidth:document.documentElement.scrollWidth}))()`)
  if(capture){await c.eval(`document.querySelector('.selected-refinements')?.scrollIntoView({block:'center'})`);await sleep(120);await c.shot(`qa-artifacts/${prefix}-${width}-chosen.png`)}
  await apply(c)
  const ids=await resultIds(c)
  const resultState=await c.eval(`(()=>({url:location.href,criteria:[...document.querySelectorAll('.criteria-chips span')].map((x)=>x.textContent?.trim()),relations:[...document.querySelectorAll('.result-relations')].map((x)=>x.innerText.replace(/\\s+/g,' ').trim()).slice(0,5),innerWidth,docWidth:document.documentElement.scrollWidth}))()`)
  assert.equal(editorState.docWidth,editorState.innerWidth,`${prefix}-${width} editor overflow`)
  assert.equal(resultState.docWidth,resultState.innerWidth,`${prefix}-${width} results overflow`)
  if(capture){await c.eval(`window.scrollTo(0,0)`);await sleep(120);await c.shot(`qa-artifacts/${prefix}-${width}-results.png`)}
  return{ids,metric,editorState,resultState}
}

const {version,proc,dir,c}=await launch()
const report={browserVersion:version,production:{sha:BASE_SHA,base:PROD},candidate:{sha:PR_SHA,base:PREVIEW},key:KEY,label:LABEL,checks:{}}
try{
  await c.connect()
  for(const width of [390,1440]){
    const before=await runCase(c,{base:PROD,width,prefix:'before',query:KEY,label:BEFORE_LABEL,capture:true})
    const afterEnglish=await runCase(c,{base:PREVIEW,width,prefix:'after-en',query:KEY,label:LABEL,capture:false})
    const afterKorean=await runCase(c,{base:PREVIEW,width,prefix:'after',query:'가다랑어',label:LABEL,capture:true})
    assert.deepEqual(afterEnglish.ids,before.ids,`English key product set changed at ${width}`)
    assert.deepEqual(afterKorean.ids,before.ids,`Korean label product set changed at ${width}`)
    for(const candidate of [afterEnglish,afterKorean]){
      assert.ok(candidate.editorState.url.includes(`recipeDetails=${KEY}`),`editor URL lost raw key at ${width}`)
      assert.ok(candidate.editorState.selected.includes(LABEL),`selected refinement missing label at ${width}`)
      assert.ok(candidate.resultState.url.includes(`recipeDetails=${KEY}`),`result URL lost raw key at ${width}`)
      assert.ok(candidate.resultState.criteria.includes(LABEL),`criteria bar missing label at ${width}`)
      assert.ok(candidate.resultState.relations.every((text)=>text.includes(LABEL)),`result relation label inconsistent at ${width}`)
    }
    report.checks[width]={before,afterEnglish,afterKorean}
  }
  await c.viewport(390,900);await c.nav(PREVIEW+`?view=workspace&applied=1&recipeDetails=${KEY}`);await c.wait(`document.querySelectorAll('.research-result-card').length>0`,'quick results');const first=await c.eval(`document.querySelector('.research-result-card')?.dataset.productId`);assert.ok(first);await c.eval(`document.querySelector('[data-product-id="${first}"]')?.click()`);await c.wait(`document.querySelector('.research-quick-view')`,'quick view');const quickText=await c.eval(`document.querySelector('.research-quick-view')?.innerText||''`);assert.ok(quickText.includes(LABEL),'quick view missing Korean recipe label');await c.shot('qa-artifacts/after-390-quick.png');report.quickView={productId:first,containsLabel:true}
  writeFileSync('qa-artifacts/report.json',JSON.stringify(report,null,2));console.log('RECIPE_LABEL_PR18_VISUAL PASS')
}catch(error){writeFileSync('qa-artifacts/report.json',JSON.stringify({...report,error:String(error)},null,2));throw error}
finally{c.close();proc.kill('SIGTERM');await sleep(200);if(proc.exitCode==null)proc.kill('SIGKILL');rmSync(dir,{recursive:true,force:true})}
