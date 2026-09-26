import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'switch-change-keep-candidate-output'
await mkdir(OUT,{recursive:true})

const report={
  candidateSha:process.env.GITHUB_SHA||null,
  generatedAt:new Date().toISOString(),
  blockedWrites:[],
  blockedAnalytics:[],
  scenarios:{},
  longIdentity:null,
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function newPage(width,height){
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

const norm=v=>String(v||'').replace(/\s+/g,' ').trim()

async function enterSwitch(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).waitFor({state:'visible',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  await page.locator('.switch-find-search input').waitFor({state:'visible',timeout:10000})
  await page.waitForFunction(
    () => document.querySelector('.research-status')?.textContent?.includes('데이터 연결됨')===true,
    undefined,
    {timeout:30000},
  )
}

async function chooseAatu(page){
  const search=page.locator('.switch-find-search input')
  await search.fill('AATU')
  const salmon=page.locator('.switch-find-result').filter({hasText:/연어/}).first()
  await salmon.waitFor({state:'visible',timeout:30000})
  await salmon.click()
  await page.locator('.switch-current-preview').waitFor({state:'visible'})
  const identity=await page.evaluate(()=>({
    brand:document.querySelector('.switch-preview-identity > div > span')?.textContent?.trim()||'',
    name:document.querySelector('.switch-preview-identity h2')?.textContent?.trim()||'',
  }))
  assert.match(identity.brand,/AATU/i,'AATU brand selected')
  assert.match(identity.name,/연어/,'AATU salmon selected')
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  await page.locator('.switch-sku-option').first().waitFor({state:'visible',timeout:30000})
  const oneKg=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
  assert.ok(await oneKg.count(),'actual 1kg SKU exists')
  await oneKg.click()
  const sku=norm(await oneKg.textContent())
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
  return {...identity,sku}
}

async function toggleAdditional(page,open){
  const toggle=page.locator('.switch-change-additional-toggle')
  if(!(await toggle.count())) return
  if((await toggle.getAttribute('aria-expanded'))!==String(open)) await toggle.click()
  await page.waitForFunction(
    value=>document.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')===String(value),
    open,
  )
}

async function setTargetChange(page,width){
  const noChange=page.locator('.switch-no-change')
  await noChange.click()
  assert.ok((await noChange.getAttribute('class'))?.includes('is-selected'),'no-change selects')
  await page.getByRole('button',{name:'다른 브랜드로 보기',exact:true}).click()
  assert.equal((await noChange.getAttribute('class'))?.includes('is-selected'),false,'actual change clears no-change')

  if(width<=760) await toggleAdditional(page,true)
  await page.getByRole('button',{name:'시니어',exact:true}).click()
  assert.equal(await page.getByRole('button',{name:'시니어',exact:true}).getAttribute('aria-pressed'),'true','senior selected')
  if(width<=760) await toggleAdditional(page,false)
}

async function state(page,step){
  return page.evaluate((step)=>{
    const root=document.querySelector('.switch-'+step+'-step')||document
    const rect=el=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}
    }
    const style=el=>{
      if(!(el instanceof HTMLElement)) return null
      const s=getComputedStyle(el)
      return {
        display:s.display,position:s.position,overflowY:s.overflowY,
        fontSize:s.fontSize,lineHeight:s.lineHeight,
        outline:s.outline,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,
        whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,overflowWrap:s.overflowWrap,
      }
    }
    const choices=[...root.querySelectorAll('.switch-choice')].filter(el=>{
      if(!(el instanceof HTMLElement)) return false
      const r=el.getBoundingClientRect(),s=getComputedStyle(el)
      return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'
    }).map(el=>({text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:style(el)}))
    const main=root.querySelector('.switch-step-main')
    const actions=root.querySelector('.switch-step-actions')
    const reference=root.querySelector('.switch-reference-rail')
    const name=root.querySelector('.switch-reference-product strong')
    const sku=root.querySelector('.switch-reference-sku strong')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{scrollY,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},
      main:{
        box:rect(main),scrollTop:main instanceof HTMLElement?main.scrollTop:null,
        scrollHeight:main instanceof HTMLElement?main.scrollHeight:null,
        clientHeight:main instanceof HTMLElement?main.clientHeight:null,
        style:style(main),
      },
      reference:{box:rect(reference),text:String(reference?.textContent||'').replace(/\\s+/g,' ').trim(),name:{text:String(name?.textContent||'').replace(/\\s+/g,' ').trim(),box:rect(name),style:style(name)},sku:{text:String(sku?.textContent||'').replace(/\\s+/g,' ').trim(),box:rect(sku),style:style(sku)}},
      header:{box:rect(root.querySelector('.switch-step-header h1')),style:style(root.querySelector('.switch-step-header h1')),text:String(root.querySelector('.switch-step-header h1')?.textContent||'').replace(/\\s+/g,' ').trim()},
      choices,
      disclosure:{
        exists:Boolean(root.querySelector('.switch-change-additional-toggle')),
        expanded:root.querySelector('.switch-change-additional-toggle')?.getAttribute('aria-expanded')||null,
        summary:root.querySelector('.switch-change-additional-summary')?String(root.querySelector('.switch-change-additional-summary')?.textContent||'').replace(/\\s+/g,' ').trim():null,
      },
      changeSummary:root.querySelector('.switch-change-selection-summary')?String(root.querySelector('.switch-change-selection-summary')?.textContent||'').replace(/\\s+/g,' ').trim():null,
      facts:root.querySelector('.switch-current-facts-summary')?String(root.querySelector('.switch-current-facts-summary')?.textContent||'').replace(/\\s+/g,' ').trim():null,
      actions:{
        box:rect(actions),
        secondary:{box:rect(actions?.querySelector('.switch-secondary-action')),style:style(actions?.querySelector('.switch-secondary-action')),text:String(actions?.querySelector('.switch-secondary-action')?.textContent||'').replace(/\\s+/g,' ').trim()},
        primary:{box:rect(actions?.querySelector('.switch-primary-action')),style:style(actions?.querySelector('.switch-primary-action')),text:String(actions?.querySelector('.switch-primary-action')?.textContent||'').replace(/\\s+/g,' ').trim()},
      },
      horizontalOverflow:document.documentElement.scrollWidth-innerWidth,
    }
  },step)
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
      outline:s.outline,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,
      box:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},
      focusBox:{top:r.top-extent,bottom:r.bottom+extent,left:r.left-extent,right:r.right+extent},
    }
  })
}

