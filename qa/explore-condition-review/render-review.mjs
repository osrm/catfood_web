import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const PROTOTYPE='http://127.0.0.1:4173/qa/explore-condition-review/condition-prototype.html'
const OUT=process.env.OUT_DIR||'explore-condition-review-output'
await mkdir(OUT,{recursive:true})

const report={
  baselineMain:'730d9b7a332e27606ce3af879b102d1c83493116',
  generatedAt:new Date().toISOString(),
  prototype:{},
  source:{},
}

for(const [key,path] of Object.entries({
  html:'qa/explore-condition-review/condition-prototype.html',
  css:'qa/explore-condition-review/condition-prototype.css',
  measurement:'qa/explore-condition-review/render-review.mjs',
})){
  const bytes=await readFile(path)
  report.source[key]={path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function openPrototype(width,height){
  const context=await browser.newContext({viewport:{width,height}})
  const page=await context.newPage()
  await page.goto(PROTOTYPE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.evaluate(async()=>{await document.fonts?.ready})
  return {page,context}
}

async function state(page){
  return page.evaluate(()=>{
    const rect=el=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}
    }
    const style=el=>{
      if(!(el instanceof HTMLElement)) return null
      const s=getComputedStyle(el)
      return {
        display:s.display,
        position:s.position,
        fontSize:s.fontSize,
        lineHeight:s.lineHeight,
        outline:s.outline,
        outlineWidth:s.outlineWidth,
        outlineOffset:s.outlineOffset,
        boxShadow:s.boxShadow,
        scrollMarginBottom:s.scrollMarginBottom,
      }
    }
    const body=document.querySelector('.editor-body')
    const details=document.querySelector('.additional-disclosure')
    const summary=document.querySelector('.additional-toggle')
    const collapsed=document.querySelector('.collapsed-selection')
    const bar=document.querySelector('.editor-actions')
    const lastNote=[...document.querySelectorAll('.field-note')].at(-1)
    const choices=[...document.querySelectorAll('.choice')].map(el=>({
      text:el.textContent?.trim()||'',
      pressed:el.getAttribute('aria-pressed'),
      box:rect(el),
      style:style(el),
    }))
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{
        scrollWidth:document.documentElement.scrollWidth,
        scrollHeight:document.documentElement.scrollHeight,
        scrollY,
        scrollPaddingBottom:getComputedStyle(document.documentElement).scrollPaddingBottom,
      },
      editor:rect(document.querySelector('.editor')),
      editorBody:{
        box:rect(body),
        scrollTop:body instanceof HTMLElement?body.scrollTop:null,
        scrollHeight:body instanceof HTMLElement?body.scrollHeight:null,
        clientHeight:body instanceof HTMLElement?body.clientHeight:null,
        style:style(body),
      },
      actionBar:{box:rect(bar),style:style(bar)},
      apply:{box:rect(document.querySelector('.apply')),style:style(document.querySelector('.apply'))},
      reset:{box:rect(document.querySelector('.reset')),style:style(document.querySelector('.reset'))},
      disclosure:{
        open:details instanceof HTMLDetailsElement?details.open:null,
        summary:{box:rect(summary),style:style(summary),text:summary?.textContent?.replace(/\s+/g,' ').trim()||''},
        collapsed:{
          box:rect(collapsed),
          style:style(collapsed),
          text:collapsed?.textContent?.replace(/\s+/g,' ').trim()||'',
        },
        sectionsDisplay:style(document.querySelector('.additional-sections'))?.display||null,
      },
      choices,
      lastNote:{box:rect(lastNote),text:lastNote?.textContent?.trim()||'',style:style(lastNote)},
      note:document.querySelector('.prototype-note')?.textContent?.trim()||'',
    }
  })
}

async function activeFocus(page){
  return page.evaluate(()=>{
    const el=document.activeElement
    if(!(el instanceof HTMLElement)) return null
    const r=el.getBoundingClientRect(),s=getComputedStyle(el)
    const n=v=>Number.parseFloat(v)||0
    const extent=n(s.outlineWidth)+n(s.outlineOffset)
    return {
      text:el.textContent?.replace(/\s+/g,' ').trim()||'',
      tag:el.tagName,
      className:el.className,
      box:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},
      focusBox:{top:r.top-extent,bottom:r.bottom+extent,left:r.left-extent,right:r.right+extent},
      outline:s.outline,
      outlineWidth:s.outlineWidth,
      outlineOffset:s.outlineOffset,
      boxShadow:s.boxShadow,
    }
  })
}

async function visibleFocusLabels(page){
  return page.evaluate(()=>[...document.querySelectorAll('button, summary')]
    .filter(el=>{
      if(!(el instanceof HTMLElement)) return false
      const s=getComputedStyle(el),r=el.getBoundingClientRect()
      return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&!el.hasAttribute('disabled')
    })
    .map(el=>el.textContent?.replace(/\s+/g,' ').trim()||''))
}

