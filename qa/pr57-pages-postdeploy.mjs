import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'pr57-postdeploy-output'
await mkdir(OUT,{recursive:true})

const report={
  deployedMergeSha:'7f49ac85e20e9873f37e70c08995240032168722',
  generatedAt:new Date().toISOString(),
  blockedWrites:[],
  blockedAnalytics:[],
  scenarios:{},
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

const normalize=(value)=>String(value||'').replace(/\s+/g,' ').trim()

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
    await route.continue()
  })
  return {page,context}
}

async function enterSwitch(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).waitFor({state:'visible',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  await page.locator('.switch-find-search input').waitFor({state:'visible',timeout:10000})
  await page.waitForFunction(
    ()=>document.querySelector('.research-status')?.textContent?.includes('데이터 연결됨')===true,
    undefined,
    {timeout:30000},
  )
}

async function visibleExact(page,label,selector='button'){
  const matches=page.getByRole('button',{name:label,exact:true})
  const count=await matches.count()
  for(let i=0;i<count;i++){
    const item=matches.nth(i)
    if(await item.isVisible() && await item.evaluate((el,sel)=>el.matches(sel),selector)) return item
  }
  return null
}

async function chooseAatu(page){
  const input=page.locator('.switch-find-search input')
  await input.fill('AATU')
  await page.locator('.switch-find-result').first().waitFor({state:'visible',timeout:30000})
  const row=page.locator('.switch-find-result').filter({hasText:/연어/}).first()
  assert.ok(await row.count(),'AATU salmon result exists')
  await row.click()
  await page.locator('.switch-current-preview').waitFor({state:'visible'})
  const previewName=normalize(await page.locator('.switch-preview-identity h2').textContent())
  const previewBrand=normalize(await page.locator('.switch-preview-identity > div > span').textContent())
  assert.equal(previewBrand,'AATU','AATU brand selected')
  assert.match(previewName,/연어/,'AATU salmon selected')

  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  await page.locator('.switch-sku-list').waitFor({state:'visible',timeout:10000})
  await page.locator('.switch-sku-option').first().waitFor({state:'visible',timeout:30000})
  const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
  assert.ok(await sku.count(),'actual 1kg SKU exists')
  const skuText=normalize(await sku.textContent())
  await sku.click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})

  const image=page.locator('.switch-reference-image')
  await image.waitFor({state:'visible',timeout:10000})
  await page.waitForFunction(()=>{
    const img=document.querySelector('.switch-reference-image')
    return img instanceof HTMLImageElement&&img.complete&&img.naturalWidth>0
  },undefined,{timeout:30000})

  return {previewBrand,previewName,skuText}
}

async function configureChange(page){
  const brand=await visibleExact(page,'다른 브랜드로 보기','.switch-choice')
  assert.ok(brand,'different-brand choice visible')
  await brand.click()
  assert.equal(await brand.getAttribute('aria-pressed'),'true','different-brand selected')

  const toggle=page.locator('.switch-change-additional-toggle')
  if(await toggle.isVisible() && await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
  const senior=await visibleExact(page,'시니어','.switch-choice')
  assert.ok(senior,'senior choice visible')
  await senior.click()
  assert.equal(await senior.getAttribute('aria-pressed'),'true','senior selected')
}

async function focusInfo(page){
  return page.evaluate(()=>{
    const el=document.activeElement
    if(!(el instanceof HTMLElement)) return null
    const r=el.getBoundingClientRect(),s=getComputedStyle(el)
    const extent=(parseFloat(s.outlineWidth)||0)+(parseFloat(s.outlineOffset)||0)
    return {
      text:el.textContent?.replace(/\s+/g,' ').trim()||'',
      tag:el.tagName,
      className:el.className,
      outlineWidth:s.outlineWidth,
      box:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},
      focusBox:{top:r.top-extent,bottom:r.bottom+extent,left:r.left-extent,right:r.right+extent},
    }
  })
}

