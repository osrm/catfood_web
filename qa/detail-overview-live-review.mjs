import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'pr74-copy-review'
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,blocked:[],reads:[],screens:{}}
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
async function homeScreen(){
  const {context,page}=await guardedPage()
  await openHome(page)
  const route=page.locator('.home-entry-route').filter({hasText:'조건으로 찾아보기'})
  await route.scrollIntoViewIfNeeded()
  const text=(await route.innerText()).replace(/\s+/g,' ').trim()
  assert.match(text,/사료 형태·연령과 원하는 조건을 골라 제품을 살펴봅니다\./)
  assert.doesNotMatch(text,/명백히 충돌|미확인은 남겨둡니다/)
  const file='home-explore-guidance-390x844.png'
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
  await policy.waitFor({state:'visible'})
  const policyText=(await policy.innerText()).replace(/\s+/g,' ').trim()
  assert.match(headingText,/사료 형태·연령과 원하는 조건을 고릅니다\./)
  assert.equal(policyText,'선택한 조건 정보가 없는 제품도 결과에 남습니다.')
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ')
  assert.equal((body.match(/선택한 조건 정보가 없는 제품도 결과에 남습니다\./g)||[]).length,1)
  assert.doesNotMatch(body,/명백히 충돌하는 제품만 제외|미확인은 남겨둡니다/)
  const file='explore-condition-entry-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.screens.condition={headingText,policyText,file}
  await context.close()
}
async function recipeScreen(){
  const {context,page}=await guardedPage()
  await openHome(page)
  await page.getByRole('button',{name:'조건 고르기 →'}).click()
  const dry=page.locator('button.choice').filter({hasText:'건식'}).first()
  await dry.click()
  await page.getByRole('button',{name:'이 조건으로 찾기'}).click()
  const refine=page.getByRole('button',{name:'더 좁혀보기'})
  await refine.waitFor({state:'visible',timeout:30000})
  await refine.click()
  const recipeTitle=page.locator('.filter-section').filter({hasText:'주요 레시피'}).first()
  await recipeTitle.waitFor({state:'visible',timeout:30000})
  const note=recipeTitle.locator('.field-note').first()
  await note.scrollIntoViewIfNeeded()
  const noteText=(await note.innerText()).replace(/\s+/g,' ').trim()
  assert.equal(noteText,'선택한 레시피 중 하나 이상이 확인된 제품만 봅니다.')
  const sectionText=(await recipeTitle.innerText()).replace(/\s+/g,' ').trim()
  assert.match(sectionText,/확인된 레시피로 좁히기/)
  assert.doesNotMatch(sectionText,/명백히 충돌|미확인은 남겨둡니다/)
  const file='explore-recipe-refine-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.screens.recipe={noteText,sectionText,file}
  await context.close()
}

await homeScreen()
await conditionScreen()
await recipeScreen()
assert.equal(report.blocked.filter(x=>x.reason==='write').length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
