import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.PAGES_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'compare-energy-postdeploy-output'
const EXPECTED_SHA=process.env.EXPECTED_SHA||''
const AATU='product_d99406c26240b263'
const NATURAL='product_b47d3ae674773585'
const GO='product_a0e685be674c6617'

await mkdir(OUT,{recursive:true})
const report={
  pagesSha:EXPECTED_SHA,
  pagesUrl:BASE,
  blocked:[],
  reads:[],
  general:{},
  switch:{},
  desktop:{},
  screenshots:{
    '01-general-aatu-natural-energy-390x844.png':'viewport after scrolling the energy row into view',
    '02-general-aatu-natural-scope-390x844.png':'viewport after scrolling the provided-value disclosure into view',
    '03-general-aatu-natural-full-390.png':'full-page capture; not a single viewport state',
    '03-switch-aatu-natural-390x844.png':'viewport',
    '04-switch-aatu-go-390x844.png':'viewport after candidate switch',
    '05-switch-aatu-go-full-390.png':'full-page capture; not a single viewport state',
    '06-general-aatu-natural-desktop-1440x900.png':'desktop viewport',
    '07-switch-energy-desktop-1440x900.png':'desktop viewport',
  },
}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const norm=v=>String(v||'').replace(/\s+/g,' ').trim()

async function pageAt(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(), url=new URL(req.url()), method=req.method()
    const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
    const supabase=/\.supabase\.co$/i.test(url.hostname)
    const local=url.origin===new URL(BASE).origin
    const google=/googleapis\.com$|gstatic\.com$/i.test(url.hostname)
    if(analytics || (supabase&&!['GET','HEAD','OPTIONS'].includes(method))){
      report.blocked.push({method,url:url.href,reason:analytics?'analytics':'write'})
      return route.abort('blockedbyclient')
    }
    if(supabase) report.reads.push({method,path:url.pathname,query:url.search})
    if(!local&&!supabase&&!google) return route.abort('blockedbyclient')
    await route.continue()
  })
  return {context,page}
}

function compareUrl(ids){
  const url=new URL(BASE)
  url.searchParams.set('view','workspace')
  url.searchParams.set('mode','lookup')
  url.searchParams.set('compare',ids.join(','))
  url.searchParams.set('compareOpen','1')
  url.searchParams.set('compareTab','nutrition')
  return url.href
}

async function generalMobile(){
  const {context,page}=await pageAt(390,844)
  await page.goto(compareUrl([AATU,NATURAL]),{waitUntil:'domcontentloaded',timeout:30000})
  const view=page.locator('.compare-mobile-two-product-nutrition')
  await view.waitFor({state:'visible',timeout:90000})
  await page.waitForFunction(()=>document.querySelector('.compare-mobile-two-product-nutrition')?.textContent?.includes('348 kcal/100g'),null,{timeout:90000})

  const metrics=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const view=document.querySelector('.compare-mobile-two-product-nutrition')
    const table=view.querySelector('.compare-mobile-two-product-table')
    const energy=[...view.querySelectorAll('.compare-mobile-two-product-field.is-metric')].find(row=>row.querySelector('.compare-mobile-two-product-row-label')?.textContent.trim()==='열량')
    const scope=[...view.querySelectorAll('.compare-mobile-two-product-field')].find(row=>row.querySelector('.compare-mobile-two-product-row-label')?.textContent.trim()==='적용 범위')
    const cells=[...view.querySelectorAll('.compare-mobile-two-product-field.is-metric .compare-mobile-two-product-value')]
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      view:{clientWidth:view.clientWidth,scrollWidth:view.scrollWidth},
      table:{clientWidth:table.clientWidth,scrollWidth:table.scrollWidth},
      metricFontSizes:[...new Set(cells.map(x=>getComputedStyle(x).fontSize))],
      heads:[...view.querySelectorAll('.compare-mobile-two-product-name')].map(x=>x.textContent.trim()),
      energy:[...energy.querySelectorAll('.compare-mobile-two-product-value')].map(x=>x.textContent.replace(/\s+/g,' ').trim()),
      scope:[...scope.querySelectorAll('.compare-mobile-two-product-value')].map(x=>x.textContent.replace(/\s+/g,' ').trim()),
    }
  })
  assert.deepEqual(metrics.metricFontSizes,['15.5px'])
  assert.deepEqual(metrics.energy,['370 kcal/100g','348 kcal/100g'])
  assert.match(metrics.scope[0],/제공된 열량.*370 kcal\/100g/)
  assert.match(metrics.scope[1],/제공된 열량.*3,480 kcal\/kg/)
  assert.ok(metrics.document.scrollWidth<=metrics.document.clientWidth+1)
  assert.ok(metrics.view.scrollWidth<=metrics.view.clientWidth+1)
  assert.ok(metrics.table.scrollWidth<=metrics.table.clientWidth+1)

  const energyField=view.locator('.compare-mobile-two-product-field.is-metric').filter({hasText:'열량'}).first()
  await energyField.scrollIntoViewIfNeeded()
  await page.screenshot({path:OUT+'/01-general-aatu-natural-energy-390x844.png',fullPage:false})

  const summaries=view.locator('.compare-evidence-disclosure summary')
  assert.ok(await summaries.count()>=2)
  const naturalSummary=summaries.nth(1)
  await naturalSummary.scrollIntoViewIfNeeded()
  await naturalSummary.focus()
  assert.equal(await naturalSummary.evaluate(el=>document.activeElement===el),true)
  await page.keyboard.press('Enter')
  assert.equal(await naturalSummary.evaluate(el=>el.parentElement?.hasAttribute('open')),true)
  assert.match(norm(await naturalSummary.evaluate(el=>el.parentElement?.textContent||'')),/제공된 열량.*3,480 kcal\/kg/)
  assert.equal(await naturalSummary.evaluate(el=>document.activeElement===el),true)
  await page.screenshot({path:OUT+'/02-general-aatu-natural-scope-390x844.png',fullPage:false})
  await page.keyboard.press('Enter')

  await page.screenshot({path:OUT+'/03-general-aatu-natural-full-390.png',fullPage:true})
  report.general={...metrics,providedValueKeyboard:{opened:true,closed:true,focusRetained:true}}
  await context.close()
}

