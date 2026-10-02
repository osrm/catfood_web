import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'pr95-consumer-theme-candidate-output'
const PRODUCT_SHA=process.env.PRODUCT_SHA||''
await mkdir(OUT,{recursive:true})
const report={productSha:PRODUCT_SHA,source:'exact production build + public production Supabase reads',network:{reads:[],blocked:[],requestFailures:[],responseFailures:[]},mobile:{},desktop:{},screenshots:{}}
const clean=v=>String(v||'').replace(/\s+/g,' ').trim()
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function guardedPage(viewport){
  const context=await browser.newContext({viewport,serviceWorkers:'block'})
  const page=await context.newPage()
  page.on('requestfailed',req=>report.network.requestFailures.push({method:req.method(),url:req.url(),failure:req.failure()?.errorText||'unknown'}))
  page.on('response',res=>{if(res.status()>=400)report.network.responseFailures.push({status:res.status(),url:res.url()})})
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method()
    const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
    if(analytics || (url.hostname.endsWith('.supabase.co') && !['GET','HEAD','OPTIONS'].includes(method))){
      report.network.blocked.push({method,url:url.href,reason:analytics?'analytics':'write'})
      return route.abort('blockedbyclient')
    }
    if(url.hostname.endsWith('.supabase.co')) report.network.reads.push({method,path:url.pathname,query:url.search})
    await route.continue()
  })
  return {context,page}
}
async function settle(page){
  await page.evaluate(async()=>{
    if(document.fonts?.ready) await document.fonts.ready
    const visible=[...document.images].filter(img=>{const r=img.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth})
    await Promise.all(visible.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{
      let done=false;const finish=()=>{if(done)return;done=true;resolve()}
      img.addEventListener('load',finish,{once:true});img.addEventListener('error',finish,{once:true});setTimeout(finish,12000)
    })))
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))
  })
}
async function waitCatalog(page){
  await page.waitForFunction(()=>/(\d+\s*PRODUCTS|현재 확인된 제품\s*\d+개)/.test(document.body.textContent||''),null,{timeout:90000})
  await settle(page)
}
async function shot(page,name){
  await settle(page)
  const meta=await page.evaluate(()=>{
    const visible=[...document.images].filter(img=>{const r=img.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth})
    return {url:location.href,scrollY,fontStatus:document.fonts?.status||'unsupported',document:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight},visibleImages:visible.map(i=>({src:i.currentSrc||i.src,outcome:i.complete&&i.naturalWidth>0?'loaded':i.complete?'failed':'pending'}))}
  })
  await page.screenshot({path:OUT+'/'+name,fullPage:false})
  report.screenshots[name]=meta
}
async function theme(page){
 return page.evaluate(()=>{
   const val=(sel,prop)=>{const el=document.querySelector(sel);return el?getComputedStyle(el)[prop]:null}
   return {
    bodyBg:val('body','backgroundColor'),bodyFont:val('body','fontFamily'),bodyColor:val('body','color'),
    primaryBg:val('.home-entry-search-submit,.switch-primary-action,.switch-compare-dock button','backgroundColor'),
    topbarBg:val('.research-topbar,.detail-topbar,.home-header','backgroundColor'),
    mainFont:val('main','fontFamily'),
   }
 })
}
async function rect(page,sel){
 return page.locator(sel).first().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,text:(el.textContent||'').replace(/\s+/g,' ').trim(),fontSize:getComputedStyle(el).fontSize}})
}
async function buttonByText(page,text){
 const all=page.locator('button')
 for(let i=0;i<await all.count();i++){const b=all.nth(i);if((clean(await b.textContent())).includes(text) && await b.isVisible()) return b}
 throw new Error('missing button '+text)
}

