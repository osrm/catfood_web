import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'

const PROD='https://osrm.github.io/catfood_web/'
const PREVIEW='http://127.0.0.1:4173/'
const BASE_SHA='41346569f410d8caf9540f5e7be04a1de9847ec9'
const PR_SHA='d84931c2bd55e68747c70dbf0628103e17f79d57'
const BASE='?view=workspace&applied=1'
const KEY='skipjack_tuna'
const LABEL='가다랑어(Skipjack tuna)'
const BEFORE_LABEL='skipjack tuna'
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms))

class Cdp {
  constructor(url){this.url=url;this.ws=null;this.id=1;this.pending=new Map()}
  async connect(){this.ws=new WebSocket(this.url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('ws timeout')),15000);this.ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});this.ws.addEventListener('error',()=>reject(new Error('ws error')),{once:true})});this.ws.addEventListener('message',(event)=>{const message=JSON.parse(event.data);if(!message.id)return;const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.result)});for(const method of ['Page.enable','Runtime.enable','Network.enable'])await this.send(method)}
  send(method,params={}){const id=this.id++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expression){const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value}
  async wait(expression,label,ms=60000){const end=Date.now()+ms;while(Date.now()<end){try{if(await this.eval(`Boolean(${expression})`))return}catch{}await sleep(120)}throw new Error(`timeout ${label}`)}
  async nav(url){await this.send('Page.navigate',{url});await this.wait(`document.readyState==='complete'`,'ready');await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`,'root')}
  async viewport(width,height){await this.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<800})}
  async shot(path){const result=await this.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(path,Buffer.from(result.data,'base64'))}
  close(){try{this.ws?.close()}catch{}}
}

async function launch(){const bin='/usr/bin/google-chrome';assert.ok(existsSync(bin));const version=execFileSync(bin,['--version'],{encoding:'utf8'}).trim();const port=9930+(process.pid%50);const dir=`/tmp/catfood-recipe-${process.pid}`;rmSync(dir,{recursive:true,force:true});const proc=spawn(bin,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'});for(let i=0;i<220;i++){try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const page=pages.find((item)=>item.type==='page'&&item.webSocketDebuggerUrl);if(page)return{version,proc,dir,c:new Cdp(page.webSocketDebuggerUrl)}}catch{}await sleep(120)}throw new Error('chrome start timeout')}

async function waitResults(c){await c.wait(`document.querySelector('.recipe-search')&&document.querySelectorAll('.research-result-card').length>0`,'workspace');await sleep(350)}
async function setSearch(c,value){await c.eval(`(()=>{const input=document.querySelector('.recipe-search');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await sleep(250)}
async function ids(c){return JSON.parse(await c.eval(`JSON.stringify([...document.querySelectorAll('.research-result-card')].map((node)=>node.dataset.productId).sort())`))}
async function captureCase(c,{base,width,prefix,query,label}){
  await c.viewport(width,width===1440?1000:900)
  await c.nav(base+BASE)
  await waitResults(c)
  await setSearch(c,query)
  await c.wait(`[...document.querySelectorAll('.recipe-detail-grid .choice')].some((node)=>node.textContent?.trim()===${JSON.stringify(label)})`,'matching recipe option')
  await c.eval(`document.querySelector('.recipe-search')?.scrollIntoView({block:'center'})`)
  await sleep(150)
  await c.shot(`qa-artifacts/${prefix}-${width}-filter.png`)
  const buttonMetric=await c.eval(`(()=>{const node=[...document.querySelectorAll('.recipe-detail-grid .choice')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});const style=getComputedStyle(node);return{text:node.textContent.trim(),clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,whiteSpace:style.whiteSpace,textOverflow:style.textOverflow,fontSize:style.fontSize}})()`)
  assert.notEqual(buttonMetric.whiteSpace,'nowrap',`${prefix}-${width} nowrap`)
  assert.notEqual(buttonMetric.textOverflow,'ellipsis',`${prefix}-${width} ellipsis`)
  assert.ok(buttonMetric.scrollWidth<=buttonMetric.clientWidth+1,`${prefix}-${width} clipped horizontally`)
  await c.eval(`(()=>{const node=[...document.querySelectorAll('.recipe-detail-grid .choice')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});node.click()})()`)
  await c.wait(`new URLSearchParams(location.search).get('recipeDetails')?.includes('${KEY}')`,'raw recipe key in URL')
  await waitResults(c)
  const productIds=await ids(c)
  await c.eval(`window.scrollTo(0,0)`);await sleep(150)
  const state=await c.eval(`(()=>({url:location.href,innerWidth,docWidth:document.documentElement.scrollWidth,criteria:[...document.querySelectorAll('.criteria-chips span')].map((x)=>x.textContent?.trim()),selected:[...document.querySelectorAll('.selected-refinement')].map((x)=>x.textContent?.replace('×','').trim()),relation:[...document.querySelectorAll('.result-relations')].map((x)=>x.innerText.replace(/\\s+/g,' ').trim()).slice(0,5)}))()`)
  assert.equal(state.docWidth,state.innerWidth,`${prefix}-${width} page overflow`)
  await c.shot(`qa-artifacts/${prefix}-${width}-selected.png`)
  return{productIds,state,buttonMetric}
}

const {version,proc,dir,c}=await launch()
const report={browserVersion:version,production:{sha:BASE_SHA,base:PROD},candidate:{sha:PR_SHA,base:PREVIEW},key:KEY,label:LABEL,checks:{}}
try{
  await c.connect()
  for(const width of [390,1440]){
    const before=await captureCase(c,{base:PROD,width,prefix:'before',query:KEY,label:BEFORE_LABEL})
    const afterEnglish=await captureCase(c,{base:PREVIEW,width,prefix:'after-en',query:KEY,label:LABEL})
    const afterKorean=await captureCase(c,{base:PREVIEW,width,prefix:'after-ko',query:'가다랑어',label:LABEL})
    assert.deepEqual(afterEnglish.productIds,before.productIds,`English-key result set changed at ${width}`)
    assert.deepEqual(afterKorean.productIds,before.productIds,`Korean-label result set changed at ${width}`)
    for(const result of [afterEnglish,afterKorean]){
      assert.ok(result.state.url.includes(`recipeDetails=${KEY}`),`raw key missing from URL at ${width}`)
      assert.ok(result.state.criteria.includes(LABEL),`criteria display missing at ${width}`)
      assert.ok(result.state.selected.includes(LABEL),`selected display missing at ${width}`)
    }
    report.checks[width]={before,afterEnglish,afterKorean}
  }
  await c.viewport(390,900);await c.nav(PREVIEW+BASE+`&recipeDetails=${KEY}`);await waitResults(c)
  const first=await c.eval(`document.querySelector('.research-result-card')?.dataset.productId`);assert.ok(first)
  await c.eval(`document.querySelector('[data-product-id="${first}"]')?.click()`);await c.wait(`document.querySelector('.research-quick-view')`,'quick view')
  const quickText=await c.eval(`document.querySelector('.research-quick-view')?.innerText||''`);assert.ok(quickText.includes(LABEL),'quick view label missing')
  await c.shot('qa-artifacts/after-390-quick.png')
  report.quickView={productId:first,containsLabel:true}
  writeFileSync('qa-artifacts/report.json',JSON.stringify(report,null,2))
  console.log('RECIPE_LABEL_QA PASS')
} catch(error){writeFileSync('qa-artifacts/report.json',JSON.stringify({...report,error:String(error)},null,2));throw error}
finally{c.close();proc.kill('SIGTERM');await sleep(200);if(proc.exitCode==null)proc.kill('SIGKILL');rmSync(dir,{recursive:true,force:true})}
