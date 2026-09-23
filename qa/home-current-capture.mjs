import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR || 'qa-output'
await mkdir(OUT,{recursive:true})

const report={generatedAt:new Date().toISOString(),blockedNonGet:[],blockedAnalytics:[],apiReads:[],views:{}}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function capture(width,height,key,file){
  const page=await browser.newPage({viewport:{width,height}})
  await page.route('**/*',async route=>{
    const req=route.request()
    const method=req.method()
    const url=req.url()
    let u=null
    try { u=new URL(url) } catch {}
    if(!['GET','HEAD','OPTIONS'].includes(method)){
      report.blockedNonGet.push({method,url:u ? u.origin+u.pathname : url})
      await route.abort('blockedbyclient')
      return
    }
    if(/\/functions\/v1\/|analytics|telemetry|event_log/i.test(url)){
      report.blockedAnalytics.push({method,url:u ? u.origin+u.pathname : url})
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  page.on('response',response=>{
    try{
      const u=new URL(response.url())
      if(u.host==='gnosbstdatkytsyxuapt.supabase.co' && u.pathname.startsWith('/rest/v1/')){
        report.apiReads.push({method:response.request().method(),path:u.pathname,status:response.status()})
      }
    }catch{}
  })
  await page.goto(BASE,{waitUntil:'networkidle',timeout:60000})
  await page.waitForFunction(() => !document.querySelector('.home-search-console')?.innerText.includes('—개'), null, { timeout: 30000 })
  await page.evaluate(()=>document.fonts?.ready)
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.views[key]=await page.evaluate(()=>({
    viewport:{width:innerWidth,height:innerHeight},
    documentWidth:document.documentElement.scrollWidth,
    bodyWidth:document.body.scrollWidth,
    scrollHeight:document.documentElement.scrollHeight,
    header:document.querySelector('.home-header')?.getBoundingClientRect().toJSON?.() ?? null,
    start:document.querySelector('.home-start')?.getBoundingClientRect().toJSON?.() ?? null,
    heroTitle:document.querySelector('.home-start-copy h1')?.textContent?.trim() || null,
    heroDescription:document.querySelector('.home-start-copy p')?.textContent?.replace(/\s+/g,' ').trim() || null,
    searchConsole:document.querySelector('.home-search-console')?.innerText.replace(/\s+/g,' ').trim() || null,
    paths:[...document.querySelectorAll('.home-start-path')].map(x=>x.innerText.replace(/\s+/g,' ').trim()),
    nav:[...document.querySelectorAll('.home-nav button')].map(x=>x.textContent?.trim()),
    visibleBottomText:document.elementFromPoint(Math.min(innerWidth-2,20),innerHeight-2)?.textContent?.trim() || null,
  }))
  assert.ok(report.views[key].documentWidth<=width,'no horizontal overflow on current HOME')
  await page.close()
}

await capture(390,844,'mobile390','current-home-390x844.png')
await capture(1440,900,'desktop1440','current-home-1440x900.png')

assert.equal(report.blockedNonGet.length,0,'current HOME attempted no writes')
assert.equal(report.blockedAnalytics.length,0,'current HOME attempted no analytics')
assert.ok(report.apiReads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method) && x.status>=200 && x.status<300),'all observed API reads are safe 2xx reads')

await writeFile(OUT+'/current-home-report.json',JSON.stringify(report,null,2))
console.log('CATFOOD_HOME_CURRENT='+JSON.stringify(report))
await browser.close()
