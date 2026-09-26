import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const PROTOTYPE='http://127.0.0.1:4173/qa/switch-change-keep-review/switch-change-keep-prototype.html'
const OUT=process.env.OUT_DIR||'switch-change-keep-review-output'
const CURRENT=process.env.CURRENT_DIR||'switch-change-keep-current'
const REPO=process.env.REPO_DIR||'.'
await mkdir(OUT,{recursive:true})

const currentReport=JSON.parse(await readFile(join(CURRENT,'measurements-current.json'),'utf8'))
const report={
  baselineMain:'f69e1c64b37d68f99365a12eeae74e4627148271',
  generatedAt:new Date().toISOString(),
  source:{},
  current:currentReport.current,
  currentRequestGuard:{blockedWrites:currentReport.blockedWrites.length,blockedAnalytics:currentReport.blockedAnalytics.length},
  prototype:{},
}

for(const [key,path] of Object.entries({
  html:'qa/switch-change-keep-review/switch-change-keep-prototype.html',
  css:'qa/switch-change-keep-review/switch-change-keep-prototype.css',
  renderer:'qa/switch-change-keep-review/render-review.mjs',
})){
  const bytes=await readFile(join(REPO,path))
  report.source[key]={path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}
}

for(const name of await readdir(CURRENT)){
  if(name.endsWith('.png')) await copyFile(join(CURRENT,name),join(OUT,'current-'+name))
}
await copyFile(join(REPO,'qa/switch-change-keep-review/switch-change-keep-prototype.html'),join(OUT,'switch-change-keep-prototype.html'))
await copyFile(join(REPO,'qa/switch-change-keep-review/switch-change-keep-prototype.css'),join(OUT,'switch-change-keep-prototype.css'))

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function openPrototype(width,height,hash){
  const context=await browser.newContext({viewport:{width,height}})
  const page=await context.newPage()
  await page.goto(PROTOTYPE+hash,{waitUntil:'domcontentloaded',timeout:30000})
  await page.waitForFunction(() => {
    const choice=document.querySelector('.choice')
    return choice instanceof HTMLElement && parseFloat(getComputedStyle(choice).minHeight) >= 44
  },undefined,{timeout:30000})
  await page.evaluate(async()=>{await document.fonts?.ready})
  return {page,context}
}

async function state(page,step){
  return page.evaluate(step=>{
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
    const screen=document.querySelector(step==='change'?'#change':'#keep')
    const editor=screen?.querySelector('.editor')
    const details=screen?.querySelector('.additional')
    const selectedSummary=screen?.querySelector('.selected-summary')
    const choices=[...(screen?.querySelectorAll('.choice')||[])].filter(el=>{
      if(!(el instanceof HTMLElement)) return false
      const r=el.getBoundingClientRect(),s=getComputedStyle(el)
      return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'
    }).map(el=>({text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:style(el)}))
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{scrollY,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},
      reference:{box:rect(screen?.querySelector('.reference')),text:screen?.querySelector('.reference')?.textContent?.replace(/\s+/g,' ').trim()||''},
      editor:{
        box:rect(editor),style:style(editor),
        scrollTop:editor instanceof HTMLElement?editor.scrollTop:null,
        scrollHeight:editor instanceof HTMLElement?editor.scrollHeight:null,
        clientHeight:editor instanceof HTMLElement?editor.clientHeight:null,
      },
      heading:{box:rect(screen?.querySelector('.step-heading h1')),style:style(screen?.querySelector('.step-heading h1')),text:screen?.querySelector('.step-heading h1')?.textContent?.trim()||''},
      intro:{box:rect(screen?.querySelector('.step-heading>p')),style:style(screen?.querySelector('.step-heading>p')),text:screen?.querySelector('.step-heading>p')?.textContent?.trim()||''},
      noChange:{box:rect(screen?.querySelector('.no-change')),style:style(screen?.querySelector('.no-change'))},
      currentFacts:{box:rect(screen?.querySelector('.current-facts')),text:screen?.querySelector('.current-facts')?.textContent?.replace(/\s+/g,' ').trim()||''},
      choices,
      disclosure:details?{
        open:details.open,
        summary:{box:rect(details.querySelector('summary')),style:style(details.querySelector('summary')),text:details.querySelector('summary')?.textContent?.replace(/\s+/g,' ').trim()||''},
        selectedSummary:selectedSummary?{box:rect(selectedSummary),style:style(selectedSummary),text:selectedSummary.textContent?.trim()||''}:null,
      }:null,
      actions:{
        box:rect(screen?.querySelector('.actions')),
        primary:{box:rect(screen?.querySelector('.actions .primary')),style:style(screen?.querySelector('.actions .primary')),text:screen?.querySelector('.actions .primary')?.textContent?.trim()||''},
        secondary:{box:rect(screen?.querySelector('.actions .secondary')),style:style(screen?.querySelector('.actions .secondary')),text:screen?.querySelector('.actions .secondary')?.textContent?.trim()||''},
      },
      selectedChoices:choices.filter(x=>x.pressed==='true').map(x=>x.text),
    }
  },step)
}

