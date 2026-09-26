import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const PROTOTYPE='http://127.0.0.1:4173/qa/switch-change-keep-review/switch-change-keep-prototype.html'
const OUT=process.env.OUT_DIR||'switch-change-keep-review-output'
const REPO=process.env.REPO_DIR||'.'
await mkdir(OUT,{recursive:true})

const report={
  baselineHead:'518bef25f8953d07ff7c330ebf0db85f2af13464',
  generatedAt:new Date().toISOString(),
  source:{},
  viewportRoundTrip:null,
  navigation:{},
  viewports:{},
}

for(const [key,path] of Object.entries({
  html:'qa/switch-change-keep-review/switch-change-keep-prototype.html',
  css:'qa/switch-change-keep-review/switch-change-keep-prototype.css',
  renderer:'qa/switch-change-keep-review/render-review.mjs',
})){
  const bytes=await readFile(join(REPO,path))
  report.source[key]={path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}
}

await copyFile(join(REPO,'qa/switch-change-keep-review/switch-change-keep-prototype.html'),join(OUT,'switch-change-keep-prototype.html'))
await copyFile(join(REPO,'qa/switch-change-keep-review/switch-change-keep-prototype.css'),join(OUT,'switch-change-keep-prototype.css'))

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function openPrototype(width,height,hash='#change'){
  const context=await browser.newContext({viewport:{width,height}})
  const page=await context.newPage()
  await page.goto(PROTOTYPE+hash,{waitUntil:'domcontentloaded',timeout:30000})
  await page.waitForFunction(()=>{
    const choice=document.querySelector('.choice')
    return choice instanceof HTMLElement && parseFloat(getComputedStyle(choice).minHeight)>=44
  })
  await page.evaluate(async()=>{await document.fonts?.ready})
  return {page,context}
}

async function disclosureState(page){
  return page.evaluate(()=>{
    const details=document.querySelector('#change .additional')
    const summary=document.querySelector('#change .additional>summary')
    const selected=document.querySelector('#change .additional .choice[aria-pressed="true"]')
    const selectedSummary=document.querySelector('#change .selected-summary')
    if(!(details instanceof HTMLDetailsElement)) return null
    const box=(el)=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}
    }
    const display=(el)=>el instanceof HTMLElement?getComputedStyle(el).display:null
    return {
      width:innerWidth,
      open:details.open,
      summaryDisplay:display(summary),
      selectedText:selected?.textContent?.trim()||null,
      selectedPressed:selected?.getAttribute('aria-pressed')||null,
      selectedBox:box(selected),
      selectedSummaryText:selectedSummary?.textContent?.trim()||null,
      selectedSummaryDisplay:display(selectedSummary),
    }
  })
}

async function roundTrip(){
  const {page,context}=await openPrototype(390,844,'#change')
  const details=page.locator('#change .additional')
  if(await details.evaluate(el=>el.open)) await page.locator('#change .additional>summary').click()
  await page.waitForFunction(()=>document.querySelector('#change .additional')?.open===false)

  const mobileCollapsed=await disclosureState(page)
  assert.equal(mobileCollapsed.open,false,'390px disclosure is collapsed')
  assert.equal(mobileCollapsed.summaryDisplay,'grid','390px disclosure summary remains visible')
  assert.match(mobileCollapsed.selectedSummaryText||'',/시니어/,'390px collapsed summary keeps selected senior')

  await page.setViewportSize({width:761,height:844})
  await page.waitForFunction(()=>document.querySelector('#change .additional')?.open===true)
  const tablet=await disclosureState(page)
  assert.equal(tablet.open,true,'761px forces additional conditions open')
  assert.equal(tablet.summaryDisplay,'none','761px hides mobile summary row')
  assert.equal(tablet.selectedPressed,'true','761px keeps senior selected')
  assert.ok(tablet.selectedBox?.height>0,'761px selected senior is visibly rendered')

  await page.setViewportSize({width:1440,height:900})
  const desktop=await disclosureState(page)
  assert.equal(desktop.open,true,'1440px keeps additional conditions open')
  assert.equal(desktop.selectedPressed,'true','1440px keeps senior selected')
  assert.ok(desktop.selectedBox?.height>=44,'1440px selected senior remains accessible')

  await page.setViewportSize({width:390,height:844})
  await page.waitForFunction(()=>document.querySelector('#change .additional')?.open===false)
  const mobileRestored=await disclosureState(page)
  assert.equal(mobileRestored.open,false,'return to 390px restores prior mobile collapsed state')
  assert.match(mobileRestored.selectedSummaryText||'',/시니어/,'return to 390px restores selected summary')
  assert.equal(mobileRestored.selectedPressed,'true','return to 390px preserves selected senior state')

  await page.screenshot({path:join(OUT,'prototype-mobile-390x844-roundtrip-collapsed.png'),fullPage:false})
  report.viewportRoundTrip={mobileCollapsed,tablet,desktop,mobileRestored}
  await context.close()
}

