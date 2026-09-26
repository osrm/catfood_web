import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'postdeploy-output'
await mkdir(OUT,{recursive:true})

const report={
  deployedMergeSha:'f69e1c64b37d68f99365a12eeae74e4627148271',
  generatedAt:new Date().toISOString(),
  blockedWrites:[],
  blockedAnalytics:[],
  scenarios:{},
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function makePage(width,height){
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

async function enterExplore(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'조건 고르기 →'}).waitFor({state:'visible',timeout:30000})
  await page.waitForFunction(
    () => document.querySelector('.research-status')?.textContent?.includes('데이터 연결됨') === true,
    undefined,
    {timeout:30000},
  )
  await page.getByRole('button',{name:'조건 고르기 →'}).click()
  await page.locator('.condition-actions').waitFor({state:'visible',timeout:10000})
  await page.evaluate(async()=>{await document.fonts?.ready})
}

async function centerHit(page,selector){
  return page.locator(selector).evaluate(el=>{
    const r=el.getBoundingClientRect()
    const x=r.left+r.width/2,y=r.top+r.height/2
    const hit=document.elementFromPoint(x,y)
    return {
      rect:{top:r.top,left:r.left,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
      center:{x,y},
      hitText:hit?.textContent?.replace(/\s+/g,' ').trim()||null,
      hitsSelf:hit===el||Boolean(hit?.closest(selector)===el),
    }
  })
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
      outline:s.outline,
      outlineWidth:s.outlineWidth,
      outlineOffset:s.outlineOffset,
      box:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},
      focusBox:{top:r.top-extent,bottom:r.bottom+extent,left:r.left-extent,right:r.right+extent},
    }
  })
}

async function mobile(){
  const key='mobile-390x844'
  const {page,context}=await makePage(390,844)
  await enterExplore(page)

  const basics=await page.evaluate(()=>{
    const rect=sel=>{const el=document.querySelector(sel);if(!(el instanceof HTMLElement))return null;const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    return {
      reset:rect('.condition-actions .secondary-action'),
      apply:rect('.condition-actions .primary-action'),
      toggleText:document.querySelector('.mobile-additional-toggle')?.textContent?.replace(/\s+/g,' ').trim()||'',
      resultsCount:document.querySelectorAll('.research-results').length,
    }
  })
  assert.ok(basics.reset&&basics.apply,'mobile actions visible')
  assert.equal(basics.resultsCount,0,'editing keeps results pane absent')

  await page.locator('.mobile-additional-toggle').click()
  await page.getByRole('button',{name:'실내묘',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('button[aria-pressed="true"]')?.textContent?.includes('실내묘')===true)
  await page.locator('.mobile-additional-toggle').click()
  const collapsed=await page.evaluate(()=>({
    expanded:document.querySelector('.mobile-additional-toggle')?.getAttribute('aria-expanded'),
    summary:document.querySelector('.mobile-additional-summary')?.textContent?.replace(/\s+/g,' ').trim()||null,
  }))
  assert.equal(collapsed.expanded,'false','additional conditions collapse')
  assert.match(collapsed.summary||'',/실내묘/,'collapsed summary keeps selection')

  await page.locator('.mobile-additional-toggle').click()
  assert.equal(await page.getByRole('button',{name:'실내묘',exact:true}).getAttribute('aria-pressed'),'true','reopening preserves selected value')
  assert.equal(await page.locator('.mobile-additional-summary').count(),0,'expanded state hides duplicate summary')

  await page.locator('.research-shell').evaluate(el=>{el.scrollTop=0})
  await page.locator('body').click({position:{x:2,y:2}})
  if(await page.evaluate(()=>document.activeElement instanceof HTMLElement)) await page.evaluate(()=>document.activeElement?.blur())
  let grainFocus=null
  for(let i=0;i<40;i++){
    await page.keyboard.press('Tab')
    const focus=await activeFocus(page)
    if(focus?.text==='Grain-Free 표기'){grainFocus=focus;break}
  }
  assert.ok(grainFocus,'Tab reaches Grain-Free')
  const actionTop=await page.locator('.condition-actions').evaluate(el=>el.getBoundingClientRect().top)
  assert.ok(parseFloat(grainFocus.outlineWidth)>=2,'Grain-Free focus ring visible')
  assert.ok(grainFocus.focusBox.bottom<=actionTop-1,'bottom condition focus stays above fixed actions')

  await page.getByRole('button',{name:'건식',exact:true}).click()
  const applyHitBefore=await centerHit(page,'.condition-actions .primary-action')
  assert.equal(applyHitBefore.hitsSelf,true,'apply center hit-test reaches apply before first apply')
  await page.locator('.condition-actions .primary-action').click()
  await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:30000})

  await page.locator('.research-result-card').first().click()
  await page.locator('.research-quick-view').waitFor({state:'visible'})
  await page.locator('.quick-view-actions .switch-compare-action').first().click()
  await page.locator('.switch-compare-dock').waitFor({state:'visible'})
  const compareBefore=new URL(page.url()).searchParams.get('compare')
  assert.ok(compareBefore,'compare ID stored before re-edit')
  const dockBefore=await page.locator('.switch-compare-dock').evaluate(el=>{const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,text:el.textContent?.replace(/\s+/g,' ').trim()}})
  assert.match(dockBefore.text||'',/비교 1\/5/,'result dock works normally')

  await page.getByRole('button',{name:'닫기 ×',exact:true}).click()
  await page.locator('.criteria-bar > button').click()
  await page.locator('.condition-actions').waitFor({state:'visible'})
  assert.equal(await page.locator('.switch-compare-dock').count(),0,'compare dock absent during re-edit')
  assert.equal(await page.getByRole('button',{name:'비교 보기 →',exact:true}).count(),0,'dock action absent from DOM/focus targets')
  const compareDuring=new URL(page.url()).searchParams.get('compare')
  assert.equal(compareDuring,compareBefore,'compare ID preserved when re-edit begins')

  const applyHit=await centerHit(page,'.condition-actions .primary-action')
  assert.equal(applyHit.hitsSelf,true,'re-edit apply center hit-test reaches apply')
  await page.screenshot({path:OUT+'/'+key+'-reedit.png',fullPage:false})

  await page.locator('.condition-actions .primary-action').click()
  await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:30000})
  assert.equal(new URL(page.url()).searchParams.get('compare'),null,'apply retains existing compare reset policy')
  assert.equal(await page.locator('.switch-compare-dock').count(),0,'compare dock cleared after apply')

  report.scenarios[key]={basics,collapsed,grainFocus,actionTop,applyHitBefore,dockBefore,compareBefore,compareDuring,applyHit}
  await context.close()
}

