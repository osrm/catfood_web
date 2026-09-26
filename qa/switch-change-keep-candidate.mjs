import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'candidate-output'
await mkdir(OUT,{recursive:true})

const report={
  candidateSha:process.env.GITHUB_SHA||null,
  generatedAt:new Date().toISOString(),
  blockedWrites:[],
  blockedAnalytics:[],
  publicReads:[],
  scenarios:{},
  longIdentity:null,
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

function normalize(value){return String(value||'').replace(/\s+/g,' ').trim()}

async function makePage(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(),method=req.method(),url=req.url()
    const analytics=/functions\/v1|search-runs|considerations|event_log|analytics|telemetry/i.test(url)
    const write=!['GET','HEAD','OPTIONS'].includes(method)
    if(analytics||write){
      if(analytics) report.blockedAnalytics.push({method,url})
      if(write) report.blockedWrites.push({method,url})
      await route.abort('blockedbyclient')
      return
    }
    if(/supabase\.co\/rest\/v1|supabase\.co\/storage\/v1/.test(url)) report.publicReads.push({method,url})
    await route.continue()
  })
  return {page,context}
}

async function assertLoadedImage(locator,label){
  await locator.waitFor({state:'visible',timeout:10000})
  const info=await locator.evaluate(async el=>{
    if(!(el instanceof HTMLImageElement)) return null
    if(!el.complete||el.naturalWidth===0){
      try{ await el.decode() }catch{}
    }
    const r=el.getBoundingClientRect()
    return {src:el.currentSrc||el.src,naturalWidth:el.naturalWidth,naturalHeight:el.naturalHeight,width:r.width,height:r.height}
  })
  assert.ok(info&&info.naturalWidth>0&&info.naturalHeight>0,label+' actual image loaded')
  return info
}

async function enterSwitch(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).waitFor({state:'visible',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  await page.locator('.switch-find-search input').waitFor({state:'visible',timeout:10000})
}

async function enterAatu(page){
  await enterSwitch(page)
  const search=page.locator('.switch-find-search input')
  await search.fill('AATU')
  await page.locator('.switch-find-result').first().waitFor({state:'visible',timeout:30000})
  const salmon=page.locator('.switch-find-result').filter({hasText:/연어/}).first()
  assert.ok(await salmon.count(),'AATU 연어 result exists')
  await salmon.click()
  await page.locator('.switch-current-preview').waitFor({state:'visible'})
  const productName=normalize(await page.locator('.switch-preview-identity h2').textContent())
  const productBrand=normalize(await page.locator('.switch-preview-identity > div > span').textContent())
  assert.equal(productBrand,'AATU','actual current brand')
  assert.match(productName,/연어/,'actual current product')
  const previewImage=await assertLoadedImage(page.locator('.switch-preview-image'),'AATU preview')
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  await page.locator('.switch-sku-option').first().waitFor({state:'visible',timeout:30000})
  const oneKg=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
  assert.ok(await oneKg.count(),'actual 1kg SKU exists')
  await oneKg.click()
  const skuLabel=normalize(await oneKg.locator('strong').textContent())
  assert.match(skuLabel,/1\s*kg|1[,.]?000\s*g/i,'selected actual 1kg SKU')
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
  const referenceImage=await assertLoadedImage(page.locator('.switch-reference-image'),'AATU reference')
  return {productBrand,productName,skuLabel,previewImage,referenceImage}
}

async function activeFocus(page){
  return page.evaluate(()=>{
    const el=document.activeElement
    if(!(el instanceof HTMLElement)) return null
    const r=el.getBoundingClientRect(),s=getComputedStyle(el)
    const extent=(parseFloat(s.outlineWidth)||0)+(parseFloat(s.outlineOffset)||0)
    return {
      text:el.textContent?.replace(/\s+/g,' ').trim()||'',
      className:el.className,
      outline:s.outline,
      outlineWidth:s.outlineWidth,
      outlineOffset:s.outlineOffset,
      box:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},
      focusBox:{top:r.top-extent,bottom:r.bottom+extent,left:r.left-extent,right:r.right+extent},
    }
  })
}

