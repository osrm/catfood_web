import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'direct-list-compare-review-output'
const PRODUCT_SHA=process.env.PRODUCT_SHA||''
const AATU='product_d99406c26240b263'
const GO='product_a0e685be674c6617'

await mkdir(OUT,{recursive:true})
const report={
  productSha:PRODUCT_SHA,
  candidateUrl:BASE,
  blocked:[],
  reads:[],
  mobile:{},
  desktop:{},
  screenshots:{
    '01-general-lookup-direct-added-390x844.png':'390x844 viewport immediately after direct list compare add in LOOKUP; quick view remains closed',
    '02-general-explore-preserved-390x844.png':'390x844 viewport after EXPLORE re-entry/reapply with the same general comparison preserved',
    '03-switch-go-direct-added-390x844.png':'390x844 viewport after SWITCH GO! LID Duck direct list compare add; inspector remains closed',
    '04-switch-zero-dock-centered-390x844.png':'390x844 viewport after zero-result SWITCH search with compare dock scrolled into view',
    '05-general-max5-1440x900.png':'1440x900 viewport at general 5/5 comparison cap; selected controls remain removable',
    '06-switch-direct-sync-1440x900.png':'1440x900 viewport showing SWITCH list compared state after search hide/show and quick-view synchronization',
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

async function waitCatalog(page){
  await page.waitForFunction(()=>/\d+\s*PRODUCTS/.test(document.querySelector('.research-status')?.textContent||''),null,{timeout:90000})
}

async function generalMobile(){
  const {context,page}=await pageAt(390,844)
  const url=new URL(BASE)
  url.searchParams.set('view','workspace')
  url.searchParams.set('mode','lookup')
  url.searchParams.set('q','AATU')
  await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:30000})
  await waitCatalog(page)

  const compare=page.locator(`[data-compare-product-id="${AATU}"]`)
  const row=page.locator(`[data-product-id="${AATU}"]`)
  await compare.waitFor({state:'visible',timeout:30000})
  assert.equal(await page.locator('button button').count(),0,'actions must never nest buttons')

  const scroller=page.locator('.research-results-scroll')
  await scroller.evaluate(el=>{el.scrollTop=18})
  await compare.focus()
  const scrollBefore=await scroller.evaluate(el=>el.scrollTop)
  await page.keyboard.press('Enter')
  const scrollAfter=await scroller.evaluate(el=>el.scrollTop)

  assert.equal(await compare.evaluate(el=>document.activeElement===el),true)
  assert.equal(scrollAfter,scrollBefore)
  assert.equal(await compare.getAttribute('aria-pressed'),'true')
  assert.equal(await compare.locator('..').evaluate(el=>el.classList.contains('is-compared')),true)
  assert.equal(await row.evaluate(el=>el.classList.contains('is-selected')),false,'compared state is distinct from quick-view selection')
  assert.equal(await page.locator('.research-quick-view').count(),0)
  assert.equal(await page.locator('.detail-stage').count(),0)
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/비교 1\/5/)
  assert.equal(new URL(page.url()).searchParams.get('q'),'AATU')
  await compare.scrollIntoViewIfNeeded()
  await page.screenshot({path:OUT+'/01-general-lookup-direct-added-390x844.png',fullPage:false})

  await row.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible',timeout:30000})
  assert.equal(await row.evaluate(el=>el.classList.contains('is-selected')),true)
  assert.equal(await compare.locator('..').evaluate(el=>el.classList.contains('is-compared')),true)
  assert.match(norm(await quick.locator('.quick-view-actions').textContent()),/비교에서 제거/)
  await quick.locator('.quick-view-topline button').click()
  await quick.waitFor({state:'detached',timeout:30000})

  await page.getByRole('button',{name:'조건으로 찾기'}).click()
  await page.locator('.condition-actions').waitFor({state:'visible',timeout:30000})
  assert.equal(new URL(page.url()).searchParams.get('compare'),AATU)
  assert.equal(await page.locator('.switch-compare-dock').count(),0,'dock stays hidden while conditions are edited')
  await page.getByRole('button',{name:'이 조건으로 찾기'}).click()
  await page.locator('.research-results').waitFor({state:'visible',timeout:30000})
  assert.equal(new URL(page.url()).searchParams.get('compare'),AATU)
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/비교 1\/5/)
  const exploreCompare=page.locator(`[data-compare-product-id="${AATU}"]`)
  await exploreCompare.waitFor({state:'attached',timeout:30000})
  assert.equal(await exploreCompare.getAttribute('aria-pressed'),'true')
  await exploreCompare.scrollIntoViewIfNeeded()
  await page.screenshot({path:OUT+'/02-general-explore-preserved-390x844.png',fullPage:false})

  await page.getByRole('button',{name:'제품 찾기'}).click()
  await page.locator('.lookup-input').waitFor({state:'visible',timeout:30000})
  assert.equal(await page.locator('.lookup-input').inputValue(),'AATU')
  assert.equal(new URL(page.url()).searchParams.get('compare'),AATU)
  const lookupCompareAgain=page.locator(`[data-compare-product-id="${AATU}"]`)
  await lookupCompareAgain.waitFor({state:'visible',timeout:30000})
  assert.equal(await lookupCompareAgain.getAttribute('aria-pressed'),'true')

  const layout=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const shell=document.querySelector('.research-shell')
    const workspace=document.querySelector('.research-workspace')
    return {
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      shell:{clientWidth:shell.clientWidth,scrollWidth:shell.scrollWidth},
      workspace:{clientWidth:workspace.clientWidth,scrollWidth:workspace.scrollWidth},
    }
  })
  assert.ok(layout.document.scrollWidth<=layout.document.clientWidth+1)
  assert.ok(layout.shell.scrollWidth<=layout.shell.clientWidth+1)
  assert.ok(layout.workspace.scrollWidth<=layout.workspace.clientWidth+1)

  report.mobile.general={
    productId:AATU,
    query:'AATU',
    focusAfterDirectAdd:'compare-control',
    quickViewOpenedByDirectCompare:false,
    detailOpenedByDirectCompare:false,
    listScroll:{before:scrollBefore,after:scrollAfter},
    exploreLookupPreserved:true,
    layout,
  }
  await context.close()
}

