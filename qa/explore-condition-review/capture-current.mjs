import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'explore-condition-current'
await mkdir(OUT,{recursive:true})
const report={baseline:'730d9b7a332e27606ce3af879b102d1c83493116',generatedAt:new Date().toISOString(),blockedWrites:[],blockedAnalytics:[],views:{}}

const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

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
      await route.abort('blockedbyclient'); return
    }
    await route.continue()
  })
  return {page,context}
}

async function enterExplore(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'조건 고르기 →'}).waitFor({state:'visible'})
  await page.getByRole('button',{name:'조건 고르기 →'}).click()
  await page.locator('.research-filter-scroll').waitFor({state:'visible'})
  await page.evaluate(async()=>{await document.fonts?.ready})
}

async function pressChoice(page,label){
  const b=page.getByRole('button',{name:label,exact:true})
  await b.scrollIntoViewIfNeeded()
  await b.click()
  assert.equal(await b.getAttribute('aria-pressed'),'true',label+' selected')
}

async function selectedStressState(page,width){
  await pressChoice(page,'건식')
  await pressChoice(page,'임신·수유·키튼')
  if(width<=760){
    const toggle=page.locator('.mobile-additional-toggle')
    if(await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
  }
  await pressChoice(page,'실내묘')
  await pressChoice(page,'중성화묘')
  await pressChoice(page,'체중 관리')
  await pressChoice(page,'피부·피모')
  await pressChoice(page,'생선')
  await pressChoice(page,'Grain-Free 표기')
  const skin=page.getByRole('button',{name:'피부·피모',exact:true})
  await skin.click()
  assert.equal(await skin.getAttribute('aria-pressed'),'false','selected choice can be deselected')
  await skin.click()
  assert.equal(await skin.getAttribute('aria-pressed'),'true','deselected choice can be reselected')
}

async function tabTo(page,label,max=80){
  await page.locator('body').click({position:{x:2,y:2}})
  for(let i=0;i<max;i++){
    await page.keyboard.press('Tab')
    const active=await page.evaluate(()=>({
      text:document.activeElement?.textContent?.replace(/\s+/g,' ').trim()||'',
      outline:document.activeElement instanceof HTMLElement?getComputedStyle(document.activeElement).outline:'',
      outlineOffset:document.activeElement instanceof HTMLElement?getComputedStyle(document.activeElement).outlineOffset:'',
      boxShadow:document.activeElement instanceof HTMLElement?getComputedStyle(document.activeElement).boxShadow:'',
      tag:document.activeElement?.tagName||'',
      className:document.activeElement instanceof HTMLElement?document.activeElement.className:''
    }))
    if(active.text===label) return active
  }
  throw new Error('Tab target not found: '+label)
}

async function measure(page){
  return page.evaluate(()=>{
    const rect=el=>{if(!(el instanceof HTMLElement))return null;const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
    const styles=sel=>{
      const el=document.querySelector(sel)
      if(!(el instanceof HTMLElement)) return null
      const s=getComputedStyle(el)
      return {fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,color:s.color,background:s.backgroundColor,border:s.border}
    }
    const choices=[...document.querySelectorAll('.choice')].map(el=>{
      const s=getComputedStyle(el),r=el.getBoundingClientRect()
      return {text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),fontSize:s.fontSize,lineHeight:s.lineHeight,width:r.width,height:r.height,top:r.top,left:r.left}
    })
    const headings=[...document.querySelectorAll('.filter-heading')].map(el=>({text:el.textContent?.replace(/\s+/g,' ').trim()||'',box:rect(el),font:stylesFrom(el)}))
    function stylesFrom(el){const s=getComputedStyle(el);return{fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight}}
    const filter=document.querySelector('.research-filters')
    const scroll=document.querySelector('.research-filter-scroll')
    const actions=document.querySelector('.condition-actions')
    const primary=document.querySelector('.condition-actions .primary-action')
    const secondary=document.querySelector('.condition-actions .secondary-action')
    const draft=document.querySelector('.condition-draft-count')
    const groupTitles=[...document.querySelectorAll('.condition-group-title')].map(el=>({text:el.textContent?.replace(/\s+/g,' ').trim()||'',box:rect(el),font:stylesFrom(el)}))
    const mobileToggle=document.querySelector('.mobile-additional-toggle')
    const mobileSummary=document.querySelector('.mobile-additional-summary')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      page:{scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},
      filter:rect(filter),scroll:rect(scroll),actions:rect(actions),primary:rect(primary),secondary:rect(secondary),
      paneHeading:rect(document.querySelector('.research-pane-heading')),
      paneTitle:styles('.research-pane-heading strong'),
      paneDescription:styles('.research-pane-heading span'),
      draftCount:{text:draft?.textContent?.trim()||'',box:rect(draft),style:draft instanceof HTMLElement?stylesFrom(draft):null},
      groupTitles,headings,choices,
      fieldNote:styles('.field-note'),
      primaryStyle:styles('.condition-actions .primary-action'),
      secondaryStyle:styles('.condition-actions .secondary-action'),
      mobileToggle:mobileToggle?{text:mobileToggle.textContent?.replace(/\s+/g,' ').trim()||'',expanded:mobileToggle.getAttribute('aria-expanded'),box:rect(mobileToggle),style:stylesFrom(mobileToggle)}:null,
      mobileSummary:mobileSummary?{text:mobileSummary.textContent?.replace(/\s+/g,' ').trim()||'',box:rect(mobileSummary),children:[...mobileSummary.children].map(el=>({text:el.textContent?.trim()||'',box:rect(el)}))}:null,
      basicTitle:document.querySelector('.condition-group-title')?.textContent?.replace(/\s+/g,' ').trim()||'',
      desktopAdditionalTitle:document.querySelector('.desktop-additional-title')?.textContent?.replace(/\s+/g,' ').trim()||'',
      waitingMessage:document.querySelector('.research-results-scroll')?.textContent?.replace(/\s+/g,' ').trim()||'',
    }
  })
}

