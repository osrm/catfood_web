import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'result-relation-candidate'
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,blocked:[],views:{}}
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
async function waitCatalog(page){await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})}
async function waitVisibleImages(page){
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(img=>{
    const r=img.getBoundingClientRect()
    return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth
  }).every(img=>img.complete&&img.naturalWidth>0),null,{timeout:30000})
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
const metrics=loc=>loc.evaluate(el=>{
  const r=el.getBoundingClientRect(),s=getComputedStyle(el)
  return {text:el.textContent?.trim(),left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,whiteSpace:s.whiteSpace,lineHeight:s.lineHeight,fontSize:s.fontSize}
})

// 390x844 result list with both confirmed and unknown relationship labels.
{
  const {context,page}=await guardedPage(390,844)
  const rows=await enterExplore(page)
  const unknown=rows.filter({has:page.locator('.relation-line.is-unknown')}).first()
  assert.ok(await unknown.count()>0)
  await unknown.scrollIntoViewIfNeeded()
  await waitVisibleImages(page)
  const labels=unknown.locator('.relation-line > span')
  const labelMetrics=[]
  for(let i=0;i<await labels.count();i++) labelMetrics.push(await metrics(labels.nth(i)))
  assert.ok(labelMetrics.some(x=>x.text==='확인된 조건'))
  assert.ok(labelMetrics.some(x=>x.text==='미확인 조건'))
  for(const x of labelMetrics){
    assert.ok(x.scrollWidth<=x.clientWidth+1, x.text+' must not be horizontally clipped')
  }
  const file='explore-390x844-results.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.views.mobile={file,row:await unknown.innerText(),labels:labelMetrics}
  await context.close()
}

// 1440x900 quick view for an unknown relationship case.
{
  const {context,page}=await guardedPage(1440,900)
  const rows=await enterExplore(page)
  const unknown=rows.filter({has:page.locator('.relation-line.is-unknown')}).first()
  assert.ok(await unknown.count()>0)
  await unknown.click()
  const quick=page.locator('.research-quick-view')
  await quick.waitFor({state:'visible'})
  await waitVisibleImages(page)
  const section=quick.locator('.quick-view-section').filter({hasText:'선택한 조건과 비교'}).first()
  const dts=section.locator('dt')
  assert.equal(await dts.nth(0).innerText(),'확인된 조건')
  assert.equal(await dts.nth(1).innerText(),'미확인 조건')
  const file='explore-1440x900-quickview.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.views.desktop={file,row:await unknown.innerText(),quick:await section.innerText(),labels:[await metrics(dts.nth(0)),await metrics(dts.nth(1))]}
  await context.close()
}

assert.equal(report.blocked.length,0)
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
