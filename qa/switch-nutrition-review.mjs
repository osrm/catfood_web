import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.PAGES_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'pages-combined-postdeploy-output'
const EXPECTED_SHA=process.env.EXPECTED_SHA||'15dfbc94680f8cbc699426af6125aa2236c64f96'
const CURRENT_ID='product_d99406c26240b263'
const GO_ID='product_a0e685be674c6617'
const SOURCE_NAMES=[
  'De-boned duck','duck meal','whole dried egg','peas','lentils','pea flour','tapioca','chickpeas',
  'chicken fat (preserved with mixed tocopherols)','flaxseed','natural flavour','salt','calcium carbonate',
  'dried chicory root','phosphoric acid','choline chloride','potassium chloride','vitamins','minerals','taurine','dried rosemary',
]
const DISPLAY_NAMES=[
  '뼈를 제거한 오리','duck meal','건조 전란','완두콩','렌틸콩','완두콩 가루','타피오카','병아리콩',
  '닭 지방(혼합 토코페롤로 보존)','아마씨','natural flavour','소금','탄산칼슘',
  '말린 치커리 뿌리','인산','염화콜린','염화칼륨','비타민','미네랄','타우린','말린 로즈마리',
]
const RAW_TEXT=SOURCE_NAMES.join(', ')

await mkdir(OUT,{recursive:true})
const report={
  expectedSha:EXPECTED_SHA,
  pagesUrl:BASE,
  blocked:[],
  reads:[],
  ingredient:{},
  mobile:{},
  desktop:{},
}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const norm=value=>String(value||'').replace(/\s+/g,' ').trim()

async function pageAt(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(), url=new URL(req.url()), method=req.method()
    const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
    const supabase=/\.supabase\.co$/i.test(url.hostname)
    const local=url.origin===new URL(BASE).origin
    const google=/googleapis\.com$|gstatic\.com$/i.test(url.hostname)
    if(analytics || (supabase && !['GET','HEAD','OPTIONS'].includes(method))){
      report.blocked.push({method,url:url.href,reason:analytics?'analytics':'write'})
      return route.abort('blockedbyclient')
    }
    if(supabase) report.reads.push({method,path:url.pathname,query:url.search})
    if(!local && !supabase && !google) return route.abort('blockedbyclient')
    await route.continue()
  })
  return {context,page}
}

async function ingredientScenario(){
  const {context,page}=await pageAt(390,844)
  const url=new URL(BASE)
  url.searchParams.set('view','workspace')
  url.searchParams.set('detail',GO_ID)
  url.searchParams.set('detailTab','ingredients')
  await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:30000})
  await page.locator('.detail-stage').waitFor({state:'visible',timeout:90000})
  await page.getByRole('heading',{name:/LID 오리/i}).waitFor({state:'visible',timeout:90000})
  const list=page.locator('.detail-ingredient-list-compact')
  await list.waitFor({state:'visible',timeout:90000})
  await page.waitForFunction(()=>document.querySelectorAll('.detail-ingredient-list-compact span').length===21,null,{timeout:90000})

  const displayed=await list.locator('span').allInnerTexts()
  assert.deepEqual(displayed,DISPLAY_NAMES)
  assert.equal(displayed[1],'duck meal')
  assert.equal(displayed[10],'natural flavour')
  assert.equal(await page.locator('.detail-ingredient-reading-help').innerText(),'한국어 읽기 도움')

  const source=page.locator('.detail-source-disclosure').filter({has:page.getByText('원문 보기',{exact:true})}).first()
  await source.waitFor({state:'visible'})
  const summary=source.locator('summary')
  await summary.focus()
  assert.equal(await summary.evaluate(el=>document.activeElement===el),true)
  await page.keyboard.press('Enter')
  await page.waitForFunction(()=>document.querySelector('.detail-source-disclosure')?.hasAttribute('open'))
  assert.equal(await summary.evaluate(el=>document.activeElement===el),true)
  const raw=source.locator('.detail-ingredient-copy')
  assert.equal((await raw.innerText()).trim(),RAW_TEXT)

  const metrics=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const list=document.querySelector('.detail-ingredient-list-compact')
    const spans=[...list.querySelectorAll('span')]
    const raw=document.querySelector('.detail-source-disclosure[open] .detail-ingredient-copy')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      list:{clientWidth:list.clientWidth,scrollWidth:list.scrollWidth,itemCount:spans.length},
      itemFontSizes:[...new Set(spans.map(x=>getComputedStyle(x).fontSize))],
      raw:{clientWidth:raw.clientWidth,scrollWidth:raw.scrollWidth},
    }
  })
  assert.deepEqual(metrics.itemFontSizes,['15.5px'])
  assert.ok(metrics.document.scrollWidth<=metrics.document.clientWidth+1)
  assert.ok(metrics.list.scrollWidth<=metrics.list.clientWidth+1)
  assert.ok(metrics.raw.scrollWidth<=metrics.raw.clientWidth+1)

  await page.screenshot({path:OUT+'/pages-go-ingredients-390x844.png',fullPage:false})
  await page.screenshot({path:OUT+'/pages-go-ingredients-full-390.png',fullPage:true})
  await page.keyboard.press('Enter')
  await page.waitForFunction(()=>!document.querySelector('.detail-source-disclosure')?.hasAttribute('open'))
  assert.equal(await summary.evaluate(el=>document.activeElement===el),true)
  report.ingredient={...metrics,displayed,rawText:(await raw.innerText()).trim(),keyboard:{opened:true,closed:true,focusRetained:true}}
  await context.close()
}