async function desktop(){
  const key='desktop-1440x700'
  const {page,context}=await makePage(1440,700)
  await enterExplore(page)
  await page.locator('.mobile-additional-toggle').click()

  await page.locator('.research-filter-scroll').hover()
  await page.mouse.wheel(0,5000)
  await page.waitForFunction(()=>{
    const el=document.querySelector('.research-filter-scroll')
    return el instanceof HTMLElement&&el.scrollTop>0
  })
  const measured=await page.evaluate(()=>{
    const rect=sel=>{const el=document.querySelector(sel);if(!(el instanceof HTMLElement))return null;const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    const scroll=document.querySelector('.research-filter-scroll')
    const note=[...document.querySelectorAll('.field-note')].at(-1)
    return {
      scrollTop:scroll instanceof HTMLElement?scroll.scrollTop:null,
      scrollHeight:scroll instanceof HTMLElement?scroll.scrollHeight:null,
      clientHeight:scroll instanceof HTMLElement?scroll.clientHeight:null,
      reset:rect('.condition-actions .secondary-action'),
      apply:rect('.condition-actions .primary-action'),
      note:note instanceof HTMLElement?(()=>{const r=note.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})():null,
    }
  })
  assert.ok(measured.scrollTop>0,'desktop body is internally scrolled')
  assert.ok(measured.scrollHeight>measured.clientHeight,'desktop body has internal scroll range')
  assert.ok(measured.reset&&measured.reset.top>=0&&measured.reset.bottom<=700,'reset remains in viewport')
  assert.ok(measured.apply&&measured.apply.top>=0&&measured.apply.bottom<=700,'apply remains in viewport')
  assert.ok(measured.note&&measured.note.top>=0&&measured.note.bottom<=measured.apply.top-4,'last note reachable above action row')

  await page.screenshot({path:OUT+'/'+key+'-bottom.png',fullPage:false})
  report.scenarios[key]=measured
  await context.close()
}

await mobile()
await desktop()

assert.equal(report.blockedWrites.length,0,'deployed flow attempted no writes')
assert.equal(report.blockedAnalytics.length,0,'deployed flow attempted no analytics')
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('PR55_POSTDEPLOY='+JSON.stringify({
  mobile:report.scenarios['mobile-390x844'],
  desktop:report.scenarios['desktop-1440x700'],
  blockedWrites:report.blockedWrites.length,
  blockedAnalytics:report.blockedAnalytics.length,
}))
await browser.close()
