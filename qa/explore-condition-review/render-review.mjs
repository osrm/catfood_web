import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const PUBLIC='https://osrm.github.io/catfood_web/'
const PROTOTYPE='http://127.0.0.1:4173/qa/explore-condition-review/condition-prototype.html'
const OUT=process.env.OUT_DIR||'explore-condition-review-output'
await mkdir(OUT,{recursive:true})

const report={
  baselineMain:'730d9b7a332e27606ce3af879b102d1c83493116',
  generatedAt:new Date().toISOString(),
  current:{},
  prototype:{},
  network:{blockedWrites:[],blockedAnalytics:[]},
  source:{},
}

for(const [key,path] of Object.entries({
  html:'qa/explore-condition-review/condition-prototype.html',
  css:'qa/explore-condition-review/condition-prototype.css',
})){
  const bytes=await readFile(path)
  report.source[key]={path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

function boxFrom(r){return r?{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}:null}

async function currentPage(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(), method=req.method(), url=req.url()
    const analytics=/functions\/v1|search-runs|considerations|event_log|analytics|telemetry/i.test(url)
    const write=!['GET','HEAD','OPTIONS'].includes(method)
    if(analytics||write){
      if(analytics) report.network.blockedAnalytics.push({method,url})
      if(write) report.network.blockedWrites.push({method,url})
      await route.abort('blockedbyclient'); return
    }
    await route.continue()
  })
  await page.goto(PUBLIC,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'조건 고르기 →'}).click()
  await page.locator('.research-filter-scroll').waitFor({state:'visible'})
  await page.evaluate(async()=>{await document.fonts?.ready})
  return {page,context}
}

async function selectCurrent(page,width){
  async function press(label){
    const b=page.getByRole('button',{name:label,exact:true})
    await b.scrollIntoViewIfNeeded()
    await b.click()
    assert.equal(await b.getAttribute('aria-pressed'),'true',label+' selected')
  }
  await press('건식')
  await press('임신·수유·키튼')
  if(width<=760){
    const toggle=page.locator('.mobile-additional-toggle')
    if(await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
  }
  for(const label of ['실내묘','중성화묘','체중 관리','피부·피모','생선','Grain-Free 표기']) await press(label)
  const skin=page.getByRole('button',{name:'피부·피모',exact:true})
  await skin.click(); assert.equal(await skin.getAttribute('aria-pressed'),'false','current deselection works')
  await skin.click(); assert.equal(await skin.getAttribute('aria-pressed'),'true','current reselection works')
}

async function tabEvidence(page,target,max=80){
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement) document.activeElement.blur()})
  await page.locator('body').click({position:{x:3,y:3}})
  for(let i=0;i<max;i++){
    await page.keyboard.press('Tab')
    const active=await page.evaluate(()=>{
      const el=document.activeElement
      if(!(el instanceof HTMLElement)) return null
      const s=getComputedStyle(el),r=el.getBoundingClientRect()
      return {text:el.textContent?.replace(/\s+/g,' ').trim()||'',tag:el.tagName,className:el.className,outline:s.outline,outlineOffset:s.outlineOffset,boxShadow:s.boxShadow,box:box(r)}
      function box(r){return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
    })
    if(active?.text===target) return active
  }
  throw new Error('Tab target not reached: '+target)
}

