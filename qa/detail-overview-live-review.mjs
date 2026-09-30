import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'pr74-postdeploy'
await mkdir(OUT,{recursive:true})
const report={mergeSha:process.env.PRODUCT_SHA,base:BASE,blocked:[],reads:[],screens:{},interactions:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function guardedPage(){
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'})
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
async function openHome(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog(page)
}
async function startLookup(page,query){
  await openHome(page)
  const input=page.locator('.home-entry-search input[type="search"]')
  await input.fill(query)
  await page.locator('.home-entry-search-submit').click()
  await page.locator('.lookup-input').waitFor({state:'visible',timeout:30000})
}
async function homeScreen(){
  const {context,page}=await guardedPage()
  await openHome(page)
  const route=page.locator('.home-entry-route').filter({hasText:'조건으로 찾아보기'})
  await route.scrollIntoViewIfNeeded()
  const text=(await route.innerText()).replace(/\s+/g,' ').trim()
  assert.match(text,/사료 형태·연령과 원하는 조건을 골라 제품을 살펴봅니다\./)
  assert.doesNotMatch(text,/명백히 충돌|미확인은 남겨둡니다/)
  const file='postdeploy-home-explore-guidance-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.screens.home={text,file}
  await context.close()
}
async function conditionScreen(){
  const {context,page}=await guardedPage()
  await openHome(page)
  await page.getByRole('button',{name:'조건 고르기 →'}).click()
  const heading=page.locator('.research-pane-heading')
  await heading.waitFor({state:'visible',timeout:30000})
  const headingText=(await heading.innerText()).replace(/\s+/g,' ').trim()
  const policy=page.locator('.condition-policy-note')
  const policyText=(await policy.innerText()).replace(/\s+/g,' ').trim()
  assert.match(headingText,/사료 형태·연령과 원하는 조건을 고릅니다\./)
  assert.equal(policyText,'선택한 조건 정보가 없는 제품도 결과에 남습니다.')
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ')
  assert.equal((body.match(/선택한 조건 정보가 없는 제품도 결과에 남습니다\./g)||[]).length,1)
  assert.doesNotMatch(body,/명백히 충돌하는 제품만 제외|미확인은 남겨둡니다/)
  const file='postdeploy-explore-condition-entry-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.screens.condition={headingText,policyText,file}
  await context.close()
}
async function recipeScreen(){
  const {context,page}=await guardedPage()
  await openHome(page)
  await page.getByRole('button',{name:'조건 고르기 →'}).click()
  await page.locator('button.choice').filter({hasText:'건식'}).first().click()
  await page.getByRole('button',{name:'이 조건으로 찾기'}).click()
  const refine=page.getByRole('button',{name:'더 좁혀보기'})
  await refine.waitFor({state:'visible',timeout:30000})
  await refine.click()
  const section=page.locator('.filter-section').filter({hasText:'주요 레시피'}).first()
  await section.waitFor({state:'visible',timeout:30000})
  const note=section.locator('.field-note').first()
  await note.scrollIntoViewIfNeeded()
  const noteText=(await note.innerText()).replace(/\s+/g,' ').trim()
  const sectionText=(await section.innerText()).replace(/\s+/g,' ').trim()
  assert.equal(noteText,'선택한 레시피 중 하나 이상이 확인된 제품만 봅니다.')
  assert.match(sectionText,/확인된 레시피로 좁히기/)
  assert.doesNotMatch(sectionText,/명백히 충돌|미확인은 남겨둡니다/)
  const file='postdeploy-explore-recipe-refine-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.screens.recipe={noteText,sectionText,file}
  await context.close()
}
async function aliasScreen(){
  const {context,page}=await guardedPage()
  await startLookup(page,'아투')
  const aatu=page.locator('.research-result-card').first()
  await aatu.waitFor({state:'visible',timeout:30000})
  const aatuText=(await aatu.innerText()).replace(/\s+/g,' ').trim()
  assert.match(aatuText,/AATU/i)
  const aatuId=await aatu.getAttribute('data-product-id')
  assert.ok(aatuId)
  const aatuFile='postdeploy-alias-aatu-390x844.png'
  await page.screenshot({path:OUT+'/'+aatuFile,fullPage:false})

  const lookup=page.locator('.lookup-input')
  await lookup.fill('Hills')
  const hills=page.locator('.research-result-card').first()
  await hills.waitFor({state:'visible',timeout:30000})
  const hillsText=(await hills.innerText()).replace(/\s+/g,' ').trim()
  assert.match(hillsText,/힐스|Hill/i)
  const hillsId=await hills.getAttribute('data-product-id')
  assert.ok(hillsId)
  await lookup.fill('Hill’s')
  const curly=page.locator('.research-result-card').first()
  await curly.waitFor({state:'visible',timeout:30000})
  const curlyId=await curly.getAttribute('data-product-id')
  assert.equal(curlyId,hillsId)
  await lookup.fill('Hills')
  await hills.waitFor({state:'visible',timeout:30000})
  const hillsFile='postdeploy-alias-hills-390x844.png'
  await page.screenshot({path:OUT+'/'+hillsFile,fullPage:false})
  report.screens.alias={aatuText,aatuId,hillsText,hillsId,curlyId,aatuFile,hillsFile}
  await context.close()
}
async function quickViewKeyboard(){
  const {context,page}=await guardedPage()
  await startLookup(page,'아투')
  const card=page.locator('.research-result-card').first()
  await card.waitFor({state:'visible',timeout:30000})
  const id=await card.getAttribute('data-product-id')
  assert.ok(id)
  const scroller=page.locator('.research-results-scroll')
  const before=await scroller.evaluate(el=>el.scrollTop)
  await card.focus()
  await page.keyboard.press('Enter')
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible',timeout:30000})
  const close=quick.locator('.quick-view-topline button')
  await page.waitForFunction(()=>document.activeElement?.closest('.quick-view-topline')?.querySelector('button')===document.activeElement,null,{timeout:30000})
  assert.equal(await close.evaluate(el=>document.activeElement===el),true)
  const openScroll=await scroller.evaluate(el=>el.scrollTop)
  assert.equal(openScroll,before)
  const file='postdeploy-quick-view-keyboard-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  await page.keyboard.press('Enter')
  await quick.waitFor({state:'detached',timeout:30000})
  await page.waitForFunction(productId=>document.activeElement?.getAttribute('data-product-id')===productId,id,{timeout:5000})
  const after=await page.evaluate(productId=>({
    focusedId:document.activeElement?.getAttribute('data-product-id'),
    listScroll:document.querySelector('.research-results-scroll')?.scrollTop??null,
    productId,
  }),id)
  assert.equal(after.focusedId,id)
  assert.equal(after.listScroll,before)
  report.screens.quickView={productId:id,file}
  report.interactions.quickView={before,openScroll,after}
  await context.close()
}

await homeScreen()
await conditionScreen()
await recipeScreen()
await aliasScreen()
await quickViewKeyboard()
assert.equal(report.blocked.filter(x=>x.reason==='write').length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
