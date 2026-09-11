import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'

const BASE='https://osrm.github.io/catfood_web/'
const DEPLOY_SHA='0c6cb2acb010ebe6d9121805babad72c22b297ad'
const PAGES_RUN=34551837837
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const out='qa-artifacts'

class Cdp {
  constructor(url){this.url=url;this.ws=null;this.id=1;this.pending=new Map()}
  async connect(){
    this.ws=new WebSocket(this.url)
    await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('ws timeout')),15000);this.ws.addEventListener('open',()=>{clearTimeout(t);res()},{once:true});this.ws.addEventListener('error',()=>rej(new Error('ws error')),{once:true})})
    this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(!m.id)return;const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)})
    for(const m of ['Page.enable','Runtime.enable']) await this.send(m)
  }
  send(method,params={}){const id=this.id++;return new Promise((res,rej)=>{this.pending.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method,params}))})}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value}
  async wait(expression,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){try{if(await this.eval(`Boolean(${expression})`))return}catch{}await sleep(120)}throw new Error(`timeout ${label}`)}
  async nav(url){await this.send('Page.navigate',{url});await this.wait(`document.readyState==='complete'`,'ready');await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`,'root')}
  async viewport(w,h){await this.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true})}
  async shot(path){const r=await this.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});writeFileSync(path,Buffer.from(r.data,'base64'))}
  close(){try{this.ws?.close()}catch{}}
}

async function launch(){
  const bin='/usr/bin/google-chrome';assert.ok(existsSync(bin));const version=execFileSync(bin,['--version'],{encoding:'utf8'}).trim();const port=9930+(process.pid%40);const dir=`/tmp/pr19-postdeploy-${process.pid}`;rmSync(dir,{recursive:true,force:true})
  const proc=spawn(bin,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'})
  for(let i=0;i<220;i++){try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const p=pages.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p){const c=new Cdp(p.webSocketDebuggerUrl);await c.connect();return{version,proc,dir,c}}}catch{}await sleep(100)}throw new Error('chrome timeout')
}

const visibleExpr=(s)=>`(()=>{const n=document.querySelector(${JSON.stringify(s)});if(!n)return false;const r=n.getBoundingClientRect(),c=getComputedStyle(n);return c.display!=='none'&&c.visibility!=='hidden'&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight})()`
async function clickVisible(c,selector,text=null){
  const p=await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const n=${text===null?'nodes[0]':`nodes.find(x=>x.textContent?.trim().includes(${JSON.stringify(text)}))`};if(!n)return null;const r=n.getBoundingClientRect();if(r.bottom<=0||r.top>=innerHeight)return{hidden:true,top:r.top,bottom:r.bottom};return{x:r.left+r.width/2,y:r.top+r.height/2,text:n.textContent?.trim()}})()`)
  assert.ok(p&&!p.hidden,`target not visibly clickable: ${text??selector} ${JSON.stringify(p)}`)
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});await sleep(250)
}
async function wheel(c,deltaY,w,h){await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:Math.floor(w/2),y:Math.floor(h/2),deltaX:0,deltaY});await sleep(180)}
async function wheelToTop(c,w,h){for(let i=0;i<35;i++){const y=await c.eval('window.scrollY');if(y<=1)return;await wheel(c,-600,w,h)}throw new Error('failed to return to top')}
async function wheelUntilLastVisible(c,w,h){
  for(let i=0;i<45;i++){
    const m=await c.eval(`(()=>{const n=document.querySelector('.recipe-detail-grid .choice:last-child');if(!n)return null;const r=n.getBoundingClientRect();return{y:r.y,top:r.top,bottom:r.bottom,text:n.textContent?.trim(),scrollY,docH:document.documentElement.scrollHeight}})()`)
    assert.ok(m,'missing last recipe choice')
    if(m.top>=0&&m.bottom<=h-8)return m
    const before=await c.eval('window.scrollY');await wheel(c,Math.min(520,Math.max(180,m.top-h+120)),w,h);const after=await c.eval('window.scrollY')
    if(after===before&&m.bottom>h)throw new Error(`document scroll stopped before last choice: ${JSON.stringify(m)}`)
  }
  throw new Error('last recipe choice never became visible')
}
async function pressTab(c){await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await sleep(100)}
async function keyboardReachLast(c,h){
  const lastText=await c.eval(`document.querySelector('.recipe-detail-grid .choice:last-child')?.textContent?.trim()`);assert.ok(lastText)
  await c.eval(`document.querySelector('.recipe-search')?.focus()`);await sleep(100)
  for(let i=0;i<120;i++){
    await pressTab(c)
    const m=await c.eval(`(()=>{const a=document.activeElement,last=document.querySelector('.recipe-detail-grid .choice:last-child');const r=a?.getBoundingClientRect?.();return{isLast:a===last,text:a?.textContent?.trim(),top:r?.top,bottom:r?.bottom,scrollY}})()`)
    if(m.isLast){assert.ok(m.top>=0&&m.bottom<=h,`keyboard-focused last item not visible ${JSON.stringify(m)}`);return m}
  }
  throw new Error('Tab focus never reached last recipe choice')
}
async function waitCatalog(c){await c.wait(`!document.body.innerText.includes('제품 데이터를 불러오는 중입니다.')`,'catalog settle',60000);await sleep(450)}
async function waitVisibleImages(c){const end=Date.now()+12000;while(Date.now()<end){const done=await c.eval(`(()=>{const imgs=[...document.querySelectorAll('.research-result-image')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight});return imgs.length===0||imgs.every(n=>n.complete)})()`);if(done)break;await sleep(150)}await sleep(300);return c.eval(`(()=>[...document.querySelectorAll('.research-result-image')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).slice(0,6).map(n=>({complete:n.complete,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight,visibility:getComputedStyle(n).visibility})))()`)}