async function findCandidate(page,pattern){
  for(let pageIndex=0;pageIndex<30;pageIndex++){
    const rows=page.locator('.switch-candidate-row')
    for(let i=0;i<await rows.count();i++){
      const row=rows.nth(i)
      if(pattern.test(norm(await row.textContent()))) return row
    }
    const more=page.locator('.load-more')
    if(await more.count()===0||!await more.isVisible()) break
    await more.click()
    await page.waitForTimeout(40)
  }
  throw new Error('candidate not found: '+pattern)
}

async function setupSwitch(page){
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
  await page.getByRole('button',{name:'후보 제품 보기 →'}).click()
  await page.locator('.switch-candidate-row').first().waitFor({state:'visible',timeout:90000})

  const natural=await findCandidate(page,/내추럴발란스.*오리지날 울트라 그레인프리 인도어 닭 & 연어 레시피/)
  await natural.scrollIntoViewIfNeeded()
  await natural.click()
  let add=page.locator('.switch-inspector-actions button').first()
  assert.match(norm(await add.textContent()),/비교에 추가/)
  await add.click()
  await page.locator('.switch-preview-topline button').click()

  const go=await findCandidate(page,/GO! SOLUTIONS.*LID 오리/)
  await go.scrollIntoViewIfNeeded()
  await go.click()
  add=page.locator('.switch-inspector-actions button').first()
  assert.match(norm(await add.textContent()),/비교에 추가/)
  await add.click()
  await page.locator('.switch-preview-topline button').click()

  await page.locator('.switch-compare-dock button').click()
  await page.getByRole('tab',{name:'영양'}).click()
}