async function setupCompare(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  await page.waitForFunction(()=>/\d+\s*PRODUCTS/.test(document.querySelector('.research-status')?.textContent||''),null,{timeout:90000})
  await page.locator('.switch-find-search input').fill('AATU')
  const currentRow=page.locator('.switch-find-result').filter({hasText:/연어/}).first()
  await currentRow.waitFor({state:'visible',timeout:30000})
  await currentRow.click()
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
  await sku.waitFor({state:'visible',timeout:30000})
  await sku.click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.locator('.switch-no-change').click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})
  await page.getByRole('button',{name:'후보 제품 보기 →'}).click()
  await page.locator('.switch-candidate-row').first().waitFor({state:'visible',timeout:90000})

  const goRow=page.locator('.switch-candidate-row').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
  for(let pageIndex=0;pageIndex<30 && await goRow.count()===0;pageIndex++){
    const more=page.locator('.load-more')
    if(await more.count()===0 || !await more.isVisible()) break
    await more.click()
    await page.waitForTimeout(40)
  }
  assert.ok(await goRow.count()>0,'GO! SOLUTIONS LID 오리 must be present')
  await goRow.scrollIntoViewIfNeeded()
  await goRow.click()
  const addGo=page.locator('.switch-inspector-actions button').first()
  assert.match(norm(await addGo.textContent()),/비교에 추가/)
  await addGo.click()
  await page.locator('.switch-preview-topline button').click()

  const rows=page.locator('.switch-candidate-row')
  let second=null
  for(let i=0;i<await rows.count();i++){
    const text=norm(await rows.nth(i).textContent())
    if(!/GO! SOLUTIONS/.test(text)||!/LID 오리/.test(text)){second=rows.nth(i);break}
  }
  assert.ok(second,'second candidate must exist')
  await second.click()
  const secondName=norm(await page.locator('.switch-inspector-identity h1').textContent())
  await page.locator('.switch-inspector-actions button').first().click()
  await page.locator('.switch-preview-topline button').click()

  await page.locator('.switch-compare-dock button').click()
  await page.getByRole('tab',{name:'영양'}).click()
  return {secondName}
}

function nutritionReadFilters(){
  return report.reads.filter(x=>x.path.endsWith('/compare_product_nutrition')).map(x=>new URLSearchParams(x.query).get('product_id'))
}