async function run(width,height,key){
  const {page,context}=await newPage(width,height)
  await enterExplore(page)
  await selectedStressState(page,width)
  await page.evaluate(()=>window.scrollTo(0,0))
  const focusChoice=await tabTo(page,'건식')
  const focusApply=await tabTo(page,'이 조건으로 찾기')
  const metrics=await measure(page)
  assert.equal(metrics.page.scrollWidth,width,key+': no horizontal document overflow')
  assert.ok(metrics.choices.every(c=>c.height>=38),key+': condition choices keep current minimum height')
  assert.ok(metrics.primary&&metrics.primary.height>=44,key+': apply button >=44px')
  assert.ok(metrics.secondary&&metrics.secondary.height>=44,key+': reset button >=44px')
  assert.match(focusChoice.outline+focusChoice.boxShadow,/rgb|px|rgba/i,key+': keyboard focus visible on condition choice')
  assert.match(focusApply.outline+focusApply.boxShadow,/rgb|px|rgba/i,key+': keyboard focus visible on apply')
  if(width<=760){
    assert.ok(metrics.mobileToggle&&metrics.mobileToggle.expanded==='true',key+': additional conditions expanded')
    assert.ok(metrics.mobileSummary&&/실내묘/.test(metrics.mobileSummary.text)&&/Grain-Free/.test(metrics.mobileSummary.text),key+': selected additional summary visible')
  }
  await page.screenshot({path:OUT+'/current-'+key+'.png',fullPage:false})
  report.views[key]={metrics,focus:{choice:focusChoice,apply:focusApply},url:page.url()}
  await context.close()
}

await run(390,844,'mobile-390x844')
await run(1440,900,'desktop-1440x900')
assert.equal(report.blockedWrites.length,0,'no write requests attempted')
await writeFile(OUT+'/current-measurements.json',JSON.stringify(report,null,2))
console.log('EXPLORE_CONDITION_CURRENT='+JSON.stringify({
  mobileApply:report.views['mobile-390x844'].metrics.primary,
  desktopApply:report.views['desktop-1440x900'].metrics.primary,
  blockedWrites:report.blockedWrites.length,
  blockedAnalytics:report.blockedAnalytics.length
}))
await browser.close()
