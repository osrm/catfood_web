import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.BASE_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'consumer-language-postdeploy'
await mkdir(OUT,{recursive:true})
const report={pages:true,deploySha:process.env.DEPLOY_SHA,blocked:[],home:{},explore:{}}
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
const rect=loc=>loc.evaluate(el=>{const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})

// HOME 390x844
{
  const {context,page}=await guardedPage(390,844)
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})
  const trigger=page.getByRole('button',{name:/정보 읽는 기준 보기/})
  const panel=page.locator('#home-info-panel')
  const heading=page.locator('#home-info-title')
  assert.equal(await trigger.getAttribute('aria-expanded'),'false')
  assert.equal(await panel.isHidden(),true)

  await trigger.click()
  await heading.waitFor({state:'visible'})
  assert.equal(await trigger.getAttribute('aria-expanded'),'true')
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'home-info-title')

  await page.keyboard.press('Tab')
  const close=page.getByRole('button',{name:'정보 안내 닫기'})
  assert.equal(await close.evaluate(el=>el===document.activeElement),true)
  await page.keyboard.press('Enter')
  assert.equal(await panel.isHidden(),true)
  await page.waitForFunction(()=>document.activeElement?.textContent?.includes('정보 읽는 기준 보기'))
  assert.equal(await trigger.evaluate(el=>el===document.activeElement),true)

  const file='home-390x844.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.home={file,hiddenInitially:true,headingFocusedAfterOpen:true,tabToClose:true,enterClosed:true,focusReturned:true}
  await context.close()
}

// EXPLORE 1440x900
{
  const {context,page}=await guardedPage(1440,900)
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})
  await page.getByRole('button',{name:/조건 고르기/}).click()

  const scroll=page.locator('.research-filter-scroll')
  const note=scroll.locator('.condition-policy-note')
  const sections=scroll.locator(':scope > .filter-section')
  const feed=sections.nth(0),age=sections.nth(1)
  await note.waitFor()
  await feed.locator('.filter-heading').waitFor()
  await age.locator('.filter-heading').waitFor()

  const nr=await rect(note), fr=await rect(feed), ar=await rect(age)
  const fh=await rect(feed.locator('.filter-heading')), ah=await rect(age.locator('.filter-heading'))
  assert.ok(nr.bottom<=Math.min(fr.top,ar.top)+1,'policy note must be above both conditions')
  assert.ok(nr.left<=fr.left+1 && nr.right>=ar.right-1,'policy note must span both columns')
  assert.ok(Math.abs(fr.top-ar.top)<=1,'basic sections must share one row')
  assert.ok(Math.abs(fh.top-ah.top)<=1,'basic headings must share one row')

  const toggle=page.locator('.mobile-additional-toggle')
  const chevron=toggle.locator('.mobile-additional-chevron')
  const tr=await rect(toggle), cr=await rect(chevron)
  const toggleGrid=await toggle.evaluate(el=>getComputedStyle(el).gridTemplateColumns)
  assert.equal(toggleGrid.split(/\s+/).length,3)
  assert.ok(cr.right<=tr.right+1 && cr.right>tr.left+tr.width*0.8,'chevron must remain at the right edge')

  await page.getByRole('button',{name:'이 조건으로 찾기'}).click()
  const edit=page.getByRole('button',{name:'조건 수정'}).first()
  await edit.waitFor({timeout:90000})
  await edit.click()
  await note.waitFor()
  assert.ok(await note.isVisible())

  const file='explore-1440x900.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.explore={file,note:nr,feed:fr,age:ar,feedHeading:fh,ageHeading:ah,toggle:tr,chevron:cr,toggleGrid,applyEditReturned:true}
  await context.close()
}

assert.equal(report.blocked.length,0)
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