async function mobileSwitchScenario(){
  const {context,page}=await pageAt(390,844)
  const {secondName}=await setupCompare(page)
  const view=page.locator('.compare-switch-mobile-nutrition')
  await view.waitFor({state:'visible',timeout:90000})
  await page.waitForFunction(()=>document.querySelector('.compare-switch-mobile-nutrition')?.textContent?.includes('370 kcal/100g'),null,{timeout:90000})
  await page.waitForFunction(()=>document.querySelector('.compare-switch-mobile-nutrition')?.textContent?.includes('422 kcal/100g'),null,{timeout:90000})

  const toggle=page.locator('.compare-mobile-candidate-toggle')
  await toggle.click()
  const goOption=page.locator('.compare-mobile-candidate-options button').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
  await goOption.click()
  await page.waitForTimeout(50)

  const text=norm(await view.textContent())
  assert.match(text,/AATU/)
  assert.match(text,/연어/)
  assert.match(text,/GO! SOLUTIONS/)
  assert.match(text,/LID 오리/)
  assert.match(text,/370 kcal\/100g/)
  assert.match(text,/422 kcal\/100g/)
  assert.match(text,/대표 영양 자료 · 3 kg · 사용 규격과 다른 포장/)
  assert.match(text,/3 kg 자료 · 다른 포장/)
  assert.match(text,/제품 단위 보완 자료/)
  assert.match(text,/한국 판매 제품 자료 · 7\.26 kg 제품에서 확인/)

  const metrics=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const view=document.querySelector('.compare-switch-mobile-nutrition')
    const table=view.querySelector('.compare-mobile-two-product-table')
    const cells=[...view.querySelectorAll('.compare-mobile-two-product-field.is-metric .compare-mobile-two-product-value')]
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      view:{clientWidth:view.clientWidth,scrollWidth:view.scrollWidth},
      table:{clientWidth:table.clientWidth,scrollWidth:table.scrollWidth},
      metricFontSizes:[...new Set(cells.map(x=>getComputedStyle(x).fontSize))],
      currentEvidenceSummary:view.querySelector('.compare-current-nutrition-evidence')?.textContent.replace(/\s+/g,' ').trim(),
      metricRows:[...view.querySelectorAll('.compare-mobile-two-product-field.is-metric')].map(row=>({
        label:row.querySelector('.compare-mobile-two-product-row-label')?.textContent.replace(/\s+/g,' ').trim(),
        current:row.querySelector('.compare-mobile-two-product-value.is-current')?.textContent.replace(/\s+/g,' ').trim(),
        candidate:row.querySelector('.compare-mobile-two-product-value.is-candidate')?.textContent.replace(/\s+/g,' ').trim(),
      })),
    }
  })
  assert.deepEqual(metrics.metricFontSizes,['15.5px'])
  assert.ok(metrics.document.scrollWidth<=metrics.document.clientWidth+1)
  assert.ok(metrics.view.scrollWidth<=metrics.view.clientWidth+1)
  assert.ok(metrics.table.scrollWidth<=metrics.table.clientWidth+1)
  const energy=metrics.metricRows.find(row=>row.label==='열량')
  const protein=metrics.metricRows.find(row=>row.label==='조단백질')
  assert.ok(energy&&protein)
  assert.match(energy.current,/370 kcal\/100g/)
  assert.match(energy.current,/3 kg 자료 · 다른 포장/)
  assert.doesNotMatch(energy.current,/제품 단위 보완 자료/)
  assert.match(protein.current,/33% 이상/)
  assert.match(protein.current,/제품 단위 보완 자료/)
  assert.doesNotMatch(protein.current,/3 kg 자료|다른 포장/)

  const currentBefore=energy.current
  await toggle.focus()
  assert.equal(await toggle.evaluate(el=>document.activeElement===el),true)
  await page.keyboard.press('Enter')
  await page.locator('.compare-mobile-candidate-options').waitFor({state:'visible'})
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  const focusedOption=await page.evaluate(()=>({tag:document.activeElement?.tagName||'',text:String(document.activeElement?.textContent||'').replace(/\\s+/g,' ').trim()}))
  assert.equal(focusedOption.tag,'BUTTON')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(50)
  assert.equal(await toggle.evaluate(el=>document.activeElement===el),true)
  const currentAfter=norm(await page.locator('.compare-mobile-two-product-field.is-metric').first().locator('.compare-mobile-two-product-value.is-current').textContent())
  assert.equal(currentAfter,currentBefore)
  assert.equal(norm(await page.locator('#compare-mobile-switch-candidate-name').textContent()),secondName)

  await toggle.click()
  const goAgain=page.locator('.compare-mobile-candidate-options button').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
  await goAgain.click()
  await page.waitForTimeout(50)

  const disclosure=view.getByText('자료 기준 보기',{exact:true}).first()
  await disclosure.focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(30)
  assert.equal(await disclosure.evaluate(el=>document.activeElement===el),true)
  assert.equal(await disclosure.evaluate(el=>el.parentElement?.hasAttribute('open')),true)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(30)
  assert.equal(await disclosure.evaluate(el=>el.parentElement?.hasAttribute('open')),false)

  await page.screenshot({path:OUT+'/pages-switch-nutrition-mobile-390x844.png',fullPage:false})
  await page.screenshot({path:OUT+'/pages-switch-nutrition-mobile-full-390.png',fullPage:true})
  report.mobile={...metrics,currentFixed:true,secondCandidate:secondName,pickerKeyboard:{focusRestored:true,focusedOption},disclosureKeyboard:{opened:true,closed:true,focusRetained:true},text}
  await context.close()
}