async function reachSwitchResults(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  await waitCatalog(page)
  await page.locator('.switch-find-search input').fill('AATU')
  const current=page.locator('.switch-find-result').filter({hasText:/AATU/}).filter({hasText:/연어/}).first()
  await current.waitFor({state:'visible',timeout:30000})
  await current.click()
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
  await sku.waitFor({state:'visible',timeout:30000})
  await sku.click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.locator('.switch-no-change').click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('button',{name:'후보 제품 보기 →'}).click()
  await page.locator('.switch-results-stage').waitFor({state:'visible',timeout:90000})
  await page.waitForFunction(()=>{
    const text=document.querySelector('.switch-session-bar')?.textContent||''
    return text.includes('AATU')&&text.includes('연어')&&text.includes('1 kg')
  },null,{timeout:90000})
}

async function switchMobile(){
  const {context,page}=await pageAt(390,844)
  await reachSwitchResults(page)
  assert.equal(await page.locator('button button').count(),0)

  const search=page.locator('input[aria-label="후보 제품 검색"]')
  await search.fill('GO!')
  const direct=page.locator(`[data-switch-compare-product-id="${GO}"]`)
  const row=page.locator('.switch-candidate-row').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
  await direct.waitFor({state:'visible',timeout:30000})
  await direct.focus()
  await page.keyboard.press('Enter')

  assert.equal(await direct.evaluate(el=>document.activeElement===el),true)
  assert.equal(await direct.getAttribute('aria-pressed'),'true')
  assert.equal(await direct.locator('..').evaluate(el=>el.classList.contains('is-compared')),true)
  assert.equal(await row.evaluate(el=>el.classList.contains('is-selected')),false)
  assert.equal(await page.locator('.switch-candidate-inspector').count(),0,'direct SWITCH compare must not open inspector')
  assert.equal(await search.inputValue(),'GO!')
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/비교 1\/5.*LID 오리/)
  await direct.scrollIntoViewIfNeeded()
  await page.screenshot({path:OUT+'/03-switch-go-direct-added-390x844.png',fullPage:false})

  await row.click()
  const inspector=page.locator('.switch-candidate-inspector')
  await inspector.waitFor({state:'visible',timeout:30000})
  assert.match(norm(await inspector.locator('.switch-inspector-actions').textContent()),/비교에서 제거/)
  await inspector.locator('.switch-preview-topline button').click()
  await inspector.waitFor({state:'detached',timeout:30000})

  await search.fill('__검색결과없음__')
  const zero=page.locator('.switch-candidate-list .switch-state-message').filter({hasText:'이름 검색 결과가 없습니다.'}).first()
  await zero.waitFor({state:'visible',timeout:30000})
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/LID 오리/)
  const dock=page.locator('.switch-compare-dock')
  await dock.evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest'}))
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const dockZero=await dock.evaluate(el=>{
    const r=el.getBoundingClientRect()
    return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,inViewport:r.bottom>0&&r.top<innerHeight,text:el.textContent.replace(/\s+/g,' ').trim()}
  })
  assert.equal(dockZero.inViewport,true)
  await page.screenshot({path:OUT+'/04-switch-zero-dock-centered-390x844.png',fullPage:false})

  const clear=zero.getByRole('button',{name:'검색 지우기'})
  await clear.focus()
  await page.keyboard.press('Enter')
  assert.equal(await search.inputValue(),'')
  assert.equal(await search.evaluate(el=>document.activeElement===el),true)
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/LID 오리/)

  await search.fill('GO!')
  const directAgain=page.locator(`[data-switch-compare-product-id="${GO}"]`)
  await directAgain.waitFor({state:'visible',timeout:30000})
  assert.equal(await directAgain.getAttribute('aria-pressed'),'true','compared marker returns when hidden product reappears')

  const layout=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const stage=document.querySelector('.switch-results-stage')
    const workspace=document.querySelector('.switch-results-workspace')
    const pane=document.querySelector('.switch-candidate-pane')
    return {
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      stage:{clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth},
      workspace:{clientWidth:workspace.clientWidth,scrollWidth:workspace.scrollWidth},
      pane:{clientWidth:pane.clientWidth,scrollWidth:pane.scrollWidth},
    }
  })
  assert.ok(layout.document.scrollWidth<=layout.document.clientWidth+1)
  assert.ok(layout.stage.scrollWidth<=layout.stage.clientWidth+1)
  assert.ok(layout.workspace.scrollWidth<=layout.workspace.clientWidth+1)
  assert.ok(layout.pane.scrollWidth<=layout.pane.clientWidth+1)

  report.mobile.switch={
    currentFood:'AATU 연어',
    currentVariant:'1 kg',
    comparedCandidate:'GO! SOLUTIONS LID 오리',
    queryAfterDirectAdd:'GO!',
    focusAfterDirectAdd:'compare-control',
    inspectorOpenedByDirectCompare:false,
    zeroResultComparisonPreserved:true,
    clearComparisonPreserved:true,
    reappearedComparedMarker:true,
    dockZero,
    layout,
  }
  await context.close()
}

