import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'switch-candidate-search-review-output'
const PRODUCT_SHA=process.env.PRODUCT_SHA||''
await mkdir(OUT,{recursive:true})

const report={
  productSha:PRODUCT_SHA,
  candidateUrl:BASE,
  blocked:[],
  reads:[],
  mobile:{},
  desktop:{},
  screenshots:{
    '01-mobile-go-search-390x844.png':'390x844 viewport with GO! candidate search result visible',
    '02-mobile-zero-search-390x844.png':'390x844 viewport with zero name-search result while compare dock remains',
    '03-mobile-compare-nutrition-390x844.png':'390x844 compare viewport after nutrition data settled',
    '04-mobile-return-go-search-390x844.png':'390x844 viewport after returning from compare; GO! search preserved',
    '05-mobile-return-go-search-full-390.png':'full-page capture after compare return; not a single viewport state',
    '06-desktop-go-search-1440x900.png':'1440x900 viewport with GO! candidate search result',
    '07-desktop-compare-1440x900.png':'1440x900 SWITCH compare viewport',
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

async function reachCandidateResults(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  await page.waitForFunction(()=>/\d+\s*PRODUCTS/.test(document.querySelector('.research-status')?.textContent||''),null,{timeout:90000})
  const currentSearch=page.locator('.switch-find-search input')
  await currentSearch.fill('AATU')
  const currentRow=page.locator('.switch-find-result').filter({hasText:/AATU/}).filter({hasText:/연어/}).first()
  await currentRow.waitFor({state:'visible',timeout:30000})
  await currentRow.click()
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
  await sku.waitFor({state:'visible',timeout:30000})
  await sku.click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.locator('.switch-no-change').click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible',timeout:30000})
  await page.getByRole('button',{name:'후보 제품 보기 →'}).click()
  await page.locator('.switch-results-stage').waitFor({state:'visible',timeout:90000})
  const candidateSearch=page.locator('input[aria-label="후보 제품 검색"]')
  await candidateSearch.waitFor({state:'visible',timeout:30000})
  return candidateSearch
}

function goRow(page){
  return page.locator('.switch-candidate-row').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
}

async function waitGoResult(page){
  const row=goRow(page)
  await row.waitFor({state:'visible',timeout:30000})
  return row
}

async function addGoCandidate(page,candidateSearch){
  await candidateSearch.fill('GO!')
  const row=await waitGoResult(page)
  assert.equal(await candidateSearch.evaluate(el=>document.activeElement===el),true)
  const loadMoreBefore=await page.locator('.load-more').count()
  await row.click()
  const inspector=page.locator('.switch-candidate-inspector')
  await inspector.waitFor({state:'visible',timeout:30000})
  assert.match(norm(await inspector.textContent()),/GO! SOLUTIONS.*LID 오리/)
  const add=inspector.locator('.switch-inspector-actions button').first()
  assert.match(norm(await add.textContent()),/비교에 추가/)
  await add.click()
  await inspector.locator('.switch-preview-topline button').click()
  assert.equal(await row.evaluate(el=>document.activeElement===el),true,'quick-view close must restore focus to searched result')
  assert.equal(await candidateSearch.inputValue(),'GO!')
  return {row,loadMoreBefore}
}

async function mobileScenario(){
  const {context,page}=await pageAt(390,844)
  const search=await reachCandidateResults(page)
  const sessionBefore=norm(await page.locator('.switch-session-bar').textContent())
  assert.match(sessionBefore,/AATU.*연어/)
  assert.match(sessionBefore,/1 kg/)

  const {row,loadMoreBefore}=await addGoCandidate(page,search)
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/LID 오리/)
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({path:OUT+'/01-mobile-go-search-390x844.png',fullPage:false})

  await search.fill('LID 오리')
  await waitGoResult(page)
  assert.match(norm(await goRow(page).textContent()),/GO! SOLUTIONS.*LID 오리/)

  await search.fill('__검색결과없음__')
  const zero=page.locator('.switch-candidate-list .switch-state-message').filter({hasText:'이름 검색 결과가 없습니다.'}).first()
  await zero.waitFor({state:'visible',timeout:30000})
  assert.match(norm(await zero.textContent()),/검색 지우기/)
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/LID 오리/)
  await page.screenshot({path:OUT+'/02-mobile-zero-search-390x844.png',fullPage:false})

  const clear=zero.getByRole('button',{name:'검색 지우기'})
  await clear.focus()
  assert.equal(await clear.evaluate(el=>document.activeElement===el),true)
  await page.keyboard.press('Enter')
  assert.equal(await search.inputValue(),'')
  assert.equal(await search.evaluate(el=>document.activeElement===el),true,'clear must return focus to search input')
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/LID 오리/)

  await search.fill('GO!')
  await waitGoResult(page)
  const compareTrigger=page.locator('.switch-compare-dock button')
  await compareTrigger.focus()
  await page.keyboard.press('Enter')
  const compare=page.locator('.compare-stage')
  await compare.waitFor({state:'visible',timeout:30000})
  assert.match(norm(await compare.textContent()),/AATU.*연어/)
  assert.match(norm(await compare.textContent()),/GO! SOLUTIONS.*LID 오리/)
  await page.getByRole('tab',{name:'영양'}).click()
  await page.waitForFunction(()=>{
    const text=document.querySelector('.compare-stage')?.textContent||''
    return text.includes('370 kcal/100g')&&text.includes('422 kcal/100g')&&!text.includes('조회 중')
  },null,{timeout:90000})

  const disclosure=page.locator('.compare-evidence-disclosure summary').first()
  await disclosure.waitFor({state:'visible',timeout:30000})
  const details=disclosure.locator('..')
  const beforeOpen=await details.evaluate(el=>el.hasAttribute('open'))
  assert.equal(beforeOpen,false)
  await disclosure.focus()
  const focusBefore=await disclosure.evaluate(el=>document.activeElement===el)
  assert.equal(focusBefore,true)
  await page.keyboard.press('Enter')
  const afterOpen=await details.evaluate(el=>el.hasAttribute('open'))
  const focusAfterOpen=await disclosure.evaluate(el=>document.activeElement===el)
  assert.equal(afterOpen,true)
  assert.equal(focusAfterOpen,true)
  await page.screenshot({path:OUT+'/03-mobile-compare-nutrition-390x844.png',fullPage:false})
  await page.keyboard.press('Enter')
  const afterClose=await details.evaluate(el=>el.hasAttribute('open'))
  const focusAfterClose=await disclosure.evaluate(el=>document.activeElement===el)
  assert.equal(afterClose,false)
  assert.equal(focusAfterClose,true)

  await page.getByRole('button',{name:/제품 목록으로/}).click()
  await page.locator('.switch-results-stage').waitFor({state:'visible',timeout:30000})
  const returnedSearch=page.locator('input[aria-label="후보 제품 검색"]')
  assert.equal(await returnedSearch.inputValue(),'GO!')
  const returnedTrigger=page.locator('.switch-compare-dock button')
  assert.equal(await returnedTrigger.evaluate(el=>document.activeElement===el),true,'compare close must restore focus to compare trigger')
  assert.match(norm(await page.locator('.switch-session-bar').textContent()),/AATU.*연어/)
  assert.match(norm(await page.locator('.switch-session-bar').textContent()),/1 kg/)
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/LID 오리/)

  const metrics=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const stage=document.querySelector('.switch-results-stage')
    const workspace=document.querySelector('.switch-results-workspace')
    const pane=document.querySelector('.switch-candidate-pane')
    const input=document.querySelector('input[aria-label="후보 제품 검색"]')
    const rect=input.getBoundingClientRect()
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      stage:{clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth},
      workspace:{clientWidth:workspace.clientWidth,scrollWidth:workspace.scrollWidth},
      pane:{clientWidth:pane.clientWidth,scrollWidth:pane.scrollWidth},
      searchInput:{left:rect.left,right:rect.right,width:rect.width,fontSize:getComputedStyle(input).fontSize,value:input.value},
      visibleRows:document.querySelectorAll('.switch-candidate-row').length,
    }
  })
  assert.ok(metrics.document.scrollWidth<=metrics.document.clientWidth+1)
  assert.ok(metrics.stage.scrollWidth<=metrics.stage.clientWidth+1)
  assert.ok(metrics.workspace.scrollWidth<=metrics.workspace.clientWidth+1)
  assert.ok(metrics.pane.scrollWidth<=metrics.pane.clientWidth+1)
  assert.ok(metrics.searchInput.left>=-1&&metrics.searchInput.right<=391)
  await waitGoResult(page)
  await goRow(page).scrollIntoViewIfNeeded()
  await page.screenshot({path:OUT+'/04-mobile-return-go-search-390x844.png',fullPage:false})
  await page.screenshot({path:OUT+'/05-mobile-return-go-search-full-390.png',fullPage:true})

  report.mobile={
    sessionBefore,
    loadMoreBefore,
    comparePreservedThroughZero:true,
    queryAfterCompare:await returnedSearch.inputValue(),
    focusAfterQuickView:'candidate-row',
    focusAfterClear:'candidate-search',
    focusAfterCompare:'compare-trigger',
    disclosure:{beforeOpen,afterOpen,afterClose,focusBefore,focusAfterOpen,focusAfterClose},
    metrics,
  }
  await context.close()
}