async function measureCurrent(page){
  return page.evaluate(()=>{
    const rect=el=>{if(!(el instanceof HTMLElement))return null;const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
    const style=el=>{if(!(el instanceof HTMLElement))return null;const s=getComputedStyle(el);return{fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,color:s.color,background:s.backgroundColor,border:s.border}}
    const choices=[...document.querySelectorAll('.choice')].map(el=>({text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:style(el)}))
    const selected=choices.filter(x=>x.pressed==='true')
    const primary=document.querySelector('.condition-actions .primary-action')
    const secondary=document.querySelector('.condition-actions .secondary-action')
    const mobileSummary=document.querySelector('.mobile-additional-summary')
    const filterScroll=document.querySelector('.research-filter-scroll')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,scrollY},
      pane:{filter:rect(document.querySelector('.research-filters')),results:rect(document.querySelector('.research-results')),heading:rect(document.querySelector('.research-pane-heading')),scroll:rect(filterScroll),scrollTop:filterScroll instanceof HTMLElement?filterScroll.scrollTop:null},
      title:{text:document.querySelector('.research-pane-heading strong')?.textContent?.trim()||'',style:style(document.querySelector('.research-pane-heading strong'))},
      description:{text:document.querySelector('.research-pane-heading span')?.textContent?.trim()||'',style:style(document.querySelector('.research-pane-heading span'))},
      draft:{text:document.querySelector('.condition-draft-count')?.textContent?.trim()||'',box:rect(document.querySelector('.condition-draft-count')),style:style(document.querySelector('.condition-draft-count'))},
      groupTitles:[...document.querySelectorAll('.condition-group-title')].map(el=>({text:el.textContent?.replace(/\s+/g,' ').trim()||'',box:rect(el),style:style(el)})),
      sectionHeads:[...document.querySelectorAll('.filter-heading')].map(el=>({text:el.textContent?.replace(/\s+/g,' ').trim()||'',box:rect(el),style:style(el)})),
      choices,selected,
      action:{primary:{text:primary?.textContent?.trim()||'',box:rect(primary),style:style(primary)},secondary:{text:secondary?.textContent?.trim()||'',box:rect(secondary),style:style(secondary)}},
      mobileToggle:rect(document.querySelector('.mobile-additional-toggle')),
      mobileSummary:mobileSummary?{box:rect(mobileSummary),text:mobileSummary.textContent?.replace(/\s+/g,' ').trim()||'',children:[...mobileSummary.children].map(el=>({text:el.textContent?.trim()||'',box:rect(el)}))}:null,
      waiting:document.querySelector('.research-results')?.textContent?.replace(/\s+/g,' ').trim()||'',
    }
  })
}

async function captureCurrent(width,height,key){
  const {page,context}=await currentPage(width,height)
  await selectCurrent(page,width)
  const focusChoice=await tabEvidence(page,'건식')
  const focusApply=await tabEvidence(page,'이 조건으로 찾기')
  await page.evaluate(()=>{
    window.scrollTo(0,0)
    const el=document.querySelector('.research-filter-scroll')
    if(el instanceof HTMLElement) el.scrollTop=0
    const pane=document.querySelector('.research-filters')
    if(pane instanceof HTMLElement) pane.scrollTop=0
  })
  await page.waitForTimeout(80)
  const top=await measureCurrent(page)
  assert.equal(top.document.scrollWidth,width,key+' current no horizontal overflow')
  assert.ok(top.choices.every(x=>x.box&&x.box.height>=38),key+' current choices >=38px')
  assert.ok(top.action.primary.box&&top.action.primary.box.height>=44,key+' current apply >=44px')
  assert.match(focusChoice.outline+focusChoice.boxShadow,/\dpx|rgb|rgba/,key+' current choice keyboard focus visible')
  assert.match(focusApply.outline+focusApply.boxShadow,/\dpx|rgb|rgba/,key+' current apply keyboard focus visible')
  await page.screenshot({path:OUT+'/current-'+key+'.png',fullPage:false})

  await page.locator('.condition-actions .primary-action').scrollIntoViewIfNeeded()
  await page.waitForTimeout(50)
  const actions=await measureCurrent(page)
  await page.screenshot({path:OUT+'/current-'+key+'-actions.png',fullPage:false})

  report.current[key]={top,actions,focus:{choice:focusChoice,apply:focusApply},url:page.url()}
  await context.close()
}

