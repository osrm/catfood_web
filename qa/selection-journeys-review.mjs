import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE_PATH||'playwright-core')
const BASE=process.env.CANDIDATE_URL||'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'selection-journeys-output'
await mkdir(OUT,{recursive:true})
const report={base:BASE,sourceSha:process.env.CANDIDATE_SHA,realPublicData:true,blocked:[],errors:[],views:{},observations:[]}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome'})
let page
try{
 for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'})
  page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)))
  const facts=new Map(),reads=[];let energyReads=0
  page.on('response',response=>{
   const path=new URL(response.url()).pathname
   if(path.endsWith('/compare_product_nutrition'))energyReads++
   if(path.endsWith('/effective_product_catalog_summary'))reads.push(response.json().then(rows=>{for(const row of rows)facts.set(row.product_id,{...facts.get(row.product_id),...row})}).catch(()=>{}))
  })
  await page.route('**/*',async route=>{
   const req=route.request(),url=req.url()
   if(!['GET','HEAD','OPTIONS'].includes(req.method())||/functions\/v1|analytics|telemetry|search-runs|considerations/.test(url)){report.blocked.push(url);return route.abort()}
   if(url.startsWith(BASE)||url.startsWith('https://gnosbstdatkytsyxuapt.supabase.co/rest/v1/')||url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/')||req.resourceType()==='image')return route.continue()
   return route.abort()
  })
  async function capture(key,selector){await page.evaluate(()=>document.fonts.ready);const geometry=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));assert.ok(geometry.documentWidth<=width+1,key+': page overflow');report.views[width+'-'+key]={url:page.url(),geometry,text:(await page.locator(selector).innerText()).slice(0,14000)};await page.screenshot({path:`${OUT}/${width}-${key}.png`})}
  async function button(name){return page.getByRole('button',{name,exact:true}).filter({visible:true}).first()}
  await page.goto(BASE+'?view=workspace&mode=explore',{waitUntil:'domcontentloaded'})
  await (await button('건식')).click();await (await button('성묘')).click()
  await page.locator('.mobile-additional-toggle').click();await (await button('체중 관리')).click()
  await (await button('이 조건으로 찾기')).click();await page.locator('.research-result-card').first().waitFor({timeout:45000})
  if(!await page.locator('.energy-refine').isVisible())await page.locator('.mobile-refine-entry button').click()
  await (await button('열량으로 좁히기')).click();await page.locator('#energy-max').waitFor({timeout:45000})
  await page.locator('#energy-max').fill('350');await (await button('이 열량 이하로 보기')).click()
  const refineToggle=page.locator('.mobile-refine-entry button')
  if(await refineToggle.isVisible()&&await refineToggle.getAttribute('aria-expanded')==='true')await refineToggle.click()
  await page.locator('.explore-energy-result').first().waitFor({timeout:45000})
  await capture('energy-results','.research-workspace')
  const known=page.locator('.research-result-row').filter({has:page.locator('.explore-energy-result strong').filter({hasText:/\d/})}).first()
  const knownText=await known.innerText()
  const knownAmount=await known.locator('.explore-energy-result > strong').innerText()
  const lowerCandidateName=await known.locator('.research-result-identity > strong').innerText()
  const beforeEnergyReads=energyReads
  await known.locator('.research-result-card').click();await page.locator('.research-quick-view').waitFor()
  await capture('energy-quick-view','.research-quick-view')
  const quick=page.locator('.research-quick-view')
  assert.equal(await quick.locator('.explore-energy-result > strong').innerText(),knownAmount)
  assert.match(await quick.innerText(),/선택한 최대 열량.*350 kcal\/100g 이하/)
  assert.match(await quick.innerText(),/선택한 최대 열량 이하로 확인/)
  report.observations.push({width,case:'energy',row:knownText,quickHasEnergy:true})
  await (await button('닫기 ×')).click()
  const unknownEnergy=page.locator('.research-result-row').filter({has:page.locator('.explore-energy-result > strong').filter({hasText:/^열량 미확인$/})}).first()
  for(let i=0;!await unknownEnergy.count()&&i<25;i++){const more=page.getByRole('button',{name:/제품 더 보기/});assert.ok(await more.count(),'expected an unknown energy candidate');await more.click()}
  await unknownEnergy.locator('.research-result-card').click();await quick.waitFor()
  assert.match(await quick.innerText(),/선택한 최대 열량.*350 kcal\/100g 이하/)
  assert.match(await quick.innerText(),/이 열량 이하인지 확인하지 못했습니다/)
  assert.equal(energyReads,beforeEnergyReads,'quick views reuse the current energy read')
  await capture('energy-unknown','.research-quick-view')

  await page.goto(BASE+'?view=workspace&mode=explore&applied=1&feed='+encodeURIComponent('건식')+'&age=adult&avoidIngredients=salmon',{waitUntil:'domcontentloaded'})
  await page.locator('.research-result-card').first().waitFor({timeout:45000})
  const reviewedId=await page.locator('.result-evidence-group:not(.is-unverified) .research-result-card').first().getAttribute('data-product-id')
  for(let i=0;i<25;i++){const more=page.getByRole('button',{name:/제품 더 보기/});if(!await more.count())break;await more.click()}
  await Promise.all(reads)
  const displayedIds=await page.locator('.research-result-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.productId))
  for(const id of displayedIds){const row=facts.get(id);assert.ok(row?.confirmed_present_ingredient_terms,'missing public ingredient facts');assert.ok(![...row.confirmed_present_ingredient_terms,...row.direct_evidence_ingredient_terms,...row.flavor_associated_ingredient_terms].includes('salmon'),'confirmed salmon must be excluded')}
  await capture('salmon-results','.research-workspace')
  const unknown=page.locator('.result-evidence-group.is-unverified .research-result-card').filter({hasText:'원료 미확인'}).first()
  assert.ok(await unknown.count(),'expected an unresolved salmon candidate')
  const unknownId=await unknown.getAttribute('data-product-id')
  assert.ok(facts.get(unknownId).insufficient_evidence_ingredient_terms.includes('salmon'))
  await unknown.click();await quick.waitFor();await page.locator('.ingredient-disclosure').waitFor({timeout:45000})
  assert.match(await quick.innerText(),/원료 미확인[\s\S]*연어/)
  await capture('salmon-unknown','.research-quick-view')
  await page.locator('.quick-view-actions button').first().click();await (await button('닫기 ×')).click()
  await page.locator(`[data-compare-product-id="${reviewedId}"]`).click();await (await button('비교 보기 →')).click()
  await page.locator('.compare-stage').waitFor();assert.match(await page.locator('.compare-stage').innerText(),/연어/)
  await capture('salmon-comparison','.compare-stage')
  await page.getByRole('tab',{name:'원재료',exact:true}).click()
  await page.getByText(/원료 표기/).filter({visible:true}).first().waitFor({timeout:45000})
  await capture('salmon-source-comparison','.compare-stage')
  await page.getByRole('button',{name:/제품 목록으로/}).filter({visible:true}).first().click()
  await page.locator('.research-result-card').first().waitFor()
  const restored=new URL(page.url()).searchParams
  assert.equal(restored.get('avoidIngredients'),'salmon');assert.ok(restored.get('compare').includes(unknownId)&&restored.get('compare').includes(reviewedId))
  report.observations.push({width,case:'salmon',displayed:displayedIds.length,reviewedId,unknownId,positiveSalmonExcluded:true,returnPreserved:true})

  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await (await button('먹이는 사료 찾기 →')).click();await page.locator('.switch-find-search input').fill('AATU')
  const current=page.locator('.switch-find-result').filter({hasText:/연어/}).first();await current.waitFor({timeout:45000});await current.click()
  const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first();await sku.waitFor();await sku.click();await page.locator('.switch-step-actions .switch-primary-action').click()
  await (await button('다른 브랜드로 보기')).click()
  await page.getByRole('heading',{name:'그대로 두고 싶은 점'}).waitFor()
  await (await button('건식 유지')).click();await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.locator('.switch-candidate-row').first().waitFor({timeout:45000})
  const switchEnergyReadsBefore=energyReads
  await (await button('후보 열량 살펴보기')).click()
  await page.waitForFunction(()=>document.querySelector('.switch-energy-baseline')?.textContent.includes('370'),null,{timeout:45000})
  await page.waitForFunction(()=>document.querySelector('.switch-energy-refinement')?.textContent.includes('근거 포장 · 3 kg'),null,{timeout:45000})
  assert.match(await page.locator('.switch-energy-refinement').innerText(),/사용 규격과 다른 포장에서 확인/)
  await page.locator('.switch-energy-lower input').check()
  await page.locator('.switch-energy-refinement').scrollIntoViewIfNeeded()
  await capture('switch-energy-controls','.switch-energy-refinement')
  for(let i=0;i<25;i++){const more=page.getByRole('button',{name:/제품 더 보기/});if(!await more.count())break;await more.click()}
  await page.locator('.switch-candidate-row').first().scrollIntoViewIfNeeded()
  await capture('switch-lower-energy-list','.switch-candidate-pane')
  const energyRows=page.locator('.switch-candidate-row')
  let lowerCount=0,unknownCount=0
  for(let i=0;i<await energyRows.count();i++){
   const text=await energyRows.nth(i).locator('.switch-candidate-energy > strong').innerText()
   if(text==='열량 비교 미확인'){unknownCount++;continue}
   const amount=Number(text.replace(' kcal/100g','').replaceAll(',',''))
   assert.ok(amount>0&&amount<370,'rendered lower candidate must have a lower positive label value');lowerCount++
  }
  assert.ok(lowerCount>0&&unknownCount>0,'known lower and unknown candidates both remain')
  const unknownEnergyCandidate=energyRows.filter({has:page.locator('.switch-candidate-energy > strong').filter({hasText:'열량 비교 미확인'})}).first()
  await unknownEnergyCandidate.click();await page.locator('.switch-candidate-inspector').waitFor()
  assert.match(await page.locator('.switch-candidate-inspector .switch-candidate-energy').innerText(),/열량 비교 미확인/)
  await capture('switch-energy-unknown','.switch-candidate-inspector')
  await page.locator('.switch-preview-topline button').click()
  await page.getByRole('searchbox',{name:'후보 제품 검색'}).fill(lowerCandidateName)
  const lowerCandidate=page.locator('.switch-candidate-row').filter({hasText:lowerCandidateName}).first();await lowerCandidate.waitFor();await lowerCandidate.click()
  await page.waitForFunction(()=>!/근거 포장 용량 확인 중/.test(document.querySelector('.switch-candidate-inspector')?.textContent||''),null,{timeout:45000})
  assert.match(await page.locator('.switch-candidate-inspector .switch-candidate-energy').innerText(),/현재 표기값보다.*낮음/)
  assert.match(await page.locator('.switch-candidate-inspector').innerText(),/근거 포장 · 3 kg[\s\S]*사용 규격과 다른 포장에서 확인/)
  await page.locator('.switch-candidate-inspector').waitFor();await capture('switch-candidate','.switch-candidate-inspector')
  await (await button('현재 사료와 영양 비교 →')).click()
  await page.locator('.compare-stage').waitFor();await page.waitForFunction(()=>{const text=document.querySelector('.compare-stage')?.textContent||'';return /kcal/.test(text)&&!/조회 중|불러오는 중/.test(text)},null,{timeout:45000})
  const retryCurrent=page.getByRole('button',{name:'현재 사료 다시 시도',exact:true})
  if(await retryCurrent.isVisible()){
   report.retries??=[];report.retries.push({width,case:'current-food',message:await page.locator('.compare-state.is-error').innerText()})
   await capture('switch-nutrition-retry','.compare-stage');await retryCurrent.click()
  }
  const difference=page.locator('.compare-energy-difference').filter({visible:true}).first();await difference.waitFor({timeout:45000})
  assert.match(await difference.innerText(),/낮음/)
  const energyHighlights=page.locator('.comparison-highlights').filter({visible:true})
  await energyHighlights.getByText(/100g당 22 kcal 낮음/).waitFor()
  assert.match(await energyHighlights.innerText(),/근거 포장 · 3 kg/)
  assert.match(await energyHighlights.innerText(),/사용 규격과 다른 포장에서 확인/)
  await capture('switch-nutrition','.compare-stage')
  report.observations.push({width,case:'current-food',energyDifference:await difference.innerText()})
  await page.getByRole('button',{name:'← 후보 목록으로',exact:true}).click();await page.locator('.switch-candidate-inspector').waitFor()
  assert.match(await page.locator('.switch-candidate-inspector').innerText(),/AATU/)
  assert.equal(await page.locator('.switch-energy-lower input').isChecked(),true)
  assert.equal(energyReads,switchEnergyReadsBefore+1,'energy list and inspector share a single energy-only read')
  await capture('switch-energy-return','.switch-candidate-inspector')
  report.observations.push({width,case:'switch-energy-list',lowerCount,unknownCount,sourcePackageMismatchVisible:true,lowerFilterPreserved:true})
  await context.close()
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.blocked,[])
}catch(e){report.failure=String(e);if(page&&!page.isClosed()){report.failureText=await page.locator('body').innerText();await page.screenshot({path:`${OUT}/failure.png`})}throw e}
finally{await browser.close();await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))}
console.log(JSON.stringify({views:Object.keys(report.views),observations:report.observations,errors:report.errors,blocked:report.blocked},null,2))


