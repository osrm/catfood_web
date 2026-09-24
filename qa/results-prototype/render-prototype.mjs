import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4174/results-prototype.html'
const OUT=process.env.OUT_DIR||'qa-output'
const SOURCE=process.env.SOURCE_DIR||'.'
await mkdir(OUT,{recursive:true})

const report={
  generatedAt:new Date().toISOString(),
  note:'Standalone UI prototype. Buttons are mock controls and are not evidence of CATFOOD app navigation behavior.',
  states:{},
  blockedAttempts:[],
  imageResponses:[],
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function makePage(width,height){
  const page=await browser.newPage({viewport:{width,height}})
  await page.route('**/*',async route=>{
    const req=route.request()
    const method=req.method()
    const url=req.url()
    if(!['GET','HEAD','OPTIONS'].includes(method)||/analytics|telemetry|event_log|functions\/v1/i.test(url)){
      report.blockedAttempts.push({method,url})
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  page.on('response',response=>{
    try{
      const u=new URL(response.url())
      if(u.host==='gnosbstdatkytsyxuapt.supabase.co' && u.pathname.includes('/storage/v1/object/public/product-images/')){
        report.imageResponses.push({path:u.pathname,status:response.status()})
      }
    }catch{}
  })
  return page
}

async function settle(page){
  await page.locator('.result-row').first().waitFor({state:'visible',timeout:20000})
  await page.evaluate(async()=>{
    await document.fonts?.ready
    const images=[...document.querySelectorAll('img')]
    await Promise.all(images.filter(img=>{
      const r=img.getBoundingClientRect()
      return r.bottom>0&&r.top<innerHeight
    }).map(img=>img.decode?.().catch(()=>undefined)))
  })
}

async function measure(page){
  return page.evaluate(()=>{
    const rect=selector=>{
      const el=document.querySelector(selector)
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}
    }
    const rows=[...document.querySelectorAll('.result-row')].map(row=>{
      const name=row.querySelector('h2')
      const brand=row.querySelector('.row-brand')
      const action=row.querySelector('.row-action')
      const relations=[...row.querySelectorAll('.relation')].map(rel=>({
        kind:rel.classList.contains('confirmed')?'confirmed':'unknown',
        text:rel.textContent?.replace(/\s+/g,' ').trim()||'',
        labelFont:getComputedStyle(rel.querySelector('span')).fontSize,
        valueFont:getComputedStyle(rel.querySelector('strong')).fontSize,
      }))
      const rr=row.getBoundingClientRect()
      const ar=action?.getBoundingClientRect()
      return {
        selected:row.classList.contains('is-selected'),
        brand:brand?.textContent?.trim()||'',
        name:name?.textContent?.trim()||'',
        nameFont:name?getComputedStyle(name).fontSize:null,
        nameLineHeight:name?getComputedStyle(name).lineHeight:null,
        nameOverflow:name?getComputedStyle(name).overflow:null,
        nameScrollWidth:name?.scrollWidth||0,
        nameClientWidth:name?.clientWidth||0,
        nameScrollHeight:name?.scrollHeight||0,
        nameClientHeight:name?.clientHeight||0,
        row:{width:rr.width,height:rr.height},
        action:ar?{width:ar.width,height:ar.height,fontSize:getComputedStyle(action).fontSize}:null,
        relations,
      }
    })
    const q=document.querySelector('.quick-view')
    const results=document.querySelector('.results-panel')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      documentWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth,
      results:rect('.results-panel'),
      quickView:rect('.quick-view'),
      rows,
      resultsTitleFont:getComputedStyle(document.querySelector('.results-heading strong')).fontSize,
      resultContextFont:document.querySelector('#resultContext:not([hidden])')?getComputedStyle(document.querySelector('#resultContext')).fontSize:null,
      quickWidth:q instanceof HTMLElement?q.getBoundingClientRect().width:null,
      resultsWidth:results instanceof HTMLElement?results.getBoundingClientRect().width:null,
    }
  })
}

async function focusEvidence(page){
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()})
  const sequence=[]
  for(let i=0;i<40;i+=1){
    await page.keyboard.press('Tab')
    const state=await page.evaluate(()=>{
      const el=document.activeElement
      return {
        tag:el?.tagName||'',
        className:el instanceof HTMLElement?el.className:'',
        text:el?.textContent?.replace(/\s+/g,' ').trim().slice(0,80)||'',
      }
    })
    sequence.push(state)
    if(state.className.includes('row-action')){
      const style=await page.evaluate(()=>{
        const el=document.activeElement
        const cs=getComputedStyle(el)
        return {outline:cs.outline,outlineOffset:cs.outlineOffset}
      })
      return {sequence,style}
    }
  }
  return {sequence,style:null}
}

async function capture(key,query,width,height,file){
  const page=await makePage(width,height)
  await page.goto(BASE+query,{waitUntil:'domcontentloaded',timeout:20000})
  await settle(page)
  const metrics=await measure(page)
  const focus=await focusEvidence(page)
  assert.equal(metrics.documentWidth,width,key+': no horizontal document overflow')
  assert.equal(metrics.bodyWidth,width,key+': no horizontal body overflow')
  assert.ok(metrics.rows.every(r=>r.nameScrollWidth<=r.nameClientWidth+2),key+': names do not overflow horizontally')
  assert.ok(metrics.rows.every(r=>r.action?.height>=44),key+': row actions are at least 44px high')
  assert.ok(metrics.rows.every(r=>r.nameFont==='16px'),key+': product names are 16px')
  const relationRows=metrics.rows.flatMap(r=>r.relations)
  if(relationRows.length){
    assert.ok(relationRows.every(r=>r.valueFont==='13px'&&r.labelFont==='12px'),key+': relation typography is readable')
  }
  assert.ok(focus.style&&focus.style.outline.includes('2px'),key+': visible keyboard focus exists on quick-view action')
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()})
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.states[key]={query,width,height,metrics,focus,file}
  await page.close()
}

await capture('lookupMobile','?mode=lookup',390,844,'prototype-lookup-mobile-390x844-browse.png')
await capture('lookupDesktop','?mode=lookup&selected=1',1440,900,'prototype-lookup-desktop-1440x900-selected.png')
await capture('exploreMobile','?mode=explore',390,844,'prototype-explore-mobile-390x844-browse.png')
await capture('exploreDesktop','?mode=explore&selected=1',1440,900,'prototype-explore-desktop-1440x900-selected.png')

const longExplore=report.states.exploreMobile.metrics.rows[0]
assert.ok(longExplore.name.length>20,'long product name case is present')
assert.ok(longExplore.nameScrollHeight>=longExplore.nameClientHeight,'long product name remains fully laid out')
const unknown=report.states.exploreDesktop.metrics.rows.find(r=>r.relations.some(x=>x.kind==='unknown'))
assert.ok(unknown,'selected EXPLORE desktop contains an explicit unknown relation')
assert.match(unknown.relations.find(x=>x.kind==='unknown').text,/미확인.*제품 표기 대상.*실내묘/,'unknown wording preserved')
assert.ok(report.states.lookupDesktop.metrics.resultsWidth>540,'desktop result list receives more room than current selected state')
assert.ok(report.states.lookupDesktop.metrics.quickWidth>600,'quick view remains a substantial decision panel')

await copyFile(SOURCE+'/results-prototype.html',OUT+'/results-prototype.html')
await copyFile(SOURCE+'/results-prototype.css',OUT+'/results-prototype.css')
await writeFile(OUT+'/prototype-measurements.json',JSON.stringify(report,null,2))
console.log('RESULTS_PROTOTYPE='+JSON.stringify(report))

await browser.close()
