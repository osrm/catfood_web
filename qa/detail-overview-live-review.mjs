import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'pr72-postdeploy'
await mkdir(OUT,{recursive:true})
const report={mergeSha:process.env.PRODUCT_SHA,base:BASE,blocked:[],reads:[],explore:null,compare:null}
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
async function exploreOmitted(){
  const {context,page}=await guardedPage(390,844)
  const sets=[
    {targets:'indoor,sterilized',features:'weight_management,stool,hairball,digestive,urinary,skin_coat,dental'},
    {targets:'indoor',features:'hairball,digestive,urinary,skin_coat,dental'},
  ]
  let found=null
  for(const set of sets){
    const url=new URL(BASE)
    url.searchParams.set('view','workspace')
    url.searchParams.set('mode','explore')
    url.searchParams.set('applied','1')
    url.searchParams.set('feed','건식')
    url.searchParams.set('age','adult')
    url.searchParams.set('targets',set.targets)
    url.searchParams.set('features',set.features)
    await page.goto(url.href,{waitUntil:'domcontentloaded'})
    await waitWorkspaceCatalog(page)
    await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:30000})
    const cards=page.locator('.research-result-card')
    for(let i=0;i<Math.min(await cards.count(),40);i++){
      const text=await cards.nth(i).innerText()
      if(/외 \d+개/.test(text)){found={text,index:i,url:page.url()};break}
    }
    if(found) break
  }
  assert.ok(found,'EXPLORE live results did not expose an omitted-condition count')
  assert.match(found.text,/외 \d+개/)
  await waitVisibleImages(page)
  const file='postdeploy-explore-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
  report.explore={...found,file}
  await context.close()
}
async function compareReturn(){
  const {context,page}=await guardedPage(1440,900)
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitHomeCatalog(page)
  const home=page.locator('.home-entry-search input[type="search"]')
  await home.waitFor({state:'visible',timeout:30000})
  await home.fill('GO!')
  await page.locator('.home-entry-search-submit').click()
  await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:30000})
  const cards=page.locator('.research-result-card')
  assert.ok(await cards.count()>=2,'need at least two lookup results for compare postdeploy')
  const names=[]
  for(let i=0;i<2;i++){
    const card=cards.nth(i)
    names.push((await card.locator('.research-result-identity > strong').innerText()).trim())
    await card.click()
    const quick=page.locator('.research-quick-view')
    await quick.waitFor({state:'visible'})
    await quick.getByRole('button',{name:/비교에 추가/}).click()
    await quick.getByRole('button',{name:/닫기/}).click()
    await page.locator('.research-result-card').first().waitFor({state:'visible'})
  }
  await page.getByRole('button',{name:/비교 보기/}).click()
  const compare=page.locator('.compare-stage')
  await compare.waitFor({state:'visible',timeout:30000})
  const comparisonUrl=page.url()
  const detailLink=page.locator('.compare-detail-link').first()
  await detailLink.click()
  await page.locator('.detail-stage').waitFor({state:'visible',timeout:30000})
  const back=page.locator('.detail-topbar button')
  assert.equal((await back.innerText()).trim(),'← 비교로 돌아가기')
  await waitVisibleImages(page)
  const file='postdeploy-compare-detail-1440x900.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
  await back.click()
  await compare.waitFor({state:'visible',timeout:30000})
  assert.equal(page.url(),comparisonUrl,'explicit compare return should restore the same comparison URL')
  assert.ok(await page.locator('.compare-product-head').count()>=2)
  report.compare={names,backLabel:'← 비교로 돌아가기',comparisonUrl,file}
  await context.close()
}

await exploreOmitted()
await compareReturn()
assert.equal(report.blocked.length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