function assertFocusVisible(focus,height,label){
  assert.ok(focus,label+' focus exists')
  assert.ok(parseFloat(focus.outlineWidth)>=2,label+' focus outline >=2px')
  assert.ok(focus.focusBox.top>=-0.5&&focus.focusBox.bottom<=height+0.5,label+' full focus ring in viewport')
}

async function normalScrollBottom(page,width,step){
  if(width<=760){
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
    await page.waitForFunction(()=>window.scrollY>0)
  }else{
    const main=page.locator('.switch-'+step+'-step .switch-step-main')
    await main.hover()
    await page.mouse.wheel(0,5000)
    await page.waitForFunction(step=>{
      const el=document.querySelector('.switch-'+step+'-step .switch-step-main')
      return el instanceof HTMLElement&&el.scrollTop>0
    },step)
  }
}

async function focusActionPair(page,height,step){
  const secondary=page.locator('.switch-'+step+'-step .switch-secondary-action')
  const primary=page.locator('.switch-'+step+'-step .switch-primary-action')
  await primary.focus()
  const primaryFocus=await activeFocus(page)
  assertFocusVisible(primaryFocus,height,step+' primary')
  await page.keyboard.press('Shift+Tab')
  const reverse=await activeFocus(page)
  assert.equal(norm(reverse?.text),norm(await secondary.textContent()),step+' Shift+Tab reaches secondary action')
  assertFocusVisible(reverse,height,step+' secondary')
  await page.keyboard.press('Tab')
  const forward=await activeFocus(page)
  assert.equal(norm(forward?.text),norm(await primary.textContent()),step+' Tab returns to primary action')
  assertFocusVisible(forward,height,step+' primary forward')
  return {primaryFocus,reverse,forward}
}