function assertFocusVisible(focus,height,label){
  assert.ok(focus,label+' focus exists')
  assert.ok(parseFloat(focus.outlineWidth)>=2,label+' 2px+ focus outline')
  assert.ok(focus.focusBox.top>=-0.5,label+' focus top visible')
  assert.ok(focus.focusBox.bottom<=height+0.5,label+' focus bottom visible')
}

async function pressTabTo(page,selector,height,max=40){
  for(let i=0;i<max;i++){
    await page.keyboard.press('Tab')
    const focus=await activeFocus(page)
    if(focus) assertFocusVisible(focus,height,'Tab '+focus.text)
    if(await page.evaluate(sel=>document.activeElement?.matches(sel)===true,selector)) return focus
  }
  throw new Error('Tab target not reached: '+selector)
}

async function setChangeReviewState(page,width){
  const noChange=page.locator('.switch-no-change')
  await noChange.click()
  assert.equal(await noChange.evaluate(el=>el.classList.contains('is-selected')),true,'no-change selects')
  await page.getByRole('button',{name:'다른 브랜드로 보기',exact:true}).click()
  assert.equal(await noChange.evaluate(el=>el.classList.contains('is-selected')),false,'actual change clears no-change')

  if(width<=760){
    const toggle=page.locator('.switch-change-additional-toggle')
    if(await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
  }
  const senior=page.getByRole('button',{name:'시니어',exact:true}).filter({visible:true})
  await senior.click()
  assert.equal(await senior.getAttribute('aria-pressed'),'true','senior change selected')

  if(width<=760){
    const toggle=page.locator('.switch-change-additional-toggle')
    if(await toggle.getAttribute('aria-expanded')!=='false') await toggle.click()
    assert.match(normalize(await page.locator('.switch-change-additional-summary').textContent()),/시니어/,'collapsed summary shows senior')
  }
}

async function measureDecision(page,step){
  return page.evaluate((step)=>{
    const root=document.querySelector('.switch-'+step+'-step')||document
    const rect=(el)=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}
    }
    const style=(el)=>{
      if(!(el instanceof HTMLElement)) return null
      const s=getComputedStyle(el)
      return {display:s.display,position:s.position,overflowY:s.overflowY,fontSize:s.fontSize,lineHeight:s.lineHeight,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,overflow:s.overflow}
    }
    const norm=(value)=>String(value||'').replace(/\\s+/g,' ').trim()
    const choices=[...root.querySelectorAll('.switch-choice')].filter(el=>{
      if(!(el instanceof HTMLElement)) return false
      const r=el.getBoundingClientRect(),s=getComputedStyle(el)
      return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'
    }).map(el=>({text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:style(el)}))
    const actions=document.querySelector('.switch-step-actions')
    const main=document.querySelector('.switch-step-main')
    const rail=document.querySelector('.switch-reference-rail')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth,scrollY},
      main:{box:rect(main),scrollTop:main instanceof HTMLElement?main.scrollTop:null,scrollHeight:main instanceof HTMLElement?main.scrollHeight:null,clientHeight:main instanceof HTMLElement?main.clientHeight:null,style:style(main)},
      rail:{box:rect(rail),text:norm(rail?.textContent),style:style(rail)},
      heading:{box:rect(document.querySelector('.switch-step-header h1')),style:style(document.querySelector('.switch-step-header h1'))},
      choices,
      actions:{
        box:rect(actions),
        secondary:{box:rect(actions?.querySelector('.switch-secondary-action')),style:style(actions?.querySelector('.switch-secondary-action')),text:norm(actions?.querySelector('.switch-secondary-action')?.textContent)},
        primary:{box:rect(actions?.querySelector('.switch-primary-action')),style:style(actions?.querySelector('.switch-primary-action')),text:norm(actions?.querySelector('.switch-primary-action')?.textContent)},
      },
      additional:{
        mobileDisplay:style(document.querySelector('.switch-change-mobile-criteria'))?.display||null,
        desktopDisplay:style(document.querySelector('.switch-change-desktop-criteria'))?.display||null,
        expanded:document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')||null,
        summary:norm(document.querySelector('.switch-change-additional-summary')?.textContent)||null,
      },
      keepChangeSummary:norm(document.querySelector('.switch-keep-change-summary')?.textContent)||null,
      currentFacts:norm(document.querySelector('.switch-current-facts-summary')?.textContent)||null,
      horizontalOverflow:document.documentElement.scrollWidth-innerWidth,
    }
  },step)
}