async function activeFocus(page){
  return page.evaluate(()=>{
    const el=document.activeElement
    if(!(el instanceof HTMLElement)) return null
    const r=el.getBoundingClientRect(),s=getComputedStyle(el)
    return {
      text:el.textContent?.replace(/\s+/g,' ').trim()||'',
      tag:el.tagName,className:el.className,
      box:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},
      outline:s.outline,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,
    }
  })
}

async function tabUntil(page,selector,max=80){
  await page.locator('body').click({position:{x:2,y:2}})
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement) document.activeElement.blur()})
  for(let i=0;i<max;i++){
    await page.keyboard.press('Tab')
    const matched=await page.evaluate(selector=>document.activeElement instanceof HTMLElement&&document.activeElement.matches(selector),selector)
    if(matched) return activeFocus(page)
  }
  return null
}

async function mobile(){
  const {page,context}=await openPrototype(390,844,'#change')
  const initialDetails=page.locator('#change .additional')
  if(await initialDetails.evaluate(el=>el.open)) await page.locator('#change .additional>summary').click()
  await page.evaluate(()=>window.scrollTo(0,0))
  const pageTop=await state(page,'change')
  assert.equal(pageTop.document.scrollWidth,390,'prototype mobile no horizontal overflow')
  assert.ok(pageTop.choices.every(x=>x.box&&x.box.height>=43.5),'prototype mobile choices >=44px')
  assert.equal(pageTop.actions.primary.box.height,48,'prototype mobile primary is 48px')
  await page.screenshot({path:OUT+'/prototype-mobile-390x844-change-page-top.png',fullPage:false})

  const details=page.locator('#change .additional')
  if(await details.evaluate(el=>el.open)) await page.locator('#change .additional>summary').click()
  await page.locator('#change .additional>summary').scrollIntoViewIfNeeded()
  const collapsed=await state(page,'change')
  assert.equal(collapsed.disclosure.open,false,'prototype mobile disclosure collapsed')
  assert.equal(collapsed.disclosure.selectedSummary.style.display,'block','collapsed selected summary visible')
  assert.match(collapsed.disclosure.selectedSummary.text,/시니어/,'collapsed summary keeps selected name')
  await page.screenshot({path:OUT+'/prototype-mobile-390x844-change-collapsed.png',fullPage:false})

  await page.locator('#change .additional>summary').click()
  const expanded=await state(page,'change')
  assert.equal(expanded.disclosure.open,true,'prototype mobile disclosure expanded')
  assert.equal(expanded.disclosure.selectedSummary.style.display,'none','expanded duplicate selected summary hidden')
  assert.ok(expanded.selectedChoices.includes('시니어'),'expanded state preserves senior selection')
  await page.screenshot({path:OUT+'/prototype-mobile-390x844-change-expanded.png',fullPage:false})

  const brandFocus=await tabUntil(page,'#change .basic-grid .choice.active')
  const disclosureFocus=await tabUntil(page,'#change .additional>summary')
  const nextFocus=await tabUntil(page,'#change .actions .primary')
  for(const [label,f] of [['brand',brandFocus],['disclosure',disclosureFocus],['next',nextFocus]]){
    assert.ok(f,'prototype mobile '+label+' focus exists')
    assert.ok(parseFloat(f.outlineWidth)>=2,'prototype mobile '+label+' focus ring >=2px')
  }

  await page.goto(PROTOTYPE+'#keep',{waitUntil:'domcontentloaded'})
  await page.evaluate(async()=>{await document.fonts?.ready;window.scrollTo(0,0)})
  const keepTop=await state(page,'keep')
  assert.ok(keepTop.choices.every(x=>x.box&&x.box.height>=43.5),'prototype keep choices >=44px')
  assert.equal(keepTop.currentFacts.box.height<=100,true,'prototype compact keep facts <=100px')
  assert.deepEqual(keepTop.selectedChoices.sort(),['건식 유지','생선'].sort(),'prototype keep selection state matches review state')
  await page.screenshot({path:OUT+'/prototype-mobile-390x844-keep-page-top.png',fullPage:false})

  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
  const keepBottom=await state(page,'keep')
  await page.screenshot({path:OUT+'/prototype-mobile-390x844-keep-bottom.png',fullPage:false})
  const keepPrimaryFocus=await tabUntil(page,'#keep .actions .primary')
  assert.ok(keepPrimaryFocus&&parseFloat(keepPrimaryFocus.outlineWidth)>=2,'prototype keep primary keyboard focus visible')

  report.prototype['mobile-390x844']={change:{pageTop,collapsed,expanded,focus:{brand:brandFocus,disclosure:disclosureFocus,next:nextFocus}},keep:{pageTop:keepTop,bottom:keepBottom,focus:{primary:keepPrimaryFocus}}}
  await context.close()
}