async function assertDecisionMetrics(page,width,height,step){
  const measured=await state(page,step)
  assert.equal(measured.horizontalOverflow,0,step+' no horizontal overflow')
  assert.ok(measured.choices.every(x=>x.box&&x.box.height>=44),step+' choices >=44px')
  assert.ok(measured.actions.primary.box?.height>=48&&measured.actions.secondary.box?.height>=48,step+' actions >=48px')
  assert.match(measured.reference.name.style?.whiteSpace||'',/normal/,'reference product name can wrap')
  assert.notEqual(measured.reference.name.style?.textOverflow,'ellipsis','reference name is not ellipsized')
  await normalScrollBottom(page,width,step)
  const bottom=await state(page,step)
  assert.ok(bottom.actions.primary.box?.top>=0&&bottom.actions.primary.box?.bottom<=height,step+' primary action reachable')
  assert.ok(bottom.actions.secondary.box?.top>=0&&bottom.actions.secondary.box?.bottom<=height,step+' secondary action reachable')
  const focus=await focusActionPair(page,height,step)
  return {top:measured,bottom,focus}
}

async function viewportRoundTrip(page){
  await toggleAdditional(page,false)
  const mobile=await state(page,'change')
  assert.match(mobile.disclosure.summary||'',/시니어/,'collapsed mobile summary names senior')

  await page.setViewportSize({width:761,height:844})
  const tablet=await state(page,'change')
  assert.ok(tablet.choices.some(x=>x.text==='시니어'&&x.pressed==='true'&&x.box.height>=44),'761 desktop criteria exposes selected senior')

  await page.setViewportSize({width:1440,height:900})
  const desktop=await state(page,'change')
  assert.ok(desktop.choices.some(x=>x.text==='시니어'&&x.pressed==='true'&&x.box.height>=44),'1440 criteria exposes selected senior')

  await page.setViewportSize({width:390,height:844})
  const restored=await state(page,'change')
  assert.equal(restored.disclosure.expanded,'false','return to mobile keeps collapsed disclosure state')
  assert.match(restored.disclosure.summary||'',/시니어/,'return to mobile keeps selected summary')
  await toggleAdditional(page,true)
  assert.equal(await page.getByRole('button',{name:'시니어',exact:true}).getAttribute('aria-pressed'),'true','reopen preserves senior')
  await toggleAdditional(page,false)
  return {mobile,tablet,desktop,restored}
}

async function chooseKeepTarget(page){
  const dry=page.getByRole('button',{name:'건식 유지',exact:true})
  assert.ok(await dry.count(),'dry KEEP is available')
  if((await dry.getAttribute('aria-pressed'))!=='true') await dry.click()
  const fish=page.getByRole('button',{name:'생선',exact:true})
  assert.ok(await fish.count(),'fish KEEP is available')
  if((await fish.getAttribute('aria-pressed'))!=='true') await fish.click()
}

async function scenario(width,height,key,{roundTrip=false,conflict=false,candidate=false}={}){
  const {page,context}=await newPage(width,height)
  await enterSwitch(page)
  const identity=await chooseAatu(page)
  assert.match(identity.sku,/1\s*kg|1[,.]?000\s*g/i,'1kg SKU selected')
  await setTargetChange(page,width)

  let resize=null
  if(roundTrip) resize=await viewportRoundTrip(page)

  if(width<=760){
    await toggleAdditional(page,false)
    const collapsed=await state(page,'change')
    assert.match(collapsed.disclosure.summary||'',/시니어/,'collapsed summary shown')
    await page.screenshot({path:OUT+'/'+key+'-change-collapsed.png',fullPage:false})
    await toggleAdditional(page,true)
    const expanded=await state(page,'change')
    assert.equal(expanded.disclosure.summary,null,'expanded disclosure hides duplicate summary')
  }

  const changeAccess=await assertDecisionMetrics(page,width,height,'change')
  await page.screenshot({path:OUT+'/'+key+'-change-bottom.png',fullPage:false})

  await page.locator('.switch-change-step .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})
  let keepTop=await state(page,'keep')
  assert.match(keepTop.changeSummary||'',/다른 브랜드/,'KEEP separates CHANGE summary')
  assert.match(keepTop.changeSummary||'',/시니어/,'KEEP summary includes senior')
  assert.match(keepTop.facts||'',/현재 제품에서 확인됨/,'KEEP current facts separated from change summary')
  await chooseKeepTarget(page)
  keepTop=await state(page,'keep')
  assert.ok(keepTop.choices.some(x=>x.text==='건식 유지'&&x.pressed==='true'),'dry KEEP selected')
  assert.ok(keepTop.choices.some(x=>x.text==='생선'&&x.pressed==='true'),'fish KEEP selected')
  await page.screenshot({path:OUT+'/'+key+'-keep-top.png',fullPage:false})

  if(conflict){
    await page.locator('.switch-keep-step .switch-secondary-action').click()
    await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
    const scrollAfterBack=await page.evaluate(()=>({window:scrollY,main:(document.querySelector('.switch-change-step .switch-step-main') instanceof HTMLElement)?document.querySelector('.switch-change-step .switch-step-main').scrollTop:null}))
    assert.ok(scrollAfterBack.window<=2,'explicit CHANGE return resets document scroll')
    if(width<=760) await toggleAdditional(page,false)
    const wet=page.getByRole('button',{name:'습식',exact:true})
    await wet.click()
    await page.waitForFunction(()=>document.body.textContent.includes('사료 형태 유지 조건을 해제했습니다.'))
    assert.match(norm(await page.locator('[role="status"]').textContent()),/사료 형태 유지 조건을 해제했습니다/,'conflict notice shown')
    await wet.click()
    await page.locator('.switch-change-step .switch-primary-action').click()
    await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})
    assert.equal(await page.getByRole('button',{name:'건식 유지',exact:true}).getAttribute('aria-pressed'),'false','conflicting KEEP was cleared')
    await page.getByRole('button',{name:'건식 유지',exact:true}).click()
    assert.equal(await page.getByRole('button',{name:'생선',exact:true}).getAttribute('aria-pressed'),'true','non-conflicting KEEP survived roundtrip')
  }

  const keepAccess=await assertDecisionMetrics(page,width,height,'keep')
  await page.screenshot({path:OUT+'/'+key+'-keep-bottom.png',fullPage:false})

  if(candidate){
    await page.locator('.switch-keep-step .switch-primary-action').click()
    await page.locator('.switch-results-stage').waitFor({state:'visible',timeout:30000})
    assert.ok(await page.locator('.switch-candidate-row').count()>0,'candidate entry still works')
  }

  report.scenarios[key]={identity,resize,changeAccess,keepTop,keepAccess}
  await context.close()
}