async function resizeRoundTrip(page){
  const toggle=page.locator('.switch-change-additional-toggle')
  assert.equal(await toggle.getAttribute('aria-expanded'),'false','mobile starts review state collapsed')
  const before=await measureDecision(page,'change')
  assert.match(before.additional.summary||'',/시니어/,'mobile collapsed summary')

  await page.setViewportSize({width:761,height:844})
  await page.waitForTimeout(80)
  let state=await measureDecision(page,'change')
  assert.equal(state.additional.mobileDisplay,'none','761 hides mobile disclosure presentation')
  assert.notEqual(state.additional.desktopDisplay,'none','761 exposes desktop condition presentation')
  const senior761=page.locator('.switch-change-desktop-criteria').getByRole('button',{name:'시니어',exact:true})
  assert.equal(await senior761.getAttribute('aria-pressed'),'true','761 keeps senior selected')
  assert.ok((await senior761.boundingBox())?.height>=44,'761 senior remains accessible')

  await page.setViewportSize({width:1440,height:900})
  await page.waitForTimeout(80)
  state=await measureDecision(page,'change')
  assert.notEqual(state.additional.desktopDisplay,'none','1440 desktop conditions accessible')
  const senior1440=page.locator('.switch-change-desktop-criteria').getByRole('button',{name:'시니어',exact:true})
  assert.equal(await senior1440.getAttribute('aria-pressed'),'true','1440 senior selected')

  await page.setViewportSize({width:390,height:844})
  await page.waitForTimeout(80)
  state=await measureDecision(page,'change')
  assert.equal(await toggle.getAttribute('aria-expanded'),'false','return mobile restores prior collapsed state')
  assert.match(state.additional.summary||'',/시니어/,'return mobile keeps selected-name summary')
  await toggle.click()
  const seniorBack=page.locator('.switch-change-additional-content').getByRole('button',{name:'시니어',exact:true})
  assert.equal(await seniorBack.getAttribute('aria-pressed'),'true','return mobile keeps senior selected')
  assert.equal(await page.locator('.switch-change-additional-summary').count(),0,'expanded mobile hides duplicate summary')
  await toggle.click()

  return {before,at761:await page.setViewportSize({width:761,height:844}).then(()=>measureDecision(page,'change')),at1440:await page.setViewportSize({width:1440,height:900}).then(()=>measureDecision(page,'change')),restored:await page.setViewportSize({width:390,height:844}).then(()=>measureDecision(page,'change'))}
}

async function selectKeepReviewState(page){
  const dry=page.getByRole('button',{name:'건식 유지',exact:true})
  assert.ok(await dry.count(),'dry keep available')
  if(await dry.getAttribute('aria-pressed')!=='true') await dry.click()
  const fish=page.getByRole('button',{name:'생선',exact:true})
  assert.ok(await fish.count(),'fish keep available')
  if(await fish.getAttribute('aria-pressed')!=='true') await fish.click()
  assert.equal(await dry.getAttribute('aria-pressed'),'true','dry keep selected')
  assert.equal(await fish.getAttribute('aria-pressed'),'true','fish keep selected')
}