async function tabTo(page,selector,max=120){
  await page.locator('body').click({position:{x:2,y:2}})
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()})
  for(let i=0;i<max;i++){
    await page.keyboard.press('Tab')
    const matched=await page.evaluate((selector)=>document.activeElement instanceof HTMLElement&&document.activeElement.matches(selector),selector)
    if(matched) return focusInfo(page)
  }
  return null
}

async function measureDecision(page){
  return page.evaluate(()=>{
    const root=document.querySelector('.switch-decision-step-layout')
    const rect=el=>{if(!(el instanceof HTMLElement))return null;const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    const css=el=>{if(!(el instanceof HTMLElement))return null;const s=getComputedStyle(el);return{fontSize:s.fontSize,minHeight:s.minHeight,position:s.position,whiteSpace:s.whiteSpace,overflowY:s.overflowY,outlineWidth:s.outlineWidth}}
    const main=root?.querySelector('.switch-step-main')
    const actions=root?.querySelector('.switch-step-actions')
    const choices=[...root.querySelectorAll('.switch-choice')].filter(el=>{
      if(!(el instanceof HTMLElement))return false
      const r=el.getBoundingClientRect(),s=getComputedStyle(el)
      return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'
    }).map(el=>({text:el.textContent?.trim()||'',box:rect(el),style:css(el),pressed:el.getAttribute('aria-pressed')}))
    const product=root?.querySelector('.switch-reference-product strong')
    const sku=root?.querySelector('.switch-reference-sku strong')
    const criteria=[...root.querySelectorAll('.switch-criterion-section')].filter(el=>el.getBoundingClientRect().height>0)
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{scrollY,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},
      main:{box:rect(main),scrollTop:main instanceof HTMLElement?main.scrollTop:null,scrollHeight:main instanceof HTMLElement?main.scrollHeight:null,clientHeight:main instanceof HTMLElement?main.clientHeight:null,style:css(main)},
      reference:{
        product:{text:product?.textContent?.trim()||'',box:rect(product),style:css(product),scrollWidth:product instanceof HTMLElement?product.scrollWidth:null,clientWidth:product instanceof HTMLElement?product.clientWidth:null},
        sku:{text:sku?.textContent?.trim()||'',box:rect(sku),scrollWidth:sku instanceof HTMLElement?sku.scrollWidth:null,clientWidth:sku instanceof HTMLElement?sku.clientWidth:null},
      },
      choices,
      lastCriterion:rect(criteria.at(-1)),
      actions:{
        box:rect(actions),
        secondary:{box:rect(actions?.querySelector('.switch-secondary-action')),style:css(actions?.querySelector('.switch-secondary-action'))},
        primary:{box:rect(actions?.querySelector('.switch-primary-action')),style:css(actions?.querySelector('.switch-primary-action'))},
      },
      changeSummary:root?.querySelector('.switch-keep-change-summary')?.textContent?.replace(/\s+/g,' ').trim()||'',
      currentFacts:root?.querySelector('.switch-current-facts-summary')?.textContent?.replace(/\s+/g,' ').trim()||'',
    }
  })
}

