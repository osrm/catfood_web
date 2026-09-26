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
  scenarios:{},
  catalog:null,
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

function normalize(value){return String(value||'').replace(/\s+/g,' ').trim()}

async function newPage(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  let catalogRows=null

  page.on('response',async response=>{
    if(!response.url().includes('/rest/v1/effective_product_catalog_summary')) return
    try {
      const data=await response.json()
      if(Array.isArray(data)) catalogRows=data
    } catch {}
  })

  await page.route('**/*',async route=>{
    const req=route.request(), method=req.method(), url=req.url()
    const analytics=/functions\/v1|search-runs|considerations|event_log|analytics|telemetry/i.test(url)
    const write=!['GET','HEAD','OPTIONS'].includes(method)
    if(analytics||write){
      if(analytics) report.blockedAnalytics.push({method,url})
      if(write) report.blockedWrites.push({method,url})
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })

  return {page,context,getCatalog:()=>catalogRows}
}

async function enterSwitch(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).waitFor({state:'visible',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  await page.locator('.switch-find-search input').waitFor({state:'visible',timeout:10000})
  await page.waitForFunction(()=>document.querySelector('.research-status')?.textContent?.includes('데이터 연결됨')===true,undefined,{timeout:30000})
}

async function chooseProduct(page,query,matcher){
  const input=page.locator('.switch-find-search input')
  await input.fill(query)
  await page.locator('.switch-find-result').first().waitFor({state:'visible',timeout:30000})
  const row=page.locator('.switch-find-result').filter({hasText:matcher}).first()
  assert.ok(await row.count(),'product result exists: '+String(matcher))
  await row.click()
  await page.locator('.switch-current-preview').waitFor({state:'visible'})
  const identity={
    brand:normalize(await page.locator('.switch-preview-identity > div > span').textContent()),
    name:normalize(await page.locator('.switch-preview-identity h2').textContent()),
  }
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  await page.locator('.switch-sku-list').waitFor({state:'visible',timeout:10000})
  await page.locator('.switch-sku-option').first().waitFor({state:'visible',timeout:30000})
  return identity
}

async function chooseAatu(page){
  const identity=await chooseProduct(page,'AATU',/연어/)
  assert.equal(identity.brand,'AATU','AATU brand selected')
  assert.match(identity.name,/연어/,'AATU salmon selected')
  const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
  assert.ok(await sku.count(),'actual 1kg SKU exists')
  await sku.click()
  const selectedSku=normalize(await sku.textContent())
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
  return {...identity,selectedSku}
}

async function visibleExact(page,label,selector='button'){
  const matches=page.getByRole('button',{name:label,exact:true})
  const count=await matches.count()
  for(let i=0;i<count;i++){
    const item=matches.nth(i)
    if(await item.isVisible() && (!selector || await item.evaluate((el,sel)=>el.matches(sel),selector))) return item
  }
  return null
}

async function configureChange(page){
  const noChange=page.locator('.switch-no-change')
  await noChange.click()
  assert.equal((await noChange.getAttribute('class')).includes('is-selected'),true,'no-change selects')
  const brand=await visibleExact(page,'다른 브랜드로 보기','.switch-choice')
  assert.ok(brand)
  await brand.click()
  assert.equal((await noChange.getAttribute('class')).includes('is-selected'),false,'actual change clears no-change')

  const toggle=page.locator('.switch-change-additional-toggle')
  if(await toggle.isVisible()){
    if(await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
  }
  const senior=await visibleExact(page,'시니어','.switch-choice')
  assert.ok(senior,'visible senior choice')
  await senior.click()
  assert.equal(await senior.getAttribute('aria-pressed'),'true','senior selected')
  return {brand,senior}
}

async function collapseAdditional(page){
  const toggle=page.locator('.switch-change-additional-toggle')
  if(await toggle.isVisible() && await toggle.getAttribute('aria-expanded')!=='false') await toggle.click()
  if(await toggle.isVisible()){
    assert.equal(await toggle.getAttribute('aria-expanded'),'false')
    const summary=page.locator('.switch-change-additional-summary')
    assert.equal(await summary.count(),1,'collapsed summary rendered')
    assert.match(normalize(await summary.textContent()),/시니어/,'collapsed summary includes senior')
  }
}

async function configureKeep(page){
  const dry=await visibleExact(page,'건식 유지','.switch-choice')
  const fish=await visibleExact(page,'생선','.switch-choice')
  assert.ok(dry,'dry keep available')
  assert.ok(fish,'fish keep available')
  if(await dry.getAttribute('aria-pressed')!=='true') await dry.click()
  if(await fish.getAttribute('aria-pressed')!=='true') await fish.click()
  assert.equal(await dry.getAttribute('aria-pressed'),'true')
  assert.equal(await fish.getAttribute('aria-pressed'),'true')
  const changeSummary=normalize(await page.locator('.switch-keep-change-summary').textContent())
  const facts=normalize(await page.locator('.switch-current-facts-summary').textContent())
  assert.match(changeSummary,/다른 브랜드/,'KEEP shows actual CHANGE brand intent')
  assert.match(changeSummary,/시니어/,'KEEP shows actual CHANGE senior intent')
  assert.match(facts,/건식/,'current facts retain dry fact')
  assert.match(facts,/생선/,'current facts retain fish recipe')
  return {changeSummary,facts}
}

async function measure(page,step){
  return page.evaluate(step=>{
    const root=document.querySelector('.switch-decision-step-layout')
    const norm=value=>String(value||'').replace(/\s+/g,' ').trim()
    const rect=el=>{if(!(el instanceof HTMLElement))return null;const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    const css=el=>{if(!(el instanceof HTMLElement))return null;const s=getComputedStyle(el);return{fontSize:s.fontSize,lineHeight:s.lineHeight,minHeight:s.minHeight,overflowY:s.overflowY,position:s.position,whiteSpace:s.whiteSpace,outline:s.outline,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset}}
    const main=root?.querySelector('.switch-step-main')
    const actions=root?.querySelector('.switch-step-actions')
    const choices=[...root.querySelectorAll('.switch-choice')].filter(el=>{
      if(!(el instanceof HTMLElement))return false
      const r=el.getBoundingClientRect(),s=getComputedStyle(el)
      return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'
    }).map(el=>({text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:css(el)}))
    const productName=root?.querySelector('.switch-reference-product strong')
    const sku=root?.querySelector('.switch-reference-sku strong')
    const lastCriterion=[...root.querySelectorAll('.switch-criterion-section')].filter(el=>el.getBoundingClientRect().height>0).at(-1)
    return {
      step,
      viewport:{width:innerWidth,height:innerHeight},
      document:{scrollY,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth},
      layout:rect(root),
      main:{box:rect(main),style:css(main),scrollTop:main instanceof HTMLElement?main.scrollTop:null,scrollHeight:main instanceof HTMLElement?main.scrollHeight:null,clientHeight:main instanceof HTMLElement?main.clientHeight:null},
      reference:{box:rect(root?.querySelector('.switch-reference-rail')),productName:{text:productName?.textContent?.trim()||'',box:rect(productName),style:css(productName),scrollWidth:productName instanceof HTMLElement?productName.scrollWidth:null,clientWidth:productName instanceof HTMLElement?productName.clientWidth:null},sku:{text:sku?.textContent?.trim()||'',box:rect(sku),style:css(sku),scrollWidth:sku instanceof HTMLElement?sku.scrollWidth:null,clientWidth:sku instanceof HTMLElement?sku.clientWidth:null}},
      choices,
      actions:{box:rect(actions),primary:{box:rect(actions?.querySelector('.switch-primary-action')),style:css(actions?.querySelector('.switch-primary-action'))},secondary:{box:rect(actions?.querySelector('.switch-secondary-action')),style:css(actions?.querySelector('.switch-secondary-action'))}},
      lastCriterion:rect(lastCriterion),
      changeSummary:norm(root?.querySelector('.switch-keep-change-summary')?.textContent),
      currentFacts:norm(root?.querySelector('.switch-current-facts-summary')?.textContent),
    }
  },step)
}

async function focusInfo(page){
  return page.evaluate(()=>{
    const el=document.activeElement
    if(!(el instanceof HTMLElement))return null
    const r=el.getBoundingClientRect(),s=getComputedStyle(el)
    const extent=(parseFloat(s.outlineWidth)||0)+(parseFloat(s.outlineOffset)||0)
    return {text:el.textContent?.replace(/\s+/g,' ').trim()||'',tag:el.tagName,box:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},focusBox:{top:r.top-extent,bottom:r.bottom+extent,left:r.left-extent,right:r.right+extent},outline:s.outline,outlineWidth:s.outlineWidth}
  })
}

async function keyboardReachSelector(page,selector,direction='Tab',max=100){
  await page.locator('body').click({position:{x:2,y:2}})
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()})
  for(let i=0;i<max;i++){
    await page.keyboard.press(direction)
    const matched=await page.evaluate((selector)=>document.activeElement instanceof HTMLElement&&document.activeElement.matches(selector),selector)
    if(matched) return focusInfo(page)
  }
  return null
}

async function scrollBottom(page,width){
  if(width<=760){
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
  }else{
    await page.locator('.switch-decision-step-layout .switch-step-main').evaluate(el=>{el.scrollTop=el.scrollHeight})
  }
  await page.waitForTimeout(60)
}

function assertSizing(state,key,height){
  assert.equal(state.document.scrollWidth,state.viewport.width,key+': no horizontal overflow')
  assert.ok(state.choices.every(x=>x.box.height>=44),key+': visible choices >=44px')
  assert.ok(state.actions.primary.box.height>=48,key+': primary action >=48px')
  assert.ok(state.actions.secondary.box.height>=48,key+': secondary action >=48px')
  assert.notEqual(state.actions.primary.style.position,'fixed',key+': primary not fixed')
  assert.notEqual(state.actions.primary.style.position,'sticky',key+': primary not sticky')
  assert.ok(state.actions.primary.box.top>=0&&state.actions.primary.box.bottom<=height,key+': primary action in viewport after normal scroll')
  assert.ok(state.actions.secondary.box.top>=0&&state.actions.secondary.box.bottom<=height,key+': secondary action in viewport after normal scroll')
}

async function mobileScenario(){
  const key='mobile-390x844'
  const {page,context}=await newPage(390,844)
  await enterSwitch(page)
  const identity=await chooseAatu(page)
  await configureChange(page)
  await collapseAdditional(page)

  const collapsed=await measure(page,'change-collapsed')
  await page.screenshot({path:OUT+'/'+key+'-change-collapsed.png',fullPage:false})

  await page.setViewportSize({width:761,height:844})
  const senior761=await visibleExact(page,'시니어','.switch-choice')
  assert.ok(senior761,'761px senior accessible through desktop criteria')
  assert.equal(await senior761.getAttribute('aria-pressed'),'true','761px preserves senior')
  assert.notEqual(await page.locator('.switch-change-desktop-criteria').evaluate(el=>getComputedStyle(el).display),'none','761px desktop criteria visible')

  await page.setViewportSize({width:1440,height:900})
  const senior1440=await visibleExact(page,'시니어','.switch-choice')
  assert.ok(senior1440,'1440px senior accessible')
  assert.equal(await senior1440.getAttribute('aria-pressed'),'true','1440px preserves senior')

  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.locator('.switch-change-additional-toggle').getAttribute('aria-expanded'),'false','mobile collapsed state survives roundtrip')
  assert.match(normalize(await page.locator('.switch-change-additional-summary').textContent()),/시니어/,'mobile summary survives roundtrip')

  await page.locator('.switch-change-additional-toggle').click()
  assert.equal(await page.locator('.switch-change-additional-summary').count(),0,'expanded mobile hides duplicate names')
  const seniorBack=await visibleExact(page,'시니어','.switch-choice')
  assert.equal(await seniorBack.getAttribute('aria-pressed'),'true','mobile reopen preserves senior')

  await scrollBottom(page,390)
  const changeBottom=await measure(page,'change-expanded-bottom')
  assertSizing(changeBottom,key+' change',844)
  const nextFocus=await keyboardReachSelector(page,'.switch-step-actions .switch-primary-action')
  assert.ok(nextFocus,'Tab reaches CHANGE primary action')
  assert.equal(nextFocus.tag,'BUTTON','CHANGE primary focus is the actual button')
  assert.ok(parseFloat(nextFocus.outlineWidth)>=2,'CHANGE next focus visible')
  assert.ok(nextFocus.focusBox.bottom<=844,'CHANGE next focus not clipped')
  await page.keyboard.press('Enter')
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})

  const keepSelected=await configureKeep(page)
  await page.evaluate(()=>window.scrollTo(0,0))
  await page.screenshot({path:OUT+'/'+key+'-keep-top.png',fullPage:false})

  await scrollBottom(page,390)
  const keepBottom=await measure(page,'keep-bottom')
  assertSizing(keepBottom,key+' keep',844)
  const candidateFocus=await keyboardReachSelector(page,'.switch-step-actions .switch-primary-action')
  assert.ok(candidateFocus,'Tab reaches KEEP candidate action')
  assert.equal(candidateFocus.tag,'BUTTON','KEEP primary focus is the actual button')
  assert.ok(parseFloat(candidateFocus.outlineWidth)>=2,'KEEP candidate focus visible')
  assert.ok(candidateFocus.focusBox.bottom<=844,'KEEP candidate focus not clipped')

  await page.locator('.switch-step-actions .switch-primary-action').focus()
  await page.keyboard.press('Shift+Tab')
  const backFocus=await focusInfo(page)
  assert.match(backFocus.text,/바꿀 것 수정/,'Shift+Tab reaches KEEP back action')
  await page.keyboard.press('Enter')
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
  const reentrySenior=await visibleExact(page,'시니어','.switch-choice')
  assert.equal(await reentrySenior.getAttribute('aria-pressed'),'true','CHANGE reentry preserves senior')
  assert.equal(await page.locator('.switch-change-additional-toggle').getAttribute('aria-expanded'),'true','advanced value reentry keeps existing disclosure policy')

  report.scenarios[key]={identity,collapsed,changeBottom,keepSelected,keepBottom,nextFocus,candidateFocus,backFocus}
  await context.close()
}

