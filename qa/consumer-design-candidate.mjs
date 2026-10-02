import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const CANDIDATE = process.env.CANDIDATE_URL || 'http://127.0.0.1:4173/'
const PAGES = process.env.PAGES_URL || 'https://osrm.github.io/catfood_web/'
const OUT = process.env.OUT_DIR || 'consumer-design-candidate-output'
const PRODUCT_SHA = process.env.PRODUCT_SHA || ''
await mkdir(OUT,{recursive:true})

const report = {
  productSha: PRODUCT_SHA,
  candidateUrl: CANDIDATE,
  baselinePagesUrl: PAGES,
  network: { candidate:{reads:[],blocked:[],requestFailures:[],responseFailures:[]}, baseline:{reads:[],blocked:[],requestFailures:[],responseFailures:[]} },
  candidate:{mobile:{},desktop:{}},
  baseline:{mobile:{},desktop:{}},
  screenshots:{},
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

const clean=v=>String(v||'').replace(/\s+/g,' ').trim()

async function makePage(viewport, kind){
  const context=await browser.newContext({viewport,serviceWorkers:'block'})
  const page=await context.newPage()
  const net=report.network[kind]
  page.on('requestfailed',req=>net.requestFailures.push({method:req.method(),url:req.url(),failure:req.failure()?.errorText||'unknown',resourceType:req.resourceType()}))
  page.on('response',res=>{ if(res.status()>=400) net.responseFailures.push({status:res.status(),url:res.url(),resourceType:res.request().resourceType()}) })
  await page.route('**/*',async route=>{
    const req=route.request(), method=req.method(), url=new URL(req.url())
    const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
    if(analytics || (url.hostname.endsWith('.supabase.co') && !['GET','HEAD','OPTIONS'].includes(method))){
      net.blocked.push({method,url:url.href,reason:analytics?'analytics':'write',resourceType:req.resourceType()})
      return route.abort('blockedbyclient')
    }
    if(url.hostname.endsWith('.supabase.co')) net.reads.push({method,path:url.pathname,query:url.search})
    await route.continue()
  })
  return {context,page}
}

async function settle(page){
  return page.evaluate(async()=>{
    if(document.fonts?.ready) await document.fonts.ready
    const visible=[...document.images].filter(img=>{const r=img.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth})
    await Promise.all(visible.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{
      let done=false;const finish=()=>{if(done)return;done=true;resolve()}
      img.addEventListener('load',finish,{once:true});img.addEventListener('error',finish,{once:true});setTimeout(finish,12000)
    })))
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))
    return {
      fontStatus:document.fonts?.status||'unsupported',
      visibleImages:visible.map(img=>({src:img.currentSrc||img.src,outcome:img.complete&&img.naturalWidth>0?'loaded':img.complete?'failed':'timeout',naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight})),
    }
  })
}
async function shot(page,name){
  const visuals=await settle(page)
  const doc=await page.evaluate(()=>({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight,overflowX:document.documentElement.scrollWidth-document.documentElement.clientWidth}))
  await page.screenshot({path:OUT+'/'+name,fullPage:false})
  report.screenshots[name]={url:page.url(),viewport:page.viewportSize(),visuals,document:doc}
}
async function waitHome(page){
  await page.locator('.home-shell').waitFor({state:'visible',timeout:30000})
  await page.waitForFunction(()=>/현재 확인된 제품 \d+개/.test(document.querySelector('.home-catalog-status')?.textContent||''),null,{timeout:90000})
  await settle(page)
}
async function waitCatalog(page){
  await page.waitForFunction(()=>/\d+\s*PRODUCTS/.test(document.querySelector('.research-status')?.textContent||''),null,{timeout:90000})
}
async function waitResults(page){
  await page.locator('.research-result-row').first().waitFor({state:'visible',timeout:90000})
  await settle(page)
}
async function waitDetail(page){
  await page.locator('.detail-stage').waitFor({state:'visible',timeout:30000})
  await page.waitForFunction(()=>{
    const t=document.body.textContent||''
    return !t.includes('판매 규격을 불러오는 중입니다.')
      && !t.includes('원재료 정보를 불러오는 중입니다.')
      && !t.includes('영양 정보를 불러오는 중입니다.')
      && !t.includes('제조 정보를 불러오는 중입니다.')
      && !t.includes('유통 정보를 불러오는 중입니다.')
  },null,{timeout:90000})
  await settle(page)
}
async function rect(page,selector){
  return page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth}})
}
async function style(page,selector,props){
  return page.locator(selector).first().evaluate((el,props)=>{const s=getComputedStyle(el);return Object.fromEntries(props.map(p=>[p,s.getPropertyValue(p)]))},props)
}
async function homeState(page,target,prefix){
  await page.goto(target,{waitUntil:'domcontentloaded',timeout:30000})
  await waitHome(page)
  const state={
    text:clean(await page.locator('.home-start').textContent()),
    title:clean(await page.locator('.home-start-copy h1').textContent()),
    titleStyle:await style(page,'.home-start-copy h1',['font-family','font-size','font-weight','line-height','color']),
    bodyStyle:await style(page,'.home-shell',['font-family','background-color','color']),
    searchRect:await rect(page,'.home-entry-search'),
    routeRects:await page.locator('.home-entry-route').evaluateAll(xs=>xs.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}}))
  }
  await shot(page,prefix+'-home.png')
  return state
}
async function enterExplore(page){
  const route=page.locator('.home-entry-route').nth(1)
  await route.getByRole('button').click()
  await waitCatalog(page)
  await page.locator('.condition-actions').waitFor({state:'visible',timeout:30000})
  const clickVisible=async(name)=>{
    const xs=page.getByRole('button',{name,exact:true})
    for(let i=0;i<await xs.count();i++){ if(await xs.nth(i).isVisible()){await xs.nth(i).click();return} }
    throw new Error('missing visible '+name)
  }
  await clickVisible('건식')
  await clickVisible('성묘')
  await page.getByRole('button',{name:'이 조건으로 찾기'}).click()
  await waitResults(page)
}
async function listState(page,prefix){
  const state={
    criteria:clean(await page.locator('.criteria-bar').textContent()),
    heading:clean(await page.locator('.research-results-heading').textContent()),
    firstRows:await page.locator('.research-result-row').evaluateAll(xs=>xs.slice(0,3).map(el=>({
      text:(el.textContent||'').replace(/\s+/g,' ').trim(),
      rect:(()=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}})()
    }))),
    imageStyle:await style(page,'.research-result-image',['width','height','object-fit']),
    identityStyle:await style(page,'.research-result-identity > strong',['font-size','font-weight','line-height','color']),
  }
  await shot(page,prefix+'-list.png')
  return state
}
async function pickTwoAndDetail(page,prefix){
  const rows=page.locator('.research-result-row')
  assert.ok(await rows.count()>=2)
  await rows.nth(0).locator('.research-result-compare').click()
  await rows.nth(1).locator('.research-result-compare').click()
  await rows.nth(0).locator('.research-result-card').click()
  await page.locator('.research-quick-view').waitFor({state:'visible',timeout:30000})
  await page.getByRole('button',{name:'상세 보기 →'}).click()
  await waitDetail(page)
  const state={
    identity:clean(await page.locator('.detail-identity').textContent()),
    titleStyle:await style(page,'.detail-identity-copy h1',['font-family','font-size','font-weight','line-height','color']),
    imageRect:await rect(page,'.detail-product-image'),
    tabs:await page.locator('.detail-tabs button').allTextContents(),
    bodyFont:await style(page,'.detail-body',['font-family','font-size','color']),
  }
  await shot(page,prefix+'-detail.png')
  return state
}
async function returnAndCompare(page,prefix,isCandidate){
  await page.locator('.detail-topbar button').click()
  await page.locator('.switch-compare-dock').waitFor({state:'visible',timeout:30000})
  await page.locator('.switch-compare-dock').getByRole('button',{name:'비교 보기 →'}).click()
  await page.locator('.compare-stage').waitFor({state:'visible',timeout:30000})
  await settle(page)
  const overview={
    text:clean((await page.locator('.compare-stage').textContent()).slice(0,1600)),
    cellStyle:await style(page,'.compare-cell',['font-size','line-height','color']).catch(()=>null),
    headerStyle:await style(page,'.compare-header h1',['font-family','font-size','font-weight','color']),
    mobileTwoHeads:await page.locator('.compare-mobile-two-product-head').count(),
  }
  await shot(page,prefix+'-compare.png')

  if(isCandidate && page.viewportSize()?.width===390){
    await page.getByRole('tab',{name:'원재료'}).click()
    await page.waitForFunction(()=>!(document.querySelector('.compare-stage')?.textContent||'').includes('원재료 정보를 불러오는 중입니다.'),null,{timeout:90000})
    const wrap=page.locator('#compare-panel-ingredients')
    await wrap.waitFor({state:'visible',timeout:30000})
    const box=await wrap.boundingBox();assert.ok(box)
    await page.mouse.move(box.x+box.width*.75,box.y+Math.min(280,box.height*.5))
    const before=await wrap.evaluate(el=>el.scrollLeft)
    await page.mouse.wheel(403,0)
    await page.waitForTimeout(1000)
    const after=await wrap.evaluate(el=>el.scrollLeft)
    const fixed=await page.locator('#compare-panel-ingredients .compare-row-label').first().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right}})
    const heads=page.locator('#compare-panel-ingredients .compare-product-head')
    const targetIndex=Math.min(2,(await heads.count())-1)
    const target=await heads.nth(targetIndex).evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right}})
    const sourceRow=page.locator('#compare-panel-ingredients .compare-row').filter({has:page.locator('.compare-row-label',{hasText:'출처 원문'})}).first()
    const details=sourceRow.locator('details')
    if(await details.count()) await details.first().locator('summary').click()
    await shot(page,prefix+'-compare-ingredients.png')
    overview.ingredientRegression={before,after,fixed,target,openDetails:await sourceRow.locator('details[open]').count(),ingredientStyle:await style(page,'#compare-panel-ingredients .compare-cell',['font-size','line-height'])}
  }
  return overview
}
async function switchState(page,target,prefix,isCandidate){
  await page.goto(target,{waitUntil:'domcontentloaded',timeout:30000})
  await waitHome(page)
  await page.locator('.home-entry-route').nth(0).getByRole('button').click()
  await waitCatalog(page)
  const input=page.locator('.switch-find-search input')
  await input.waitFor({state:'visible',timeout:30000})
  await input.fill('AATU')
  const row=page.locator('.switch-find-result').filter({hasText:/연어/}).first()
  await row.waitFor({state:'visible',timeout:30000});await row.click()
  await page.locator('.switch-current-preview').waitFor({state:'visible',timeout:30000})
  await settle(page)
  const action=page.locator('.switch-current-preview .switch-primary-action').first()
  const state={
    previewText:clean((await page.locator('.switch-current-preview').textContent()).slice(0,1300)),
    actionText:clean(await action.textContent()),
    actionRect:await action.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:r.bottom<=innerHeight&&r.top>=0}}),
    identityRect:await rect(page,'.switch-preview-identity'),
    imageStyle:await style(page,'.switch-preview-image',['width','height','object-fit']),
  }
  await shot(page,prefix+'-switch.png')
  if(isCandidate){
    assert.ok(state.actionRect.visible,'current-food confirmation must be fully visible')
    await action.click()
    await page.locator('.switch-sku-option').first().waitFor({state:'visible',timeout:30000})
    const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
    if(await sku.count()) await sku.click(); else await page.locator('.switch-sku-option').first().click()
    await page.locator('.switch-step-actions .switch-primary-action').click()
    await page.getByRole('heading',{name:'어떤 점을 바꾸고 싶나요?'}).waitFor({timeout:30000})
    const different=page.getByRole('button',{name:'다른 브랜드로 보기',exact:true})
    for(let i=0;i<await different.count();i++) if(await different.nth(i).isVisible()){await different.nth(i).click();break}
    await page.locator('.switch-step-actions .switch-primary-action').click()
    await page.getByRole('heading',{name:'어떤 점을 그대로 유지할까요?'}).waitFor({timeout:30000})
    const keepDry=page.getByRole('button',{name:'건식 유지',exact:true})
    if(await keepDry.count()) await keepDry.click()
    await page.getByRole('button',{name:'비교할 제품 보기 →'}).click()
    await page.locator('.switch-candidate-row').first().waitFor({state:'visible',timeout:90000})
    await page.getByLabel('비교할 제품 검색').fill('GO!')
    await page.waitForTimeout(500)
    const candidates=page.locator('.switch-candidate-item')
    assert.ok(await candidates.count()>0)
    state.resultsText=clean((await page.locator('.switch-results-stage').textContent()).slice(0,1800))
    state.candidateCount=await candidates.count()
  }
  return state
}