async function generalDesktopMaxFive(){
  const {context,page}=await pageAt(1440,900)
  const url=new URL(BASE)
  url.searchParams.set('view','workspace')
  url.searchParams.set('mode','lookup')
  url.searchParams.set('q','로얄캐닌')
  await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:30000})
  await waitCatalog(page)
  const controls=page.locator('.research-result-compare')
  await page.waitForFunction(()=>document.querySelectorAll('.research-result-compare').length>=6,null,{timeout:30000})
  const count=await controls.count()
  assert.ok(count>=6)
  for(let i=0;i<5;i++) await controls.nth(i).click()
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/비교 5\/5/)
  assert.equal(await controls.nth(5).isDisabled(),true)
  assert.equal(await controls.nth(0).isDisabled(),false)
  assert.equal(await controls.nth(0).getAttribute('aria-pressed'),'true')

  await controls.nth(0).focus()
  await page.keyboard.press('Enter')
  assert.equal(await controls.nth(0).evaluate(el=>document.activeElement===el),true)
  assert.equal(await controls.nth(0).getAttribute('aria-pressed'),'false')
  assert.equal(await controls.nth(5).isDisabled(),false)
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/비교 4\/5/)

  await controls.nth(5).click()
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/비교 5\/5/)
  await page.locator('.switch-compare-dock').scrollIntoViewIfNeeded()
  await page.screenshot({path:OUT+'/05-general-max5-1440x900.png',fullPage:false})

  const layout=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const shell=document.querySelector('.research-shell')
    const workspace=document.querySelector('.research-workspace')
    return {
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      shell:{clientWidth:shell.clientWidth,scrollWidth:shell.scrollWidth},
      workspace:{clientWidth:workspace.clientWidth,scrollWidth:workspace.scrollWidth},
    }
  })
  assert.ok(layout.document.scrollWidth<=layout.document.clientWidth+1)
  assert.ok(layout.shell.scrollWidth<=layout.shell.clientWidth+1)
  assert.ok(layout.workspace.scrollWidth<=layout.workspace.clientWidth+1)

  report.desktop.general={
    query:'로얄캐닌',
    visibleDirectControls:count,
    maxFiveConfirmed:true,
    selectedRemovableAtCap:true,
    sixthReenabledAfterRemoval:true,
    layout,
  }
  await context.close()
}

