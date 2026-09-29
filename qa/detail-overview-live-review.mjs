import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'compare-consumer-review'
await mkdir(OUT,{recursive:true})
const report={base:BASE,productSha:process.env.PRODUCT_SHA,blocked:[],reads:[],views:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'})
const page=await context.newPage()

await page.route('**/*',async route=>{
  const req=route.request(), url=new URL(req.url()), method=req.method()
  const isAnalytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
  const isSupabase=/\.supabase\.co$/i.test(url.hostname)
  if(isAnalytics || (isSupabase && !['GET','HEAD','OPTIONS'].includes(method))){
    report.blocked.push({method,url:url.href})
    return route.abort('blockedbyclient')
  }
  if(isSupabase) report.reads.push({method,url:url.pathname})
  await route.continue()
})

async function waitCatalog(){ await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000}) }
async function waitImages(){
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(img=>{
    const r=img.getBoundingClientRect()
    return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth
  }).every(img=>img.complete&&img.naturalWidth>0),null,{timeout:30000})
}
async function addLookup(query, namePattern){
  const input=page.locator('.lookup-input')
  await input.fill(query)
  const card=page.locator('.research-result-card').filter({hasText:namePattern}).first()
  await card.waitFor({state:'visible',timeout:30000})
  await card.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  await waitImages()
  const add=quick.getByRole('button',{name:/비교에 추가/})
  await add.click()
  await quick.getByRole('button',{name:/닫기/}).click()
  await page.locator('.research-results').waitFor({state:'visible'})
}

await page.goto(BASE,{waitUntil:'domcontentloaded'})
await waitCatalog()
const homeSearch=page.locator('.home-entry-search input[type="search"]')
await homeSearch.waitFor({state:'visible',timeout:30000})
await homeSearch.fill('AATU')
await page.locator('.home-entry-search-submit').click()
const input=page.locator('.lookup-input')
await input.waitFor({state:'visible'})

await addLookup('AATU',/연어/)
await addLookup('GO!',/GO!|고!/i)
await page.locator('.switch-compare-dock').getByRole('button',{name:/비교 보기/}).click()
await page.getByRole('heading',{name:'제품 비교'}).waitFor()
await waitImages()

async function capture(tab,file){
  if(tab!=='개요'){
    await page.getByRole('tab',{name:tab,exact:true}).click()
    if(tab==='영양') await page.getByText('영양 성분',{exact:true}).waitFor({timeout:60000})
    if(tab==='원재료') await page.getByText('원재료',{exact:true}).last().waitFor({timeout:60000})
  }
  await waitImages()
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
  const stage=page.locator('.compare-stage')
  report.views[tab]={
    file,
    header:await page.locator('.compare-header').innerText(),
    sections:await stage.locator('.compare-section-row').allInnerTexts(),
    rows:await stage.locator('.compare-row').allInnerTexts(),
    footnote:await stage.locator('.compare-footnote').count()?await stage.locator('.compare-footnote').innerText():null,
    scrollWidth:await page.locator('.compare-table-wrap').evaluate(el=>({clientWidth:el.clientWidth,scrollWidth:el.scrollWidth}))
  }
}

await capture('개요','compare-overview-1440x900.png')
await capture('영양','compare-nutrition-1440x900.png')
await capture('원재료','compare-ingredients-1440x900.png')

assert.ok(report.views['개요'].rows.length>0)
assert.ok(report.views['영양'].rows.some(x=>x.includes('조단백질')))
assert.ok(report.views['원재료'].rows.some(x=>x.includes('출처 원문')))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
