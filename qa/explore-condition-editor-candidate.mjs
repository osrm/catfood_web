import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'candidate-output'
await mkdir(OUT,{recursive:true})

const report={
  candidateSha:process.env.GITHUB_SHA||null,
  generatedAt:new Date().toISOString(),
  blockedWrites:[],
  blockedAnalytics:[],
  scenarios:{},
  breakpoints:{},
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

function normalize(value){return String(value||'').replace(/\s+/g,' ').trim()}

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

async function enterExplore(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'조건 고르기 →'}).waitFor({state:'visible',timeout:30000})
  await page.getByRole('button',{name:'조건 고르기 →'}).click()
  await page.locator('.research-filter-scroll').waitFor({state:'visible',timeout:10000})
  await page.waitForFunction(
    () => document.querySelector('.research-status')?.textContent?.includes('데이터 연결됨') === true,
    undefined,
    {timeout:30000},
  )
  await page.evaluate(async()=>{await document.fonts?.ready})
}

async function clickChoice(page,label,pressed=true){
  const button=page.getByRole('button',{name:label,exact:true})
  await button.scrollIntoViewIfNeeded()
  await button.click()
  await page.waitForFunction(
    ({label,pressed})=>{
      const button=[...document.querySelectorAll('.choice')].find(el=>el.textContent?.trim()===label)
      return button?.getAttribute('aria-pressed')===String(pressed)
    },
    {label,pressed},
  )
}

async function setDisclosure(page,open){
  const toggle=page.locator('.mobile-additional-toggle')
  const current=await toggle.getAttribute('aria-expanded')
  if(current!==String(open)) await toggle.click()
  await page.waitForFunction(
    open=>document.querySelector('.mobile-additional-toggle')?.getAttribute('aria-expanded')===String(open),
    open,
  )
}

async function selectEight(page){
  await clickChoice(page,'건식')
  await clickChoice(page,'임신·수유·키튼')
  await setDisclosure(page,true)
  for(const label of ['실내묘','중성화묘','체중 관리','피부·피모','생선','Grain-Free 표기']) await clickChoice(page,label)
  await page.waitForFunction(()=>document.querySelector('.condition-draft-count')?.textContent?.includes('8개')===true)
}

async function editorState(page){
  return page.evaluate(()=>{
    const rect=el=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {top:r.top,left:r.left,right:r.right,bottom:r.bottom,width:r.width,height:r.height}
    }
    const style=el=>{
      if(!(el instanceof HTMLElement)) return null
      const s=getComputedStyle(el)
      return {
        display:s.display,position:s.position,overflowY:s.overflowY,
        fontSize:s.fontSize,lineHeight:s.lineHeight,
        outline:s.outline,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,
        scrollPaddingBottom:s.scrollPaddingBottom,scrollMarginBottom:s.scrollMarginBottom,
      }
    }
    const shell=document.querySelector('.research-shell')
    const scroll=document.querySelector('.research-filter-scroll')
    const action=document.querySelector('.condition-actions')
    const note=[...document.querySelectorAll('.field-note')].at(-1)
    const toggle=document.querySelector('.mobile-additional-toggle')
    const summary=document.querySelector('.mobile-additional-summary')
    const choices=[...document.querySelectorAll('.research-filter-scroll .choice')]
      .filter(el=>{
        if(!(el instanceof HTMLElement)) return false
        const computed=getComputedStyle(el),r=el.getBoundingClientRect()
        return computed.display!=='none'&&computed.visibility!=='hidden'&&r.width>0&&r.height>0
      })
      .map(el=>({
        text:el.textContent?.trim()||'',pressed:el.getAttribute('aria-pressed'),box:rect(el),style:style(el),
      }))
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},
      shell:{
        box:rect(shell),scrollTop:shell instanceof HTMLElement?shell.scrollTop:null,
        scrollHeight:shell instanceof HTMLElement?shell.scrollHeight:null,
        clientHeight:shell instanceof HTMLElement?shell.clientHeight:null,
        style:style(shell),
      },
      filter:rect(document.querySelector('.research-filters')),
      paneHeading:{box:rect(document.querySelector('.research-pane-heading')),title:style(document.querySelector('.research-pane-heading strong'))},
      scroll:{
        box:rect(scroll),scrollTop:scroll instanceof HTMLElement?scroll.scrollTop:null,
        scrollHeight:scroll instanceof HTMLElement?scroll.scrollHeight:null,
        clientHeight:scroll instanceof HTMLElement?scroll.clientHeight:null,
        style:style(scroll),
      },
      action:{
        box:rect(action),style:style(action),
        reset:{box:rect(document.querySelector('.condition-actions .secondary-action')),style:style(document.querySelector('.condition-actions .secondary-action'))},
        apply:{box:rect(document.querySelector('.condition-actions .primary-action')),style:style(document.querySelector('.condition-actions .primary-action'))},
      },
      disclosure:{
        expanded:toggle?.getAttribute('aria-expanded')||null,
        box:rect(toggle),style:style(toggle),
        summary:summary?{text:String(summary.textContent||'').replace(/\\s+/g,' ').trim(),box:rect(summary),style:style(summary)}:null,
        sectionsDisplay:style(document.querySelector('.additional-condition-sections'))?.display||null,
      },
      draftCount:String(document.querySelector('.condition-draft-count')?.textContent||'').replace(/\\s+/g,' ').trim(),
      choices,
      lastNote:{text:String(note?.textContent||'').replace(/\\s+/g,' ').trim(),box:rect(note),style:style(note)},
      resultsExists:Boolean(document.querySelector('.research-results')),
      horizontalOverflow:document.documentElement.scrollWidth-innerWidth,
    }
  })
}

