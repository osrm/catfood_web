import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'general-compare-navigation-output'
const PRODUCT_SHA=process.env.PRODUCT_SHA||''
await mkdir(OUT,{recursive:true})

const report={productSha:PRODUCT_SHA,blocked:[],reads:[],snapshots:{},selection:{},measurements:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'})
const page=await context.newPage()
const norm=value=>String(value||'').replace(/\s+/g,' ').trim()
const compareParam=()=>new URL(page.url()).searchParams.get('compare')?.split(',').filter(Boolean)||[]

await page.route('**/*',async route=>{
  const req=route.request(), url=new URL(req.url()), method=req.method()
  const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
  const supabase=/\.supabase\.co$/i.test(url.hostname)
  const local=url.origin===new URL(BASE).origin
  const google=/googleapis\.com$|gstatic\.com$/i.test(url.hostname)
  if(analytics || (supabase&&!['GET','HEAD','OPTIONS'].includes(method))){
    report.blocked.push({method,url:url.href,reason:analytics?'analytics':'write'})
    return route.abort('blockedbyclient')
  }
  if(supabase) report.reads.push({method,path:url.pathname,query:url.search})
  if(!local&&!supabase&&!google) return route.abort('blockedbyclient')
  await route.continue()
})

async function visibleButton(name){
  const xs=page.getByRole('button',{name,exact:true})
  for(let i=0;i<await xs.count();i++) if(await xs.nth(i).isVisible()) return xs.nth(i)
  throw new Error('visible button not found: '+name)
}
async function waitCatalog(){
  await page.waitForFunction(()=>/\d+\s*PRODUCTS/.test(document.querySelector('.research-status')?.textContent||''),null,{timeout:90000})
}
async function quickAdd(card){
  const id=await card.getAttribute('data-product-id')
  await card.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  const name=norm(await quick.locator('.quick-view-identity h1').textContent())
  const add=quick.locator('.quick-view-actions button').first()
  assert.match(norm(await add.textContent()),/비교에 추가/)
  await add.click()
  assert.match(norm(await add.textContent()),/비교에서 제거/)
  await quick.getByRole('button',{name:'닫기 ×',exact:true}).click()
  await quick.waitFor({state:'detached'})
  return{id,name}
}
async function dockCount(count){
  const dock=page.locator('.switch-compare-dock')
  await dock.waitFor({state:'visible'})
  assert.match(norm(await dock.textContent()),new RegExp('비교 '+count+'/5'))
  return dock
}

const start=new URL(BASE)
start.searchParams.set('view','workspace')
await page.goto(start.href,{waitUntil:'domcontentloaded',timeout:30000})
await waitCatalog()
await (await visibleButton('건식')).click()
await (await visibleButton('성묘')).click()
await (await visibleButton('이 조건으로 찾기')).click()
await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:90000})

const first=await quickAdd(page.locator('.research-result-card').nth(0))
const secondCard=page.locator('.research-result-card').filter({hasNot:page.locator('[data-product-id="'+first.id+'"]')})
let second=null
for(let i=0;i<await page.locator('.research-result-card').count();i++){
  const card=page.locator('.research-result-card').nth(i)
  if(await card.getAttribute('data-product-id')!==first.id){second=await quickAdd(card);break}
}
assert.ok(second)
await dockCount(2)
assert.deepEqual(compareParam(),[first.id,second.id])
report.snapshots.exploreTwo={url:page.url(),compare:compareParam(),names:[first.name,second.name]}
await page.screenshot({path:OUT+'/01-explore-two-390x844.png',fullPage:false})

await (await visibleButton('제품 찾기')).click()
await page.locator('.lookup-input').waitFor({state:'visible'})
assert.deepEqual(compareParam(),[first.id,second.id])
assert.equal(new URL(page.url()).searchParams.get('feed'),'건식')
assert.equal(new URL(page.url()).searchParams.get('age'),'adult')
assert.equal(new URL(page.url()).searchParams.get('applied'),'1')
await dockCount(2)

async function findThird(){
  for(const query of ['GO!','AATU','로얄']){
    await page.locator('.lookup-input').fill(query)
    await page.waitForTimeout(120)
    const cards=page.locator('.research-result-card')
    for(let i=0;i<await cards.count();i++){
      const card=cards.nth(i), id=await card.getAttribute('data-product-id')
      if(id&&id!==first.id&&id!==second.id) return quickAdd(card)
    }
  }
  throw new Error('third lookup product not found')
}
const third=await findThird()
await dockCount(3)
const threeIds=[first.id,second.id,third.id]
assert.deepEqual(compareParam(),threeIds)
report.snapshots.lookupThree={url:page.url(),compare:compareParam(),names:[first.name,second.name,third.name]}

