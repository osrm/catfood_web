import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'consumer-results-review'
await mkdir(OUT,{recursive:true})
const report={main:'109ee7bfccca32815ddab7eadd5e7d86da1b9bdb',blocked:[],screens:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function guardedPage(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method()
    if(!['GET','HEAD','OPTIONS'].includes(method)||/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)){
      report.blocked.push({method,url:url.href})
      return route.abort('blockedbyclient')
    }
    await route.continue()
  })
  return {context,page}
}

async function waitVisibleImages(page){
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(img=>{
    const r=img.getBoundingClientRect()
    return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth
  }).every(img=>img.complete&&img.naturalWidth>0),null,{timeout:30000})
}

async function waitCatalog(page){
  await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})
}

// LOOKUP mobile results
{
  const {context,page}=await guardedPage(390,844)
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog(page)
  const input=page.getByRole('searchbox',{name:'브랜드 또는 제품명 검색'})
  await input.fill('GO! SOLUTIONS')
  await page.getByRole('button',{name:'검색',exact:true}).click()
  const rows=page.locator('.research-result-card')
  await rows.first().waitFor({timeout:90000})
  await waitVisibleImages(page)
  const texts=await rows.evaluateAll(nodes=>nodes.slice(0,5).map(n=>n.innerText))
  assert.ok(texts.some(t=>/GO!|고!|Solutions/i.test(t)))
  const file='lookup-390x844-results.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.screens.lookupMobile={file,firstFive:texts}
  await context.close()
}

// LOOKUP desktop quick view
{
  const {context,page}=await guardedPage(1440,900)
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog(page)
  const input=page.getByRole('searchbox',{name:'브랜드 또는 제품명 검색'})
  await input.fill('GO! SOLUTIONS')
  await page.getByRole('button',{name:'검색',exact:true}).click()
  const rows=page.locator('.research-result-card')
  await rows.first().waitFor({timeout:90000})
  await rows.first().click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  await waitVisibleImages(page)
  const file='lookup-1440x900-quickview.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.screens.lookupDesktop={file,row:await rows.first().innerText(),quick:await quick.innerText()}
  await context.close()
}

async function enterExplore(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await waitCatalog(page)
  await page.getByRole('button',{name:/조건 고르기/}).click()
  await page.getByRole('button',{name:'건식',exact:true}).click()
  const indoor=page.getByRole('button',{name:'실내묘',exact:true})
  if(!(await indoor.isVisible())){
    const toggle=page.locator('.mobile-additional-toggle')
    if(await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
  }
  await indoor.click()
  await page.getByRole('button',{name:'이 조건으로 찾기',exact:true}).click()
  const rows=page.locator('.research-result-card')
  await rows.first().waitFor({timeout:90000})
  return rows
}

// EXPLORE mobile results, scroll an unknown relationship into view.
{
  const {context,page}=await guardedPage(390,844)
  const rows=await enterExplore(page)
  const unknown=rows.filter({has:page.locator('.relation-line.is-unknown')}).first()
  assert.ok(await unknown.count()>0,'expected an EXPLORE unknown relationship case')
  await unknown.scrollIntoViewIfNeeded()
  await waitVisibleImages(page)
  const file='explore-390x844-results.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.screens.exploreMobile={file,unknownRow:await unknown.innerText()}
  await context.close()
}

// EXPLORE desktop quick view for an unknown relationship case.
{
  const {context,page}=await guardedPage(1440,900)
  const rows=await enterExplore(page)
  const unknown=rows.filter({has:page.locator('.relation-line.is-unknown')}).first()
  assert.ok(await unknown.count()>0,'expected an EXPLORE unknown relationship case')
  await unknown.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  await waitVisibleImages(page)
  const file='explore-1440x900-quickview.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.screens.exploreDesktop={file,row:await unknown.innerText(),quick:await quick.innerText()}
  await context.close()
}

assert.equal(report.blocked.filter(x=>!['GET','HEAD','OPTIONS'].includes(x.method)).length>=0,true)
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
