import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HTML=resolve(process.env.PROTOTYPE_HTML||'qa/explore-conditions-review/explore-conditions-prototype.html')
const OUT=process.env.OUT_DIR||'prototype-output'
await mkdir(OUT,{recursive:true})
const report={
  source:'static QA prototype',
  controls:'nonfunctional mock buttons',
  state:['건식','임신·수유·키튼','실내묘','중성화묘','체중 관리','소화','피부·피모','가금류','생선','Grain-Free 표기'],
  mobile:null,
  desktop:null,
}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function tabTo(page,pattern,max=80){
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement) document.activeElement.blur()})
  for(let i=0;i<max;i++){
    await page.keyboard.press('Tab')
    const active=await page.evaluate(()=>{
      const el=document.activeElement
      if(!(el instanceof HTMLElement)) return null
      const s=getComputedStyle(el)
      return {text:el.textContent?.replace(/\s+/g,' ').trim()||'',outline:s.outline,boxShadow:s.boxShadow,className:el.className}
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
      return {fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,color:s.color,backgroundColor:s.backgroundColor,borderColor:s.borderColor,position:s.position}
    }
    const choices=[...document.querySelectorAll('.choice')].map(el=>({text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:style(el),scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight}))
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
      bodyWidth:document.body.scrollWidth,
      editor:rect(document.querySelector('.editor')),
      heading:{box:rect(document.querySelector('.editor-heading')),titleStyle:style(document.querySelector('.editor-heading h1')),countStyle:style(document.querySelector('.selection-count'))},
      groupHeadings:[...document.querySelectorAll('.group-heading')].map(el=>({box:rect(el),title:el.querySelector('h2')?.textContent?.trim()||'',titleStyle:style(el.querySelector('h2')),note:el.querySelector('p')?.textContent?.trim()||'',noteStyle:style(el.querySelector('p'))})),
      fields:[...document.querySelectorAll('.field')].map(el=>({title:el.querySelector('h3')?.textContent?.trim()||'',box:rect(el),titleStyle:style(el.querySelector('h3')),hintStyle:style(el.querySelector('.field-heading span')),noteStyle:style(el.querySelector('.field-note'))})),
      choices,
      selectedCount:choices.filter(x=>x.pressed==='true').length,
      additionalCount:{text:document.querySelector('.additional-count')?.textContent?.trim()||'',box:rect(document.querySelector('.additional-count')),style:style(document.querySelector('.additional-count'))},
      action:{box:rect(document.querySelector('.action-bar')),style:style(document.querySelector('.action-bar')),apply:{box:rect(document.querySelector('.apply-action')),style:style(document.querySelector('.apply-action'))},reset:{box:rect(document.querySelector('.reset-action')),style:style(document.querySelector('.reset-action'))}},
      repeatedSummaryChipCount:document.querySelectorAll('.mobile-additional-summary span').length,
      resultsPanelCount:document.querySelectorAll('.research-results').length,
    }
  })
}

async function run(width,height,key){
  const page=await browser.newPage({viewport:{width,height}})
  await page.goto(pathToFileURL(HTML).href,{waitUntil:'load'})
  await page.evaluate(async()=>{await document.fonts?.ready})
  const choiceFocus=await tabTo(page,'건식')
  const applyFocus=await tabTo(page,'이 조건으로 찾기')
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement) document.activeElement.blur();scrollTo(0,0)})
  const metrics=await measure(page)
  assert.equal(metrics.document.width,width,key+': no horizontal document overflow')
  assert.equal(metrics.bodyWidth,width,key+': no horizontal body overflow')
  assert.equal(metrics.selectedCount,10,key+': same 10-condition state')
  assert.equal(metrics.repeatedSummaryChipCount,0,key+': no duplicated selected-summary chips')
  assert.equal(metrics.resultsPanelCount,0,key+': no empty results placeholder in editor prototype')
  assert.ok(metrics.choices.every(c=>c.box.height>=44),key+': all condition controls >=44px')
  assert.ok(metrics.choices.every(c=>c.style.fontSize==='13px'),key+': choice type is 13px')
  assert.ok(metrics.choices.every(c=>c.scrollWidth<=c.clientWidth+2&&c.scrollHeight<=c.clientHeight+2),key+': long choice names are not clipped')
  assert.ok(metrics.action.apply.box.height>=46,key+': apply action >=46px')
  assert.ok(metrics.action.reset.box.height>=46,key+': reset action >=46px')
  if(width===390){
    assert.equal(metrics.action.style.position,'fixed',key+': mobile actions remain visible')
    assert.ok(metrics.action.box.bottom<=height+1&&metrics.action.box.top>=height-90,key+': mobile action bar is visible at viewport bottom')
    assert.ok(metrics.additionalCount.box.width>0,key+': additional selection count visible')
  }
  await page.screenshot({path:OUT+'/prototype-'+key+'-top.png',fullPage:false})
  if(width===390){
    await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight))
    await page.screenshot({path:OUT+'/prototype-'+key+'-bottom.png',fullPage:false})
  }
  await page.screenshot({path:OUT+'/prototype-'+key+'-full.png',fullPage:true})
  await page.close()
  return {metrics,focus:{choice:choiceFocus,apply:applyFocus}}
}

report.mobile=await run(390,844,'mobile-390x844')
report.desktop=await run(1440,900,'desktop-1440x900')
await writeFile(OUT+'/prototype-measurements.json',JSON.stringify(report,null,2))
console.log('EXPLORE_CONDITIONS_PROTOTYPE='+JSON.stringify({
  mobileHeight:report.mobile.metrics.document.height,
  mobileAction:report.mobile.metrics.action.box,
  desktopEditorWidth:report.desktop.metrics.editor.width,
  selected:report.desktop.metrics.selectedCount,
}))
await browser.close()
