import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'detail-overview-postdeploy-output'
const cases=[
 {slug:'go',width:390,height:844,id:'product_31bc515d78d43d5d',name:'카니보 치킨&칠면조&오리',size:/1\.36 kg|3\.63 kg|7\.26 kg/,grain:true},
 {slug:'monge',width:1440,height:900,id:'product_285ec8eafca0bec8',name:'몬지 모노프로틴(L.I.D) 그레인프리 플레이크 온리 포크',size:/80 g/,grain:false},
]
await mkdir(OUT,{recursive:true})
const blocked=[],report={pages:true,mergeSha:process.env.MERGE_SHA,blocked,views:{},goReturn:null}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
for(const c of cases){
 const context=await browser.newContext({viewport:{width:c.width,height:c.height},serviceWorkers:'block'}),page=await context.newPage()
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url()),method=req.method();if(!['GET','HEAD','OPTIONS'].includes(method)||/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)){blocked.push({method,url:url.href});return route.abort('blockedbyclient')}await route.continue()})
 await page.goto(BASE+'?view=workspace&mode=lookup&detail='+c.id+'&detailTab=overview',{waitUntil:'domcontentloaded'})
 const titleEl=page.locator('.detail-identity h1');await titleEl.waitFor();const title=await titleEl.innerText();assert.ok(title.includes(c.name),'full title missing '+title)
 const sizeText=await page.locator('.detail-size-list').innerText();assert.match(sizeText,c.size)
 await page.getByRole('button',{name:/원재료 보기/}).waitFor({timeout:90000})
 const overview=await page.locator('#detail-panel-overview').innerText();assert.ok(!/사료 형태|대상 연령|레시피 종류|주요 레시피/.test(overview),'duplicate basic info remains')
 const img=page.locator('.detail-identity img').first();await img.waitFor({state:'visible'});await page.waitForFunction(()=>{const x=document.querySelector('.detail-identity img');return x&&x.complete&&x.naturalWidth>0})
 const titleMetrics=await titleEl.evaluate(el=>({text:el.innerText,wordBreak:getComputedStyle(el).wordBreak,overflowWrap:getComputedStyle(el).overflowWrap,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth}))
 assert.equal(titleMetrics.wordBreak,'keep-all');assert.ok(titleMetrics.scrollWidth<=titleMetrics.clientWidth+1,'title horizontal overflow')
 const docOverflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);assert.ok(docOverflow<=1,'page horizontal overflow '+docOverflow)
 if(c.grain){assert.match(overview,/Grain-Free/);await page.getByRole('tab',{name:'영양'}).click();await page.getByRole('tab',{name:'개요'}).click();const check=await page.evaluate(()=>{const tabs=document.querySelector('.detail-tabs'),top=document.querySelector('.detail-topbar'),grain=[...document.querySelectorAll('#detail-panel-overview .detail-fact')].find(n=>n.textContent?.includes('Grain-Free')),r=grain?.getBoundingClientRect(),stickyBottom=Math.max(tabs?.getBoundingClientRect().bottom||0,top?.getBoundingClientRect().bottom||0);return {grainTop:r?.top??null,stickyBottom,visible:Boolean(r&&r.top>=stickyBottom-1)}});assert.ok(check.visible,'Grain-Free obscured '+JSON.stringify(check));report.goReturn=check}
 const file=c.slug+'-'+c.width+'x'+c.height+'.png';await page.screenshot({path:OUT+'/'+file,fullPage:false});report.views[c.slug]={file,title,sizeText,overview,titleMetrics,image:await img.evaluate(x=>({src:x.currentSrc||x.src,naturalWidth:x.naturalWidth,naturalHeight:x.naturalHeight})),docOverflow}
 await context.close()
}
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2));await browser.close()