async function runMobile(){
 const {context,page}=await guardedPage({width:390,height:844})
 await page.goto(BASE,{waitUntil:'domcontentloaded'});await waitCatalog(page)
 report.mobile.home={theme:await theme(page),title:clean(await page.locator('.home-start-copy').textContent())}
 assert.match(report.mobile.home.title,/이 사료와 저 사료,\s*뭐가 다를까요\?/)
 assert.match(report.mobile.home.title,/원재료와 영양 성분을 한곳에서 확인할 수 있어요/)
 await shot(page,'01-home-mobile-390x844.png')

 await page.getByRole('button',{name:'조건 고르기 →'}).click();await waitCatalog(page)
 const dry=page.getByRole('button',{name:'건식',exact:true});if(await dry.count())await dry.first().click()
 const adult=page.getByRole('button',{name:'성묘',exact:true});if(await adult.count())await adult.first().click()
 await page.getByRole('button',{name:'이 조건으로 찾기'}).click()
 await page.locator('.research-result-row').first().waitFor({state:'visible',timeout:90000});await settle(page)
 report.mobile.results={theme:await theme(page),first:await rect(page,'.research-result-card'),image:await rect(page,'.research-result-image'),overflow:await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)}
 assert.equal(report.mobile.results.overflow,0)
 await shot(page,'02-results-mobile-390x844.png')
 const rows=page.locator('.research-result-row');await rows.nth(0).locator('.research-result-compare').click();await rows.nth(1).locator('.research-result-compare').click()
 await rows.nth(0).locator('.research-result-card').click();await page.locator('.research-quick-view').waitFor({state:'visible'})
 await page.getByRole('button',{name:'상세 보기 →'}).click();await page.locator('.detail-stage').waitFor({state:'visible'});await settle(page)
 report.mobile.detail={theme:await theme(page),identity:await rect(page,'.detail-identity'),tabs:await page.locator('.detail-tabs button').allTextContents(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)}
 assert.deepEqual(report.mobile.detail.tabs.map(clean),['개요','원재료','영양','제조 · 유통'])
 assert.equal(report.mobile.detail.overflow,0)
 await shot(page,'03-detail-mobile-390x844.png')
 await page.getByRole('tab',{name:'원재료'}).click();await settle(page)
 const ing=await page.locator('.detail-ingredient-list span,.detail-ingredient-copy').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)).catch(()=>15.5)
 assert.ok(ing>=15.5,'ingredient font too small: '+ing)
 report.mobile.detail.ingredientFont=ing
 await page.locator('.detail-topbar button').click();await page.locator('.switch-compare-dock').waitFor({state:'visible'})
 await page.locator('.switch-compare-dock button').click();await page.locator('.compare-stage').waitFor({state:'visible'});await settle(page)
 const compareFont=await page.locator('.compare-cell').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize))
 report.mobile.compare={theme:await theme(page),fontSize:compareFont,overflow:await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),internal:await page.locator('.compare-table-wrap').evaluate(el=>el.scrollWidth-el.clientWidth)}
 assert.ok(compareFont>=15.5);assert.equal(report.mobile.compare.overflow,0)
 await shot(page,'04-compare-mobile-390x844.png')
 await context.close()

 const sw=await guardedPage({width:390,height:844});const p=sw.page
 await p.goto(BASE,{waitUntil:'domcontentloaded'});await waitCatalog(p);await p.getByRole('button',{name:'현재 사료로 시작 →'}).click();await waitCatalog(p)
 await p.locator('.switch-find-search input').fill('AATU')
 const result=p.locator('.switch-find-result').filter({hasText:/연어/}).first();await result.waitFor({state:'visible',timeout:30000});await result.click();await p.locator('.switch-current-preview').waitFor({state:'visible'});await settle(p)
 const cta=await rect(p,'.switch-preview-primary'),facts=await rect(p,'.switch-preview-facts')
 report.mobile.switch={theme:await theme(p),cta,facts,overflow:await p.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)}
 assert.ok(cta.visible && cta.bottom<=844,JSON.stringify(cta));assert.ok(cta.top<facts.top);assert.equal(report.mobile.switch.overflow,0)
 await shot(p,'05-switch-mobile-390x844.png')
 await p.locator('.switch-preview-primary').click();await p.locator('.switch-sku-option').first().waitFor({state:'visible',timeout:30000})
 const sku=p.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first();if(await sku.count())await sku.click();else await p.locator('.switch-sku-option').first().click()
 await p.locator('.switch-step-actions .switch-primary-action').click();await p.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor()
 const brand=await buttonByText(p,'다른 브랜드로 보기');await brand.click();await p.locator('.switch-step-actions .switch-primary-action').click()
 await p.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor();const keep=p.getByRole('button',{name:'건식 유지',exact:true});if(await keep.count())await keep.click()
 await p.getByRole('button',{name:'후보 제품 보기 →'}).click();await p.locator('.switch-candidate-row').first().waitFor({state:'visible',timeout:90000})
 const search=p.getByLabel('후보 제품 검색');await search.fill('GO!');await p.waitForTimeout(500);await p.locator('.switch-candidate-row').first().click();await p.locator('.switch-candidate-inspector').waitFor({state:'visible'})
 await p.locator('.switch-inspector-actions button').filter({hasText:'비교에 추가'}).click()
 report.mobile.switch.regression={candidateSearch:await search.inputValue(),compareCount:await p.locator('.switch-compare-dock').count()}
 await sw.context.close()
}
async function captureDesktop(url,name,kind){
 const {context,page}=await guardedPage({width:1440,height:900})
 await page.goto(url,{waitUntil:'domcontentloaded'});await waitCatalog(page);await settle(page)
 const data={theme:await theme(page),overflow:await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)}
 assert.equal(data.overflow,0,kind+' document overflow')
 report.desktop[kind]=data;await shot(page,name);await context.close()
}
await runMobile()
const m=report.screenshots
await captureDesktop(BASE,'06-home-desktop-1440x900.png','home')
await captureDesktop(m['02-results-mobile-390x844.png'].url,'07-results-desktop-1440x900.png','results')
await captureDesktop(m['03-detail-mobile-390x844.png'].url,'08-detail-desktop-1440x900.png','detail')
await captureDesktop(m['04-compare-mobile-390x844.png'].url,'09-compare-desktop-1440x900.png','compare')
{
 const {context,page}=await guardedPage({width:1440,height:900})
 await page.goto(BASE,{waitUntil:'domcontentloaded'});await waitCatalog(page);await page.getByRole('button',{name:'현재 사료로 시작 →'}).click();await waitCatalog(page)
 await page.locator('.switch-find-search input').fill('AATU');const r=page.locator('.switch-find-result').filter({hasText:/연어/}).first();await r.waitFor({state:'visible'});await r.click();await settle(page)
 report.desktop.switch={theme:await theme(page),cta:await rect(page,'.switch-preview-primary'),overflow:await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)}
 assert.equal(report.desktop.switch.overflow,0);await shot(page,'10-switch-desktop-1440x900.png');await context.close()
}
report.network.summary={publicReadCount:report.network.reads.length,blockedWriteAttempts:report.network.blocked.filter(x=>x.reason==='write').length,blockedAnalyticsAttempts:report.network.blocked.filter(x=>x.reason==='analytics').length,requestFailureCount:report.network.requestFailures.length,responseFailureCount:report.network.responseFailures.length}
assert.ok(report.network.summary.publicReadCount>0);assert.equal(report.network.summary.blockedWriteAttempts,0);assert.equal(report.network.summary.blockedAnalyticsAttempts,0)
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await browser.close()
