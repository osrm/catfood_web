import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'zero-dock-evidence-output'
await mkdir(OUT,{recursive:true})

const report={pagesUrl:BASE,blocked:[],reads:[],capture:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'})
const page=await context.newPage()

await page.route('**/*',async route=>{
  const req=route.request(), url=new URL(req.url()), method=req.method()
  const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
  const supabase=/\.supabase\.co$/i.test(url.hostname)
  const pages=url.origin===new URL(BASE).origin
  const google=/googleapis\.com$|gstatic\.com$/i.test(url.hostname)
  if(analytics || (supabase&&!['GET','HEAD','OPTIONS'].includes(method))){
    report.blocked.push({method,url:url.href,reason:analytics?'analytics':'write'})
    return route.abort('blockedbyclient')
  }
  if(supabase) report.reads.push({method,path:url.pathname})
  if(!pages&&!supabase&&!google) return route.abort('blockedbyclient')
  await route.continue()
})

await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
await page.waitForFunction(()=>/\d+\s*PRODUCTS/.test(document.querySelector('.research-status')?.textContent||''),null,{timeout:90000})
await page.locator('.switch-find-search input').fill('AATU')
const current=page.locator('.switch-find-result').filter({hasText:/AATU/}).filter({hasText:/연어/}).first()
await current.waitFor({state:'visible',timeout:30000})
await current.click()
await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
await sku.waitFor({state:'visible',timeout:30000})
await sku.click()
await page.locator('.switch-step-actions .switch-primary-action').click()
await page.locator('.switch-no-change').click()
await page.locator('.switch-step-actions .switch-primary-action').click()
await page.getByRole('button',{name:'후보 제품 보기 →'}).click()

const search=page.locator('input[aria-label="후보 제품 검색"]')
await search.waitFor({state:'visible',timeout:90000})
await search.fill('GO!')
const row=page.locator('.switch-candidate-row').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
await row.waitFor({state:'visible',timeout:30000})
await row.click()
const inspector=page.locator('.switch-candidate-inspector')
await inspector.waitFor({state:'visible',timeout:30000})
await inspector.locator('.switch-inspector-actions button').first().click()
await inspector.locator('.switch-preview-topline button').click()
await search.fill('__검색결과없음__')
await page.locator('.switch-candidate-list .switch-state-message').filter({hasText:'이름 검색 결과가 없습니다.'}).waitFor({state:'visible',timeout:30000})

const dock=page.locator('.switch-compare-dock')
assert.match((await dock.textContent())||'',/비교 1\/5/)
await dock.evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest'}))
await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))

report.capture=await page.evaluate(()=>{
  const dock=document.querySelector('.switch-compare-dock')
  const r=dock.getBoundingClientRect()
  return {
    viewport:{width:innerWidth,height:innerHeight},
    dock:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,inViewport:r.bottom>0&&r.top<innerHeight},
    text:dock.textContent.replace(/\s+/g,' ').trim(),
    scrollY:window.scrollY,
  }
})
assert.equal(report.capture.dock.inViewport,true)
assert.ok(report.capture.dock.top>=0&&report.capture.dock.bottom<=844)
await page.screenshot({path:OUT+'/zero-dock-centered-390x844.png',fullPage:false})
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(row=>['GET','HEAD','OPTIONS'].includes(row.method)))
assert.equal(report.blocked.filter(row=>row.reason==='write').length,0)
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await context.close()
await browser.close()