async function mobileSwitch(){
  const {context,page}=await pageAt(390,844)
  await setupSwitch(page)
  const view=page.locator('.compare-switch-mobile-nutrition')
  await view.waitFor({state:'visible',timeout:90000})
  await page.waitForFunction(()=>document.querySelector('.compare-switch-mobile-nutrition')?.textContent?.includes('370 kcal/100g'),null,{timeout:90000})

  const toggle=page.locator('.compare-mobile-candidate-toggle')
  await toggle.click()
  const naturalOption=page.locator('.compare-mobile-candidate-options button').filter({hasText:/내추럴발란스/}).first()
  await naturalOption.click()
  await page.waitForFunction(()=>{
    const text=document.querySelector('.compare-switch-mobile-nutrition')?.textContent||''
    return text.includes('3 kg 자료 · 다른 포장')&&text.includes('제품 단위 보완 자료')&&text.includes('348 kcal/100g')
  },null,{timeout:90000})

  const readMetrics=()=>page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const view=document.querySelector('.compare-switch-mobile-nutrition')
    const table=view.querySelector('.compare-mobile-two-product-table')
    const rows=[...view.querySelectorAll('.compare-mobile-two-product-field.is-metric')]
    const energy=rows.find(row=>row.querySelector('.compare-mobile-two-product-row-label')?.textContent.trim()==='열량')
    const protein=rows.find(row=>row.querySelector('.compare-mobile-two-product-row-label')?.textContent.trim()==='조단백질')
    return {
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      view:{clientWidth:view.clientWidth,scrollWidth:view.scrollWidth},
      table:{clientWidth:table.clientWidth,scrollWidth:table.scrollWidth},
      metricFontSizes:[...new Set([...view.querySelectorAll('.compare-mobile-two-product-field.is-metric .compare-mobile-two-product-value')].map(x=>getComputedStyle(x).fontSize))],
      energy:{
        current:energy.querySelector('.is-current')?.textContent.replace(/\s+/g,' ').trim(),
        candidate:energy.querySelector('.is-candidate')?.textContent.replace(/\s+/g,' ').trim(),
      },
      proteinCurrent:protein.querySelector('.is-current')?.textContent.replace(/\s+/g,' ').trim(),
      currentEvidence:view.querySelector('.compare-current-nutrition-evidence')?.textContent.replace(/\s+/g,' ').trim(),
      scopes:[...view.querySelectorAll('.compare-mobile-two-product-field')].find(row=>row.querySelector('.compare-mobile-two-product-row-label')?.textContent.trim()==='적용 범위')
        ? [...[...view.querySelectorAll('.compare-mobile-two-product-field')].find(row=>row.querySelector('.compare-mobile-two-product-row-label')?.textContent.trim()==='적용 범위').querySelectorAll('.compare-mobile-two-product-value')].map(x=>x.textContent.replace(/\s+/g,' ').trim())
        : [],
      candidateName:document.querySelector('#compare-mobile-switch-candidate-name')?.textContent.trim(),
    }
  })

  const naturalMetrics=await readMetrics()
  assert.deepEqual(naturalMetrics.metricFontSizes,['15.5px'])
  assert.match(naturalMetrics.energy.current,/370 kcal\/100g/)
  assert.match(naturalMetrics.energy.current,/3 kg 자료 · 다른 포장/)
  assert.match(naturalMetrics.energy.candidate,/348 kcal\/100g/)
  assert.match(naturalMetrics.proteinCurrent,/제품 단위 보완 자료/)
  assert.doesNotMatch(naturalMetrics.proteinCurrent,/3 kg 자료|다른 포장/)
  assert.match(naturalMetrics.scopes[0],/제공된 열량.*370 kcal\/100g/)
  assert.match(naturalMetrics.scopes[1],/제공된 열량.*3,480 kcal\/kg/)
  assert.match(naturalMetrics.currentEvidence,/대표 영양 자료 · 3 kg · 사용 규격과 다른 포장/)
  assert.ok(naturalMetrics.document.scrollWidth<=naturalMetrics.document.clientWidth+1)
  assert.ok(naturalMetrics.view.scrollWidth<=naturalMetrics.view.clientWidth+1)
  assert.ok(naturalMetrics.table.scrollWidth<=naturalMetrics.table.clientWidth+1)
  await page.screenshot({path:OUT+'/03-switch-aatu-natural-390x844.png',fullPage:false})

  const currentBefore=naturalMetrics.energy.current
  await toggle.focus()
  await page.keyboard.press('Enter')
  const goOption=page.locator('.compare-mobile-candidate-options button').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
  await goOption.focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(50)
  assert.equal(await toggle.evaluate(el=>document.activeElement===el),true)
  const goMetrics=await readMetrics()
  assert.equal(goMetrics.energy.current,currentBefore)
  assert.match(goMetrics.energy.candidate,/422 kcal\/100g/)
  assert.match(goMetrics.proteinCurrent,/제품 단위 보완 자료/)
  assert.doesNotMatch(goMetrics.proteinCurrent,/3 kg 자료|다른 포장/)
  assert.match(goMetrics.scopes[1],/제공된 열량.*422 kcal\/100g/)
  await page.screenshot({path:OUT+'/04-switch-aatu-go-390x844.png',fullPage:false})
  await page.screenshot({path:OUT+'/05-switch-aatu-go-full-390.png',fullPage:true})

  report.switch={natural:naturalMetrics,go:goMetrics,candidateKeyboard:{focusRestored:true}}
  await context.close()
}

