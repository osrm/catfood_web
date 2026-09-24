import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4174/results-prototype.html'
const OUT=process.env.OUT_DIR||'qa-output'
const SOURCE=process.env.SOURCE_DIR||'.'
await mkdir(OUT,{recursive:true})

const report={
  generatedAt:new Date().toISOString(),
  note:'Standalone QA-only prototype. Mobile and desktop captures use the same selected product state per mode.',
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
      if(u.host==='gnosbstdatkytsyxuapt.supabase.co'&&u.pathname.includes('/storage/v1/object/public/product-images/')){
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
    const box=el=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}
    }
    const rows=[...document.querySelectorAll('.result-row')].map(row=>{
      const name=row.querySelector('h2')
      const identity=row.querySelector('.identity')
      const packages=row.querySelector('.packages')
      const action=row.querySelector('.row-action')
      const image=row.querySelector('.product-image')
      return {
        selected:row.classList.contains('is-selected'),
        brand:row.querySelector('.row-brand')?.textContent?.trim()||'',
        name:name?.textContent?.trim()||'',
        nameFont:name?getComputedStyle(name).fontSize:null,
        nameLineHeight:name?getComputedStyle(name).lineHeight:null,
        row:box(row),
        identity:box(identity),
        packages:box(packages),
        action:box(action),
        image:box(image),
        relations:[...row.querySelectorAll('.relation')].map(rel=>({
          kind:rel.classList.contains('unknown')?'unknown':'confirmed',
          text:rel.textContent?.replace(/\s+/g,' ').trim()||'',
          labelFont:getComputedStyle(rel.querySelector('span')).fontSize,
          valueFont:getComputedStyle(rel.querySelector('strong')).fontSize,
        })),
      }
    })
    const quick=document.querySelector('.quick-view')
    const quickName=document.querySelector('#quickName')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      documentWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth,
      results:box(document.querySelector('.results-panel')),
      quickView:box(quick),
      rows,
      quick:{
        name:quickName?.textContent||'',
        nameFont:quickName?getComputedStyle(quickName).fontSize:null,
        nameBox:box(quickName),
        actions:[...document.querySelectorAll('.quick-actions button')].map(button=>({text:button.textContent?.trim()||'',box:box(button)})),
        facts:[...document.querySelectorAll('#quickFacts dd')].map(dd=>({text:dd.textContent?.trim()||'',box:box(dd)})),
        unknown:document.querySelector('#quickUnknown')?.textContent||'',
      },
    }
  })
}

async function capture(key,query,width,height,file){
  const page=await makePage(width,height)
  await page.goto(BASE+query,{waitUntil:'domcontentloaded',timeout:20000})
  await settle(page)
  const metrics=await measure(page)
  assert.equal(metrics.documentWidth,width,key+': no horizontal document overflow')
  assert.equal(metrics.bodyWidth,width,key+': no horizontal body overflow')
  assert.ok(metrics.rows.every(row=>row.nameFont==='16px'),key+': product names remain 16px')
  assert.ok(metrics.rows.every(row=>row.action?.height>=44),key+': row actions remain at least 44px high')
  const relationRows=metrics.rows.flatMap(row=>row.relations)
  if(relationRows.length){
    assert.ok(relationRows.every(rel=>rel.labelFont==='12px'&&rel.valueFont==='13px'),key+': relation typography remains 12/13px')
  }
  if(width===390&&query.includes('mode=lookup')){
    assert.ok(metrics.rows.every(row=>row.identity?.width>=240),key+': lookup identity keeps at least 240px')
    assert.ok(metrics.rows.every(row=>row.packages?.height<20),key+': lookup package line is not squeezed into a second line')
  }
  if(width===390&&query.includes('mode=explore')){
    const selected=metrics.rows.find(row=>row.selected)
    assert.ok(selected&&selected.row.height<190,key+': selected explore row stays below 190px')
    assert.ok(selected.relations.some(rel=>rel.kind==='unknown'&&/미확인.*제품 표기 대상.*실내묘/.test(rel.text)),key+': unknown meaning is preserved')
  }
  if(width===1440){
    assert.ok(metrics.results.width>=620&&metrics.results.width<=630,key+': results panel is about 625px')
    assert.ok(metrics.quickView.width>=595&&metrics.quickView.width<=605,key+': quick view remains about 601px')
    assert.ok(metrics.quick.actions.every(action=>action.box?.height>=44),key+': quick-view actions remain 44px high')
    assert.ok(metrics.quick.facts.every(fact=>fact.box?.height<30),key+': selected package/fact values remain on one line')
    if(query.includes('mode=explore')) assert.ok(metrics.quick.nameBox?.height<50,key+': selected long quick-view name remains one line')
  }
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.states[key]={query,width,height,file,metrics}
  await page.close()
}

await capture('lookupMobile','?mode=lookup&selected=1',390,844,'prototype-lookup-mobile-390x844-selected.png')
await capture('lookupDesktop','?mode=lookup&selected=1',1440,900,'prototype-lookup-desktop-1440x900-selected.png')
await capture('exploreMobile','?mode=explore&selected=1',390,844,'prototype-explore-mobile-390x844-selected.png')
await capture('exploreDesktop','?mode=explore&selected=1',1440,900,'prototype-explore-desktop-1440x900-selected.png')

await copyFile(SOURCE+'/results-prototype.html',OUT+'/results-prototype.html')
await copyFile(SOURCE+'/results-prototype.css',OUT+'/results-prototype.css')
await writeFile(OUT+'/prototype-measurements.json',JSON.stringify(report,null,2))
console.log('RESULTS_PROTOTYPE='+JSON.stringify(report))
await browser.close()