async function mobileScenario(){
  const key='mobile-390x844'
  const {page,context}=await makePage(390,844)
  const identity=await enterAatu(page)
  await setChangeReviewState(page,390)

  const roundTrip=await resizeRoundTrip(page)
  await page.setViewportSize({width:390,height:844})
  const collapsed=await measureDecision(page,'change')
  assert.equal(collapsed.horizontalOverflow,0,'mobile no horizontal overflow')
  assert.ok(collapsed.choices.every(x=>x.box.height>=44),'mobile visible choices >=44px')
  assert.ok(collapsed.actions.primary.box.height>=48&&collapsed.actions.secondary.box.height>=48,'mobile actions >=48px')
  assert.notEqual(collapsed.actions.primary.style.position,'fixed','mobile CTA not fixed')
  assert.notEqual(collapsed.actions.primary.style.position,'sticky','mobile CTA not sticky')
  await page.screenshot({path:OUT+'/'+key+'-change-collapsed.png',fullPage:false})

  const toggle=page.locator('.switch-change-additional-toggle')
  await toggle.click()
  const focusables=page.locator('.switch-change-additional-content button:visible, .switch-change-additional-content input:visible')
  const count=await focusables.count()
  assert.ok(count>0,'expanded additional controls focusable')
  await focusables.nth(count-1).focus()
  const lastConditionFocus=await activeFocus(page)
  assertFocusVisible(lastConditionFocus,844,'last CHANGE control')
  const nextFocus=await pressTabTo(page,'.switch-step-actions .switch-primary-action',844,20)
  assertFocusVisible(nextFocus,844,'CHANGE next action')
  await page.screenshot({path:OUT+'/'+key+'-change-expanded-bottom.png',fullPage:false})
  await page.keyboard.press('Enter')
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})

  await selectKeepReviewState(page)
  let keepState=await measureDecision(page,'keep')
  assert.match(keepState.keepChangeSummary||'',/다른 브랜드/,'KEEP shows change-brand summary')
  assert.match(keepState.keepChangeSummary||'',/시니어/,'KEEP shows senior summary')
  assert.match(keepState.currentFacts||'',/건식/,'KEEP current facts show feed type')
  assert.match(keepState.currentFacts||'',/전연령/,'KEEP current facts show current life stage')
  assert.match(keepState.currentFacts||'',/생선/,'KEEP current facts show current recipe')
  assert.doesNotMatch(keepState.currentFacts||'',/다른 브랜드|시니어/,'KEEP current facts separate user change intent')
  assert.ok(keepState.choices.every(x=>x.box.height>=44),'KEEP choices >=44px')
  assert.ok(keepState.actions.primary.box.height>=48&&keepState.actions.secondary.box.height>=48,'KEEP actions >=48px')
  await page.screenshot({path:OUT+'/'+key+'-keep-selected.png',fullPage:false})

  const keepPrimary=page.locator('.switch-step-actions .switch-primary-action')
  await keepPrimary.focus()
  assertFocusVisible(await activeFocus(page),844,'KEEP primary')
  await page.keyboard.press('Shift+Tab')
  const keepBackFocus=await activeFocus(page)
  assert.ok(String(keepBackFocus?.className||'').includes('switch-secondary-action'),'Shift+Tab reaches KEEP back action')
  assertFocusVisible(keepBackFocus,844,'KEEP back')
  await page.keyboard.press('Enter')
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
  assert.equal(await page.locator('.switch-change-additional-toggle').getAttribute('aria-expanded'),'true','re-enter CHANGE with advanced selection reopens disclosure')
  const seniorReentry=page.locator('.switch-change-additional-content').getByRole('button',{name:'시니어',exact:true})
  assert.equal(await seniorReentry.getAttribute('aria-pressed'),'true','CHANGE re-entry keeps senior')

  const wet=page.getByRole('button',{name:'습식',exact:true}).filter({visible:true})
  await wet.click()
  const notice=page.locator('[role="status"]')
  assert.match(normalize(await notice.textContent()),/사료 형태 유지 조건을 해제했습니다/,'CHANGE conflict clears only dry KEEP')
  await wet.click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})
  const dryAfterConflict=page.getByRole('button',{name:'건식 유지',exact:true})
  assert.equal(await dryAfterConflict.getAttribute('aria-pressed'),'false','removed KEEP does not silently restore')
  const fishAfterConflict=page.getByRole('button',{name:'생선',exact:true})
  assert.equal(await fishAfterConflict.getAttribute('aria-pressed'),'true','unrelated KEEP survives conflict')
  await dryAfterConflict.click()

  keepState=await measureDecision(page,'keep')
  await page.screenshot({path:OUT+'/'+key+'-keep-restored.png',fullPage:false})
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.locator('.switch-results-stage').waitFor({state:'visible',timeout:30000})
  const resultSummary=normalize(await page.locator('.switch-session-bar').textContent())
  assert.match(resultSummary,/CHANGE.*다른 브랜드.*시니어/s,'results preserve CHANGE review state')
  assert.match(resultSummary,/KEEP.*건식.*생선/s,'results preserve KEEP review state')
  assert.ok(await page.locator('.switch-candidate-row').count()>0,'candidate entry succeeds')

  report.scenarios[key]={identity,roundTrip,changeCollapsed:collapsed,keep:keepState,resultSummary}
  await context.close()
}