function assertFocusRing(focus,label){
  assert.ok(focus,label+': focus exists')
  assert.ok(parseFloat(focus.outlineWidth)>=2,label+': focus ring is at least 2px')
  assert.notEqual(focus.outline,'none',label+': focus outline visible')
}

function assertNotCovered(focus,barTop,viewportHeight,label){
  assertFocusRing(focus,label)
  assert.ok(focus.focusBox.top>=-0.5,label+': focus ring top remains in viewport')
  assert.ok(focus.focusBox.bottom<=viewportHeight+0.5,label+': focus ring bottom remains in viewport')
  if(!String(focus.className).includes('apply')&&!String(focus.className).includes('reset')){
    assert.ok(focus.focusBox.bottom<=barTop-1,label+': focus ring remains above fixed/sticky action bar')
  }
}

async function tabSequence(page,direction,key){
  const labels=await visibleFocusLabels(page)
  assert.ok(labels.includes('Grain-Free 표기'),key+': Grain-Free is in focus order')
  assert.ok(labels.some(x=>x.startsWith('추가 조건')),key+': disclosure summary is in focus order')

  await page.evaluate(()=>{
    window.scrollTo(0,0)
    const body=document.querySelector('.editor-body')
    if(body instanceof HTMLElement) body.scrollTop=0
    if(document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.locator('body').click({position:{x:2,y:2}})

  const seen=[]
  if(direction==='forward'){
    for(const expected of labels){
      await page.keyboard.press('Tab')
      const focus=await activeFocus(page)
      assert.equal(focus?.text,expected,key+' forward focus order')
      const bar=(await state(page)).actionBar.box
      assert.ok(bar,key+': action bar exists during forward focus')
      assertNotCovered(focus,bar.top,(await page.viewportSize()).height,key+' forward '+expected)
      seen.push(focus)
    }
  }else{
    await page.locator('.apply').focus()
    const reverse=labels.slice(0,-1).reverse()
    for(const expected of reverse){
      await page.keyboard.press('Shift+Tab')
      const focus=await activeFocus(page)
      assert.equal(focus?.text,expected,key+' reverse focus order')
      const bar=(await state(page)).actionBar.box
      assert.ok(bar,key+': action bar exists during reverse focus')
      assertNotCovered(focus,bar.top,(await page.viewportSize()).height,key+' reverse '+expected)
      seen.push(focus)
    }
  }
  return seen
}

async function normalScrollToEnd(page,key,mobile){
  await page.evaluate(()=>{
    window.scrollTo(0,0)
    const body=document.querySelector('.editor-body')
    if(body instanceof HTMLElement) body.scrollTop=0
  })
  if(mobile){
    await page.mouse.move(360,700)
    await page.mouse.wheel(0,5000)
  }else{
    await page.locator('.editor-body').hover()
    await page.mouse.wheel(0,5000)
  }
  await page.waitForTimeout(120)
  const s=await state(page)
  assert.ok(s.lastNote.box,key+': last note exists after normal scroll')
  assert.ok(s.actionBar.box,key+': action bar exists after normal scroll')
  assert.ok(s.lastNote.box.top>=0,key+': last note reaches visible viewport')
  assert.ok(s.lastNote.box.bottom<=s.actionBar.box.top-4,key+': last note is fully readable above action bar')
  if(!mobile){
    assert.ok(s.editorBody.scrollTop>0,key+': editor body owns desktop scroll')
    assert.ok(s.editorBody.scrollHeight>s.editorBody.clientHeight,key+': desktop editor body is scrollable')
  }else{
    assert.ok(s.document.scrollY>0,key+': document owns mobile scroll')
  }
  return s
}

async function toggleDisclosure(page,open,key){
  const details=page.locator('.additional-disclosure')
  const current=await details.evaluate(el=>el.open)
  if(current!==open) await page.locator('.additional-toggle').click()
  const s=await state(page)
  assert.equal(s.disclosure.open,open,key+': disclosure state')
  if(open){
    assert.equal(s.disclosure.collapsed.style.display,'none',key+': expanded state hides duplicate selected-name summary')
    assert.notEqual(s.disclosure.sectionsDisplay,'none',key+': expanded state shows condition controls')
  }else{
    assert.notEqual(s.disclosure.collapsed.style.display,'none',key+': collapsed state keeps selected-name summary')
    assert.match(s.disclosure.collapsed.text,/실내묘/,key+': collapsed summary includes selected names')
    assert.match(s.disclosure.collapsed.text,/Grain-Free 표기/,key+': collapsed summary preserves long selected name')
  }
  return s
}

async function focusDisclosureByTab(page,key){
  await page.evaluate(()=>{
    window.scrollTo(0,0)
    const body=document.querySelector('.editor-body')
    if(body instanceof HTMLElement) body.scrollTop=0
    if(document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.locator('body').click({position:{x:2,y:2}})
  for(let i=0;i<30;i++){
    await page.keyboard.press('Tab')
    const focus=await activeFocus(page)
    if(focus?.tag==='SUMMARY'){
      assertFocusRing(focus,key+' disclosure')
      return focus
    }
  }
  throw new Error(key+': disclosure not reached by Tab')
}

async function mobile390(){
  const key='mobile-390x844'
  const {page,context}=await openPrototype(390,844)
  let s=await state(page)
  assert.equal(s.document.scrollWidth,390,key+': no horizontal overflow')
  assert.equal(s.disclosure.open,true,key+': starts expanded')
  assert.equal(s.disclosure.collapsed.style.display,'none',key+': no duplicate selected names while expanded')
  assert.ok(s.choices.every(x=>x.box&&x.box.height>=44),key+': choices remain >=44px')
  assert.equal(s.document.scrollPaddingBottom,'96px',key+': document scrollport reserves action-bar focus area')
  assert.match(s.note,/펼침\/접힘만 동작/,key+': static prototype scope is explicit')

  const forward=await tabSequence(page,'forward',key)
  const grainForward=forward.find(x=>x.text==='Grain-Free 표기')
  assert.ok(grainForward,key+': forward Tab reaches Grain-Free')
  const reverse=await tabSequence(page,'reverse',key)
  const indoorReverse=reverse.find(x=>x.text==='실내묘')
  const sterilizedReverse=reverse.find(x=>x.text==='중성화묘')
  assert.ok(indoorReverse&&sterilizedReverse,key+': Shift+Tab reaches first additional choices without action-bar occlusion')

  const end=await normalScrollToEnd(page,key,true)
  await page.screenshot({path:OUT+'/prototype-mobile-390x844-end.png',fullPage:false})

  await page.evaluate(()=>window.scrollTo(0,0))
  await toggleDisclosure(page,true,key+' expanded')
  const expandedFocus=await focusDisclosureByTab(page,key+' expanded')
  await page.screenshot({path:OUT+'/prototype-mobile-390x844-expanded.png',fullPage:false})

  await page.locator('.additional-toggle').click()
  const collapsed=await toggleDisclosure(page,false,key+' collapsed')
  const collapsedFocus=await focusDisclosureByTab(page,key+' collapsed')
  await page.screenshot({path:OUT+'/prototype-mobile-390x844-collapsed.png',fullPage:false})

  report.prototype[key]={
    initial:s,
    forward,
    reverse,
    grainForward,
    indoorReverse,
    sterilizedReverse,
    end,
    expanded:{state:await toggleDisclosure(page,true,key+' expanded-final'),focus:expandedFocus},
    collapsed:{state:collapsed,focus:collapsedFocus},
  }
  await context.close()
}

async function desktop(width,height,key){
  const {page,context}=await openPrototype(width,height)
  let s=await state(page)
  assert.equal(s.document.scrollWidth,width,key+': no horizontal overflow')
  assert.ok(s.editor&&Math.abs(s.editor.height-(height-104))<=1,key+': editor uses available viewport height')
  assert.ok(s.actionBar.box&&s.actionBar.box.top>=0&&s.actionBar.box.bottom<=height,key+': action bar fully visible')
  assert.ok(s.apply.box&&s.apply.box.top>=0&&s.apply.box.bottom<=height,key+': apply fully visible')
  assert.ok(s.reset.box&&s.reset.box.top>=0&&s.reset.box.bottom<=height,key+': reset fully visible')
  assert.ok(s.choices.every(x=>x.box&&x.box.height>=44),key+': choices remain >=44px')

  const end=await normalScrollToEnd(page,key,false)
  assert.ok(end.actionBar.box.bottom<=height,key+': action bar stays visible after internal scroll')
  await page.screenshot({path:OUT+'/prototype-'+key+'-end.png',fullPage:false})

  await page.evaluate(()=>{
    const body=document.querySelector('.editor-body')
    if(body instanceof HTMLElement) body.scrollTop=0
  })
  await toggleDisclosure(page,true,key+' expanded')
  const expandedFocus=await focusDisclosureByTab(page,key+' expanded')
  await page.screenshot({path:OUT+'/prototype-'+key+'-expanded.png',fullPage:false})

  await page.locator('.additional-toggle').click()
  const collapsed=await toggleDisclosure(page,false,key+' collapsed')
  const collapsedFocus=await focusDisclosureByTab(page,key+' collapsed')
  await page.screenshot({path:OUT+'/prototype-'+key+'-collapsed.png',fullPage:false})

  report.prototype[key]={
    initial:s,
    end,
    expanded:{state:await toggleDisclosure(page,true,key+' expanded-final'),focus:expandedFocus},
    collapsed:{state:collapsed,focus:collapsedFocus},
  }
  await context.close()
}

await mobile390()
await desktop(1440,900,'desktop-1440x900')
await desktop(1440,700,'desktop-1440x700')

await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('EXPLORE_CONDITION_PROTOTYPE='+JSON.stringify({
  mobileGrainFocus:report.prototype['mobile-390x844'].grainForward.focusBox,
  mobileBarTop:report.prototype['mobile-390x844'].end.actionBar.box.top,
  desktop900Editor:report.prototype['desktop-1440x900'].initial.editor,
  desktop700Editor:report.prototype['desktop-1440x700'].initial.editor,
  source:report.source,
}))
await browser.close()
