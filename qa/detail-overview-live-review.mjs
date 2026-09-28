import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
const BASE='http://127.0.0.1:4173/',OUT=process.env.OUT_DIR||'detail-overview-live-output'
const products=[{slug:'go',id:'product_31bc515d78d43d5d',name:'카니보 치킨&칠면조&오리',grainFree:true},{slug:'monge',id:'product_285ec8eafca0bec8',name:'몬지 모노프로틴(L.I.D) 그레인프리 플레이크 온리 포크',grainFree:false}]
await mkdir(OUT,{recursive:true})
const blocked=[],report={sourceSha:process.env.CANDIDATE_SHA,publicData:true,blocked,views:{},goReturn:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
async function openPage(width,height){
 const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'}),page=await context.newPage()
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url()),method=req.method();if(!['GET','HEAD','OPTIONS'].includes(method)||/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)){blocked.push({method,url:url.href});return route.abort('blockedbyclient')}await route.continue()})
 return {context,page}
}
async function waitImage(page){
 const img=page.locator('.detail-identity img').first();await img.waitFor({state:'visible'})
 await page.waitForFunction(()=>{const x=document.querySelector('.detail-identity img');return x&&x.complete&&x.naturalWidth>0})
 return img.evaluate(x=>({src:x.currentSrc||x.src,naturalWidth:x.naturalWidth,naturalHeight:x.naturalHeight}))
}
async function geometry(page){return page.evaluate(()=>{const nodes=[...document.querySelectorAll('.detail-body *, .detail-identity *')].filter(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'});const clipped=nodes.filter(n=>{const r=n.getBoundingClientRect();return r.right>innerWidth+1||r.left<-1}).map(n=>({tag:n.tagName,className:n.className,text:(n.textContent||'').trim().slice(0,100),left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right})).slice(0,20);const sections=[...document.querySelectorAll('.detail-body .detail-section')].filter(n=>n.getClientRects().length),overlaps=[];for(let i=1;i<sections.length;i++){const a=sections[i-1].getBoundingClientRect(),b=sections[i].getBoundingClientRect();if(b.top<a.bottom-1)overlaps.push({previous:i-1,current:i,previousBottom:a.bottom,currentTop:b.top})}return {documentOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,clipped,overlaps}})}
for(const [label,width,height] of [['390',390,844],['1440',1440,900]])for(const product of products){
 const {context,page}=await openPage(width,height)
 await page.goto(BASE+'?view=workspace&mode=lookup&detail='+product.id+'&detailTab=overview',{waitUntil:'domcontentloaded'})
 await page.locator('.detail-identity h1').waitFor();const title=await page.locator('.detail-identity h1').innerText();assert.ok(title.includes(product.name),'full product name missing: '+title)
 await page.locator('.detail-size-list').waitFor();await page.getByRole('button',{name:/원재료 보기/}).waitFor();const image=await waitImage(page),identity=await page.locator('.detail-identity').innerText(),overview=await page.locator('#detail-panel-overview').innerText()
 assert.ok(!/사료 형태|대상 연령|레시피 종류|주요 레시피/.test(overview),'duplicate overview facts remain');if(product.grainFree)assert.match(overview,/Grain-Free/)
 const g=await geometry(page);assert.ok(g.documentOverflow<=1,'horizontal overflow '+g.documentOverflow);assert.equal(g.clipped.length,0,'clipped '+JSON.stringify(g.clipped));assert.equal(g.overlaps.length,0,'overlap '+JSON.stringify(g.overlaps))
 const file=product.slug+'-'+label+'.png';await page.screenshot({path:OUT+'/'+file,fullPage:false});report.views[product.slug+'-'+label]={file,title,identity,overview,image,geometry:g}
 if(product.slug==='go'){await page.getByRole('tab',{name:'영양'}).click();await page.getByRole('tab',{name:'개요'}).click();const check=await page.evaluate(()=>{const tabs=document.querySelector('.detail-tabs'),topbar=document.querySelector('.detail-topbar'),grain=[...document.querySelectorAll('#detail-panel-overview .detail-fact')].find(n=>n.textContent?.includes('Grain-Free')),r=grain?.getBoundingClientRect(),tr=tabs?.getBoundingClientRect(),hr=topbar?.getBoundingClientRect(),stickyBottom=Math.max(tr?.bottom||0,hr?.bottom||0);return {grainTop:r?.top??null,grainBottom:r?.bottom??null,stickyBottom,visible:Boolean(r&&r.bottom>stickyBottom&&r.top>=stickyBottom-1)}});assert.ok(check.visible,'GO Grain-Free hidden '+JSON.stringify(check));report.goReturn[label]=check}
 await context.close()
}
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2));await browser.close()
