import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE='http://127.0.0.1:4173/catfood_web/'
const IDS=['product_db0958eea4a01c25','product_b47d3ae674773585']
const OUT='qa-artifacts'
mkdirSync(OUT,{recursive:true})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const report={target:'5c3d371eaf8d54ccac9b179757ed0164072e8dbe',viewport:[360,844],ids:IDS,status:'running'}
const save=()=>writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))

class Cdp{
  constructor(url){this.url=url;this.ws=null;this.id=1;this.pending=new Map()}
  async connect(){this.ws=new WebSocket(this.url);await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('ws timeout')),15000);this.ws.addEventListener('open',()=>{clearTimeout(t);r()},{once:true});this.ws.addEventListener('error',()=>j(new Error('ws error')),{once:true})});this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=m.id?this.pending.get(m.id):null;if(!p)return;this.pending.delete(m.id);m.error?p.j(new Error(m.error.message)):p.r(m.result)});for(const x of ['Page.enable','Runtime.enable','DOM.enable','CSS.enable','Network.enable'])await this.send(x);await this.send('Emulation.setLocaleOverride',{locale:'ko-KR'});await this.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const nativeFetch=window.fetch.bind(window);window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake'))return Promise.resolve(new Response(null,{status:204}));if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method))return Promise.resolve(new Response(null,{status:204}));return nativeFetch(input,init)}})();`})}
  send(method,params={}){const id=this.id++;return new Promise((r,j)=>{this.pending.set(id,{r,j});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expression){const x=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(x.exceptionDetails)throw new Error(x.exceptionDetails.exception?.description||x.exceptionDetails.text);return x.result?.value}
  async wait(expression,label,ms=40000){const end=Date.now()+ms;while(Date.now()<end){try{if(await this.eval(`Boolean(${expression})`))return}catch{}await sleep(120)}throw new Error(`timeout ${label}`)}
  async shot(path){const x=await this.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(path,Buffer.from(x.data,'base64'))}
  async fonts(selector){const {root}=await this.send('DOM.getDocument',{depth:1});const {nodeId}=await this.send('DOM.querySelector',{nodeId:root.nodeId,selector});assert.ok(nodeId);return (await this.send('CSS.getPlatformFontsForNode',{nodeId})).fonts??[]}
  close(){try{this.ws?.close()}catch{}}
}
async function launch(){const chrome='/usr/bin/google-chrome';assert.ok(existsSync(chrome));const port=9917,dir='/tmp/mobile-compare-baseline';rmSync(dir,{recursive:true,force:true});const proc=spawn(chrome,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'});for(let i=0;i<200;i++){try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),p=pages.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p){const c=new Cdp(p.webSocketDebuggerUrl);await c.connect();await c.send('Emulation.setDeviceMetricsOverride',{width:360,height:844,deviceScaleFactor:1,mobile:true,screenWidth:360,screenHeight:844});await c.send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',acceptLanguage:'ko-KR,ko;q=0.9,en;q=0.8',platform:'Android'});return{c,proc,dir,version:execFileSync(chrome,['--version'],{encoding:'utf8'}).trim()}}}catch{}await sleep(100)}throw new Error('chrome launch timeout')}
function rectInfo(n){const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
async function atRight(c){await c.eval(`(()=>{const w=document.querySelector('.compare-table-wrap');w.scrollLeft=w.scrollWidth-w.clientWidth;return true})()`);await sleep(180)}
async function metrics(c){return c.eval(`(()=>{const wrap=document.querySelector('.compare-table-wrap'),label=document.querySelector('.compare-corner'),heads=[...document.querySelectorAll('.compare-product-head')],last=heads.at(-1),detail=last.querySelector('.compare-detail-link'),remove=last.querySelector('.compare-remove');const R=n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};const hit=n=>{const r=n.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)),h=document.elementFromPoint(x,y);return{center:[x,y],ok:h===n||n.contains(h),hit:h?.className||h?.tagName}};return{docWidth:document.documentElement.scrollWidth,innerWidth,wrap:{clientWidth:wrap.clientWidth,scrollWidth:wrap.scrollWidth,scrollLeft:wrap.scrollLeft,max:wrap.scrollWidth-wrap.clientWidth},label:R(label),last:R(last),detail:{...R(detail),...hit(detail)},remove:{...R(remove),...hit(remove)},names:[...document.querySelectorAll('.compare-product-copy>strong')].map(n=>n.textContent.trim())}})()`)}
async function pointerTab(c,text){const p=await c.eval(`(()=>{const b=[...document.querySelectorAll('.compare-tabs button')].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!b)return null;const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);assert.ok(p);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1})}

const {c,proc,dir,version}=await launch();report.chrome=version
try{
  await c.send('Page.navigate',{url:`${BASE}?view=workspace&applied=1&compare=${IDS.join(',')}&compareOpen=1&compareTab=overview`})
  await c.wait(`document.readyState==='complete'`,'ready');await c.wait(`document.querySelectorAll('.compare-product-head').length===2`,'two compare heads');await c.eval('document.fonts?.ready');await sleep(250)
  report.fonts=await c.fonts('.compare-product-copy>strong');assert.ok(report.fonts.some(f=>f.familyName.includes('Noto Sans CJK KR')))
  await atRight(c);report.overview=await metrics(c);await c.shot(`${OUT}/baseline-overview-right.png`)
  await pointerTab(c,'영양');await c.wait(`!document.body.innerText.includes('영양 정보를 불러오는 중입니다.')&&document.querySelector('.compare-row.is-metric')`,'nutrition loaded');await atRight(c)
  report.nutrition=await c.eval(`(()=>{const row=[...document.querySelectorAll('.compare-row')].find(r=>r.querySelector('.compare-row-label')?.textContent.trim()==='열량'),label=row.querySelector('.compare-row-label'),cell=row.querySelectorAll('.compare-cell')[1];const R=n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,text:n.textContent.trim()}};return{label:R(label),cell:R(cell)}})()`);await c.shot(`${OUT}/baseline-nutrition-right.png`)
  save()
  assert.ok(report.overview.last.left>=report.overview.label.right-1,`last product begins under fixed label: ${JSON.stringify(report.overview)}`)
  assert.equal(report.overview.detail.ok,true,`detail control occluded: ${JSON.stringify(report.overview.detail)}`)
  assert.ok(report.nutrition.cell.left>=report.nutrition.label.right-1,`energy value begins under fixed label: ${JSON.stringify(report.nutrition)}`)
  report.status='unexpected-pass';save()
}catch(e){report.status='expected-fail';report.error=String(e?.stack||e);save();throw e}finally{c.close();proc.kill('SIGTERM');await sleep(100);if(proc.exitCode==null)proc.kill('SIGKILL');rmSync(dir,{recursive:true,force:true})}