async function focusSnapshot(page){
  return page.evaluate(()=>{
    const el=document.activeElement
    if(!(el instanceof HTMLElement)) return null
    const r=el.getBoundingClientRect(),s=getComputedStyle(el)
    const extent=(parseFloat(s.outlineWidth)||0)+(parseFloat(s.outlineOffset)||0)
    return {
      text:el.textContent?.replace(/\s+/g,' ').trim()||'',
      tag:el.tagName,
      href:el.getAttribute('href'),
      display:s.display,
      outline:s.outline,
      outlineWidth:s.outlineWidth,
      outlineOffset:s.outlineOffset,
      box:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},
      focusBox:{top:r.top-extent,bottom:r.bottom+extent,left:r.left-extent,right:r.right+extent},
    }
  })
}

async function tabUntilHref(page,href,direction='Tab',max=30){
  await page.locator('body').click({position:{x:2,y:2}})
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement) document.activeElement.blur()})
  for(let i=0;i<max;i++){
    await page.keyboard.press(direction)
    const f=await focusSnapshot(page)
    if(f?.href===href) return f
  }
  return null
}

async function navigationKeyboard(){
  const {page,context}=await openPrototype(390,844,'#change')
  const forward=await tabUntilHref(page,'#keep','Tab')
  assert.ok(forward,'Tab reaches KEEP progress link')
  assert.equal(forward.display,'flex','mobile progress link has a real layout box')
  assert.ok(forward.box.width>0&&forward.box.height>=44,'mobile progress link has a 44px+ box')
  assert.ok(parseFloat(forward.outlineWidth)>=2,'mobile progress link shows focus outline')
  await page.keyboard.press('Enter')
  await page.waitForFunction(()=>location.hash==='#keep')
  assert.equal(await page.locator('#keep').evaluate(el=>getComputedStyle(el).display),'block','Enter moves to KEEP prototype screen')

  const firstKeepChoice=page.locator('#keep .keep-grid .choice').first()
  await firstKeepChoice.focus()
  await page.keyboard.press('Shift+Tab')
  const reverse=await focusSnapshot(page)
  assert.equal(reverse?.href,'#change','Shift+Tab reaches CHANGE progress link from first KEEP control')
  assert.equal(reverse?.display,'flex','CHANGE progress link has a real mobile box')
  assert.ok(parseFloat(reverse?.outlineWidth||'0')>=2,'CHANGE progress link shows focus outline')
  await page.keyboard.press('Enter')
  await page.waitForFunction(()=>location.hash==='#change')

  await page.setViewportSize({width:1440,height:900})
  const desktopLink=page.locator('#change .progress a[href="#keep"]')
  await desktopLink.focus()
  const desktopFocus=await focusSnapshot(page)
  assert.equal(desktopFocus.display,'grid','desktop progress link has a real grid box')
  assert.ok(desktopFocus.box.width>0&&desktopFocus.box.height>=34,'desktop progress link box is measurable')
  assert.ok(parseFloat(desktopFocus.outlineWidth)>=2,'desktop progress link focus outline visible')

  report.navigation={forward,reverse,desktopFocus}
  await context.close()
}

