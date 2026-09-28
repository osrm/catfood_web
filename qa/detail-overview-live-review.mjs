import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'explore-grid-live-output'
const views=[[1440,900],[390,844]]
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,blocked:[],views:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function guard(page){
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method()
    if(!['GET','HEAD','OPTIONS'].includes(method)||/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)){
      report.blocked.push({method,url:url.href})
      return route.abort('blockedbyclient')
    }
    await route.continue()
  })
}
const rect=loc=>loc.evaluate(el=>{const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})
for(const [width,height] of views){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await guard(page)
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})
  await page.getByRole('button',{name:/조건 고르기/}).click()
  const scroll=page.locator('.research-filter-scroll')
  const note=scroll.locator('.condition-policy-note')
  const sections=scroll.locator(':scope > .filter-section')
  const feed=sections.nth(0), age=sections.nth(1)
  await note.waitFor()
  await feed.locator('.filter-heading').waitFor()
  await age.locator('.filter-heading').waitFor()

  const nr=await rect(note), fr=await rect(feed), ar=await rect(age)
  const fh=await rect(feed.locator('.filter-heading')), ah=await rect(age.locator('.filter-heading'))
  const action=page.locator('.condition-actions')
  const actionPos=await action.evaluate(el=>getComputedStyle(el).position)
  const grid=await scroll.evaluate(el=>getComputedStyle(el).gridTemplateColumns)
  const toggle=page.locator('.mobile-additional-toggle')
  const toggleGrid=await toggle.evaluate(el=>getComputedStyle(el).gridTemplateColumns)
  const chevron=toggle.locator('.mobile-additional-chevron')
  const tr=await rect(toggle), cr=await rect(chevron)

  assert.ok(nr.bottom<=Math.min(fr.top,ar.top)+1,'policy note must be its own row above both basic sections')
  if(width===1440){
    assert.ok(Math.abs(fh.top-ah.top)<=1, 'basic condition heading tops must align on desktop')
    assert.ok(Math.abs(fr.top-ar.top)<=1, 'basic condition sections must share one desktop row')
    assert.ok(nr.left<=fr.left+1 && nr.right>=ar.right-1, 'policy note must span both desktop columns')
    assert.equal(grid.split(/\s+/).length,2)
    assert.equal(toggleGrid.split(/\s+/).length,3)
    assert.ok(cr.right<=tr.right+1 && cr.right>tr.left+tr.width*0.8,'chevron must remain at the right edge')
    assert.notEqual(actionPos,'fixed')
  } else {
    assert.ok(ar.top>fr.bottom-1,'mobile basic conditions must remain stacked')
    assert.equal(grid.split(/\s+/).length,1)
    assert.equal(actionPos,'fixed','mobile condition action remains fixed')
  }

  const file='explore-'+width+'x'+height+'.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.views[String(width)]={file,note:nr,feed:fr,age:ar,feedHeading:fh,ageHeading:ah,grid,toggleGrid,chevron:cr,toggle:tr,actionPosition:actionPos}
  await context.close()
}
assert.equal(report.blocked.length,0)
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