async function measure(c){return c.eval(`(()=>{const q=s=>document.querySelector(s);const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{x:+r.x.toFixed(2),y:+r.y.toFixed(2),width:+r.width.toFixed(2),height:+r.height.toFixed(2),bottom:+r.bottom.toFixed(2)}};const panel=q('#mobile-recipe-refine-panel'),inner=q('#mobile-recipe-refine-panel .research-filter-scroll'),entry=q('.mobile-refine-entry'),button=q('.mobile-refine-entry button'),last=q('.recipe-detail-grid .choice:last-child'),root=document.scrollingElement;const pc=panel?getComputedStyle(panel):null,ic=inner?getComputedStyle(inner):null;return{url:location.href,innerWidth,innerHeight,scrollY,docHeight:document.documentElement.scrollHeight,rootScroller:root?.tagName,rootScrollTop:root?.scrollTop,entryRect:rect(entry),buttonRect:rect(button),panelRect:rect(panel),panelClientHeight:panel?.clientHeight??null,panelScrollHeight:panel?.scrollHeight??null,panelScrollTop:panel?.scrollTop??null,panelOverflowY:pc?.overflowY,panelMaxHeight:pc?.maxHeight,innerClientHeight:inner?.clientHeight??null,innerScrollHeight:inner?.scrollHeight??null,innerScrollTop:inner?.scrollTop??null,innerOverflowY:ic?.overflowY,lastRect:rect(last),lastText:last?.textContent?.trim()??null,lastPressed:last?.getAttribute('aria-pressed')??null,expanded:button?.getAttribute('aria-expanded')??null,resultCount:document.querySelectorAll('.research-result-card').length,stateText:q('.state-message')?.textContent?.trim()??null,activeIsToggle:document.activeElement===button}})()`)}
function assertOpen(m,label){
  assert.equal(m.panelOverflowY,'visible',`${label} panel overflowY`);assert.equal(m.innerOverflowY,'visible',`${label} inner overflowY`);assert.equal(m.panelMaxHeight,'none',`${label} max-height`)
  assert.ok(m.panelClientHeight>=m.panelScrollHeight-2,`${label} panel clips ${m.panelClientHeight}/${m.panelScrollHeight}`);assert.ok(m.innerClientHeight>=m.innerScrollHeight-2,`${label} inner clips ${m.innerClientHeight}/${m.innerScrollHeight}`)
  assert.equal(m.panelScrollTop,0,`${label} panel scroll container`);assert.equal(m.innerScrollTop,0,`${label} inner scroll container`);assert.ok(['HTML','BODY'].includes(m.rootScroller),`${label} unexpected root scroller`)
  assert.ok(m.buttonRect?.height>=34&&m.buttonRect.height<=50,`${label} button stretched ${m.buttonRect?.height}`)
}
async function reachResults(c,w,h){await c.viewport(w,h);await c.nav(BASE+'?view=workspace&applied=1');await waitCatalog(c);await c.wait(`${visibleExpr('.mobile-refine-entry button')}&&${visibleExpr('.research-results')}`,'mobile results');await c.eval('window.scrollTo(0,0)');await sleep(250)}
async function openRefine(c){await clickVisible(c,'.mobile-refine-entry button','더 좁혀보기');await c.wait(`${visibleExpr('.recipe-search')}&&document.querySelector('.mobile-refine-entry button')?.getAttribute('aria-expanded')==='true'`,'open refine');await c.eval(`(()=>{const n=document.querySelector('.recipe-search');if(n&&n.value){const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(n,'');n.dispatchEvent(new Event('input',{bubbles:true}))}})()`);await c.eval('window.scrollTo(0,0)');await sleep(250)}
async function closeRefine(c,w,h){await wheelToTop(c,w,h);await clickVisible(c,'.mobile-refine-entry button','목록으로 돌아가기');await c.wait(`document.querySelector('.mobile-refine-entry button')?.getAttribute('aria-expanded')==='false'&&${visibleExpr('.research-results')}`,'close refine');await sleep(250)}