async function desktopScenario(width,height,key,withConflict=false){
  const {page,context}=await newPage(width,height)
  await enterSwitch(page)
  const identity=await chooseAatu(page)
  await configureChange(page)

  await scrollBottom(page,width)
  const change=await measure(page,'change-bottom')
  assertSizing(change,key+' change',height)
  await page.screenshot({path:OUT+'/'+key+'-change-bottom.png',fullPage:false})

  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})
  const keepSelected=await configureKeep(page)

  await scrollBottom(page,width)
  const keep=await measure(page,'keep-bottom')
  assertSizing(keep,key+' keep',height)
  await page.screenshot({path:OUT+'/'+key+'-keep-bottom.png',fullPage:false})

  if(withConflict){
    await page.locator('.switch-step-actions .switch-secondary-action').click()
    await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
    const wet=await visibleExact(page,'습식','.switch-choice')
    assert.ok(wet,'wet CHANGE option exists')
    await wet.click()
    const notice=normalize(await page.locator('[role="status"]').textContent())
    assert.match(notice,/사료 형태 유지 조건을 해제했습니다/,'CHANGE conflict clears KEEP feed type')
    await wet.click()
    await page.locator('.switch-step-actions .switch-primary-action').click()
    await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})
    const dry=await visibleExact(page,'건식 유지','.switch-choice')
    assert.equal(await dry.getAttribute('aria-pressed'),'false','cleared KEEP does not silently restore')
    await dry.click()
    await page.locator('.switch-step-actions .switch-primary-action').click()
    await page.locator('.switch-results-stage').waitFor({state:'visible',timeout:30000})
    assert.match(normalize(await page.locator('.switch-session-bar').textContent()),/CHANGE.*다른 브랜드.*시니어.*KEEP.*건식.*생선/s,'candidate entry keeps final CHANGE/KEEP state')
  }

  report.scenarios[key]={identity,change,keepSelected,keep}
  await context.close()
}