async function desktopScenario(width,height,key){
  const {page,context}=await makePage(width,height)
  const identity=await enterAatu(page)
  await setChangeReviewState(page,width)
  let change=await measureDecision(page,'change')
  assert.equal(change.horizontalOverflow,0,key+' no horizontal overflow')
  assert.ok(change.choices.every(x=>x.box.height>=44),key+' CHANGE choices >=44px')
  assert.ok(change.actions.primary.box.height>=48&&change.actions.secondary.box.height>=48,key+' CHANGE actions >=48px')
  assert.equal(change.additional.mobileDisplay,'none',key+' mobile disclosure hidden on web')
  assert.notEqual(change.additional.desktopDisplay,'none',key+' web conditions exposed')
  await page.screenshot({path:OUT+'/'+key+'-change-top.png',fullPage:false})

  if(height===700){
    await page.locator('.switch-step-main').hover()
    const lastControl=page.locator('.switch-change-desktop-criteria').getByRole('button',{name:'Grain-Free 표기',exact:true})
    assert.ok(await lastControl.count(),'1440x700 final recipe-trait condition exists')
    let lastControlBox=null
    for(let i=0;i<80;i++){
      await page.mouse.wheel(0,60)
      await page.waitForTimeout(35)
      lastControlBox=await lastControl.boundingBox()
      if(lastControlBox&&lastControlBox.y>=0&&lastControlBox.y+lastControlBox.height<=height) break
    }
    const scrollDiag=await page.locator('.switch-step-main').evaluate(el=>({
      scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,
    }))
    console.log('SWITCH_700_SCROLL_DIAG='+JSON.stringify({lastControlBox,scrollDiag}))
    assert.ok(lastControlBox&&lastControlBox.y>=0&&lastControlBox.y+lastControlBox.height<=height,'1440x700 final Grain-Free condition reachable by normal scroll')

    for(let i=0;i<80;i++){
      change=await measureDecision(page,'change')
      if(change.actions.primary.box.top>=0&&change.actions.primary.box.bottom<=height) break
      await page.mouse.wheel(0,60)
      await page.waitForTimeout(35)
    }
    change=await measureDecision(page,'change')
    assert.ok(change.actions.primary.box.top>=0&&change.actions.primary.box.bottom<=height,'1440x700 CHANGE action reachable by normal scroll')
    assert.equal(change.main.style.overflowY,'auto','1440x700 internal main scroll owner')
    await page.locator('.switch-step-actions .switch-primary-action').focus()
    assertFocusVisible(await activeFocus(page),height,'1440x700 CHANGE action')
    change.lastControl={text:'Grain-Free 표기',box:lastControlBox}
  }
  await page.screenshot({path:OUT+'/'+key+'-change-bottom.png',fullPage:false})

  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})
  await selectKeepReviewState(page)
  let keep=await measureDecision(page,'keep')
  assert.ok(keep.choices.every(x=>x.box.height>=44),key+' KEEP choices >=44px')
  assert.ok(keep.actions.primary.box.height>=48&&keep.actions.secondary.box.height>=48,key+' KEEP actions >=48px')
  assert.match(keep.keepChangeSummary||'',/다른 브랜드.*시니어/s,key+' dynamic CHANGE summary')
  assert.match(keep.currentFacts||'',/건식.*전연령.*생선/s,key+' compact current facts')
  await page.screenshot({path:OUT+'/'+key+'-keep-top.png',fullPage:false})

  if(height===700){
    await page.locator('.switch-step-main').hover()
    await page.mouse.wheel(0,5000)
    keep=await measureDecision(page,'keep')
    assert.ok(keep.actions.primary.box.top>=0&&keep.actions.primary.box.bottom<=height,'1440x700 KEEP action reachable')
    await page.locator('.switch-step-actions .switch-primary-action').focus()
    assertFocusVisible(await activeFocus(page),height,'1440x700 KEEP action')
  }
  await page.screenshot({path:OUT+'/'+key+'-keep-bottom.png',fullPage:false})
  report.scenarios[key]={identity,change,keep}
  await context.close()
}

