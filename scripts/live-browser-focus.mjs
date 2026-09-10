import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE='https://osrm.github.io/catfood_web/'
const OUT='qa-artifacts-final'
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms))
class Cdp{
  constructor(url){this.url=url;this.ws=null;this.id=1;this.pending=new Map();this.requests=new Map();this.rest=[];this.failures=[]}
  async connect(){this.ws=new WebSocket(this.url);await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('ws timeout')),15000);this.ws.addEventListener('open',()=>{clearTimeout(t);r()},{once:true});this.ws.addEventListener('error',()=>j(new Error('ws error')),{once:true})});this.ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);if(m.id){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.j(new Error(m.error.message)):p.r(m.result);return}if(m.method==='Network.requestWillBeSent')this.requests.set(m.params.requestId,m.params.request?.url||'');if(m.method==='Network.responseReceived'&&m.params.response?.url?.includes('.supabase.co/rest/v1/')){const u=new URL(m.params.response.url);this.rest.push({path:u.pathname,status:m.params.response.status})}if(m.method==='Network.loadingFailed'&&m.params.errorText!=='net::ERR_ABORTED')this.failures.push({url:this.requests.get(m.params.requestId)||'',error:m.params.errorText,blockedReason:m.params.blockedReason||null})});for(const x of ['Page.enable','Runtime.enable','Network.enable'])await this.send(x)}
  send(method,params={}){const id=this.id++;return new Promise((r,j)=>{this.pending.set(id,{r,j});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expression){const x=await this.send('Runtime.evaluate',{expression,returnByValue:true});if(x.exceptionDetails)throw new Error(x.exceptionDetails.exception?.description||x.exceptionDetails.text);return x.result?.value}
  async wait(expression,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){try{if(await this.eval(`Boolean(${expression})`))return}catch{}await sleep(120)}throw new Error(`timeout ${label}: ${JSON.stringify(await this.diag())}`)}
  async nav(url){await this.send('Page.navigate',{url});await this.wait(`document.readyState==='complete'`,'ready');await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`,'root')}
  async viewport(width,height=844,mobile=true){await this.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile})}
  async shot(name){const x=await this.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(`${OUT}/${name}`,Buffer.from(x.data,'base64'))}
  async diag(){let page={};try{page=await this.eval(`({href:location.href,body:(document.body?.innerText||'').slice(0,500),inputExists:Boolean(document.querySelector('.lookup-input')),inputValue:document.querySelector('.lookup-input')?.value??null,detail:Boolean(document.querySelector('.detail-stage')),quick:Boolean(document.querySelector('.research-quick-view'))})`)}catch{}return{page,rest:this.rest.slice(-10),failures:this.failures.slice(-5)}}
  close(){try{this.ws?.close()}catch{}}
}
async function launch(){const bin=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium'].find(existsSync);assert.ok(bin);const port=9970+(process.pid%20),dir=`/tmp/catfood-diag-${process.pid}`;rmSync(dir,{recursive:true,force:true});const proc=spawn(bin,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'--window-size=1440,1100','about:blank'],{stdio:'ignore'});for(let i=0;i<200;i++){try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),p=pages.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return{proc,dir,c:new Cdp(p.webSocketDebuggerUrl)}}catch{}await sleep(100)}throw new Error('chrome start timeout')}
function log(name,data){console.log(`DIAG_QA ${name} :: ${JSON.stringify(data)}`)}

mkdirSync(OUT,{recursive:true})
const {proc,dir,c}=await launch()
try{
  await c.connect()
  await c.viewport(1440,1100,false)
  await c.nav(`${BASE}?view=workspace&mode=lookup`)
  await c.wait(`document.querySelector('.lookup-input')`,'initial lookup')
  const initial=await c.eval('history.length')
  await c.eval(`document.querySelector('.lookup-input').focus();true`)
  const typed=[];let prefix=''
  for(const ch of ['1','1','+']){prefix+=ch;await c.send('Input.insertText',{text:ch});await c.wait(`document.querySelector('.lookup-input')?.value===${JSON.stringify(prefix)}`,'typed '+prefix);typed.push({value:prefix,history:await c.eval('history.length'),search:await c.eval('location.search')})}
  await c.wait(`document.querySelectorAll('.research-result-card').length>0`,'search results')
  await c.eval(`document.querySelector('.research-result-card').click();true`)
  await c.wait(`document.querySelector('.research-quick-view')`,'quick view')
  const beforeDetail=await c.diag()
  const clicked=await c.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('상세 보기'));if(!b)return false;b.click();return true})()`);assert.equal(clicked,true)
  await c.wait(`document.querySelector('.detail-stage')`,'detail')
  const detailLength=await c.eval('history.length')
  await c.eval('history.back();true')
  await c.wait(`!document.querySelector('.detail-stage')&&location.search.includes('mode=lookup')`,'back to lookup state')
  await sleep(700)
  const afterBack=await c.diag()
  log('search-history',{initial,typed,detailLength,beforeDetail,afterBack})

  await c.nav(`${BASE}?view=workspace&applied=1`)
  await c.wait(`document.querySelectorAll('.research-result-card').length>=5`,'catalog five')
  const ids=await c.eval(`[...document.querySelectorAll('.research-result-card')].slice(0,5).map(x=>x.dataset.productId)`)
  const compareUrl=`${BASE}?view=workspace&applied=1&compare=${ids.join(',')}&compareOpen=1`
  for(const width of [390,360]){
    await c.viewport(width,844,true);await c.nav(compareUrl);await c.wait(`document.querySelectorAll('.compare-product-head').length===5`,'five compare '+width);await sleep(250)
    const before=await c.eval(`(()=>{const R=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};const w=document.querySelector('.compare-table-wrap'),label=document.querySelector('.compare-row-label');return{innerWidth,wrap:{clientWidth:w.clientWidth,scrollWidth:w.scrollWidth,scrollLeft:w.scrollLeft,rect:R(w)},label:{rect:R(label),position:getComputedStyle(label).position,left:getComputedStyle(label).left},tabs:[...document.querySelectorAll('.compare-tabs [role=tab]')].map(R),remove:R(document.querySelector('.compare-remove')),detail:R(document.querySelector('.compare-detail-link')),back:R(document.querySelector('.compare-header>button')),names:[...document.querySelectorAll('.compare-product-copy>strong')].map(n=>({text:n.textContent.trim(),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,height:R(n).height}))}})()`)
    await c.shot(`compare-${width}-prefixed-start.png`)
    const target=await c.eval(`(()=>{const w=document.querySelector('.compare-table-wrap');w.scrollLeft=Math.min(340,w.scrollWidth-w.clientWidth);w.dispatchEvent(new Event('scroll'));return w.scrollLeft})()`);await sleep(250)
    const after=await c.eval(`(()=>{const R=n=>{const r=n.getBoundingClientRect();return{x:r.x,width:r.width,right:r.right}};const w=document.querySelector('.compare-table-wrap'),label=document.querySelector('.compare-row-label');const heads=[...document.querySelectorAll('.compare-product-head')].map(n=>({text:n.querySelector('strong')?.textContent.trim()||'',...R(n)}));return{scrollLeft:w.scrollLeft,wrap:R(w),label:R(label),visibleHeads:heads.filter(h=>h.right>Math.max(label.getBoundingClientRect().right,w.getBoundingClientRect().left)&&h.x<w.getBoundingClientRect().right)}})()`)
    await c.shot(`compare-${width}-prefixed-scrolled.png`)
    log('mobile-geometry',{width,target,before,after})
  }
  console.log('DIAG_QA COMPLETE')
}finally{c.close();proc.kill('SIGTERM');await sleep(200);if(proc.exitCode==null)proc.kill('SIGKILL');rmSync(dir,{recursive:true,force:true})}