async function longIdentityScenario(){
  const key='long-identity-1440x900'
  const {page,context,getCatalog}=await newPage(1440,900)
  await enterSwitch(page)
  const rows=getCatalog()
  assert.ok(Array.isArray(rows)&&rows.length>0,'captured actual public catalog')
  const candidates=rows
    .filter(row=>row.has_variants&&row.display_image_url&&row.canonical_name)
    .sort((a,b)=>String(b.canonical_name).length-String(a.canonical_name).length)
  assert.ok(candidates.length>0,'long identity candidate available')
  const target=candidates[0]
  const identity=await chooseProduct(page,target.canonical_name,target.canonical_name)
  const skuOptions=page.locator('.switch-sku-option')
  const count=await skuOptions.count()
  assert.ok(count>0,'long identity has actual SKU')
  let longest=skuOptions.first(), longestText=''
  for(let i=0;i<count;i++){
    const item=skuOptions.nth(i),text=normalize(await item.textContent())
    if(text.length>longestText.length){longest=item;longestText=text}
  }
  await longest.click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
  const state=await measure(page,'long-reference')
  assert.equal(state.reference.productName.text,target.canonical_name,'full long product name retained')
  assert.equal(state.reference.productName.style.whiteSpace,'normal','long product name wraps instead of truncating')
  assert.ok(state.reference.productName.scrollWidth<=state.reference.productName.clientWidth+1,'long product name does not horizontally clip')
  assert.ok(state.reference.sku.text.length>0,'actual long SKU text retained')
  const image=page.locator('.switch-reference-image')
  await image.waitFor({state:'visible'})
  const imageLoaded=await image.evaluate(el=>el instanceof HTMLImageElement&&el.complete&&el.naturalWidth>0)
  assert.equal(imageLoaded,true,'actual product image loaded')
  await page.screenshot({path:OUT+'/'+key+'.png',fullPage:false})
  report.scenarios[key]={target:{product_id:target.product_id,brand:target.brand,name:target.canonical_name},identity,selectedSku:longestText,reference:state.reference,imageLoaded}
  report.catalog={count:rows.length}
  await context.close()
}

await mobileScenario()
await desktopScenario(1440,900,'desktop-1440x900',true)
await desktopScenario(1440,700,'desktop-1440x700',false)
await longIdentityScenario()

assert.equal(report.blockedWrites.length,0,'candidate attempted no writes')
assert.equal(report.blockedAnalytics.length,0,'candidate attempted no analytics')
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('SWITCH_CHANGE_KEEP_CANDIDATE='+JSON.stringify({
  sha:report.candidateSha,
  mobile:report.scenarios['mobile-390x844'],
  desktop900:report.scenarios['desktop-1440x900'],
  desktop700:report.scenarios['desktop-1440x700'],
  longIdentity:report.scenarios['long-identity-1440x900'],
  blockedWrites:report.blockedWrites.length,
  blockedAnalytics:report.blockedAnalytics.length,
}))
await browser.close()
