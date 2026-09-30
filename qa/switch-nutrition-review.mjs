import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'switch-nutrition-review-output'
const CURRENT_ID='product_d99406c26240b263'
const GO_ID='product_a0e685be674c6617'
await mkdir(OUT,{recursive:true})
const report={candidateSha:process.env.PRODUCT_SHA,blocked:[],reads:[],mobile:{},desktop:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

function norm(value){return String(value||'').replace(/\s+/g,' ').trim()}

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

async function visibleButton(page,name){
  const nodes=page.getByRole('button',{name,exact:true})
  for(let i=0;i<await nodes.count();i++) if(await nodes.nth(i).isVisible()) return nodes.nth(i)
  throw new Error('button not found: '+name)
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
  assert.ok(await goRow.count()>0,'GO! SOLUTIONS LID 오리 must be present after loading candidate pages')
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
  assert.ok(second,'a second candidate must exist')
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

async function mobileScenario(){
  const {context,page}=await pageAt(390,844)
  const {secondName}=await setupCompare(page)
  const view=page.locator('.compare-switch-mobile-nutrition')
  await view.waitFor({state:'visible',timeout:90000})
  await page.waitForFunction(()=>document.querySelector('.compare-switch-mobile-nutrition')?.textContent?.includes('370 kcal/100g'),null,{timeout:90000})
  await page.waitForFunction(()=>document.querySelector('.compare-switch-mobile-nutrition')?.textContent?.includes('422 kcal/100g'),null,{timeout:90000})

  const text=norm(await view.textContent())
  assert.match(text,/AATU/)
  assert.match(text,/연어/)
  assert.match(text,/GO! SOLUTIONS/)
  assert.match(text,/LID 오리/)
  assert.match(text,/370 kcal\/100g/)
  assert.match(text,/422 kcal\/100g/)
  assert.match(text,/33% 이상/)
  assert.match(text,/31% 이상/)
  assert.match(text,/사용 규격 · 1 kg · 영양 자료 포장 · 3 kg · 다른 포장 자료/)
  assert.match(text,/한국 판매 제품 자료 · 3 kg 제품에서 확인 · 보완 자료 포함/)
  assert.match(text,/한국 판매 제품 자료 · 7\.26 kg 제품에서 확인/)
  assert.ok((text.match(/다른 포장 자료/g)||[]).length>=6,'current-food metric cells must carry the package mismatch note')
  assert.doesNotMatch(text,/판매 대표.*다른 포장 자료/)

  const metrics=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const view=document.querySelector('.compare-switch-mobile-nutrition')
    const table=view?.querySelector('.compare-mobile-two-product-table')
    const cells=[...view.querySelectorAll('.compare-mobile-two-product-field.is-metric .compare-mobile-two-product-value')]
    const fontSizes=[...new Set(cells.map(cell=>getComputedStyle(cell).fontSize))]
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      view:{clientWidth:view.clientWidth,scrollWidth:view.scrollWidth},
      table:{clientWidth:table.clientWidth,scrollWidth:table.scrollWidth},
      metricCellCount:cells.length,
      metricFontSizes:fontSizes,
      currentMetricTexts:[...view.querySelectorAll('.compare-mobile-two-product-field.is-metric .compare-mobile-two-product-value.is-current')].map(x=>x.textContent.replace(/\s+/g,' ').trim()),
      candidateMetricTexts:[...view.querySelectorAll('.compare-mobile-two-product-field.is-metric .compare-mobile-two-product-value.is-candidate')].map(x=>x.textContent.replace(/\s+/g,' ').trim()),
    }
  })
  assert.deepEqual(metrics.metricFontSizes,['15.5px'])
  assert.ok(metrics.currentMetricTexts.every(value=>value.includes('다른 포장 자료')),'every current-food metric must identify the different evidence package')
  assert.ok(metrics.candidateMetricTexts.every(value=>!value.includes('다른 포장 자료')),'candidate metrics must not infer a use-package mismatch from representative packaging')
  assert.ok(metrics.document.scrollWidth<=metrics.document.clientWidth+1)
  assert.ok(metrics.view.scrollWidth<=metrics.view.clientWidth+1)
  assert.ok(metrics.table.scrollWidth<=metrics.table.clientWidth+1)

  const currentBefore=norm(await page.locator('.compare-mobile-two-product-value.is-current').first().textContent())
  const toggle=page.locator('.compare-mobile-candidate-toggle')
  await toggle.focus()
  assert.equal(await toggle.evaluate(el=>document.activeElement===el),true)
  await page.keyboard.press('Enter')
  await page.locator('.compare-mobile-candidate-options').waitFor({state:'visible'})
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  const focusedOption=await page.evaluate(()=>({text:(document.activeElement?.textContent||'').replace(/\s+/g,' ').trim(),tag:document.activeElement?.tagName||''}))
  assert.equal(focusedOption.tag,'BUTTON')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(50)
  assert.equal(await toggle.evaluate(el=>document.activeElement===el),true,'candidate selection should restore picker focus')
  const currentAfter=norm(await page.locator('.compare-mobile-two-product-value.is-current').first().textContent())
  assert.equal(currentAfter,currentBefore,'current baseline must stay fixed while candidate changes')
  assert.equal(norm(await page.locator('#compare-mobile-switch-candidate-name').textContent()),secondName)

  await toggle.click()
  const goOption=page.locator('.compare-mobile-candidate-options button').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
  await goOption.click()
  await page.waitForTimeout(50)
  assert.match(norm(await page.locator('#compare-mobile-switch-candidate-name').textContent()),/LID 오리/)

  const disclosure=view.getByText('자료 기준 보기',{exact:true}).first()
  await disclosure.focus()
  assert.equal(await disclosure.evaluate(el=>document.activeElement===el),true)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(30)
  assert.equal(await disclosure.evaluate(el=>document.activeElement===el),true)
  assert.equal(await disclosure.evaluate(el=>el.parentElement?.hasAttribute('open')),true)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(30)
  assert.equal(await disclosure.evaluate(el=>document.activeElement===el),true)
  assert.equal(await disclosure.evaluate(el=>el.parentElement?.hasAttribute('open')),false)

  await page.screenshot({path:OUT+'/switch-nutrition-mobile-390x844.png',fullPage:false})
  await page.screenshot({path:OUT+'/switch-nutrition-mobile-full-390.png',fullPage:true})

  report.mobile={...metrics,secondCandidate:secondName,currentFixed:true,pickerKeyboard:{focusedOption,focusRestored:true},disclosureKeyboard:{opened:true,closed:true,focusRetained:true},text}
  await context.close()
}