await page.locator('.lookup-input').fill('no-such-product-query-zzzz')
await page.waitForFunction(()=>/검색 결과가 없습니다/.test(document.querySelector('.state-message')?.textContent||''),null,{timeout:30000})
assert.equal(await page.locator('.research-result-card').count(),0)
await dockCount(3)
assert.deepEqual(compareParam(),threeIds)
report.snapshots.lookupZero={url:page.url(),compare:compareParam(),zeroResults:true}
await page.screenshot({path:OUT+'/02-lookup-zero-three-390x844.png',fullPage:false})

await page.goBack()
await page.waitForFunction(()=>document.querySelector('.mode-button[aria-current="page"]')?.textContent?.includes('조건으로 찾기'),null,{timeout:30000})
await dockCount(2)
assert.deepEqual(compareParam(),[first.id,second.id])
report.snapshots.historyBack={url:page.url(),compare:compareParam()}

await page.goForward()
await page.waitForFunction(()=>document.querySelector('.mode-button[aria-current="page"]')?.textContent?.includes('제품 찾기'),null,{timeout:30000})
await page.locator('.lookup-input').waitFor({state:'visible'})
await dockCount(3)
assert.deepEqual(compareParam(),threeIds)
assert.equal(new URL(page.url()).searchParams.get('feed'),'건식')
assert.equal(new URL(page.url()).searchParams.get('age'),'adult')
assert.match(norm(await page.locator('.state-message').textContent()),/검색 결과가 없습니다/)
report.snapshots.historyForward={url:page.url(),compare:compareParam(),feed:new URL(page.url()).searchParams.get('feed'),age:new URL(page.url()).searchParams.get('age')}

await (await visibleButton('조건으로 찾기')).click()
await page.locator('.condition-actions').waitFor({state:'visible'})
assert.equal(await page.locator('.switch-compare-dock').count(),0)
assert.deepEqual(compareParam(),threeIds)
report.snapshots.exploreEditor={url:page.url(),compare:compareParam(),dockHidden:true}

await (await visibleButton('이 조건으로 찾기')).click()
await dockCount(3)
assert.deepEqual(compareParam(),threeIds)
assert.equal(new URL(page.url()).searchParams.get('feed'),'건식')
assert.equal(new URL(page.url()).searchParams.get('age'),'adult')
report.snapshots.exploreReapplied={url:page.url(),compare:compareParam(),feed:new URL(page.url()).searchParams.get('feed'),age:new URL(page.url()).searchParams.get('age')}
await page.screenshot({path:OUT+'/03-explore-three-reapplied-390x844.png',fullPage:false})

await (await visibleButton('조건 수정')).click()
await page.locator('.condition-actions').waitFor({state:'visible'})
assert.deepEqual(compareParam(),threeIds)
await (await visibleButton('이 조건으로 찾기')).click()
await dockCount(3)
assert.deepEqual(compareParam(),threeIds)
report.snapshots.explicitSameReapply={url:page.url(),compare:compareParam()}

await page.locator('.switch-compare-dock button').click()
await page.locator('.compare-stage').waitFor({state:'visible'})
const headNames=await page.locator('.compare-product-head .compare-product-copy strong').allInnerTexts()
assert.deepEqual(headNames.map(norm),[first.name,second.name,third.name])
report.selection={ids:threeIds,names:[first.name,second.name,third.name],compareHeadNames:headNames.map(norm)}
await page.screenshot({path:OUT+'/04-compare-three-390x844.png',fullPage:false})
await page.screenshot({path:OUT+'/05-compare-three-full-390.png',fullPage:true})

report.measurements=await page.evaluate(()=>{
  const doc=document.scrollingElement||document.documentElement
  const stage=document.querySelector('.compare-stage')
  const dock=document.querySelector('.switch-compare-dock')
  return{
    viewport:{width:innerWidth,height:innerHeight},
    document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
    compareStage:stage?{clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth}:null,
    dock:dock?{clientWidth:dock.clientWidth,scrollWidth:dock.scrollWidth}:null,
    compareHeadCount:document.querySelectorAll('.compare-product-head').length,
  }
})
assert.equal(report.measurements.viewport.width,390)
assert.equal(report.measurements.compareHeadCount,3)
assert.ok(report.reads.some(x=>x.path.endsWith('/effective_product_catalog_summary')))
assert.equal(report.blocked.filter(x=>x.reason==='write').length,0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))

await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await context.close()
await browser.close()
