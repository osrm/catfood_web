import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'mobile-two-product-nutrition-review'
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,blocked:[],reads:[],views:{},interactions:[]}
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
async function enterLookup(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog(page)
  const home=page.locator('.home-entry-search input[type="search"]')
  await home.fill('AATU')
  await page.locator('.home-entry-search-submit').click()
  await page.locator('.lookup-input').waitFor({state:'visible',timeout:30000})
}
async function addProduct(page,query,pattern){
  const input=page.locator('.lookup-input')
  await input.fill(query)
  const card=page.locator('.research-result-card').filter({hasText:pattern}).first()
  await card.waitFor({state:'visible',timeout:30000})
  const name=(await card.locator('.research-result-identity > strong').innerText()).trim()
  await card.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  await waitVisibleImages(page)
  await quick.getByRole('button',{name:/비교에 추가/}).click()
  await quick.getByRole('button',{name:/닫기/}).click()
  return name
}
async function openNutrition(page){
  await enterLookup(page)
  const first=await addProduct(page,'AATU',/연어|Salmon/i)
  const second=await addProduct(page,'GO!',/LID.*오리|오리.*LID|Duck/i)
  await page.getByRole('button',{name:/비교 보기/}).click()
  await page.locator('.compare-stage').waitFor({state:'visible',timeout:30000})
  await page.getByRole('tab',{name:'영양',exact:true}).click()
  await page.getByText('영양 정보를 불러오는 중입니다.').waitFor({state:'hidden',timeout:60000})
  await page.waitForFunction(()=>{
    const text=document.querySelector('.compare-stage')?.textContent||''
    return text.includes('3 kg 제품에서 확인')&&text.includes('7.26 kg 제품에서 확인')&&!text.includes('포장 용량 확인 중')
  },null,{timeout:60000})
  await waitVisibleImages(page)
  return [first,second]
}
async function mobile390(){
  const {context,page}=await guardedPage(390,844)
  const names=await openNutrition(page)
  const mobile=page.locator('.compare-mobile-two-product-nutrition')
  await mobile.waitFor({state:'visible'})
  const desktop=page.locator('.compare-two-product-nutrition-desktop')
  assert.equal(await desktop.evaluate(el=>getComputedStyle(el).display),'none')

  const headerTexts=await mobile.locator('.compare-mobile-two-product-key th[scope="col"]').allInnerTexts()
  assert.equal(headerTexts.length,2)
  assert.match(headerTexts[0],/AATU/i)
  assert.match(headerTexts[1],/GO!/i)

  const rowData={}
  for(const [key,label] of [['energy','열량'],['protein','조단백질'],['fat','조지방'],['fiber','조섬유'],['moisture','수분'],['ash','조회분'],['scope','적용 범위']]){
    const header=mobile.locator('#compare-mobile-two-row-nutrition-'+key)
    await header.waitFor({state:'attached'})
    const tbody=header.locator('xpath=..').locator('xpath=..')
    const cells=tbody.locator('.compare-mobile-two-product-value')
    assert.equal(await cells.count(),2,label+' should have two product values')
    const values=await cells.allInnerTexts()
    const boxes=await cells.evaluateAll(nodes=>nodes.map(node=>{
      const r=node.getBoundingClientRect()
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,visible:r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1}
    }))
    assert.ok(boxes.every(x=>x.visible),label+' values must be simultaneously visible')
    rowData[key]={values,boxes}
  }

  assert.ok(rowData.energy.values.every(v=>/kcal\/(kg|100g)|미확인/.test(v)), 'energy units must remain visible')
  assert.ok(rowData.protein.values.every(v=>/%|미확인|기준 자료만 확인/.test(v)), 'protein unit/unknown semantics must remain visible')
  const metricFonts=await mobile.locator('.compare-mobile-two-product-field.is-metric .compare-mobile-two-product-value').evaluateAll(nodes=>nodes.map(node=>parseFloat(getComputedStyle(node).fontSize)))
  assert.ok(metricFonts.length>0)
  assert.ok(metricFonts.every(size=>size>=15.5), 'metric text must not shrink below existing 15.5px')

  assert.match(rowData.scope.values[0],/한국 판매 제품 자료.*3 kg 제품에서 확인.*보완 자료 포함/s)
  assert.match(rowData.scope.values[0],/자료 기준 보기/)
  assert.match(rowData.scope.values[1],/한국 판매 제품 자료.*7\.26 kg 제품에서 확인/s)

  const layout=await page.locator('.compare-table-wrap').evaluate(wrap=>{
    const doc=document.scrollingElement||document.documentElement
    const stage=wrap.closest('.compare-stage')
    return {
      viewport:innerWidth,
      documentClientWidth:doc.clientWidth,documentScrollWidth:doc.scrollWidth,
      wrapClientWidth:wrap.clientWidth,wrapScrollWidth:wrap.scrollWidth,
      stageClientWidth:stage?.clientWidth??0,stageScrollWidth:stage?.scrollWidth??0,
    }
  })
  assert.ok(layout.documentScrollWidth<=layout.documentClientWidth+1,'document should not horizontally overflow')
  assert.ok(layout.wrapScrollWidth<=layout.wrapClientWidth+1,'mobile two-product nutrition should not need horizontal scroll')
  assert.ok(layout.stageScrollWidth<=layout.stageClientWidth+1,'compare stage should not horizontally overflow')

  await page.evaluate(()=>scrollTo(0,0))
  const file='mobile-two-product-nutrition-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
  report.views.mobile390={names,headerTexts,rowData,metricFonts,layout,file}
  await context.close()
}
async function desktop1440(){
  const {context,page}=await guardedPage(1440,900)
  const names=await openNutrition(page)
  const mobile=page.locator('.compare-mobile-two-product-nutrition')
  assert.equal(await mobile.evaluate(el=>getComputedStyle(el).display),'none')
  const desktop=page.locator('.compare-two-product-nutrition-desktop')
  await desktop.waitFor({state:'visible'})
  assert.notEqual(await desktop.evaluate(el=>getComputedStyle(el).display),'none')
  assert.match(await desktop.innerText(),/조단백질/)
  assert.match(await desktop.innerText(),/적용 범위/)
  await page.evaluate(()=>scrollTo(0,0))
  const file='two-product-nutrition-1440x900.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
  report.views.desktop1440={names,file}
  await context.close()
}

await mobile390()
await desktop1440()
assert.equal(report.blocked.length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
