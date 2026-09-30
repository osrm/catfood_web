import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'ingredient-reading-help-review'
const PRODUCT_ID='product_a0e685be674c6617'
const SOURCE_NAMES=[
  'De-boned duck','duck meal','whole dried egg','peas','lentils','pea flour','tapioca','chickpeas',
  'chicken fat (preserved with mixed tocopherols)','flaxseed','natural flavour','salt','calcium carbonate',
  'dried chicory root','phosphoric acid','choline chloride','potassium chloride','vitamins','minerals','taurine','dried rosemary',
]
const DISPLAY_NAMES=[
  '뼈를 제거한 오리','duck meal','건조 전란','완두콩','렌틸콩','완두콩 가루','타피오카','병아리콩',
  '닭 지방(혼합 토코페롤로 보존)','아마씨','natural flavour','소금','탄산칼슘',
  '말린 치커리 뿌리','인산','염화콜린','염화칼륨','비타민','미네랄','타우린','말린 로즈마리',
]
const RAW_TEXT=SOURCE_NAMES.join(', ')
await mkdir(OUT,{recursive:true})
const report={candidateSha:process.env.PRODUCT_SHA,blocked:[],reads:[],measurements:{},keyboard:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'})
const page=await context.newPage()

await page.route('**/*',async route=>{
  const req=route.request(), url=new URL(req.url()), method=req.method()
  const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
  const supabase=/\.supabase\.co$/i.test(url.hostname)
  const local=url.origin===new URL(BASE).origin
  const google=/googleapis\.com$|gstatic\.com$/i.test(url.hostname)
  if(analytics || (supabase && !['GET','HEAD','OPTIONS'].includes(method))){
    report.blocked.push({method,url:url.href,reason:analytics?'analytics':'write'})
    return route.abort('blockedbyclient')
  }
  if(supabase) report.reads.push({method,path:url.pathname,query:url.search})
  if(!local && !supabase && !google) return route.abort('blockedbyclient')
  await route.continue()
})

const url=new URL(BASE)
url.searchParams.set('view','workspace')
url.searchParams.set('detail',PRODUCT_ID)
url.searchParams.set('detailTab','ingredients')
await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:30000})
await page.locator('.detail-stage').waitFor({state:'visible',timeout:90000})
await page.getByRole('heading',{name:/LID 오리/i}).waitFor({state:'visible',timeout:90000})
const list=page.locator('.detail-ingredient-list-compact')
await list.waitFor({state:'visible',timeout:90000})
await page.waitForFunction(()=>document.querySelectorAll('.detail-ingredient-list-compact span').length===21,null,{timeout:90000})

const displayed=await list.locator('span').allInnerTexts()
assert.deepEqual(displayed,DISPLAY_NAMES)
assert.equal(displayed.length,21)
assert.equal(displayed[1],'duck meal')
assert.equal(displayed[10],'natural flavour')
assert.equal(await page.locator('.detail-ingredient-reading-help').innerText(),'한국어 읽기 도움')
assert.doesNotMatch(await page.locator('body').innerText(),/검토용/)

const source=page.locator('.detail-source-disclosure').filter({has:page.getByText('원문 보기',{exact:true})}).first()
await source.waitFor({state:'visible'})
assert.equal(await source.getAttribute('open'),null)

const defaultFile='ingredient-reading-help-default-390x844.png'
await page.screenshot({path:OUT+'/'+defaultFile,fullPage:true})

const summary=source.locator('summary')
await summary.focus()
assert.equal(await summary.evaluate(el=>document.activeElement===el),true)
await page.keyboard.press('Enter')
await page.waitForFunction(()=>document.querySelector('.detail-source-disclosure')?.hasAttribute('open'))
report.keyboard.opened=true
assert.equal(await summary.evaluate(el=>document.activeElement===el),true)
const raw=source.locator('.detail-ingredient-copy')
assert.equal((await raw.innerText()).trim(),RAW_TEXT)

const openFile='ingredient-reading-help-raw-open-390x844.png'
await page.screenshot({path:OUT+'/'+openFile,fullPage:true})

const measurements=await page.evaluate(({displayNames})=>{
  const list=document.querySelector('.detail-ingredient-list-compact')
  const spans=[...list.querySelectorAll('span')]
  const doc=document.scrollingElement||document.documentElement
  const itemMetrics=spans.map((span,index)=>{
    const cs=getComputedStyle(span)
    const range=document.createRange()
    range.selectNodeContents(span)
    return {
      index,
      text:span.textContent,
      fontSize:cs.fontSize,
      lineHeight:cs.lineHeight,
      rectCount:range.getClientRects().length,
      clientWidth:span.clientWidth,
      scrollWidth:span.scrollWidth,
      clientHeight:span.clientHeight,
      scrollHeight:span.scrollHeight,
    }
  })
  const longIndex=displayNames.indexOf('닭 지방(혼합 토코페롤로 보존)')
  const raw=document.querySelector('.detail-source-disclosure[open] .detail-ingredient-copy')
  const summary=document.querySelector('.detail-source-disclosure summary')
  return {
    viewport:{width:innerWidth,height:innerHeight},
    document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
    list:{clientWidth:list.clientWidth,scrollWidth:list.scrollWidth,itemCount:spans.length},
    itemMetrics,
    longItem:itemMetrics[longIndex],
    shortItems:itemMetrics.filter((_,index)=>index!==longIndex),
    raw:{clientWidth:raw.clientWidth,scrollWidth:raw.scrollWidth,fontSize:getComputedStyle(raw).fontSize},
    summary:{fontSize:getComputedStyle(summary).fontSize},
  }
},{displayNames:DISPLAY_NAMES})
report.measurements=measurements
report.files={default:defaultFile,rawOpen:openFile}

assert.ok(measurements.document.scrollWidth<=measurements.document.clientWidth+1,'document must not overflow horizontally')
assert.ok(measurements.list.scrollWidth<=measurements.list.clientWidth+1,'ingredient list must not overflow horizontally')
assert.ok(measurements.itemMetrics.every(x=>x.fontSize==='15.5px'),'all primary ingredient names must render at 15.5px')
assert.ok(measurements.shortItems.every(x=>x.rectCount===1),'short ingredient names must stay on one line')
assert.ok(measurements.longItem.scrollWidth<=measurements.longItem.clientWidth+1,'long preservative wording must not overflow its item')
assert.ok(measurements.raw.scrollWidth<=measurements.raw.clientWidth+1,'raw ingredient text must not overflow horizontally')
assert.ok(report.reads.some(x=>x.path.endsWith('/compare_product_ingredients')),'public ingredient endpoint must be read')

await page.keyboard.press('Enter')
await page.waitForFunction(()=>!document.querySelector('.detail-source-disclosure')?.hasAttribute('open'))
report.keyboard.closed=true
assert.equal(await summary.evaluate(el=>document.activeElement===el),true)
report.keyboard.focusRetained=true

assert.equal(report.blocked.filter(x=>x.reason==='write').length,0)
assert.ok(report.reads.length>0)
assert.ok(report.reads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await context.close()
await browser.close()