async function review(kind,target,viewport,label,isCandidate){
  const first=await makePage(viewport,kind)
  const bucket=report[kind][label]
  bucket.home=await homeState(first.page,target,kind+'-'+label+'-01')
  await enterExplore(first.page)
  bucket.list=await listState(first.page,kind+'-'+label+'-02')
  bucket.detail=await pickTwoAndDetail(first.page,kind+'-'+label+'-03')
  bucket.compare=await returnAndCompare(first.page,kind+'-'+label+'-04',isCandidate)
  await first.context.close()

  const sw=await makePage(viewport,kind)
  bucket.switch=await switchState(sw.page,target,kind+'-'+label+'-05',isCandidate)
  await sw.context.close()
}

await review('baseline',PAGES,{width:390,height:844},'mobile',false)
await review('candidate',CANDIDATE,{width:390,height:844},'mobile',true)
await review('baseline',PAGES,{width:1440,height:900},'desktop',false)
await review('candidate',CANDIDATE,{width:1440,height:900},'desktop',true)

// Narrow regression for PR #91 with all five stored products.
const fiveIds=[
  'product_233c934895be6293',
  'product_3d096b5a07657d56',
  'product_a0e685be674c6617',
  'product_5b13354ad9792881',
  'product_e7eb6b131871033e',
]
function fiveProductUrl(){
  const u=new URL(CANDIDATE)
  u.searchParams.set('view','workspace')
  u.searchParams.set('mode','lookup')
  u.searchParams.set('q','GO!')
  u.searchParams.set('criteria','1')
  u.searchParams.set('feed','건식')
  u.searchParams.set('age','adult')
  u.searchParams.set('compare',fiveIds.join(','))
  u.searchParams.set('compareOpen','1')
  u.searchParams.set('compareTab','ingredients')
  return u.href
}
{
  const first=await makePage({width:390,height:844},'candidate')
  await first.page.goto(fiveProductUrl(),{waitUntil:'domcontentloaded',timeout:30000})
  await first.page.locator('#compare-panel-ingredients').waitFor({state:'visible',timeout:90000})
  await first.page.waitForFunction(()=>{
    const panel=document.querySelector('#compare-panel-ingredients')
    if(!panel || (document.body.textContent||'').includes('원재료 정보를 불러오는 중입니다.')) return false
    return panel.querySelectorAll('.compare-head-row .compare-product-head').length===5
      && panel.querySelectorAll('.compare-row').length>4
  },null,{timeout:90000})
  await settle(first.page)
  const wrap=first.page.locator('#compare-panel-ingredients')
  assert.equal(await wrap.evaluate(el=>el.scrollLeft),0)
  const box=await wrap.boundingBox();assert.ok(box)
  await first.page.mouse.move(box.x+box.width*.75,box.y+Math.min(280,box.height*.5))
  await first.page.mouse.wheel(403,0)
  await first.page.waitForTimeout(1000)
  const scrollLeft=await wrap.evaluate(el=>el.scrollLeft)
  const maxScroll=await wrap.evaluate(el=>el.scrollWidth-el.clientWidth)
  const fixed=await first.page.locator('#compare-panel-ingredients .compare-row-label').first().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right}})
  const goHead=await first.page.locator('#compare-panel-ingredients .compare-product-head').nth(2).evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right}})
  assert.equal(Math.round(scrollLeft),380)
  assert.ok(goHead.left>=fixed.right-1.5)
  const sourceRow=first.page.locator('#compare-panel-ingredients .compare-row').filter({has:first.page.locator('.compare-row-label',{hasText:'출처 원문'})}).first()
  const goSource=sourceRow.locator('.compare-cell').nth(2)
  const goDetails=goSource.locator('details')
  if(await goDetails.count()){
    await goDetails.locator('summary').click()
    assert.equal(await goDetails.evaluate(el=>el.open),true)
  }
  report.candidate.mobile.fiveProductIngredients={
    scrollLeft,maxScroll,fixed,goHead,
    openSource:await goSource.locator('details[open]').count(),
    rawTextStart:clean((await goSource.textContent()).slice(0,260)),
    documentOverflow:await first.page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),
    valueStyle:await style(first.page,'#compare-panel-ingredients .compare-cell',['font-size','line-height'])
  }
  await shot(first.page,'candidate-mobile-06-five-product-ingredients.png')
  await first.context.close()
}
{
  const small=await makePage({width:390,height:844},'candidate')
  await small.page.goto(fiveProductUrl(),{waitUntil:'domcontentloaded',timeout:30000})
  await small.page.locator('#compare-panel-ingredients').waitFor({state:'visible',timeout:90000})
  await small.page.waitForFunction(()=>document.querySelectorAll('#compare-panel-ingredients .compare-product-head').length===5 && !(document.body.textContent||'').includes('원재료 정보를 불러오는 중입니다.'),null,{timeout:90000})
  const wrap=small.page.locator('#compare-panel-ingredients')
  const box=await wrap.boundingBox();assert.ok(box)
  await small.page.mouse.move(box.x+box.width*.75,box.y+Math.min(280,box.height*.5))
  await small.page.mouse.wheel(60,0)
  await small.page.waitForTimeout(1000)
  report.candidate.mobile.fiveProductSmallWheel={scrollLeft:await wrap.evaluate(el=>el.scrollLeft)}
  assert.equal(Math.round(report.candidate.mobile.fiveProductSmallWheel.scrollLeft),190)
  await small.context.close()
}

for(const kind of ['baseline','candidate']){
  const net=report.network[kind]
  net.summary={
    publicReadCount:net.reads.length,
    blockedWriteAttempts:net.blocked.filter(x=>x.reason==='write').length,
    blockedAnalyticsAttempts:net.blocked.filter(x=>x.reason==='analytics').length,
    requestFailureCount:net.requestFailures.length,
    responseFailureCount:net.responseFailures.length,
  }
  assert.equal(net.summary.blockedWriteAttempts,0)
  assert.equal(net.summary.blockedAnalyticsAttempts,0)
  assert.ok(net.summary.publicReadCount>0)
}
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await browser.close()