async function desktopChecks(){
  const {context,page}=await pageAt(1440,900)
  await page.goto(compareUrl([AATU,NATURAL]),{waitUntil:'domcontentloaded',timeout:30000})
  await page.locator('.compare-table').waitFor({state:'visible',timeout:90000})
  await page.waitForFunction(()=>document.querySelector('.compare-table')?.textContent?.includes('348 kcal/100g'),null,{timeout:90000})
  const general=await page.evaluate(()=>{
    const table=document.querySelector('.compare-table')
    const energy=[...table.querySelectorAll('.compare-row.is-metric')].find(row=>row.querySelector('.compare-row-label')?.textContent.trim()==='열량')
    const scope=[...table.querySelectorAll('.compare-row')].find(row=>row.querySelector('.compare-row-label')?.textContent.trim()==='적용 범위')
    return {
      energy:[...energy.querySelectorAll('.compare-cell')].map(x=>x.textContent.replace(/\s+/g,' ').trim()),
      scopes:[...scope.querySelectorAll('.compare-cell')].map(x=>x.textContent.replace(/\s+/g,' ').trim()),
    }
  })
  assert.deepEqual(general.energy,['370 kcal/100g','348 kcal/100g'])
  assert.match(general.scopes[1],/제공된 열량.*3,480 kcal\/kg/)
  await page.screenshot({path:OUT+'/06-general-aatu-natural-desktop-1440x900.png',fullPage:false})
  await context.close()

  const second=await pageAt(1440,900)
  await setupSwitch(second.page)
  const table=second.page.locator('.compare-switch-nutrition-desktop')
  await table.waitFor({state:'visible',timeout:90000})
  await second.page.waitForFunction(()=>{
    const text=document.querySelector('.compare-switch-nutrition-desktop')?.textContent||''
    return text.includes('370 kcal/100g')
      && text.includes('348 kcal/100g')
      && text.includes('422 kcal/100g')
      && text.includes('3 kg 자료 · 다른 포장')
      && text.includes('제품 단위 보완 자료')
  },null,{timeout:90000})
  const sw=await second.page.evaluate(()=>{
    const table=document.querySelector('.compare-switch-nutrition-desktop')
    const energy=[...table.querySelectorAll('.compare-row.is-metric')].find(row=>row.querySelector('.compare-row-label')?.textContent.trim()==='열량')
    const protein=[...table.querySelectorAll('.compare-row.is-metric')].find(row=>row.querySelector('.compare-row-label')?.textContent.trim()==='조단백질')
    return {
      productHeads:table.querySelectorAll('.compare-product-head').length,
      energy:[...energy.querySelectorAll('.compare-cell')].map(x=>x.textContent.replace(/\s+/g,' ').trim()),
      proteinCurrent:protein.querySelector('.compare-cell.is-current')?.textContent.replace(/\s+/g,' ').trim(),
    }
  })
  assert.equal(sw.productHeads,3)
  assert.match(sw.energy[0],/370 kcal\/100g/)
  assert.match(sw.energy[0],/3 kg 자료 · 다른 포장/)
  assert.match(sw.energy[1],/348 kcal\/100g/)
  assert.match(sw.energy[2],/422 kcal\/100g/)
  assert.match(sw.proteinCurrent,/제품 단위 보완 자료/)
  assert.doesNotMatch(sw.proteinCurrent,/3 kg 자료|다른 포장/)
  await second.page.screenshot({path:OUT+'/07-switch-energy-desktop-1440x900.png',fullPage:false})
  report.desktop={general,switch:sw}
  await second.context.close()
}

await generalMobile()
await mobileSwitch()
await desktopChecks()

assert.ok(report.reads.some(x=>x.path.endsWith('/compare_product_nutrition')))
assert.equal(report.blocked.filter(x=>x.reason==='write').length,0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await browser.close()