async function switchDesktopSync(){
  const {context,page}=await pageAt(1440,900)
  await reachSwitchResults(page)
  const search=page.locator('input[aria-label="후보 제품 검색"]')
  await search.fill('GO!')
  const direct=page.locator(`[data-switch-compare-product-id="${GO}"]`)
  const row=page.locator('.switch-candidate-row').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
  await direct.waitFor({state:'visible',timeout:30000})
  await direct.focus()
  await page.keyboard.press('Enter')
  assert.equal(await direct.evaluate(el=>document.activeElement===el),true)
  assert.equal(await direct.getAttribute('aria-pressed'),'true')
  assert.equal(await row.evaluate(el=>el.classList.contains('is-selected')),false)

  await row.click()
  const inspector=page.locator('.switch-candidate-inspector')
  await inspector.waitFor({state:'visible',timeout:30000})
  assert.equal(await row.evaluate(el=>el.classList.contains('is-selected')),true)
  assert.equal(await direct.locator('..').evaluate(el=>el.classList.contains('is-compared')),true)
  assert.match(norm(await inspector.locator('.switch-inspector-actions').textContent()),/비교에서 제거/)
  await inspector.locator('.switch-preview-topline button').click()

  await search.fill('__검색결과없음__')
  await page.locator('.switch-candidate-list .switch-state-message').filter({hasText:'이름 검색 결과가 없습니다.'}).waitFor({state:'visible',timeout:30000})
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/LID 오리/)
  await search.fill('GO!')
  const directAgain=page.locator(`[data-switch-compare-product-id="${GO}"]`)
  await directAgain.waitFor({state:'visible',timeout:30000})
  assert.equal(await directAgain.getAttribute('aria-pressed'),'true')
  assert.equal(await directAgain.locator('..').evaluate(el=>el.classList.contains('is-compared')),true)
  assert.equal(await page.locator('button button').count(),0)

  await directAgain.scrollIntoViewIfNeeded()
  await page.screenshot({path:OUT+'/06-switch-direct-sync-1440x900.png',fullPage:false})

  const layout=await page.evaluate(()=>{
    const doc=document.scrollingElement||document.documentElement
    const stage=document.querySelector('.switch-results-stage')
    const workspace=document.querySelector('.switch-results-workspace')
    return {
      document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
      stage:{clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth},
      workspace:{clientWidth:workspace.clientWidth,scrollWidth:workspace.scrollWidth},
    }
  })
  assert.ok(layout.document.scrollWidth<=layout.document.clientWidth+1)
  assert.ok(layout.stage.scrollWidth<=layout.stage.clientWidth+1)
  assert.ok(layout.workspace.scrollWidth<=layout.workspace.clientWidth+1)

  report.desktop.switch={
    currentFood:'AATU 연어',
    currentVariant:'1 kg',
    comparedCandidate:'GO! SOLUTIONS LID 오리',
    comparedMarkerSurvivesSearchHideShow:true,
    quickViewAndComparedStatesDistinct:true,
    noNestedButtons:true,
    layout,
  }
  await context.close()
}

await generalMobile()
await switchMobile()
await generalDesktopMaxFive()
await switchDesktopSync()

assert.ok(report.reads.length>0)
assert.ok(report.reads.every(row=>['GET','HEAD','OPTIONS'].includes(row.method)))
assert.equal(report.blocked.filter(row=>row.reason==='write').length,0)

await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await browser.close()