async function longIdentityCase(){
  const {page,context}=await makePage(1440,900)
  await enterSwitch(page)
  const search=page.locator('.switch-find-search input')
  for(const term of ['로얄캐닌','Royal Canin']){
    await search.fill(term)
    try{
      await page.locator('.switch-find-result').first().waitFor({state:'visible',timeout:10000})
      if(await page.locator('.switch-find-result').count()) break
    }catch{}
  }
  const count=await page.locator('.switch-find-result').count()
  assert.ok(count>0,'long-identity search results exist')
  const options=[]
  for(let i=0;i<count;i++){
    const row=page.locator('.switch-find-result').nth(i)
    const name=normalize(await row.locator('.switch-find-result-copy strong').textContent())
    options.push({i,name,length:name.length})
  }
  options.sort((a,b)=>b.length-a.length)
  const pick=options[0]
  await page.locator('.switch-find-result').nth(pick.i).click()
  await page.locator('.switch-current-preview').waitFor({state:'visible'})
  const productName=normalize(await page.locator('.switch-preview-identity h2').textContent())
  const productBrand=normalize(await page.locator('.switch-preview-identity > div > span').textContent())
  const image=await assertLoadedImage(page.locator('.switch-preview-image'),'long identity preview')
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  await page.locator('.switch-sku-option').first().waitFor({state:'visible',timeout:30000})
  const skuCount=await page.locator('.switch-sku-option').count()
  assert.ok(skuCount>0,'long identity actual SKUs exist')
  let longest={i:0,text:'',length:-1}
  for(let i=0;i<skuCount;i++){
    const text=normalize(await page.locator('.switch-sku-option').nth(i).locator('strong').textContent())
    if(text.length>longest.length) longest={i,text,length:text.length}
  }
  await page.locator('.switch-sku-option').nth(longest.i).click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
  const refs=await page.evaluate(()=> {
    const name=document.querySelector('.switch-reference-product > div > strong')
    const sku=document.querySelector('.switch-reference-sku strong')
    const inspect=(el)=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect(),s=getComputedStyle(el)
      return {text:el.textContent?.trim()||'',box:{width:r.width,height:r.height},scrollWidth:el.scrollWidth,scrollHeight:el.scrollHeight,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,overflow:s.overflow}
    }
    return {name:inspect(name),sku:inspect(sku)}
  })
  assert.equal(refs.name.text,productName,'reference keeps full long product name')
  assert.equal(refs.sku.text,longest.text,'reference keeps full long SKU')
  assert.notEqual(refs.name.whiteSpace,'nowrap','long product name may wrap')
  assert.notEqual(refs.sku.whiteSpace,'nowrap','long SKU may wrap')
  await page.screenshot({path:OUT+'/desktop-1440x900-long-identity.png',fullPage:false})
  report.longIdentity={productBrand,productName,sku:longest.text,image,reference:refs}
  await context.close()
}

await mobileScenario()
await desktopScenario(1440,900,'desktop-1440x900')
await desktopScenario(1440,700,'desktop-1440x700')
await longIdentityCase()

assert.equal(report.blockedWrites.length,0,'candidate attempted no writes')
assert.equal(report.blockedAnalytics.length,0,'candidate attempted no analytics')
assert.ok(report.publicReads.length>0,'candidate used public Supabase reads')

await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('SWITCH_CHANGE_KEEP_CANDIDATE='+JSON.stringify({
  sha:report.candidateSha,
  mobile:{
    identity:report.scenarios['mobile-390x844'].identity,
    changeHeight:report.scenarios['mobile-390x844'].changeCollapsed.document.scrollHeight,
    keepHeight:report.scenarios['mobile-390x844'].keep.document.scrollHeight,
  },
  desktop900:{
    changeScrollHeight:report.scenarios['desktop-1440x900'].change.main.scrollHeight,
    keepScrollHeight:report.scenarios['desktop-1440x900'].keep.main.scrollHeight,
  },
  desktop700:{
    changeScrollTop:report.scenarios['desktop-1440x700'].change.main.scrollTop,
    keepScrollTop:report.scenarios['desktop-1440x700'].keep.main.scrollTop,
  },
  longIdentity:report.longIdentity,
  blockedWrites:report.blockedWrites.length,
  blockedAnalytics:report.blockedAnalytics.length,
  publicReads:report.publicReads.length,
}))
await browser.close()