async function activeFocus(page){
  return page.evaluate(()=>{
    const el=document.activeElement
    if(!(el instanceof HTMLElement)) return null
    const r=el.getBoundingClientRect(),s=getComputedStyle(el)
    const extent=(Number.parseFloat(s.outlineWidth)||0)+(Number.parseFloat(s.outlineOffset)||0)
    return {
      text:String(el.textContent||'').replace(/\s+/g,' ').trim(),
      className:el.className,
      box:{top:r.top,left:r.left,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
      focusBox:{top:r.top-extent,left:r.left-extent,right:r.right+extent,bottom:r.bottom+extent},
      outline:s.outline,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,
      insideEditor:Boolean(el.closest('.research-filters')),
    }
  })
}

async function editorButtonLabels(page){
  return page.evaluate(()=>[...document.querySelectorAll('.research-filters button')]
    .filter(el=>{
      if(!(el instanceof HTMLElement)) return false
      const s=getComputedStyle(el),r=el.getBoundingClientRect()
      return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0
    })
    .map(el=>String(el.textContent||'').replace(/\s+/g,' ').trim()))
}

function assertFocusVisible(focus,label){
  assert.ok(focus,label+': focus exists')
  assert.ok(parseFloat(focus.outlineWidth)>=2,label+': focus outline >=2px')
  assert.notEqual(focus.outline,'none',label+': focus outline visible')
}

function assertFocusSafe(focus,state,label){
  assertFocusVisible(focus,label)
  assert.ok(focus.focusBox.top>=-0.5,label+': focus top visible')
  assert.ok(focus.focusBox.bottom<=state.viewport.height+0.5,label+': focus bottom visible')
  const isAction=String(focus.className).includes('primary-action')||String(focus.className).includes('secondary-action')
  if(!isAction){
    assert.ok(state.action.box,label+': action bar exists')
    assert.ok(focus.focusBox.bottom<=state.action.box.top-1,label+': focus ring stays above action bar')
  }
}

async function tabRoundTrip(page,key){
  await page.evaluate(()=>{
    const shell=document.querySelector('.research-shell')
    const scroll=document.querySelector('.research-filter-scroll')
    if(shell instanceof HTMLElement) shell.scrollTop=0
    if(scroll instanceof HTMLElement) scroll.scrollTop=0
    if(document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.locator('body').click({position:{x:2,y:2}})
  const expected=await editorButtonLabels(page)
  const forward=[]
  let inEditor=false
  for(let i=0;i<80;i++){
    await page.keyboard.press('Tab')
    const focus=await activeFocus(page)
    if(!focus) continue
    if(focus.insideEditor){
      inEditor=true
      const st=await editorState(page)
      assertFocusSafe(focus,st,key+' forward '+focus.text)
      forward.push(focus)
      if(focus.text==='이 조건으로 찾기') break
    }else if(inEditor){
      break
    }
  }
  assert.deepEqual(forward.map(x=>x.text),expected,key+': full editor forward Tab order')

  const reverse=[forward.at(-1)]
  for(let i=expected.length-2;i>=0;i--){
    await page.keyboard.press('Shift+Tab')
    const focus=await activeFocus(page)
    assert.equal(focus?.text,expected[i],key+' reverse Tab order')
    const st=await editorState(page)
    assertFocusSafe(focus,st,key+' reverse '+focus.text)
    reverse.push(focus)
  }
  return {expected,forward,reverse}
}

async function normalScrollToEnd(page,key,mobile){
  await page.evaluate(()=>{
    const shell=document.querySelector('.research-shell')
    const scroll=document.querySelector('.research-filter-scroll')
    if(shell instanceof HTMLElement) shell.scrollTop=0
    if(scroll instanceof HTMLElement) scroll.scrollTop=0
  })
  if(mobile){
    await page.locator('.research-shell').hover()
  }else{
    await page.locator('.research-filter-scroll').hover()
  }
  await page.mouse.wheel(0,5000)
  await page.waitForFunction(
    ({mobile})=>{
      const owner=document.querySelector(mobile?'.research-shell':'.research-filter-scroll')
      return owner instanceof HTMLElement && owner.scrollTop>0
    },
    {mobile},
  )
  const st=await editorState(page)
  assert.ok(st.lastNote.box,key+': final note exists')
  assert.ok(st.action.box,key+': action bar exists')
  assert.ok(st.lastNote.box.top>=0,key+': final note reaches viewport')
  assert.ok(st.lastNote.box.bottom<=st.action.box.top-4,key+': final note is clear of action bar')
  if(mobile){
    assert.ok(st.shell.scrollTop>0,key+': research shell is mobile scroll owner')
    assert.ok(st.shell.scrollHeight>st.shell.clientHeight,key+': mobile shell scrolls')
  }else{
    assert.ok(st.scroll.scrollTop>0,key+': filter body is desktop scroll owner')
    assert.ok(st.scroll.scrollHeight>st.scroll.clientHeight,key+': desktop body scrolls')
  }
  return st
}

async function assertEightPreserved(page,key){
  for(const label of ['건식','임신·수유·키튼','실내묘','중성화묘','체중 관리','피부·피모','생선','Grain-Free 표기']){
    const button=page.getByRole('button',{name:label,exact:true})
    assert.equal(await button.getAttribute('aria-pressed'),'true',key+': '+label+' preserved')
  }
  assert.match(await page.locator('.condition-draft-count').textContent(),/8개/,key+': eight-count preserved')
}

async function stressSelectionDisclosure(page,key,alreadySelected=false){
  if(!alreadySelected) await selectEight(page)
  await clickChoice(page,'피부·피모',false)
  await setDisclosure(page,false)
  let st=await editorState(page)
  assert.equal(st.draftCount,'선택한 조건 7개',key+': deselection updates total count')
  assert.ok(st.disclosure.summary,key+': collapsed summary shown')
  assert.doesNotMatch(st.disclosure.summary.text,/피부·피모/,key+': deselected label absent from summary')
  assert.match(st.disclosure.summary.text,/실내묘/,key+': collapsed summary keeps selected names')
  assert.match(st.disclosure.summary.text,/Grain-Free 표기/,key+': collapsed summary keeps long selected name')

  await setDisclosure(page,true)
  assert.equal(await page.getByRole('button',{name:'피부·피모',exact:true}).getAttribute('aria-pressed'),'false',key+': deselection survives reopen')
  st=await editorState(page)
  assert.equal(st.disclosure.summary,null,key+': expanded state hides duplicate selected-name summary')

  await clickChoice(page,'피부·피모',true)
  await setDisclosure(page,false)
  st=await editorState(page)
  assert.match(st.disclosure.summary.text,/피부·피모/,key+': reselected label returns to collapsed summary')
  assert.match(st.disclosure.summary.text,/Grain-Free 표기/,key+': long label still visible in summary')
  await setDisclosure(page,true)
  await assertEightPreserved(page,key)
  return st
}

async function assertEditorBasics(page,key,mobile){
  const st=await editorState(page)
  assert.equal(st.resultsExists,false,key+': empty result waiting pane is not rendered')
  assert.equal(st.horizontalOverflow,0,key+': no horizontal overflow')
  assert.ok(st.choices.every(x=>x.box&&x.box.height>=44),key+': all choice buttons >=44px')
  assert.ok(st.action.reset.box&&st.action.reset.box.height>=(mobile?48:46),key+': reset action target size')
  assert.ok(st.action.apply.box&&st.action.apply.box.height>=(mobile?48:46),key+': apply action target size')
  if(mobile){
    assert.equal(st.action.style.position,'fixed',key+': mobile action bar fixed')
    assert.equal(st.shell.style.overflowY,'auto',key+': mobile shell owns scrolling')
  }else{
    assert.notEqual(st.action.style.position,'fixed',key+': desktop actions stay in editor grid')
    assert.equal(st.scroll.style.overflowY,'auto',key+': desktop condition body owns scrolling')
  }
  return st
}

async function resetApplyReedit(page,key){
  await page.getByRole('button',{name:'초기화',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.condition-draft-count')?.textContent?.includes('0개')===true)
  for(const button of await page.locator('.research-filter-scroll .choice[aria-pressed="true"]').all()) {
    throw new Error(key+': reset left selected choice '+await button.textContent())
  }

  await page.getByRole('button',{name:'이 조건으로 찾기',exact:true}).click()
  await page.locator('.research-results').waitFor({state:'visible',timeout:10000})
  assert.equal(await page.locator('.condition-actions').count(),0,key+': actions leave after apply')
  assert.ok(await page.locator('.research-result-card').count()>0,key+': results restore after apply')

  await page.getByRole('button',{name:'조건 수정',exact:true}).click()
  await page.locator('.condition-actions').waitFor({state:'visible',timeout:10000})
  assert.equal(await page.locator('.research-results').count(),0,key+': result pane leaves while re-editing')
  assert.match(await page.locator('.condition-draft-count').textContent(),/0개/,key+': reset state survives result round trip')
  assert.equal(await page.locator('.mobile-additional-toggle').getAttribute('aria-expanded'),'false',key+': no-additional re-edit starts collapsed')
}

async function resultsLayoutRoundTrip(page,key){
  await page.getByRole('button',{name:'이 조건으로 찾기',exact:true}).click()
  await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:10000})
  await page.locator('.research-result-card').first().click()
  await page.locator('.research-quick-view').waitFor({state:'visible',timeout:10000})
  const split=await page.evaluate(()=>{
    const results=document.querySelector('.research-results')?.getBoundingClientRect()
    const quick=document.querySelector('.research-quick-view')?.getBoundingClientRect()
    return results&&quick?{results:results.width,quick:quick.width,share:results.width/(results.width+quick.width)}:null
  })
  assert.ok(split,key+': result/quick panes restored')
  assert.ok(split.share>=0.485&&split.share<=0.495,key+': existing 49:51 result/quick split restored')
  await page.screenshot({path:OUT+'/'+key+'-results-quick.png',fullPage:false})
  await page.getByRole('button',{name:'닫기 ×',exact:true}).click()
  await page.getByRole('button',{name:'조건 수정',exact:true}).click()
  await page.locator('.condition-actions').waitFor({state:'visible',timeout:10000})
  await assertEightPreserved(page,key+' re-edit')
  return split
}

async function mobile390(){
  const key='mobile-390x844'
  const {page,context}=await newPage(390,844)
  await enterExplore(page)
  let st=await assertEditorBasics(page,key,true)
  assert.equal(st.draftCount,'선택한 조건 0개',key+': starts with no selection')
  assert.equal(st.disclosure.expanded,'false',key+': no-selection additional conditions start collapsed')
  assert.equal(st.disclosure.summary,null,key+': no-selection has no redundant summary')
  await page.screenshot({path:OUT+'/'+key+'-no-selection.png',fullPage:false})

  await setDisclosure(page,true)
  st=await editorState(page)
  assert.equal(st.disclosure.summary,null,key+': expanded empty disclosure has no summary')

  const selection=await stressSelectionDisclosure(page,key)
  await page.screenshot({path:OUT+'/'+key+'-eight-expanded.png',fullPage:false})
  await setDisclosure(page,false)
  await page.screenshot({path:OUT+'/'+key+'-eight-collapsed.png',fullPage:false})
  await setDisclosure(page,true)

  const focus=await tabRoundTrip(page,key)
  const scrolled=await normalScrollToEnd(page,key,true)
  await page.screenshot({path:OUT+'/'+key+'-end.png',fullPage:false})

  await resetApplyReedit(page,key)
  await page.screenshot({path:OUT+'/'+key+'-reedit-reset.png',fullPage:false})

  report.scenarios[key]={initial:st,selection,focus,scrolled,reedit:await editorState(page)}
  await context.close()
}

async function desktop(width,height,key,fullFlow){
  const {page,context}=await newPage(width,height)
  await enterExplore(page)
  let st=await assertEditorBasics(page,key,false)
  assert.equal(st.draftCount,'선택한 조건 0개',key+': starts no-selection')
  assert.equal(st.disclosure.expanded,'false',key+': no-selection starts collapsed')
  assert.ok(st.action.box&&st.action.box.bottom<=height,key+': action bar fully visible')
  assert.ok(st.filter&&st.filter.bottom<=height,key+': editor fully fits viewport')
  if(height===900) await page.screenshot({path:OUT+'/'+key+'-no-selection.png',fullPage:false})

  await setDisclosure(page,true)
  await selectEight(page)
  st=await assertEditorBasics(page,key,false)
  await page.screenshot({path:OUT+'/'+key+'-eight-expanded.png',fullPage:false})

  const focus=await tabRoundTrip(page,key)
  const scrolled=await normalScrollToEnd(page,key,false)
  await page.screenshot({path:OUT+'/'+key+'-end.png',fullPage:false})

  let split=null
  let selection=null
  if(fullFlow){
    selection=await stressSelectionDisclosure(page,key,true)
    await setDisclosure(page,true)
    split=await resultsLayoutRoundTrip(page,key)
    await page.getByRole('button',{name:'초기화',exact:true}).click()
    await resetApplyReedit(page,key)
  }

  report.scenarios[key]={initial:st,selection,focus,scrolled,split,final:await editorState(page)}
  await context.close()
}

async function breakpoint(width){
  const key='width-'+width
  const {page,context}=await newPage(width,844)
  await enterExplore(page)
  const st=await assertEditorBasics(page,key,width<=760)
  report.breakpoints[key]=st
  await context.close()
}

await mobile390()
await desktop(1440,900,'desktop-1440x900',true)
await desktop(1440,700,'desktop-1440x700',false)
await breakpoint(760)
await breakpoint(761)

assert.ok(report.blockedWrites.every(x=>!['GET','HEAD','OPTIONS'].includes(x.method)), 'only write-like methods were blocked')
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('EXPLORE_CONDITION_CANDIDATE='+JSON.stringify({
  candidateSha:report.candidateSha,
  mobileScrollOwner:report.scenarios['mobile-390x844'].scrolled.shell.scrollTop,
  desktop900ScrollOwner:report.scenarios['desktop-1440x900'].scrolled.scroll.scrollTop,
  desktop700ScrollOwner:report.scenarios['desktop-1440x700'].scrolled.scroll.scrollTop,
  split:report.scenarios['desktop-1440x900'].split,
  breakpoint760:report.breakpoints['width-760'].action.style.position,
  breakpoint761:report.breakpoints['width-761'].action.style.position,
  blockedWrites:report.blockedWrites.length,
  blockedAnalytics:report.blockedAnalytics.length,
}))
await browser.close()