async function mobile(){
  const key='mobile-390x844'
  const {page,context}=await makePage(390,844)
  await enterSwitch(page)
  const identity=await chooseAatu(page)
  await configureChange(page)

  const toggle=page.locator('.switch-change-additional-toggle')
  assert.equal(await toggle.getAttribute('aria-expanded'),'true','advanced conditions open after selection')
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-expanded'),'false','additional conditions collapse')
  const countText=normalize(await toggle.locator('small').textContent())
  const collapsedSummary=normalize(await page.locator('.switch-change-additional-summary').textContent())
  assert.match(countText,/1개 선택/,'collapsed state shows selected count')
  assert.match(collapsedSummary,/시니어/,'collapsed state shows selected name')

  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-expanded'),'true','additional conditions reopen')
  assert.equal(await page.locator('.switch-change-additional-summary').count(),0,'expanded state hides duplicate selected-name summary')
  const senior=await visibleExact(page,'시니어','.switch-choice')
  assert.equal(await senior.getAttribute('aria-pressed'),'true','senior remains selected after reopen')

  await page.mouse.wheel(0,5000)
  await page.waitForTimeout(80)
  const beforeNextScroll=await page.evaluate(()=>scrollY)
  assert.ok(beforeNextScroll>0,'CHANGE mobile can be normally scrolled before step navigation')

  const nextFocus=await tabTo(page,'.switch-step-actions .switch-primary-action')
  assert.ok(nextFocus,'Tab reaches actual CHANGE next action')
  assert.equal(nextFocus.tag,'BUTTON','CHANGE next is actual button')
  assert.ok(parseFloat(nextFocus.outlineWidth)>=2,'CHANGE next has visible focus outline')
  assert.ok(nextFocus.focusBox.top>=0&&nextFocus.focusBox.bottom<=844,'CHANGE next focus is not clipped')
  await page.keyboard.press('Enter')
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible',timeout:10000})
  await page.waitForFunction(()=>window.scrollY===0,undefined,{timeout:5000})

  const keepTop=await measureDecision(page)
  assert.match(keepTop.changeSummary,/다른 브랜드/,'KEEP separates CHANGE brand intent')
  assert.match(keepTop.changeSummary,/시니어/,'KEEP separates CHANGE senior intent')
  assert.match(keepTop.currentFacts,/건식/,'KEEP current facts include dry')
  assert.match(keepTop.currentFacts,/생선/,'KEEP current facts include fish recipe')

  const dry=await visibleExact(page,'건식 유지','.switch-choice')
  const fish=await visibleExact(page,'생선','.switch-choice')
  assert.ok(dry&&fish,'dry and fish KEEP choices are available')
  await dry.click()
  await fish.click()
  assert.equal(await dry.getAttribute('aria-pressed'),'true','dry KEEP selected')
  assert.equal(await fish.getAttribute('aria-pressed'),'true','fish KEEP selected')

  await page.screenshot({path:OUT+'/'+key+'-keep.png',fullPage:false})

  await page.mouse.wheel(0,5000)
  await page.waitForTimeout(80)
  const keepPrimary=await tabTo(page,'.switch-step-actions .switch-primary-action')
  assert.ok(keepPrimary,'Tab reaches actual KEEP primary action')
  assert.ok(parseFloat(keepPrimary.outlineWidth)>=2,'KEEP primary focus visible')
  assert.ok(keepPrimary.focusBox.top>=0&&keepPrimary.focusBox.bottom<=844,'KEEP primary focus not clipped')

  await page.keyboard.press('Shift+Tab')
  const previousFocus=await focusInfo(page)
  assert.ok(previousFocus,'Shift+Tab has focus target')
  assert.match(previousFocus.text,/바꿀 것 수정/,'Shift+Tab reaches previous action')
  assert.ok(parseFloat(previousFocus.outlineWidth)>=2,'previous action focus visible')
  await page.keyboard.press('Enter')
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible',timeout:10000})
  await page.waitForFunction(()=>window.scrollY===0,undefined,{timeout:5000})
  const reentrySenior=await visibleExact(page,'시니어','.switch-choice')
  assert.equal(await reentrySenior.getAttribute('aria-pressed'),'true','CHANGE reentry preserves senior')
  assert.equal(await page.locator('.switch-change-additional-toggle').getAttribute('aria-expanded'),'true','reentry keeps existing advanced-disclosure policy')

  report.scenarios[key]={
    identity,
    countText,
    collapsedSummary,
    beforeNextScroll,
    nextFocus,
    keepTop,
    keepSelected:{dry:true,fish:true},
    keepPrimary,
    previousFocus,
    scrollAfterKeep:0,
    scrollAfterChangeReentry:0,
  }
  await context.close()
}

