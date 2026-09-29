import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'compare-postdeploy-review'
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,base:BASE,blocked:[],reads:[],mobile:{},desktop:{},interactions:[]}
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
  await addLookup(page,'GO!',/오리|Duck/i)
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
  } else if(name==='원재료'){
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
async function tabEnterToggle(page,details,label){
  const summary=details.locator('summary')
  await page.getByRole('tab',{name:'원재료',exact:true}).focus()
  let reached=false
  for(let i=0;i<50;i++){
    await page.keyboard.press('Tab')
    const active=await page.evaluate(()=>document.activeElement?.tagName==='SUMMARY'?document.activeElement.textContent?.trim():'')
    if(active==='출처 원문 보기'){reached=true;break}
  }
  assert.equal(reached,true,label+' reached by Tab')
  assert.equal(await details.evaluate(el=>el.open),false)
  await page.keyboard.press('Enter')
  assert.equal(await details.evaluate(el=>el.open),true,label+' Enter opens')
  await page.keyboard.press('Enter')
  assert.equal(await details.evaluate(el=>el.open),false,label+' Enter closes')
  report.interactions.push(label+': Tab + Enter open/close')
}

async function mobile(){
  const {context,page}=await guardedPage(390,844)
  const variantResponses=[]
  page.on('response',response=>{
    const url=new URL(response.url())
    if(url.pathname.endsWith('/switch_current_variant_options')) variantResponses.push({status:response.status(),url:response.url()})
  })
  await enterCompare(page)

  const extra=page.locator('.compare-mobile-two-product-extra .compare-disclosure').first()
  assert.equal(await extra.count(),1)
  assert.equal(await extra.evaluate(el=>el.open),false)
  await pointerToggle(extra,'390 overview extra')

  const wrap=page.locator('.compare-table-wrap')

  await setTab(page,'영양')
  await page.waitForFunction(()=>performance.getEntriesByType('resource')
    .filter(entry=>entry.name.includes('/switch_current_variant_options')).length>=2,{timeout:60000})
  const failed=variantResponses.find(r=>r.status<200||r.status>=300)
  if(failed) throw new Error(`variant API failed: ${failed.status} ${failed.url}`)
  const scopeRow=page.locator('.compare-row').filter({has:page.locator('.compare-row-label',{hasText:'적용 범위'})}).first()
  await scopeRow.waitFor({state:'visible'})
  try{
    await page.waitForFunction(()=>{
      const row=[...document.querySelectorAll('.compare-row')].find(node=>node.querySelector('.compare-row-label')?.textContent?.trim()==='적용 범위')
      const text=row?.textContent||''
      return !text.includes('포장 용량 확인 중')&&text.includes('3 kg 제품에서 확인')&&text.includes('7.26 kg 제품에서 확인')&&text.includes('보완 자료 포함')
    },null,{timeout:60000})
  }catch(error){
    throw new Error('variant responses completed but nutrition scope did not settle: '+await scopeRow.innerText()+' responses='+JSON.stringify(variantResponses))
  }
  const scope=await scopeRow.innerText()
  assert.match(scope,/3 kg 제품에서 확인/)
  assert.match(scope,/7\.26 kg 제품에서 확인/)
  assert.match(scope,/보완 자료 포함/)
  assert.doesNotMatch(scope,/포장 용량 확인 중/)
  report.mobile.nutritionScope=scope
  report.mobile.variantResponses=variantResponses

  const horizontal=await wrap.evaluate(el=>({clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,before:el.scrollLeft}))
  assert.ok(horizontal.scrollWidth>horizontal.clientWidth,'nutrition compare should be horizontally scrollable after loading')
  const box=await wrap.boundingBox()
  assert.ok(box,'missing nutrition scroll owner bounds')
  await page.mouse.move(box.x+Math.min(box.width/2,180),box.y+Math.min(box.height/2,300))
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0,900)
  await page.keyboard.up('Shift')
  await page.waitForFunction(()=>{
    const el=document.querySelector('.compare-table-wrap')
    return !!el&&el.scrollLeft>0
  },null,{timeout:10000})
  horizontal.after=await wrap.evaluate(el=>el.scrollLeft)
  assert.ok(horizontal.after>0,'horizontal wheel input did not move nutrition scroll owner')

  const rightScopeCell=scopeRow.locator('.compare-cell').nth(1)
  const rightVisible=await rightScopeCell.evaluate((cell)=>{
    const r=cell.getBoundingClientRect()
    const owner=cell.closest('.compare-table-wrap')?.getBoundingClientRect()
    return !!owner && r.right>owner.left && r.left<owner.right && r.bottom>owner.top && r.top<owner.bottom
  })
  assert.equal(rightVisible,true,'right product nutrition scope cell is not visible after horizontal wheel')
  report.mobile.horizontal={...horizontal,rightScopeCellVisible:rightVisible}

  await wrap.evaluate(el=>{el.scrollLeft=0})
  await page.evaluate(()=>scrollTo(0,0))
  await waitVisibleImages(page)
  const file='postdeploy-compare-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
  report.mobile.file=file
  await context.close()
}

async function desktop(){
  const {context,page}=await guardedPage(1440,900)
  await enterCompare(page)
  await setTab(page,'원재료')
  const status=page.locator('.compare-row').filter({has:page.locator('.compare-row-label',{hasText:'목록 상태'})}).first()
  const scope=page.locator('.compare-row').filter({has:page.locator('.compare-row-label',{hasText:'적용 범위'})}).first()
  assert.ok(await status.count())
  assert.ok(await scope.count())
  const statusText=await status.innerText(),scopeText=await scope.innerText()
  assert.ok(statusText.length>0)
  assert.ok(scopeText.length>0)

  const sources=page.locator('.compare-evidence-disclosure').filter({has:page.locator('summary',{hasText:'출처 원문 보기'})})
  assert.ok(await sources.count()>=1)
  for(let i=0;i<await sources.count();i++) assert.equal(await sources.nth(i).evaluate(el=>el.open),false)
  await pointerToggle(sources.first(),'1440 source pointer')
  await tabEnterToggle(page,sources.first(),'1440 source keyboard')

  await sources.first().locator('summary').click()
  const sourceText=await sources.first().innerText()
  assert.match(sourceText,/대표 확인 자료 · 출처 원문|현재 확인 배합 전체 목록 · 출처 원문|보조 전체 목록 · 출처 원문/)
  await sources.first().locator('summary').click()
  report.desktop.status=statusText
  report.desktop.scope=scopeText
  report.desktop.sourceCount=await sources.count()
  await page.evaluate(()=>scrollTo(0,0))
  await waitVisibleImages(page)
  const file='postdeploy-compare-1440x900.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:true})
  report.desktop.file=file
  await context.close()
}

await mobile()
await desktop()
assert.equal(report.blocked.length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