async function desktopScenario(){
  const {context,page}=await pageAt(1440,900)
  const search=await reachCandidateResults(page)
  await search.fill('GO!')
  const row=await waitGoResult(page)
  await row.scrollIntoViewIfNeeded()

  const listMetrics=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const stage=document.querySelector('.switch-results-stage')
    const workspace=document.querySelector('.switch-results-workspace')
    const input=document.querySelector('input[aria-label="후보 제품 검색"]')
    const rect=input.getBoundingClientRect()
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      stage:{clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth},
      workspace:{clientWidth:workspace.clientWidth,scrollWidth:workspace.scrollWidth},
      searchInput:{left:rect.left,right:rect.right,width:rect.width,value:input.value},
    }
  })
  assert.ok(listMetrics.document.scrollWidth<=listMetrics.document.clientWidth+1)
  assert.ok(listMetrics.stage.scrollWidth<=listMetrics.stage.clientWidth+1)
  assert.ok(listMetrics.workspace.scrollWidth<=listMetrics.workspace.clientWidth+1)
  await page.screenshot({path:OUT+'/06-desktop-go-search-1440x900.png',fullPage:false})

  await row.click()
  const inspector=page.locator('.switch-candidate-inspector')
  await inspector.waitFor({state:'visible'})
  await inspector.locator('.switch-inspector-actions button').first().click()
  await inspector.locator('.switch-preview-topline button').click()
  await page.locator('.switch-compare-dock button').click()
  const compare=page.locator('.compare-stage')
  await compare.waitFor({state:'visible'})
  assert.match(norm(await compare.textContent()),/AATU.*연어/)
  assert.match(norm(await compare.textContent()),/GO! SOLUTIONS.*LID 오리/)
  const compareMetrics=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const stage=document.querySelector('.compare-stage')
    return {
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      stage:{clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth},
      productHeads:stage.querySelectorAll('.compare-product-head').length,
    }
  })
  assert.ok(compareMetrics.document.scrollWidth<=compareMetrics.document.clientWidth+1)
  assert.ok(compareMetrics.stage.scrollWidth<=compareMetrics.stage.clientWidth+1)
  assert.equal(compareMetrics.productHeads,2)
  await page.screenshot({path:OUT+'/07-desktop-compare-1440x900.png',fullPage:false})
  report.desktop={listMetrics,compareMetrics}
  await context.close()
}

await mobileScenario()
await desktopScenario()
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(row=>['GET','HEAD','OPTIONS'].includes(row.method)))
assert.equal(report.blocked.filter(row=>row.reason==='write').length,0)
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await browser.close()