async function longIdentityCase(){
  const {page,context}=await newPage(390,844)
  await enterSwitch(page)
  const search=page.locator('.switch-find-search input')
  await search.fill('로얄캐닌')
  await page.locator('.switch-find-result').first().waitFor({state:'visible',timeout:30000})
  const cards=page.locator('.switch-find-result')
  const count=await cards.count()
  assert.ok(count>0,'Royal Canin results available')
  let best=null
  for(let i=0;i<count;i++){
    const card=cards.nth(i)
    const name=norm(await card.locator('.switch-find-result-copy strong').textContent())
    if(!best||name.length>best.name.length) best={index:i,name}
  }
  await cards.nth(best.index).click()
  await page.locator('.switch-current-preview').waitFor({state:'visible'})
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  await page.locator('.switch-sku-option').first().waitFor({state:'visible',timeout:30000})
  const variants=page.locator('.switch-sku-option')
  const vcount=await variants.count()
  let longest={index:0,label:'',text:''}
  for(let i=0;i<vcount;i++){
    const text=norm(await variants.nth(i).textContent())
    const label=norm(await variants.nth(i).locator('strong').textContent())
    if(label.length>longest.label.length) longest={index:i,label,text}
  }
  await variants.nth(longest.index).click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
  const measured=await state(page,'change')
  assert.equal(measured.reference.name.text,best.name,'full long product name preserved')
  assert.equal(measured.reference.sku.text,longest.label,'full long SKU label preserved')
  assert.notEqual(measured.reference.name.style?.textOverflow,'ellipsis','long product name not ellipsized')
  await page.screenshot({path:OUT+'/mobile-390x844-long-identity.png',fullPage:false})
  report.longIdentity={product:best.name,sku:longest.label,variantButton:longest.text,reference:measured.reference}
  await context.close()
}

await scenario(390,844,'mobile-390x844',{roundTrip:true,conflict:true,candidate:true})
await scenario(1440,900,'desktop-1440x900')
await scenario(1440,700,'desktop-1440x700')
await longIdentityCase()

await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('SWITCH_CHANGE_KEEP_CANDIDATE='+JSON.stringify({
  sha:report.candidateSha,
  identities:Object.fromEntries(Object.entries(report.scenarios).map(([k,v])=>[k,v.identity])),
  longIdentity:report.longIdentity,
  blockedWrites:report.blockedWrites.length,
  blockedAnalytics:report.blockedAnalytics.length,
}))
await browser.close()