async function desktopScenario(){
  const {context,page}=await pageAt(1440,900)
  await setupCompare(page)
  const table=page.locator('.compare-switch-nutrition-desktop')
  await table.waitFor({state:'visible',timeout:90000})
  await page.waitForFunction(()=>{
    const text=document.querySelector('.compare-switch-nutrition-desktop')?.textContent||''
    return text.includes('370 kcal/100g') && text.includes('422 kcal/100g')
  },null,{timeout:90000})
  const text=norm(await table.textContent())
  assert.match(text,/현재 사료 · 기준/)
  assert.match(text,/AATU/)
  assert.match(text,/연어/)
  assert.match(text,/370 kcal\/100g/)
  assert.match(text,/422 kcal\/100g/)
  const heads=await table.locator('.compare-product-head').count()
  assert.equal(heads,3,'desktop must have current baseline plus two candidate columns')
  assert.equal(await table.locator('.compare-current-product-head .compare-remove').count(),0)
  assert.equal(await table.locator('.compare-remove').count(),2)
  const metrics=await page.evaluate(()=>{
    const t=document.querySelector('.compare-switch-nutrition-desktop')
    const rows=[...t.querySelectorAll('.compare-row.is-metric')]
    return {
      viewport:{width:innerWidth,height:innerHeight},
      currentHead:t.querySelector('.compare-current-product-head')?.textContent?.replace(/\s+/g,' ').trim(),
      metricRows:rows.length,
      firstMetricCurrent:rows[0]?.querySelector('.compare-cell.is-current')?.textContent?.replace(/\s+/g,' ').trim(),
      productHeads:t.querySelectorAll('.compare-product-head').length,
    }
  })
  await page.screenshot({path:OUT+'/switch-nutrition-desktop-1440x900.png',fullPage:false})
  report.desktop={...metrics,text}
  await context.close()
}

await mobileScenario()
await desktopScenario()

const filters=nutritionReadFilters()
assert.ok(filters.some(x=>x===`in.(${CURRENT_ID})`),'current food nutrition must use a separate one-product request')
assert.ok(filters.some(x=>x?.includes(GO_ID) && !x.includes(CURRENT_ID)),'candidate nutrition request must contain GO without current food')
assert.equal(filters.some(x=>x?.includes(GO_ID) && x.includes(CURRENT_ID)),false,'current food must never be merged into candidate nutrition request')
assert.equal(report.blocked.filter(x=>x.reason==='write').length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await browser.close()
