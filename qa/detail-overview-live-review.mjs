import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'compare-progressive-disclosure-review'
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
    if(supabase) report.reads.push({method,path:url.pathname})
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
async function addLookup(page,query,pattern){
  const input=page.locator('.lookup-input')
  await input.fill(query)
  const card=page.locator('.research-result-card').filter({hasText:pattern}).first()
  await card.waitFor({state:'visible',timeout:30000})
  await card.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  await waitVisibleImages(page)
  await quick.getByRole('button',{name:/비교에 추가/}).click()
  await quick.getByRole('button',{name:/닫기/}).click()
  await page.locator('.research-results').waitFor({state:'visible'})
}
async function enterCompare(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog(page)
  const homeSearch=page.locator('.home-entry-search input[type="search"]')
  await homeSearch.waitFor({state:'visible',timeout:30000})
  await homeSearch.fill('AATU 연어')
  await page.locator('.home-entry-search-submit').click()
  await page.locator('.lookup-input').waitFor({state:'visible'})
  await addLookup(page,'AATU 연어',/연어/)
  await addLookup(page,'GO! LID 오리',/오리/)
  await page.locator('.switch-compare-dock').getByRole('button',{name:/비교 보기/}).click()
  await page.getByRole('heading',{name:'제품 비교'}).waitFor()
  await waitVisibleImages(page)
  const heads=await page.locator('.compare-product-copy').allInnerTexts()
  assert.ok(heads.some(x=>/AATU/i.test(x)&&/연어/.test(x)),JSON.stringify(heads))
  assert.ok(heads.some(x=>/GO!/i.test(x)&&/오리/.test(x)),JSON.stringify(heads))
}
async function setTab(page,name){
  await page.getByRole('tab',{name,exact:true}).click()
  if(name==='영양'){
    await page.getByText('영양 정보를 불러오는 중입니다.').waitFor({state:'hidden',timeout:60000})
    await page.getByText('영양 성분',{exact:true}).waitFor({state:'visible',timeout:60000})
  }
  if(name==='원재료'){
    await page.getByText('원재료 정보를 불러오는 중입니다.').waitFor({state:'hidden',timeout:60000})
    await page.getByText('원재료',{exact:true}).last().waitFor({state:'visible',timeout:60000})
  }
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
async function tabEnterToggle(page,summaryText){
  const target=page.locator('summary').filter({hasText:summaryText}).first()
  await target.waitFor({state:'visible'})
  await page.getByRole('tab',{name:'원재료',exact:true}).focus()
  let reached=false
  for(let i=0;i<40;i++){
    await page.keyboard.press('Tab')
    const active=await page.evaluate(()=>document.activeElement?.tagName==='SUMMARY'?document.activeElement.textContent?.trim():'')
    if(active===summaryText){reached=true;break}
  }
  assert.equal(reached,true,'Tab reaches '+summaryText)
  const details=target.locator('..')
  assert.equal(await details.evaluate(el=>el.open),false)
  await page.keyboard.press('Enter')
  assert.equal(await details.evaluate(el=>el.open),true,'Enter opens '+summaryText)
  await page.keyboard.press('Enter')
  assert.equal(await details.evaluate(el=>el.open),false,'Enter closes '+summaryText)
  report.interactions.push(summaryText+': Tab + Enter open/close')
}
async function tableGeometry(page){
  return page.locator('.compare-table').evaluate(table=>{
    const head=[...table.querySelectorAll(':scope > .compare-head-row > *')].map(el=>el.getBoundingClientRect().width)
    const rows=[...table.querySelectorAll(':scope > .compare-row')].slice(0,8).map(row=>[...row.children].map(el=>el.getBoundingClientRect().width))
    return {head,rows}
  })
}
function aligned(geometry){
  return geometry.rows.every(row=>row.length===geometry.head.length && row.every((width,index)=>Math.abs(width-geometry.head[index])<1))
}

async function run(width,height){
  const {context,page}=await guardedPage(width,height)
  await enterCompare(page)
  const key=`${width}x${height}`
  report.views[key]={}

  // Overview: all-empty optional facts stay behind one native disclosure for this live pair.
  const mobileTwo=width<=760
  const overviewDisclosure=mobileTwo
    ? page.locator('.compare-mobile-two-product-extra .compare-disclosure').first()
    : page.locator('.compare-table > .compare-overview-extra').first()
  assert.equal(await overviewDisclosure.count(),1,'overview disclosure exists for live all-empty optional facts')
  assert.equal(await overviewDisclosure.evaluate(el=>el.open),false)
  assert.match(await overviewDisclosure.innerText(),/제품 표기 대상/)
  assert.match(await overviewDisclosure.innerText(),/제품 특징/)
  assert.equal((await page.locator('.compare-section-row').allInnerTexts()).some(x=>/제품에 표시된 기본 정보를 나란히|레시피와 판매 규격을 함께 비교/.test(x)),false)
  await pointerToggle(overviewDisclosure,key+' overview extra')
  if(mobileTwo){
    const box=await page.locator('.compare-mobile-two-product-overview').evaluate(el=>({clientWidth:el.clientWidth,scrollWidth:el.scrollWidth}))
    assert.ok(box.scrollWidth<=box.clientWidth+1,JSON.stringify(box))
    report.views[key].overviewOverflow=box
  }else{
    const geo=await tableGeometry(page); assert.ok(aligned(geo),JSON.stringify(geo)); report.views[key].overviewGeometry=geo
  }
  await waitVisibleImages(page)
  const overviewFile=`compare-overview-${key}.png`
  await page.screenshot({path:OUT+'/'+overviewFile,fullPage:true})
  report.views[key].overviewFile=overviewFile

  // Nutrition: values first, primary scope visible, supplemental detail only when present.
  await setTab(page,'영양')
  assert.equal(await page.locator('.compare-footnote').count(),0)
  const sections=await page.locator('.compare-section-row').allInnerTexts()
  assert.equal(sections[0].startsWith('영양 성분'),true,JSON.stringify(sections))
  assert.ok(sections.some(x=>x.startsWith('자료 범위')))
  const scopeRow=page.locator('.compare-row').filter({has:page.locator('.compare-row-label',{hasText:'적용 범위'})}).first()
  assert.ok(await scopeRow.count())
  const scopeText=await scopeRow.innerText()
  assert.match(scopeText,/한국 판매 제품 자료|제품 자료|확인값 없음/)
  const nutritionDetails=page.locator('.compare-evidence-disclosure').filter({has:page.locator('summary',{hasText:'자료 기준 보기'})})
  const nutritionDetailCount=await nutritionDetails.count()
  for(let i=0;i<nutritionDetailCount;i++) assert.equal(await nutritionDetails.nth(i).evaluate(el=>el.open),false)
  if(nutritionDetailCount>0) await pointerToggle(nutritionDetails.first(),key+' nutrition evidence')
  if(width>760){const geo=await tableGeometry(page);assert.ok(aligned(geo),JSON.stringify(geo));report.views[key].nutritionGeometry=geo}
  const nutritionFile=`compare-nutrition-${key}.png`
  await page.screenshot({path:OUT+'/'+nutritionFile,fullPage:true})
  report.views[key].nutritionFile=nutritionFile
  report.views[key].nutritionDetailCount=nutritionDetailCount
  report.views[key].nutritionScope=scopeText

  // Ingredients: status/scope stay visible; source layers stay separate behind source disclosure.
  await setTab(page,'원재료')
  assert.equal(await page.locator('.compare-footnote').count(),0)
  const ingredientSections=await page.locator('.compare-section-row').allInnerTexts()
  assert.equal(ingredientSections.filter(x=>x.includes('원재료')).length,1,JSON.stringify(ingredientSections))
  const statusRow=page.locator('.compare-row').filter({has:page.locator('.compare-row-label',{hasText:'목록 상태'})}).first()
  const ingredientScope=page.locator('.compare-row').filter({has:page.locator('.compare-row-label',{hasText:'적용 범위'})}).first()
  assert.ok(await statusRow.count()); assert.ok(await ingredientScope.count())
  const sourceDetails=page.locator('.compare-evidence-disclosure').filter({has:page.locator('summary',{hasText:'출처 원문 보기'})})
  assert.ok(await sourceDetails.count()>=1)
  for(let i=0;i<await sourceDetails.count();i++) assert.equal(await sourceDetails.nth(i).evaluate(el=>el.open),false)
  if(width<=760) await tabEnterToggle(page,'출처 원문 보기')
  else await pointerToggle(sourceDetails.first(),key+' source text')

  await sourceDetails.first().locator('summary').click()
  const sourceText=await sourceDetails.first().innerText()
  assert.match(sourceText,/대표 확인 자료 · 출처 원문|현재 확인 배합 전체 목록 · 출처 원문/)
  const visibleRaw=sourceDetails.first().locator('.compare-ingredient-text:visible')
  assert.ok(await visibleRaw.count()>=1)
  const rawOverflow=await visibleRaw.first().evaluate(el=>({clientWidth:el.clientWidth,scrollWidth:el.scrollWidth}))
  assert.ok(rawOverflow.scrollWidth<=rawOverflow.clientWidth+1,JSON.stringify(rawOverflow))
  await sourceDetails.first().locator('summary').click()
  if(width>760){const geo=await tableGeometry(page);assert.ok(aligned(geo),JSON.stringify(geo));report.views[key].ingredientGeometry=geo}
  const ingredientFile=`compare-ingredients-${key}.png`
  await page.screenshot({path:OUT+'/'+ingredientFile,fullPage:true})
  report.views[key].ingredientFile=ingredientFile
  report.views[key].ingredientStatus=await statusRow.innerText()
  report.views[key].ingredientScope=await ingredientScope.innerText()
  report.views[key].sourceDisclosureCount=await sourceDetails.count()
  report.views[key].rawOverflow=rawOverflow

  await context.close()
}

await run(390,844)
await run(1440,900)
assert.equal(report.blocked.length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
