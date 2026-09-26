import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'qa-output'
await mkdir(OUT,{recursive:true})
const report={source:'deployed Pages current',baseSha:'730d9b7a332e27606ce3af879b102d1c83493116',generatedAt:new Date().toISOString(),blockedWrites:[],blockedAnalytics:[],mobile:null,desktop:null}

const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function newPage(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(), method=req.method(), url=req.url()
    const analytics=/functions\/v1|search-runs|considerations|event_log|analytics|telemetry/i.test(url)
    const writeLike=!['GET','HEAD','OPTIONS'].includes(method)
    if(analytics||writeLike){
      if(analytics) report.blockedAnalytics.push({method,url})
      if(writeLike) report.blockedWrites.push({method,url})
      await route.abort('blockedbyclient'); return
    }
    await route.continue()
  })
  return {page,context}
}

async function pointerClick(page, locator){
  await locator.scrollIntoViewIfNeeded()
  const b=await locator.boundingBox(); assert.ok(b,'pointer target box exists')
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2)
  await page.mouse.click(b.x+b.width/2,b.y+b.height/2)
}

async function startExplore(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'조건 고르기 →'}).waitFor({state:'visible',timeout:30000})
  await pointerClick(page,page.getByRole('button',{name:'조건 고르기 →'}))
  await page.locator('.condition-actions').waitFor({state:'visible',timeout:10000})
  await page.locator('.research-status').filter({hasText:'데이터 연결됨'}).waitFor({state:'visible',timeout:30000})
}

const selections=['건식','임신·수유·키튼','실내묘','중성화묘','체중 관리','소화','피부·피모','가금류','생선','Grain-Free 표기']

async function selectState(page,isMobile){
  if(isMobile){
    const toggle=page.locator('.mobile-additional-toggle')
    await toggle.waitFor({state:'visible'})
    if((await toggle.getAttribute('aria-expanded'))!=='true') await pointerClick(page,toggle)
  }
  for(const label of selections){
    const button=page.locator('button.choice').filter({hasText:label}).first()
    await button.waitFor({state:'visible'})
    if((await button.getAttribute('aria-pressed'))!=='true') await pointerClick(page,button)
  }
  await page.evaluate(async()=>{await document.fonts?.ready})
}

async function tabTo(page, pattern, max=80){
  await page.locator('.research-brand').focus()
  for(let i=0;i<max;i++){
    await page.keyboard.press('Tab')
    const active=await page.evaluate(()=>{
      const el=document.activeElement
      if(!(el instanceof HTMLElement)) return null
      const s=getComputedStyle(el)
      return {text:el.textContent?.replace(/\s+/g,' ').trim()||'',outline:s.outline,boxShadow:s.boxShadow,tag:el.tagName,className:el.className}
    })
    if(active&&new RegExp(pattern).test(active.text)) return active
  }
  throw new Error('Tab target not reached: '+pattern)
}

async function measure(page){
  return page.evaluate(()=>{
    const rect=(el)=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}
    }
    const style=(el)=>{
      if(!(el instanceof HTMLElement)) return null
      const s=getComputedStyle(el)
      return {fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,color:s.color,backgroundColor:s.backgroundColor,borderColor:s.borderColor,display:s.display}
    }
    const choices=[...document.querySelectorAll('button.choice')].filter(el=>getComputedStyle(el).display!=='none').map(el=>({
      text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:style(el)
    }))
    const summaries=[...document.querySelectorAll('.mobile-additional-summary span')].map(el=>({text:el.textContent?.trim()||'',box:rect(el),style:style(el)}))
    const sections=[...document.querySelectorAll('.filter-section')].filter(el=>getComputedStyle(el).display!=='none').map(el=>({
      title:el.querySelector('.filter-heading > span:first-child')?.textContent?.trim()||'',
      hint:el.querySelector('.filter-hint')?.textContent?.trim()||'',
      box:rect(el),
      titleStyle:style(el.querySelector('.filter-heading > span:first-child')),
      hintStyle:style(el.querySelector('.filter-hint')),
    }))
    const primary=document.querySelector('.condition-actions .primary-action')
    const secondary=document.querySelector('.condition-actions .secondary-action')
    const results=document.querySelector('.research-results')
    const filters=document.querySelector('.research-filters')
    const pane=document.querySelector('.research-pane-heading')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
      bodyWidth:document.body.scrollWidth,
      pane:{box:rect(pane),title:document.querySelector('.research-pane-heading strong')?.textContent?.trim()||'',description:document.querySelector('.research-pane-heading > div > span:not(.condition-draft-count)')?.textContent?.trim()||'',draftCount:document.querySelector('.condition-draft-count')?.textContent?.trim()||'',titleStyle:style(document.querySelector('.research-pane-heading strong')),descriptionStyle:style(document.querySelector('.research-pane-heading > div > span:not(.condition-draft-count)')),countStyle:style(document.querySelector('.condition-draft-count'))},
      groupTitles:[...document.querySelectorAll('.condition-group-title')].filter(el=>getComputedStyle(el).display!=='none').map(el=>({text:el.textContent?.replace(/\s+/g,' ').trim()||'',box:rect(el),labelStyle:style(el.querySelector('span')),smallStyle:style(el.querySelector('small'))})),
      sections,choices,summaries,
      mobileToggle:(()=>{const el=document.querySelector('.mobile-additional-toggle');return el&&getComputedStyle(el).display!=='none'?{text:el.textContent?.replace(/\s+/g,' ').trim()||'',expanded:el.getAttribute('aria-expanded'),box:rect(el),style:style(el)}:null})(),
      actions:{primary:{text:primary?.textContent?.trim()||'',box:rect(primary),style:style(primary)},secondary:{text:secondary?.textContent?.trim()||'',box:rect(secondary),style:style(secondary)},container:rect(document.querySelector('.condition-actions'))},
      filtersBox:rect(filters),resultsBox:rect(results),resultsDisplay:results?getComputedStyle(results).display:null,resultsText:results?.textContent?.replace(/\s+/g,' ').trim()||'',
      filterScroll:(()=>{const el=document.querySelector('.research-filter-scroll');return el instanceof HTMLElement?{scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,box:rect(el)}:null})(),
      selectedCount:choices.filter(c=>c.pressed==='true').length,
    }
  })
}