async function prototypePage(width,height){
  const context=await browser.newContext({viewport:{width,height}})
  const page=await context.newPage()
  await page.goto(PROTOTYPE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.evaluate(async()=>{await document.fonts?.ready})
  return {page,context}
}

async function measurePrototype(page){
  return page.evaluate(()=>{
    const rect=el=>{if(!(el instanceof HTMLElement))return null;const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
    const style=el=>{if(!(el instanceof HTMLElement))return null;const s=getComputedStyle(el);return{fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,color:s.color,background:s.backgroundColor,border:s.border,position:s.position}}
    const choices=[...document.querySelectorAll('.choice')].map(el=>({text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:style(el)}))
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,scrollY},
      editor:rect(document.querySelector('.editor')),
      head:rect(document.querySelector('.editor-head')),
      title:{text:document.querySelector('h1')?.textContent?.trim()||'',style:style(document.querySelector('h1'))},
      description:{text:document.querySelector('.editor-head p')?.textContent?.trim()||'',style:style(document.querySelector('.editor-head p'))},
      selectionCount:{text:document.querySelector('.selection-count')?.textContent?.trim()||'',box:rect(document.querySelector('.selection-count')),style:style(document.querySelector('.selection-count'))},
      groupHeads:[...document.querySelectorAll('.group-head')].map(el=>({text:el.textContent?.replace(/\s+/g,' ').trim()||'',box:rect(el)})),
      sectionHeads:[...document.querySelectorAll('.section-head')].map(el=>({text:el.textContent?.replace(/\s+/g,' ').trim()||'',box:rect(el)})),
      choices,
      selected:choices.filter(x=>x.pressed==='true'),
      additionalToggle:{text:document.querySelector('.additional-toggle')?.textContent?.replace(/\s+/g,' ').trim()||'',box:rect(document.querySelector('.additional-toggle')),style:style(document.querySelector('.additional-toggle'))},
      action:{bar:rect(document.querySelector('.editor-actions')),apply:{box:rect(document.querySelector('.apply')),style:style(document.querySelector('.apply'))},reset:{box:rect(document.querySelector('.reset')),style:style(document.querySelector('.reset'))}},
      prototypeNote:document.querySelector('.prototype-note')?.textContent?.trim()||'',
    }
  })
}

async function capturePrototype(width,height,key){
  const {page,context}=await prototypePage(width,height)
  const focusChoice=await tabEvidence(page,'건식')
  const focusApply=await tabEvidence(page,'이 조건으로 찾기')
  await page.evaluate(()=>{
    window.scrollTo(0,0)
    const body=document.querySelector('.editor-body')
    if(body instanceof HTMLElement) body.scrollTop=0
  })
  await page.waitForTimeout(50)
  const metrics=await measurePrototype(page)
  assert.equal(metrics.document.scrollWidth,width,key+' prototype no horizontal overflow')
  assert.ok(metrics.choices.every(x=>x.box&&x.box.height>=44),key+' prototype choices >=44px')
  assert.ok(metrics.action.apply.box&&metrics.action.apply.box.height>=46,key+' prototype apply >=46px')
  assert.equal(metrics.selected.length,8,key+' prototype preserves 8 selected conditions')
  assert.match(metrics.prototypeNote,/동작하지 않는 모형/,key+' prototype declares static controls')
  assert.match(focusChoice.outline+focusChoice.boxShadow,/\dpx|rgb|rgba/,key+' prototype choice keyboard focus visible')
  assert.match(focusApply.outline+focusApply.boxShadow,/\dpx|rgb|rgba/,key+' prototype apply keyboard focus visible')
  await page.screenshot({path:OUT+'/prototype-'+key+'.png',fullPage:false})
  report.prototype[key]={metrics,focus:{choice:focusChoice,apply:focusApply},url:page.url()}
  await context.close()
}

await captureCurrent(390,844,'mobile-390x844')
await captureCurrent(1440,900,'desktop-1440x900')
await capturePrototype(390,844,'mobile-390x844')
await capturePrototype(1440,900,'desktop-1440x900')

assert.equal(report.network.blockedWrites.length,0,'no write requests attempted')
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('EXPLORE_CONDITION_REVIEW='+JSON.stringify({
  currentMobileHeight:report.current['mobile-390x844'].top.document.scrollHeight,
  currentMobileSummaryHeight:report.current['mobile-390x844'].top.mobileSummary?.box?.height||0,
  currentDesktopResultsWidth:report.current['desktop-1440x900'].top.pane.results?.width||0,
  prototypeMobileHeight:report.prototype['mobile-390x844'].metrics.document.scrollHeight,
  prototypeChoiceHeight:report.prototype['mobile-390x844'].metrics.choices[0]?.box?.height||0,
  blockedWrites:report.network.blockedWrites.length,
  blockedAnalytics:report.network.blockedAnalytics.length,
}))
await browser.close()
