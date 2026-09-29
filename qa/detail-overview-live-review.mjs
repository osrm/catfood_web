import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'detail-manufacturing-postdeploy'
await mkdir(OUT,{recursive:true})
const report={mergeSha:process.env.PRODUCT_SHA,base:BASE,blocked:[],reads:[],views:{},interactions:[]}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function guardedPage(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method()
    const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
    const supabase=/\.supabase\.co$/i.test(url.hostname)
    if(analytics || (supabase && !['GET','HEAD','OPTIONS'].includes(method))){
      report.blocked.push({method,url:url.href})
      return route.abort('blockedbyclient')
    }
    if(supabase) report.reads.push({method,path:url.pathname,query:url.search})
    await route.continue()
  })
  return {context,page}
}
async function waitCatalog(page){await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})}
async function waitVisibleImages(page){
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(img=>{
    const r=img.getBoundingClientRect()
    return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth
  }).every(img=>img.complete&&img.naturalWidth>0),null,{timeout:30000})
}
async function gotoLookup(page,query){
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog(page)
  const home=page.locator('.home-entry-search input[type="search"]')
  await home.waitFor({state:'visible',timeout:30000})
  await home.fill(query)
  await page.locator('.home-entry-search-submit').click()
  await page.locator('.lookup-input').waitFor({state:'visible'})
}
async function openContext(page,query,pattern){
  await gotoLookup(page,query)
  const input=page.locator('.lookup-input')
  await input.fill(query)
  const card=page.locator('.research-result-card').filter({hasText:pattern}).first()
  await card.waitFor({state:'visible',timeout:30000})
  await card.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  await waitVisibleImages(page)
  await quick.getByRole('button',{name:/상세 보기/}).click()
  await page.locator('.detail-stage').waitFor({state:'visible'})
  await page.getByRole('tab',{name:'제조 · 유통',exact:true}).click()
  await page.getByText('제조 정보를 불러오는 중입니다.').waitFor({state:'hidden',timeout:60000})
  await page.getByText('유통 정보를 불러오는 중입니다.').waitFor({state:'hidden',timeout:60000})
  await page.getByRole('heading',{name:'제조 정보',exact:true}).waitFor({state:'visible'})
  await waitVisibleImages(page)
}
async function pointerToggle(details,label){
  const summary=details.locator('summary')
  assert.equal(await details.evaluate(el=>el.open),false,label+' default closed')
  await summary.click()
  assert.equal(await details.evaluate(el=>el.open),true,label+' pointer opens')
  await summary.click()
  assert.equal(await details.evaluate(el=>el.open),false,label+' pointer closes')
  report.interactions.push(label+': pointer open/close')
}
async function keyboardToggle(page,details,label){
  const summary=details.locator('summary')
  await page.getByRole('tab',{name:'제조 · 유통',exact:true}).focus()
  let reached=false
  for(let i=0;i<40;i++){
    await page.keyboard.press('Tab')
    if(await summary.evaluate(el=>document.activeElement===el)){reached=true;break}
  }
  assert.equal(reached,true,label+' reached by Tab')
  await page.keyboard.press('Enter')
  assert.equal(await details.evaluate(el=>el.open),true,label+' Enter opens')
  await page.keyboard.press('Enter')
  assert.equal(await details.evaluate(el=>el.open),false,label+' Enter closes')
  report.interactions.push(label+': Tab + Enter open/close')
}
async function dental390(){
  const {context,page}=await guardedPage(390,844)
  await openContext(page,'덴탈케어',/덴탈케어|Dental Care/i)
  const manufacturing=page.locator('.detail-body .detail-section').filter({has:page.getByRole('heading',{name:'제조 정보',exact:true})}).first()
  await page.waitForFunction(()=>{
    const text=[...document.querySelectorAll('.detail-section')].find(x=>x.querySelector('h2')?.textContent?.trim()==='제조 정보')?.textContent||''
    return text.includes('3.5 kg 포장에서 확인')&&!text.includes('포장 규격 확인 중')
  },null,{timeout:60000})
  const manufacturingText=await manufacturing.innerText()
  assert.match(manufacturingText,/한국/)
  assert.match(manufacturingText,/3\.5 kg 포장에서 확인/)
  assert.match(manufacturingText,/확인되지 않은 다른 규격에는 적용하지 않습니다/)
  assert.doesNotMatch(manufacturingText,/1\.5 kg 포장에서 확인|8 kg 포장에서 확인/)

  const market=page.locator('.detail-market-disclosure').first()
  assert.equal(await market.count(),1)
  assert.equal(await market.evaluate(el=>el.open),false)
  await pointerToggle(market,'dental-390 market')
  await keyboardToggle(page,market,'dental-390 market')
  await market.locator('summary').click()
  const marketText=await market.innerText()
  assert.match(marketText,/유통/)
  assert.match(marketText,/한국 제품과의 배합 비교/)
  await market.locator('summary').click()

  await page.evaluate(()=>scrollTo(0,0))
  await waitVisibleImages(page)
  const file='postdeploy-dental-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
  report.views.dental390={manufacturing:manufacturingText,market:marketText,file}
  await context.close()
}
async function go1440(){
  const {context,page}=await guardedPage(1440,900)
  await openContext(page,'GO!',/오리|Duck/i)
  const manufacturing=page.locator('.detail-body .detail-section').filter({has:page.getByRole('heading',{name:'제조 정보',exact:true})}).first()
  const manufacturingText=await manufacturing.innerText()
  assert.match(manufacturingText,/제조국\s*캐나다/)
  assert.doesNotMatch(manufacturingText,/제조 업체와 공장 정보는 확인하지 못했습니다/)
  const extra=manufacturing.locator('details').filter({has:page.locator('summary',{hasText:'추가 제조 정보 보기'})})
  assert.equal(await extra.count(),0,'GO! should not render empty additional manufacturing disclosure')

  const market=page.locator('.detail-market-disclosure').first()
  assert.equal(await market.count(),1)
  assert.equal(await market.evaluate(el=>el.open),false)
  await market.locator('summary').click()
  const marketText=await market.innerText()
  assert.match(marketText,/유통/)
  assert.match(marketText,/한국 제품과의 배합 비교/)
  assert.ok((await market.locator('.detail-market-row').count())>0)
  await market.locator('summary').click()

  await page.evaluate(()=>scrollTo(0,0))
  await waitVisibleImages(page)
  const file='postdeploy-go-1440x900.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
  report.views.go1440={manufacturing:manufacturingText,market:marketText,file}
  await context.close()
}

await dental390()
await go1440()
assert.equal(report.blocked.length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