async function desktop(){
  const {page,context}=await openPrototype(1440,900,'#change')
  const changeTop=await state(page,'change')
  assert.equal(changeTop.document.scrollWidth,1440,'prototype desktop no horizontal overflow')
  assert.ok(changeTop.choices.every(x=>x.box&&x.box.height>=43.5),'prototype desktop choices >=44px')
  assert.equal(changeTop.actions.primary.box.height,48,'prototype desktop action 48px')
  await page.screenshot({path:OUT+'/prototype-desktop-1440x900-change-top.png',fullPage:false})

  await page.locator('#change .editor').evaluate(el=>{el.scrollTop=el.scrollHeight})
  const changeBottom=await state(page,'change')
  await page.screenshot({path:OUT+'/prototype-desktop-1440x900-change-bottom.png',fullPage:false})
  const changeFocus=await tabUntil(page,'#change .basic-grid .choice.active')
  assert.ok(changeFocus&&parseFloat(changeFocus.outlineWidth)>=2,'prototype desktop choice focus visible')

  await page.goto(PROTOTYPE+'#keep',{waitUntil:'domcontentloaded'})
  await page.evaluate(async()=>{await document.fonts?.ready})
  const keepTop=await state(page,'keep')
  assert.ok(keepTop.currentFacts.box.height<=100,'prototype desktop compact keep facts')
  assert.deepEqual(keepTop.selectedChoices.sort(),['건식 유지','생선'].sort(),'prototype desktop selection state matches')
  await page.screenshot({path:OUT+'/prototype-desktop-1440x900-keep-top.png',fullPage:false})
  const keepPrimaryFocus=await tabUntil(page,'#keep .actions .primary')
  assert.ok(keepPrimaryFocus&&parseFloat(keepPrimaryFocus.outlineWidth)>=2,'prototype desktop keep primary focus visible')

  report.prototype['desktop-1440x900']={change:{top:changeTop,bottom:changeBottom,focus:{choice:changeFocus}},keep:{top:keepTop,focus:{primary:keepPrimaryFocus}}}
  await context.close()
}

await mobile()
await desktop()

await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('SWITCH_CHANGE_KEEP_REVIEW='+JSON.stringify({
  source:report.source,
  currentMobileChangeScroll:report.current['mobile-390x844'].changeCollapsed.document.scrollHeight,
  currentMobileKeepScroll:report.current['mobile-390x844'].keep.selected.document.scrollHeight,
  prototypeMobileChangeScroll:report.prototype['mobile-390x844'].change.pageTop.document.scrollHeight,
  prototypeMobileKeepScroll:report.prototype['mobile-390x844'].keep.pageTop.document.scrollHeight,
  currentKeepFactsHeight:report.current['mobile-390x844'].keep.selected.facts.box.height,
  prototypeKeepFactsHeight:report.prototype['mobile-390x844'].keep.pageTop.currentFacts.box.height,
}))
await browser.close()
