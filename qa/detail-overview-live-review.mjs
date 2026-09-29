import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.BASE_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'results-language-review'
await mkdir(OUT,{recursive:true})
const report={sourceSha:process.env.SOURCE_SHA,blocked:[],screens:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function pageAt(width,height){
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
async function loadedImages(page){
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth}).every(i=>i.complete&&i.naturalWidth>0),null,{timeout:15000})
}
async function searchLookup(page){
  await page.goto(BASE+'?view=workspace&mode=lookup',{waitUntil:'domcontentloaded'})
  await page.waitForFunction(()=>/\d+\s+PRODUCTS/.test(document.body.textContent||''),null,{timeout:90000})
  const input=page.locator('.lookup-input')
  await input.fill('GO! SOLUTIONS')
  await input.press('Enter')
  await page.locator('.research-result-card').first().waitFor({timeout:90000})
}
async function openExplore(page){
  await page.goto(BASE+'?view=workspace&mode=explore',{waitUntil:'domcontentloaded'})
  await page.waitForFunction(()=>/\d+\s+PRODUCTS/.test(document.body.textContent||''),null,{timeout:90000})
  const conditionButton=page.getByRole('button',{name:'조건 수정'})
  if(await conditionButton.count()) await conditionButton.first().click()
  else if(await page.getByRole('button',{name:/조건 고르기/}).count()) await page.getByRole('button',{name:/조건 고르기/}).click()
  const scroll=page.locator('.research-filter-scroll')
  await scroll.getByRole('button',{name:'건식',exact:true}).click()
  await scroll.getByRole('button',{name:'실내묘',exact:true}).click()
  await page.getByRole('button',{name:'이 조건으로 찾기'}).click()
  await page.locator('.research-result-card').first().waitFor({timeout:90000})
}
for(const [width,height] of [[390,844],[1440,900]]){
  {
    const {context,page}=await pageAt(width,height)
    await searchLookup(page)
    await loadedImages(page)
    if(width===1440){
      await page.locator('.research-result-card').first().click()
      await page.locator('.research-quick-view').waitFor()
      await loadedImages(page)
    }
    const file='lookup-'+width+'x'+height+'.png'
    await page.screenshot({path:OUT+'/'+file,fullPage:false})
    report.screens['lookup-'+width]={file,text:(await page.locator('.research-results-list').innerText()).slice(0,3000),quick:await page.locator('.research-quick-view').count()?await page.locator('.research-quick-view').innerText():null}
    await context.close()
  }
  {
    const {context,page}=await pageAt(width,height)
    await openExplore(page)
    let unknown=page.locator('.research-result-card').filter({has:page.locator('.relation-line.is-unknown')}).first()
    if(await unknown.count()===0) unknown=page.locator('.research-result-card').first()
    await unknown.scrollIntoViewIfNeeded()
    await loadedImages(page)
    if(width===1440){
      await unknown.click()
      await page.locator('.research-quick-view').waitFor()
      await loadedImages(page)
    }
    const file='explore-'+width+'x'+height+'.png'
    await page.screenshot({path:OUT+'/'+file,fullPage:false})
    report.screens['explore-'+width]={file,selectedRow:await unknown.innerText(),quick:await page.locator('.research-quick-view').count()?await page.locator('.research-quick-view').innerText():null}
    await context.close()
  }
}
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
