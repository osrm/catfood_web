import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'switch-review-output'
await mkdir(OUT,{recursive:true})

const report={
  baselineMain:'f69e1c64b37d68f99365a12eeae74e4627148271',
  generatedAt:new Date().toISOString(),
  blockedWrites:[],
  blockedAnalytics:[],
  current:{},
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

function normalize(v){return String(v||'').replace(/\s+/g,' ').trim()}

async function newPage(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
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
  return {page,context}
}

async function enterAatu(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).waitFor({state:'visible',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  const search=page.locator('.switch-find-search input')
  await search.waitFor({state:'visible',timeout:10000})
  await search.fill('AATU')
  await page.locator('.switch-find-result').first().waitFor({state:'visible',timeout:30000})
  const resultTexts=await page.locator('.switch-find-result').allTextContents()
  const salmon=page.locator('.switch-find-result').filter({hasText:/연어/}).first()
  assert.ok(await salmon.count(),'AATU 연어 result exists')
  await salmon.click()
  await page.locator('.switch-current-preview').waitFor({state:'visible'})
  const productName=normalize(await page.locator('.switch-preview-identity h2').textContent())
  const productBrand=normalize(await page.locator('.switch-preview-identity > div > span').textContent())
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  await page.locator('.switch-sku-list').waitFor({state:'visible',timeout:10000})
  await page.locator('.switch-sku-option').first().waitFor({state:'visible',timeout:30000})
  const skuTexts=(await page.locator('.switch-sku-option').allTextContents()).map(normalize)
  console.log('AATU_RESULTS='+JSON.stringify(resultTexts.map(normalize)))
  console.log('AATU_SKUS='+JSON.stringify(skuTexts))
  const oneKg=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
  assert.ok(await oneKg.count(),'1kg / 1,000g SKU exists')
  await oneKg.click()
  const selectedSku=normalize(await oneKg.textContent())
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
  return {resultTexts:resultTexts.map(normalize),skuTexts,productName,productBrand,selectedSku}
}

async function setChangeState(page,width){
  await page.getByRole('button',{name:'다른 브랜드로 보기',exact:true}).click()
  if(width<=760){
    const toggle=page.locator('.switch-change-additional-toggle')
    if(await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
  }
  const senior=page.getByRole('button',{name:'시니어',exact:true})
  assert.ok(await senior.count(),'senior change option exists')
  await senior.click()
  if(width<=760){
    const toggle=page.locator('.switch-change-additional-toggle')
    if(await toggle.getAttribute('aria-expanded')!=='false') await toggle.click()
  }
}

async function setKeepState(page){
  const dry=page.getByRole('button',{name:'건식 유지',exact:true})
  if(await dry.count()) await dry.click()
  const fish=page.getByRole('button',{name:'생선',exact:true})
  if(await fish.count()) await fish.click()
  return {
    selected:[...await page.locator('.switch-choice[aria-pressed="true"]').allTextContents()].map(normalize),
  }
}

async function activeFocus(page){
  return page.evaluate(()=>{
    const el=document.activeElement
    if(!(el instanceof HTMLElement)) return null
    const r=el.getBoundingClientRect(),s=getComputedStyle(el)
    return {
      text:String(el.textContent||'').replace(/\s+/g,' ').trim(),
      className:el.className,
      box:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},
      fontSize:s.fontSize,lineHeight:s.lineHeight,
      outline:s.outline,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,
    }
  })
}

async function tabTo(page,label,max=60){
  await page.locator('body').click({position:{x:2,y:2}})
  if(await page.evaluate(()=>document.activeElement instanceof HTMLElement)) await page.evaluate(()=>document.activeElement?.blur())
  for(let i=0;i<max;i++){
    await page.keyboard.press('Tab')
    const f=await activeFocus(page)
    if(f?.text===label) return f
  }
  return null
}

async function measure(page,step){
  return page.evaluate((step)=>{
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
        fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,
        outline:s.outline,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,
      }
    }
    const choices=[...document.querySelectorAll('.switch-choice')].filter(el=>{
      if(!(el instanceof HTMLElement)) return false
      const r=el.getBoundingClientRect(),s=getComputedStyle(el)
      return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'
    }).map(el=>({text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:style(el)}))
    const main=document.querySelector('.switch-step-main')
    const rail=document.querySelector('.switch-reference-rail')
    const actions=document.querySelector('.switch-step-actions')
    const additional=document.querySelector('.switch-change-additional-toggle')
    const summary=document.querySelector('.switch-change-additional-summary')
    const facts=document.querySelector('.switch-current-facts-strip')
    return {
      step,
      viewport:{width:innerWidth,height:innerHeight},
      document:{scrollY,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth},
      main:{
        box:rect(main),style:style(main),
        scrollTop:main instanceof HTMLElement?main.scrollTop:null,
        scrollHeight:main instanceof HTMLElement?main.scrollHeight:null,
        clientHeight:main instanceof HTMLElement?main.clientHeight:null,
      },
      rail:{box:rect(rail),style:style(rail),text:rail?.textContent?.replace(/\s+/g,' ').trim()||''},
      heading:{box:rect(document.querySelector('.switch-step-header h1')),style:style(document.querySelector('.switch-step-header h1')),text:document.querySelector('.switch-step-header h1')?.textContent?.trim()||''},
      intro:{box:rect(document.querySelector('.switch-step-header p')),style:style(document.querySelector('.switch-step-header p')),text:document.querySelector('.switch-step-header p')?.textContent?.trim()||''},
      noChange:{box:rect(document.querySelector('.switch-no-change')),style:style(document.querySelector('.switch-no-change')),text:document.querySelector('.switch-no-change')?.textContent?.replace(/\s+/g,' ').trim()||'',selected:document.querySelector('.switch-no-change')?.classList.contains('is-selected')||false},
      facts:{box:rect(facts),text:facts?.textContent?.replace(/\s+/g,' ').trim()||''},
      choices,
      additional:{
        box:rect(additional),style:style(additional),
        expanded:additional?.getAttribute('aria-expanded')||null,
        text:additional?.textContent?.replace(/\s+/g,' ').trim()||'',
        summary:summary?{box:rect(summary),style:style(summary),text:summary.textContent?.replace(/\s+/g,' ').trim()||''}:null,
      },
      actions:{
        box:rect(actions),
        secondary:{box:rect(actions?.querySelector('.switch-secondary-action')),style:style(actions?.querySelector('.switch-secondary-action')),text:actions?.querySelector('.switch-secondary-action')?.textContent?.replace(/\s+/g,' ').trim()||''},
        primary:{box:rect(actions?.querySelector('.switch-primary-action')),style:style(actions?.querySelector('.switch-primary-action')),text:actions?.querySelector('.switch-primary-action')?.textContent?.replace(/\s+/g,' ').trim()||'',disabled:(actions?.querySelector('.switch-primary-action') instanceof HTMLButtonElement)?actions.querySelector('.switch-primary-action').disabled:null},
      },
      selectedChoices:choices.filter(x=>x.pressed==='true').map(x=>x.text),
    }
  },step)
}