async function desktop(){
  const key='desktop-1440x700'
  const {page,context}=await makePage(1440,700)
  await enterSwitch(page)
  const identity=await chooseAatu(page)
  await configureChange(page)

  const main=page.locator('.switch-decision-step-layout .switch-step-main')
  await main.hover()
  await page.mouse.wheel(0,5000)
  await page.waitForFunction(()=>{
    const el=document.querySelector('.switch-decision-step-layout .switch-step-main')
    return el instanceof HTMLElement&&el.scrollTop>0
  },undefined,{timeout:5000})
  await page.waitForTimeout(80)

  const measured=await measureDecision(page)
  assert.equal(measured.document.scrollWidth,1440,'no horizontal overflow')
  assert.ok(measured.main.scrollTop>0,'real wheel moved internal CHANGE scroller')
  assert.ok(measured.main.scrollHeight>measured.main.clientHeight,'CHANGE has internal scroll range at 700px')
  assert.ok(measured.lastCriterion&&measured.lastCriterion.top>=0&&measured.lastCriterion.bottom<=measured.actions.box.top,'last condition reachable above actions')
  assert.equal(measured.reference.product.text,identity.previewName,'full current product name retained')
  assert.ok(measured.reference.product.scrollWidth<=measured.reference.product.clientWidth+1,'product name does not horizontally clip')
  assert.match(measured.reference.sku.text,/1\s*kg|1[,.]?000\s*g/i,'actual 1kg SKU retained')
  assert.ok(measured.choices.every(choice=>choice.box.height>=44),'visible choices are at least 44px')
  assert.ok(measured.actions.secondary.box.height>=48&&measured.actions.primary.box.height>=48,'both actions are at least 48px')
  assert.ok(measured.actions.secondary.box.top>=0&&measured.actions.secondary.box.bottom<=700,'secondary action fully visible')
  assert.ok(measured.actions.primary.box.top>=0&&measured.actions.primary.box.bottom<=700,'primary action fully visible')
  assert.notEqual(measured.actions.primary.style.position,'fixed','primary action is not fixed')
  assert.notEqual(measured.actions.primary.style.position,'sticky','primary action is not sticky')

  const secondaryFocus=await tabTo(page,'.switch-step-actions .switch-secondary-action')
  assert.ok(secondaryFocus,'Tab reaches secondary action')
  assert.ok(parseFloat(secondaryFocus.outlineWidth)>=2,'secondary focus outline visible')
  assert.ok(secondaryFocus.focusBox.top>=0&&secondaryFocus.focusBox.bottom<=700,'secondary focus not clipped')
  await page.keyboard.press('Tab')
  const primaryFocus=await focusInfo(page)
  assert.ok(primaryFocus?.className.includes('switch-primary-action'),'next Tab reaches primary action')
  assert.ok(parseFloat(primaryFocus.outlineWidth)>=2,'primary focus outline visible')
  assert.ok(primaryFocus.focusBox.top>=0&&primaryFocus.focusBox.bottom<=700,'primary focus not clipped')

  const image=page.locator('.switch-reference-image')
  const imageLoaded=await image.evaluate(el=>el instanceof HTMLImageElement&&el.complete&&el.naturalWidth>0)
  assert.equal(imageLoaded,true,'actual AATU image loaded')

  await page.screenshot({path:OUT+'/'+key+'-change-bottom.png',fullPage:false})

  report.scenarios[key]={
    identity,
    measured,
    secondaryFocus,
    primaryFocus,
    imageLoaded,
  }
  await context.close()
}

await mobile()
await desktop()

assert.equal(report.blockedWrites.length,0,'deployed flow attempted no writes')
assert.equal(report.blockedAnalytics.length,0,'deployed flow attempted no analytics')

await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('PR57_POSTDEPLOY='+JSON.stringify({
  mobile:report.scenarios['mobile-390x844'],
  desktop:report.scenarios['desktop-1440x700'],
  blockedWrites:report.blockedWrites.length,
  blockedAnalytics:report.blockedAnalytics.length,
}))
await browser.close()
