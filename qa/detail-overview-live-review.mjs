import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'search-guidance-recovery-review'
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,blocked:[],reads:[],scenarios:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function guardedPage(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method()
    const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
    const supabase=/\.supabase\.co$/i.test(url.hostname)
    if(analytics || (supabase && !['GET','HEAD','OPTIONS'].includes(method))){
      report.blocked.push({method,url:url.href,reason:analytics?'analytics':'write'})
      return route.abort('blockedbyclient')
    }
    if(supabase) report.reads.push({method,path:url.pathname,query:url.search})
    await route.continue()
  })
  return {context,page}
}
async function waitCatalog(page){
  await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})
}
async function waitWorkspace(page){
  await page.waitForFunction(()=>/\d+\s*PRODUCTS/.test(document.querySelector('.research-status')?.textContent||''),null,{timeout:90000})
}
async function waitImages(page){
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(img=>{
    const r=img.getBoundingClientRect()
    return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth
  }).every(img=>img.complete&&img.naturalWidth>0),null,{timeout:30000})
}
async function startLookup(page,query){
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog(page)
  const input=page.locator('.home-entry-search input[type="search"]')
  await input.fill(query)
  await page.locator('.home-entry-search-submit').click()
  await page.locator('.lookup-input').waitFor({state:'visible',timeout:30000})
  await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:30000})
}
async function aliasScenario(){
  const {context,page}=await guardedPage(390,844)
  await startLookup(page,'아투')
  const aatu=page.locator('.research-result-card').first()
  const aatuText=(await aatu.innerText()).replace(/\s+/g,' ').trim()
  assert.match(aatuText,/AATU/i,'아투 must find the confirmed AATU brand without changing display identity')

  const lookup=page.locator('.lookup-input')
  await lookup.fill('힐스')
  await page.waitForFunction(()=>[...document.querySelectorAll('.research-result-card')].some(el=>/Hill/i.test(el.textContent||'')),null,{timeout:30000})
  const hills=page.locator('.research-result-card').filter({hasText:/Hill/i}).first()
  const hillsText=(await hills.innerText()).replace(/\s+/g,' ').trim()
  assert.match(hillsText,/Hill/i,'힐스 must find the confirmed Hill brand')

  await lookup.fill('힐즈')
  await page.waitForTimeout(120)
  const typoCount=await page.locator('.research-result-card').count()
  assert.equal(typoCount,0,'unconfirmed similar spelling must not become fuzzy alias')

  await lookup.fill('아투')
  await aatu.waitFor({state:'visible',timeout:30000})
  await waitImages(page)
  const file='alias-lookup-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.scenarios.alias={aatuText,hillsText,unconfirmedTypoCount:typoCount,file}
  await context.close()
}
async function exploreScenario(){
  const {context,page}=await guardedPage(390,844)
  const url=new URL(BASE)
  url.searchParams.set('view','workspace')
  url.searchParams.set('mode','explore')
  url.searchParams.set('applied','1')
  url.searchParams.set('feed','건식')
  url.searchParams.set('age','adult')
  url.searchParams.set('targets','indoor')
  url.searchParams.set('features','hairball,digestive')
  await page.goto(url.href,{waitUntil:'domcontentloaded'})
  await waitWorkspace(page)
  const heading=page.locator('.research-results-heading span')
  await heading.waitFor({state:'visible',timeout:30000})
  const summary=(await heading.innerText()).replace(/\s+/g,' ').trim()
  assert.match(summary,/\d+개의 제품|\d+개 중 \d+개 표시/)
  assert.match(summary,/확인된 조건이 많은 순/)
  assert.match(summary,/미확인 조건이 있는 제품도 포함/)
  const cards=page.locator('.research-result-card')
  assert.ok(await cards.count()>0)
  const unknownCards=page.locator('.research-result-card .relation-line.is-unknown')
  assert.ok(await unknownCards.count()>0,'actual results should preserve visible unknown conditions')
  await waitImages(page)
  const file='explore-guidance-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.scenarios.explore={summary,cardCount:await cards.count(),unknownLineCount:await unknownCards.count(),file}
  await context.close()
}
async function quickViewScenario(width,height,key){
  const {context,page}=await guardedPage(width,height)
  await startLookup(page,'아투')
  const card=page.locator('.research-result-card').first()
  const id=await card.getAttribute('data-product-id')
  assert.ok(id)
  const scroller=page.locator('.research-results-scroll')
  const before=await scroller.evaluate(el=>({scrollTop:el.scrollTop,windowY:scrollY}))
  await card.focus()
  await page.keyboard.press('Enter')
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible',timeout:30000})
  const close=quick.locator('.quick-view-topline button')
  await page.waitForFunction(()=>document.activeElement?.closest('.quick-view-topline')?.querySelector('button')===document.activeElement,null,{timeout:30000})
  assert.equal(await close.evaluate(el=>document.activeElement===el),true,'quick-view close should receive focus after keyboard open')
  const openState=await scroller.evaluate(el=>({scrollTop:el.scrollTop,windowY:scrollY}))
  assert.equal(openState.scrollTop,before.scrollTop,'opening quick view must not reset the list scroller')
  await waitImages(page)
  const file=`quick-view-focus-${width}x${height}.png`
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  await page.keyboard.press('Enter')
  await quick.waitFor({state:'detached',timeout:30000})
  const after=await page.evaluate((productId)=>({
    focusedId:document.activeElement?.getAttribute('data-product-id'),
    windowY:scrollY,
    listY:document.querySelector('.research-results-scroll')?.scrollTop??null,
    productId,
  }),id)
  assert.equal(after.focusedId,id,'closing quick view must restore focus to the opening result card')
  assert.equal(after.listY,before.scrollTop,'closing quick view must preserve list scroller position')
  report.scenarios[key]={productId:id,before,openState,after,file}
  await context.close()
}
async function switchScenario(){
  const {context,page}=await guardedPage(390,844)
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog(page)
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  await waitWorkspace(page)
  const input=page.locator('.switch-find-search input')
  await input.fill('AATU')
  const row=page.locator('.switch-find-result').filter({hasText:/연어|Salmon/i}).first()
  await row.waitFor({state:'visible',timeout:30000})
  await row.click()
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  await page.getByRole('button',{name:'사용 규격을 모르겠어요'}).click()
  const noChange=page.locator('.switch-no-change')
  await noChange.waitFor({state:'visible',timeout:30000})
  await noChange.click()
  const noChangeText=(await noChange.innerText()).replace(/\s+/g,' ').trim()
  assert.match(noChangeText,/유지 조건도 고르지 않으면 전체 후보에서 탐색합니다/)
  assert.doesNotMatch(noChangeText,/비슷한 후보/)
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible',timeout:30000})
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.locator('.switch-candidate-row').first().waitFor({state:'visible',timeout:30000})
  const heading=page.locator('.switch-candidate-heading span')
  const summary=(await heading.innerText()).replace(/\s+/g,' ').trim()
  assert.match(summary,/변경·유지 조건을 고르지 않아 전체 후보에서 탐색합니다/)
  assert.doesNotMatch(summary,/비슷한 후보/)
  await waitImages(page)
  const file='switch-unfiltered-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.scenarios.switch={noChangeText,summary,candidateCount:await page.locator('.switch-candidate-row').count(),file}
  await context.close()
}

await aliasScenario()
await exploreScenario()
await quickViewScenario(390,844,'quickMobile')
await quickViewScenario(1440,900,'quickDesktop')
await switchScenario()
assert.equal(report.blocked.filter(x=>x.reason==='write').length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