async function desktopSwitchScenario(){
  const {context,page}=await pageAt(1440,900)
  await setupCompare(page)
  const table=page.locator('.compare-switch-nutrition-desktop')
  await table.waitFor({state:'visible',timeout:90000})
  await page.waitForFunction(()=>{
    const text=document.querySelector('.compare-switch-nutrition-desktop')?.textContent||''
    return text.includes('370 kcal/100g')&&text.includes('422 kcal/100g')
  },null,{timeout:90000})
  const metrics=await page.evaluate(()=>{
    const t=document.querySelector('.compare-switch-nutrition-desktop')
    const rows=[...t.querySelectorAll('.compare-row.is-metric')]
    return {
      viewport:{width:innerWidth,height:innerHeight},
      productHeads:t.querySelectorAll('.compare-product-head').length,
      currentRemoveCount:t.querySelectorAll('.compare-current-product-head .compare-remove').length,
      candidateRemoveCount:t.querySelectorAll('.compare-remove').length,
      currentEvidenceSummary:t.querySelector('.compare-current-nutrition-evidence')?.textContent.replace(/\s+/g,' ').trim(),
      metricRows:rows.map(row=>({
        label:row.querySelector('.compare-row-label')?.textContent.replace(/\s+/g,' ').trim(),
        current:row.querySelector('.compare-cell.is-current')?.textContent.replace(/\s+/g,' ').trim(),
      })),
    }
  })
  assert.equal(metrics.productHeads,3)
  assert.equal(metrics.currentRemoveCount,0)
  assert.equal(metrics.candidateRemoveCount,2)
  assert.match(metrics.currentEvidenceSummary,/대표 영양 자료 · 3 kg · 사용 규격과 다른 포장/)
  assert.match(metrics.metricRows.find(row=>row.label==='열량').current,/3 kg 자료 · 다른 포장/)
  assert.match(metrics.metricRows.find(row=>row.label==='조단백질').current,/제품 단위 보완 자료/)
  await page.screenshot({path:OUT+'/pages-switch-nutrition-desktop-1440x900.png',fullPage:false})
  report.desktop=metrics
  await context.close()
}

function normText(value){return String(value||'').replace(/\s+/g,' ').trim()}

await ingredientScenario()
await mobileSwitchScenario()
await desktopSwitchScenario()

const filters=nutritionReadFilters()
assert.ok(filters.some(x=>x===`in.(${CURRENT_ID})`),'current food nutrition must use separate one-product request')
assert.ok(filters.some(x=>x?.includes(GO_ID)&&!x.includes(CURRENT_ID)),'candidate nutrition request must include GO without current food')
assert.equal(filters.some(x=>x?.includes(GO_ID)&&x.includes(CURRENT_ID)),false)
assert.equal(report.blocked.filter(x=>x.reason==='write').length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))

await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await browser.close()
