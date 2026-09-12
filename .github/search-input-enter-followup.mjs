import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const ORIGIN='https://osrm.github.io/catfood_web/'
const OUT='qa-artifacts/search-input-enter-followup'
const HOME='.home-search-console-form input[type="search"]'
const LOOKUP='.lookup-input'
const QUERY='go!'
mkdirSync(OUT,{recursive:true})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const js=(v)=>JSON.stringify(v)

class Cdp{
  constructor(url){this.url=url;this.id=1;this.pending=new Map();this.requests=[];this.responses=[]}
  async connect(){
    this.ws=new WebSocket(this.url)
    await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('ws timeout')),15000);this.ws.addEventListener('open',()=>{clearTimeout(t);resolve()},{once:true});this.ws.addEventListener('error',()=>reject(new Error('ws error')),{once:true})})
    this.ws.addEventListener('message',(event)=>{const m=JSON.parse(event.data);if(m.method==='Network.requestWillBeSent')this.requests.push({url:m.params.request.url,method:m.params.request.method,requestId:m.params.requestId});if(m.method==='Network.responseReceived')this.responses.push({url:m.params.response.url,status:m.params.response.status,requestId:m.params.requestId});if(!m.id)return;const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)})
    for(const method of ['Page.enable','Runtime.enable','Network.enable'])await this.send(method)
    await this.send('Emulation.setLocaleOverride',{locale:'ko-KR'})
    await this.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const f=window.fetch.bind(window),b=navigator.sendBeacon?.bind(navigator);window.__events=[];window.__blocked={analytics:0,writes:0};for(const type of ['keydown','keyup','beforeinput','input','submit'])document.addEventListener(type,e=>{const t=e.target;window.__events.push({type,key:e.key??null,inputType:e.inputType??null,data:e.data??null,isTrusted:e.isTrusted,value:t instanceof HTMLInputElement?t.value:null,target:t?.className??t?.tagName??null})},true);window.fetch=(input,init={})=>{const u=typeof input==='string'?input:(input?.url||''),m=String(init.method||(input?.method)||'GET').toUpperCase();if(u.includes('/functions/v1/decision-intake')){window.__blocked.analytics++;return Promise.resolve(new Response(null,{status:204}))}if(u.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(m)){window.__blocked.writes++;return Promise.resolve(new Response(null,{status:204}))}return f(input,init)};if(b)navigator.sendBeacon=(u,d)=>{if(String(u).includes('/functions/v1/decision-intake')){window.__blocked.analytics++;return true}return b(u,d)}})();`})
  }
  send(method,params={}){const id=this.id++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expr){const r=await this.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value}
  async wait(expr,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await this.eval(`Boolean(${expr})`))return true;await sleep(80)}throw new Error(`timeout ${label}`)}
  async nav(url){await this.send('Page.navigate',{url});await this.wait(`document.readyState==='complete'`,'ready');await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`,'root');await sleep(150)}
  async shot(path){const r=await this.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(path,Buffer.from(r.data,'base64'))}
}