async function measureStepAccess(page,step,width,height,key){
  await page.evaluate(()=>window.scrollTo(0,0))
  const state=await page.evaluate((step)=>{
    const root=document.querySelector('#'+step)
    const rect=(el)=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}
    }
    const choices=[...root.querySelectorAll('.choice')].filter(el=>{
      if(!(el instanceof HTMLElement)) return false
      const r=el.getBoundingClientRect(),computed=getComputedStyle(el)
      return r.width>0&&r.height>0&&computed.display!=='none'&&computed.visibility!=='hidden'
    }).map(el=>({text:el.textContent?.trim()||'',height:el.getBoundingClientRect().height,fontSize:getComputedStyle(el).fontSize}))
    const editor=root.querySelector('.editor')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      horizontalOverflow:document.documentElement.scrollWidth-innerWidth,
      documentHeight:document.documentElement.scrollHeight,
      heading:rect(root.querySelector('.step-heading h1')),
      editor:{
        box:rect(editor),
        scrollHeight:editor instanceof HTMLElement?editor.scrollHeight:null,
        clientHeight:editor instanceof HTMLElement?editor.clientHeight:null,
        overflowY:editor instanceof HTMLElement?getComputedStyle(editor).overflowY:null,
      },
      choices,
    }
  },step)
  assert.equal(state.horizontalOverflow,0,key+' no horizontal overflow')
  assert.ok(state.heading&&state.heading.height>0,key+' heading visible')
  assert.ok(state.choices.every(x=>x.height>=44),key+' visible choices >=44px')

  if(width<=760){
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
  }else{
    await page.locator('#'+step+' .editor').evaluate(el=>{el.scrollTop=el.scrollHeight})
  }
  await page.waitForTimeout(60)

  const bottom=await page.evaluate((step)=>{
    const root=document.querySelector('#'+step)
    const action=root.querySelector('.actions')
    const primary=action?.querySelector('.primary')
    const secondary=action?.querySelector('.secondary')
    const editor=root.querySelector('.editor')
    const rect=(el)=>{if(!(el instanceof HTMLElement))return null;const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    return {
      action:rect(action),primary:rect(primary),secondary:rect(secondary),
      editorScrollTop:editor instanceof HTMLElement?editor.scrollTop:null,
      windowScrollY:scrollY,
    }
  },step)
  assert.ok(bottom.primary?.height>=48&&bottom.secondary?.height>=48,key+' actions >=48px')
  assert.ok(bottom.primary.top>=0&&bottom.primary.bottom<=height,key+' primary action reachable in viewport')
  assert.ok(bottom.secondary.top>=0&&bottom.secondary.bottom<=height,key+' secondary action reachable in viewport')

  await page.locator('#'+step+' .actions .primary').focus()
  const actionFocus=await focusSnapshot(page)
  assert.ok(parseFloat(actionFocus.outlineWidth)>=2,key+' action focus outline visible')
  assert.ok(actionFocus.focusBox.top>=0&&actionFocus.focusBox.bottom<=height,key+' action focus fully visible')

  return {state,bottom,actionFocus}
}

async function viewportAccess(width,height,key){
  const {page,context}=await openPrototype(width,height,'#change')
  if(width<=760){
    const details=page.locator('#change .additional')
    if(!(await details.evaluate(el=>el.open))) await page.locator('#change .additional>summary').click()
  }

  await page.evaluate(()=>window.scrollTo(0,0))
  await page.screenshot({path:join(OUT,key==='desktop-1440x900'?'prototype-desktop-1440x900-change.png':key==='mobile-390x844'?'prototype-mobile-390x844-change-expanded.png':'prototype-desktop-1440x700-change-top.png'),fullPage:false})
  const change=await measureStepAccess(page,'change',width,height,key+' change')
  await page.screenshot({path:join(OUT,key+'-change-bottom.png'),fullPage:false})

  await page.locator('#change .actions .primary').click()
  await page.waitForFunction(()=>location.hash==='#keep')
  await page.evaluate(()=>window.scrollTo(0,0))
  const keep=await measureStepAccess(page,'keep',width,height,key+' keep')
  await page.screenshot({path:join(OUT,key+'-keep-bottom.png'),fullPage:false})

  report.viewports[key]={change,keep}
  await context.close()
}

await roundTrip()
await navigationKeyboard()
await viewportAccess(390,844,'mobile-390x844')
await viewportAccess(1440,900,'desktop-1440x900')
await viewportAccess(1440,700,'desktop-1440x700')

await writeFile(join(OUT,'measurements.json'),JSON.stringify(report,null,2))
console.log('SWITCH_CHANGE_KEEP_NARROW='+JSON.stringify({
  roundTrip:report.viewportRoundTrip,
  navigation:report.navigation,
  viewports:Object.fromEntries(Object.entries(report.viewports).map(([k,v])=>[k,{bottom:v.bottom,focus:v.actionFocus}])),
}))
await browser.close()