async function mobileFlow(c,w,h){
  const p=`production-${DEPLOY_SHA.slice(0,8)}-${w}x${h}`
  await reachResults(c,w,h);await openRefine(c)
  const top=await measure(c);assertOpen(top,`${w} top`);await c.shot(`${out}/${p}-open-top.png`)

  const bottomReached=await wheelUntilLastVisible(c,w,h);const bottom=await measure(c);assertOpen(bottom,`${w} bottom`);assert.ok(bottom.rootScrollTop>0,`${w} document did not scroll`);assert.ok(bottom.lastRect?.y>=0&&bottom.lastRect.bottom<=h,`${w} last item not visible`);assert.equal(bottom.lastText,bottomReached.text);await c.shot(`${out}/${p}-open-bottom.png`)

  await wheelToTop(c,w,h);const keyboard=await keyboardReachLast(c,h);await c.shot(`${out}/${p}-keyboard-last-focus.png`);assert.equal(keyboard.text,bottom.lastText,`${w} keyboard target changed`)
  await clickVisible(c,'.recipe-detail-grid .choice:last-child');await c.wait(`document.querySelector('.recipe-detail-grid .choice:last-child')?.getAttribute('aria-pressed')==='true'`,'select last')
  const selectedOpen=await measure(c);assertOpen(selectedOpen,`${w} selected`);assert.equal(selectedOpen.lastPressed,'true');const selectedUrl=selectedOpen.url;assert.ok(new URL(selectedUrl).searchParams.has('recipeDetails'),`${w} recipe key missing from URL`);await c.shot(`${out}/${p}-open-last-selected.png`)

  await closeRefine(c,w,h);await waitCatalog(c);const images=await waitVisibleImages(c);const selectedResults=await measure(c);assert.ok(selectedResults.resultCount>0||selectedResults.stateText,`${w} no result state after selection`);assert.ok(new URL(selectedResults.url).searchParams.has('recipeDetails'),`${w} selected URL lost after close`);await c.shot(`${out}/${p}-selected-results.png`)

  await openRefine(c);await wheelUntilLastVisible(c,w,h);const retained=await measure(c);assert.equal(retained.lastPressed,'true',`${w} selection not retained on reopen`);await clickVisible(c,'.recipe-detail-grid .choice:last-child');await c.wait(`document.querySelector('.recipe-detail-grid .choice:last-child')?.getAttribute('aria-pressed')==='false'`,'deselect last');const deselected=await measure(c);assert.equal(deselected.lastPressed,'false');assert.ok(!new URL(deselected.url).searchParams.has('recipeDetails'),`${w} recipe key remained after deselect`);await c.shot(`${out}/${p}-open-last-deselected.png`);await closeRefine(c,w,h);const finalClosed=await measure(c);assert.equal(finalClosed.activeIsToggle,true,`${w} close focus not restored`)

  return{top,bottom,bottomReached,keyboard,selectedOpen,selectedResults,retained,deselected,finalClosed,images}
}

const {version,proc,dir,c}=await launch();const report={browserVersion:version,base:BASE,deploySha:DEPLOY_SHA,pagesRun:PAGES_RUN,cssInjection:false,checks:{}}
try{
  report.checks.mobile360=await mobileFlow(c,360,844)
  report.checks.mobile390=await mobileFlow(c,390,900)
  writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));console.log('POSTDEPLOY_PASS '+JSON.stringify({deploySha:DEPLOY_SHA,pagesRun:PAGES_RUN,last360:report.checks.mobile360.bottom.lastText,last390:report.checks.mobile390.bottom.lastText}))
} catch(e) {
  report.error=String(e?.stack||e);try{await c.shot(`${out}/failure.png`)}catch{}writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));throw e
} finally {c.close();proc.kill('SIGTERM');try{rmSync(dir,{recursive:true,force:true})}catch{}}
