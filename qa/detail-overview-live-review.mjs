import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'detail-context-review'
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,base:BASE,blocked:[],reads:[],products:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'})
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

async function waitCatalog(){await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})}
async function waitVisibleImages(){
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(img=>{
    const r=img.getBoundingClientRect()
    return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth
  }).every(img=>img.complete&&img.naturalWidth>0),null,{timeout:30000})
}
async function gotoLookup(query){
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog()
  const home=page.locator('.home-entry-search input[type="search"]')
  await home.waitFor({state:'visible',timeout:30000})
  await home.fill(query)
  await page.locator('.home-entry-search-submit').click()
  await page.locator('.lookup-input').waitFor({state:'visible'})
}
async function openDetail(query,pattern){
  await gotoLookup(query)
  const input=page.locator('.lookup-input')
  await input.fill(query)
  const card=page.locator('.research-result-card').filter({hasText:pattern}).first()
  await card.waitFor({state:'visible',timeout:30000})
  await card.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  await waitVisibleImages()
  await quick.getByRole('button',{name:/상세 보기/}).click()
  await page.locator('.detail-stage').waitFor({state:'visible'})
  await page.getByRole('tab',{name:'제조 · 유통',exact:true}).click()
  await page.getByText('제조 정보를 불러오는 중입니다.').waitFor({state:'hidden',timeout:60000})
  await page.getByText('유통 정보를 불러오는 중입니다.').waitFor({state:'hidden',timeout:60000})
  await page.getByRole('heading',{name:'제조 정보',exact:true}).waitFor({state:'visible'})
  await waitVisibleImages()
}
async function capture(key,query,pattern,file){
  await openDetail(query,pattern)
  const title=await page.locator('.detail-identity-copy h1').innerText()
  const sections=await page.locator('.detail-body .detail-section').allInnerTexts()
  const manufacturing=page.locator('.detail-body .detail-section').filter({has:page.getByRole('heading',{name:'제조 정보',exact:true})}).first()
  const markets=page.locator('.detail-body .detail-section').filter({has:page.getByRole('heading',{name:'해외 판매 · 배합 확인',exact:true})}).first()
  report.products[key]={
    title,
    manufacturing:await manufacturing.innerText(),
    markets:await markets.innerText(),
    facts:await manufacturing.locator('.detail-fact').allInnerTexts(),
    notes:await manufacturing.locator('.detail-note').allInnerTexts(),
    marketRows:await markets.locator('.detail-market-row').allInnerTexts(),
    sections,
    file,
  }
  await page.evaluate(()=>scrollTo(0,0))
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
}

await capture('go','GO!',/오리|Duck/i,'detail-context-go-1440x900.png')
await capture('dental','덴탈케어',/덴탈케어|Dental Care/i,'detail-context-dentalcare-1440x900.png')

assert.match(report.products.go.title,/GO!|오리|Duck/i)
assert.match(report.products.dental.title,/덴탈케어|Dental Care/i)
assert.equal(report.blocked.length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
