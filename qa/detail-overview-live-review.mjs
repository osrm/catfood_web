import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'compare-mobile-nutrition-scope-review'
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,blocked:[],reads:[],variantResponses:[],nutritionScope:null,file:null}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'})
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

async function waitCatalog(){await page.getByText(/현재 확인된 제품 \d+개/).waitFor()}
async function waitVisibleImages(){
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(img=>{
    const r=img.getBoundingClientRect()
    return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth
  }).every(img=>img.complete&&img.naturalWidth>0))
}
async function addLookup(query,pattern){
  const input=page.locator('.lookup-input')
  await input.fill(query)
  const card=page.locator('.research-result-card').filter({hasText:pattern}).first()
  await card.waitFor({state:'visible'})
  await card.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  await waitVisibleImages()
  await quick.getByRole('button',{name:/비교에 추가/}).click()
  await quick.getByRole('button',{name:/닫기/}).click()
  await page.locator('.research-results').waitFor({state:'visible'})
}

await page.goto(BASE,{waitUntil:'domcontentloaded'})
await waitCatalog()
const homeSearch=page.locator('.home-entry-search input[type="search"]')
await homeSearch.waitFor({state:'visible'})
await homeSearch.fill('AATU 연어')
await page.locator('.home-entry-search-submit').click()
await page.locator('.lookup-input').waitFor({state:'visible'})
await addLookup('AATU 연어',/연어/)
await addLookup('GO!',/오리|Duck/i)

const variantResponses=[]
page.on('response',async response=>{
  const url=new URL(response.url())
  if(!url.pathname.endsWith('/switch_current_variant_options')) return
  variantResponses.push({status:response.status(),url:response.url()})
})

await page.locator('.switch-compare-dock').getByRole('button',{name:/비교 보기/}).click()
await page.getByRole('heading',{name:'제품 비교'}).waitFor()
await waitVisibleImages()

await page.getByRole('tab',{name:'영양',exact:true}).click()
await page.getByText('영양 정보를 불러오는 중입니다.').waitFor({state:'hidden'})
await page.getByText('영양 성분',{exact:true}).waitFor({state:'visible'})

await page.waitForFunction(()=>performance.getEntriesByType('resource')
  .filter(entry=>entry.name.includes('/switch_current_variant_options'))
  .length>=2)

const failedVariant=variantResponses.find(item=>item.status<200||item.status>=300)
if(failedVariant) throw new Error(`variant API failed: ${failedVariant.status} ${failedVariant.url}`)

const scopeRow=page.locator('.compare-row').filter({has:page.locator('.compare-row-label',{hasText:'적용 범위'})}).first()
await scopeRow.waitFor({state:'visible'})

try {
  await page.waitForFunction(()=>{
    const row=[...document.querySelectorAll('.compare-row')].find(node=>node.querySelector('.compare-row-label')?.textContent?.trim()==='적용 범위')
    const text=row?.textContent||''
    return !text.includes('포장 용량 확인 중')
      && text.includes('3 kg 제품에서 확인')
      && text.includes('7.26 kg 제품에서 확인')
      && text.includes('보완 자료 포함')
  })
} catch (error) {
  const text=await scopeRow.innerText()
  const variantSummary=JSON.stringify(variantResponses)
  throw new Error(`variant responses completed but nutrition scope did not settle: ${text} | responses=${variantSummary}`)
}

const scopeText=await scopeRow.innerText()
assert.match(scopeText,/3 kg 제품에서 확인/)
assert.match(scopeText,/7\.26 kg 제품에서 확인/)
assert.match(scopeText,/보완 자료 포함/)
assert.doesNotMatch(scopeText,/포장 용량 확인 중/)

await page.evaluate(()=>scrollTo(0,0))
await waitVisibleImages()
const file='compare-nutrition-scope-390x844.png'
await page.screenshot({path:OUT+'/'+file,fullPage:true})

report.variantResponses=variantResponses
report.nutritionScope=scopeText
report.file=file
assert.equal(report.blocked.length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
