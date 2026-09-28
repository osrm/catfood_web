import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
const BASE='http://127.0.0.1:4173/catfood_web/'
const OUT=process.env.OUT_DIR||'detail-ingredients-live-output'
const products=[
 {slug:'go',id:'product_31bc515d78d43d5d',name:'카니보 치킨&칠면조&오리'},
 {slug:'monge',id:'product_285ec8eafca0bec8',name:'몬지 모노프로틴(L.I.D) 그레인프리 플레이크 온리 포크'},
]
const views=[[390,844],[1440,900]]
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,blocked:[],views:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
for(const product of products) for(const [width,height] of views){
 const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'}),page=await context.newPage()
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url()),method=req.method();if(!['GET','HEAD','OPTIONS'].includes(method)||/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)){report.blocked.push({method,url:url.href});return route.abort('blockedbyclient')}await route.continue()})
 await page.goto(BASE+'?view=workspace&mode=lookup&detail='+product.id+'&detailTab=ingredients',{waitUntil:'domcontentloaded'})
 const title=page.locator('.detail-identity h1');await title.waitFor();assert.ok((await title.innerText()).includes(product.name))
 const img=page.locator('.detail-identity img').first();await img.waitFor({state:'visible'});await page.waitForFunction(()=>{const x=document.querySelector('.detail-identity img');return x&&x.complete&&x.naturalWidth>0})
 await page.locator('#detail-panel-ingredients .detail-ingredient-copy, #detail-panel-ingredients .detail-ingredient-list').first().waitFor({timeout:90000})
 const panel=page.locator('#detail-panel-ingredients'),text=await panel.innerText()
 const raw=await panel.locator('.detail-ingredient-copy').first().innerText().catch(()=>null)
 const summaries=await panel.locator('summary').allInnerTexts()
 assert.ok(raw || await panel.locator('.detail-ingredient-list').count(),'primary ingredient body missing')
 assert.ok(!summaries.some(x=>/정규화 목록|출처 원문|보조 전체 목록/.test(x)),'old repeated disclosure remains')
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);assert.ok(overflow<=1,'horizontal overflow '+overflow)
 const file=product.slug+'-'+width+'x'+height+'.png';await page.screenshot({path:OUT+'/'+file,fullPage:false})
 report.views[product.slug+'-'+width]={file,title:await title.innerText(),raw,summaries,overflow,image:await img.evaluate(x=>({src:x.currentSrc||x.src,naturalWidth:x.naturalWidth,naturalHeight:x.naturalHeight}))}
 await context.close()
}
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2));await browser.close()