async function scrollToActions(page,width){
  if(width<=760){
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
  }else{
    await page.locator('.switch-step-main').evaluate(el=>{el.scrollTop=el.scrollHeight})
  }
  await page.waitForTimeout(80)
}

async function runViewport(width,height,key){
  const {page,context}=await newPage(width,height)
  const identity=await enterAatu(page)

  const initialChange=await measure(page,'change-initial')
  const noChange=page.locator('.switch-no-change')
  await noChange.click()
  const noChangeSelected=await noChange.evaluate(el=>el.classList.contains('is-selected'))
  await page.getByRole('button',{name:'다른 브랜드로 보기',exact:true}).click()
  const noChangeAfterActual=await noChange.evaluate(el=>el.classList.contains('is-selected'))
  assert.equal(noChangeSelected,true,key+': no-change selects')
  assert.equal(noChangeAfterActual,false,key+': actual change clears no-change')
  // restore exact review state: brand change + senior
  if(width<=760){
    const toggle=page.locator('.switch-change-additional-toggle')
    if(await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
  }
  await page.getByRole('button',{name:'시니어',exact:true}).click()
  if(width<=760){
    const toggle=page.locator('.switch-change-additional-toggle')
    if(await toggle.getAttribute('aria-expanded')!=='false') await toggle.click()
  }

  const changeCollapsed=await measure(page,'change-selected-collapsed')
  if(width<=760){
    assert.match(changeCollapsed.additional.summary?.text||'',/시니어/,key+': collapsed change summary')
    await page.screenshot({path:OUT+'/'+key+'-change-collapsed.png',fullPage:false})
    await page.locator('.switch-change-additional-toggle').click()
    const changeExpanded=await measure(page,'change-selected-expanded')
    assert.equal(await page.getByRole('button',{name:'시니어',exact:true}).getAttribute('aria-pressed'),'true',key+': reopen preserves senior')
    await page.screenshot({path:OUT+'/'+key+'-change-expanded.png',fullPage:false})
    report.current[key]={identity,initialChange,noChangeSelected,noChangeAfterActual,changeCollapsed,changeExpanded}
  }else{
    await page.screenshot({path:OUT+'/'+key+'-change-top.png',fullPage:false})
    report.current[key]={identity,initialChange,noChangeSelected,noChangeAfterActual,changeCollapsed}
  }

  const brandFocus=await tabTo(page,'다른 브랜드로 보기')
  const nextLabel='다음 →'
  await scrollToActions(page,width)
  const changeBottom=await measure(page,'change-bottom')
  const nextFocus=await page.locator('.switch-step-actions .switch-primary-action').focus().then(()=>activeFocus(page))
  await page.screenshot({path:OUT+'/'+key+'-change-bottom.png',fullPage:false})
  report.current[key].changeFocus={brand:brandFocus,next:nextFocus}
  report.current[key].changeBottom=changeBottom

  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible'})
  const keepInitial=await measure(page,'keep-initial')
  const keepState=await setKeepState(page)
  const keepSelected=await measure(page,'keep-selected')
  await page.screenshot({path:OUT+'/'+key+'-keep-top.png',fullPage:false})

  await scrollToActions(page,width)
  const keepBottom=await measure(page,'keep-bottom')
  const keepPrimaryFocus=await page.locator('.switch-step-actions .switch-primary-action').focus().then(()=>activeFocus(page))
  const keepBackFocus=await page.locator('.switch-step-actions .switch-secondary-action').focus().then(()=>activeFocus(page))
  await page.screenshot({path:OUT+'/'+key+'-keep-bottom.png',fullPage:false})

  report.current[key].keep={initial:keepInitial,state:keepState,selected:keepSelected,bottom:keepBottom,focus:{primary:keepPrimaryFocus,secondary:keepBackFocus}}
  await context.close()
}

await runViewport(390,844,'mobile-390x844')
await runViewport(1440,900,'desktop-1440x900')

assert.equal(report.blockedWrites.length,0,'no writes attempted')
assert.equal(report.blockedAnalytics.length,0,'no analytics attempted')
await writeFile(OUT+'/measurements-current.json',JSON.stringify(report,null,2))
console.log('SWITCH_CHANGE_KEEP_CURRENT='+JSON.stringify({
  mobileIdentity:report.current['mobile-390x844'].identity,
  desktopIdentity:report.current['desktop-1440x900'].identity,
  mobileChange:report.current['mobile-390x844'].changeCollapsed,
  mobileKeep:report.current['mobile-390x844'].keep.selected,
  desktopChange:report.current['desktop-1440x900'].changeCollapsed,
  desktopKeep:report.current['desktop-1440x900'].keep.selected,
}))
await browser.close()