async function launch(){
  const port=9900+(process.pid%80),dir=`/tmp/catfood-enter-${process.pid}`;try{rmSync(dir,{recursive:true,force:true})}catch{}
  const proc=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'})
  for(let i=0;i<200;i++){try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const page=pages.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(page){const c=new Cdp(page.webSocketDebuggerUrl);await c.connect();await c.send('Emulation.setDeviceMetricsOverride',{width:360,height:844,deviceScaleFactor:1,mobile:true,screenWidth:360,screenHeight:844});await c.send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',acceptLanguage:'ko-KR,ko;q=0.9,en;q=0.8',platform:'Android'});return{c,proc,dir,chrome:execFileSync('/usr/bin/google-chrome',['--version'],{encoding:'utf8'}).trim()}}}catch{}await sleep(100)}throw new Error('Chrome launch timeout')
}
function cleanup(x){try{x.c.ws.close()}catch{};try{x.proc.kill('SIGTERM')}catch{};setTimeout(()=>{try{x.proc.kill('SIGKILL')}catch{};try{rmSync(x.dir,{recursive:true,force:true})}catch{}},250)}
async function click(c,selector){const m=await c.eval(`(()=>{const n=document.querySelector(${js(selector)});if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,ok:Boolean(h&&(h===n||n.contains(h))),disabled:Boolean(n.disabled)}})()`);assert.ok(m?.ok&&!m.disabled,`cannot click ${selector}`);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:m.x,y:m.y,button:'left',clickCount:1});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:m.x,y:m.y,button:'left',clickCount:1});await sleep(40)}
async function focus(c,selector){await click(c,selector);const s=await c.eval(`(()=>{const n=document.querySelector(${js(selector)}),a=document.activeElement;return{focused:a===n,tag:a?.tagName??null,className:a?.className??null,value:n?.value??null}})()`);assert.equal(s.focused,true);return s}
async function typeAscii(c,selector,text){const active=await focus(c,selector);const start=await c.eval('(window.__events||[]).length');for(const ch of text){await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:ch,text:ch,unmodifiedText:ch});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:ch})}await c.wait(`document.querySelector(${js(selector)})?.value===${js(text)}`,'typed value',3000);return{active,events:await c.eval(`window.__events.slice(${start})`)}}
async function pressEnter(c){const start=await c.eval('(window.__events||[]).length');await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await sleep(300);return await c.eval(`window.__events.slice(${start})`)}
async function state(c,selector){return c.eval(`(()=>{const n=document.querySelector(${js(selector)}),a=document.activeElement,p=Object.fromEntries(new URLSearchParams(location.search));return{url:location.href,params:p,inputValue:n?.value??null,active:{focused:a===n,tag:a?.tagName??null,className:a?.className??null,value:a instanceof HTMLInputElement?a.value:null},resultCount:document.querySelectorAll('.research-result-card').length,targetGO:Boolean(document.querySelector('.research-result-card[data-product-id="product_31bc515d78d43d5d"]'))}})()`)}

const report={targetSha:process.env.TARGET_SHA,origin:ORIGIN,status:'running',startedAt:new Date().toISOString()}
const x=await launch();const c=x.c
try{
  report.chrome=x.chrome;await c.nav(ORIGIN)
  report.homeType=await typeAscii(c,HOME,QUERY);report.homeBeforeEnter=await state(c,HOME)
  report.homeEnterEvents=await pressEnter(c)
  let submitted=false;try{await c.wait(`new URL(location.href).searchParams.get('mode')==='lookup'&&new URL(location.href).searchParams.get('q')===${js(QUERY)}`,'home enter navigation',2500);submitted=true}catch{}
  report.homeEnter={submitted,state:await state(c,submitted?LOOKUP:HOME)}
  await c.shot(`${OUT}/360-home-enter-followup.png`)
  if(!submitted){await click(c,'.home-search-console-form button[type="submit"]');await c.wait(`document.querySelector(${js(LOOKUP)})?.value===${js(QUERY)}`,'button fallback')}
  await c.wait(`document.querySelector('.research-result-card[data-product-id="product_31bc515d78d43d5d"]')`,'GO result')
  report.lookupFocus=await focus(c,LOOKUP);const before=await state(c,LOOKUP);report.lookupEnterEvents=await pressEnter(c);const after=await state(c,LOOKUP);report.lookupEnter={before,after}
  assert.equal(after.active.focused,true,'lookup input lost focus after Enter');assert.equal(after.url,before.url);assert.equal(after.inputValue,QUERY);assert.equal(after.resultCount,before.resultCount);assert.equal(after.targetGO,true)
  await c.shot(`${OUT}/360-lookup-focused-enter.png`)
  const sentAnalytics=c.requests.filter(x=>x.url.includes('/functions/v1/decision-intake'));const sentWrites=c.requests.filter(x=>x.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(x.method));const blocked=await c.eval('window.__blocked');assert.equal(sentAnalytics.length,0);assert.equal(sentWrites.length,0);assert.equal(blocked.writes,0);report.network={sentAnalytics,sentWrites,blocked};report.status=submitted?'completed_home_enter_supported':'completed_home_enter_cdp_inconclusive'
}catch(e){report.status='failed';report.error={message:String(e?.message||e),stack:String(e?.stack||'')};try{await c.shot(`${OUT}/360-failure.png`)}catch{};process.exitCode=1}finally{report.finishedAt=new Date().toISOString();writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2)+'\n');cleanup(x)}