async function run(width,height,key){
  const isMobile=width===390
  const {page,context}=await newPage(width,height)
  await startExplore(page)
  await selectState(page,isMobile)

  const countText=await page.locator('.condition-draft-count').textContent()
  assert.match(countText||'',/10개/,'selected count is 10')

  // Selection can be removed and restored with the existing button semantics.
  const digestive=page.locator('button.choice').filter({hasText:'소화'}).first()
  await pointerClick(page,digestive)
  assert.equal(await digestive.getAttribute('aria-pressed'),'false',key+': active condition can be deselected')
  await pointerClick(page,digestive)
  assert.equal(await digestive.getAttribute('aria-pressed'),'true',key+': condition can be restored')

  const choiceFocus=await tabTo(page,'건식')
  const applyFocus=await tabTo(page,'이 조건으로 찾기')
  await page.evaluate(()=>{
    scrollTo(0,0)
    const scroller=document.querySelector('.research-filter-scroll')
    if(scroller instanceof HTMLElement) scroller.scrollTop=0
  })
  const metrics=await measure(page)
  assert.equal(metrics.document.width,width,key+': no horizontal document overflow')
  assert.equal(metrics.bodyWidth,width,key+': no horizontal body overflow')
  assert.ok(metrics.actions.primary.box.height>=44,key+': apply button >=44px')
  assert.ok(metrics.actions.secondary.box.height>=44,key+': reset button >=44px')
  assert.ok(metrics.choices.every(c=>c.box.height>=38),key+': choices keep >=38px current minimum')

  await page.screenshot({path:OUT+'/current-'+key+'-top.png',fullPage:false})
  if(isMobile){
    await page.locator('.condition-actions').scrollIntoViewIfNeeded()
    await page.screenshot({path:OUT+'/current-'+key+'-bottom.png',fullPage:false})
  } else {
    await page.evaluate(()=>{const scroller=document.querySelector('.research-filter-scroll');if(scroller instanceof HTMLElement) scroller.scrollTop=scroller.scrollHeight})
    await page.screenshot({path:OUT+'/current-'+key+'-bottom.png',fullPage:false})
  }
  await page.screenshot({path:OUT+'/current-'+key+'-full.png',fullPage:true})

  const data={metrics,focus:{choice:choiceFocus,apply:applyFocus},url:page.url()}
  await context.close()
  return data
}

report.mobile=await run(390,844,'mobile-390x844')
report.desktop=await run(1440,900,'desktop-1440x900')
assert.equal(report.blockedWrites.length,0,'review should not attempt writes')
await writeFile(OUT+'/current-measurements.json',JSON.stringify(report,null,2))
console.log('EXPLORE_CONDITIONS_CURRENT='+JSON.stringify({
  mobileHeight:report.mobile.metrics.document.height,
  mobileActionTop:report.mobile.metrics.actions.container.top,
  mobileSummaryCount:report.mobile.metrics.summaries.length,
  desktopResultsDisplay:report.desktop.metrics.resultsDisplay,
  desktopResultsWidth:report.desktop.metrics.resultsBox?.width,
  desktopFilterWidth:report.desktop.metrics.filtersBox?.width,
  selected:report.desktop.metrics.selectedCount,
  blockedAnalytics:report.blockedAnalytics.length,
}))
await browser.close()
