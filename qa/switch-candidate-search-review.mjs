import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'switch-candidate-focus-review-output'
const PRODUCT_SHA=process.env.PRODUCT_SHA||''
await mkdir(OUT,{recursive:true})

const report={
  productSha:PRODUCT_SHA,
  candidateUrl:BASE,
  blocked:[],
  reads:[],
  desktop:{},
  screenshots:{
    '01-a-open-b-search-1440x900.png':'desktop viewport: candidate A inspector remains open while B search removes A row',
    '02-b-search-after-keyboard-close-1440x900.png':'desktop viewport immediately after keyboard close; search input has focus',
    '03-b-search-dock-visible-1440x900.png':'desktop viewport after scrolling compare dock into view; direct visual evidence A remains compared',
    '04-zero-search-after-keyboard-close-1440x900.png':'desktop viewport after zero-result search and keyboard close; input focus and zero-result state',
  },
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})
const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'})
const page=await context.newPage()

await page.route('**/*',async route=>{
  const req=route.request(), url=new URL(req.url()), method=req.method()
  const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)
  const supabase=/\.supabase\.co$/i.test(url.hostname)
  const local=url.origin===new URL(BASE).origin
  const google=/googleapis\.com$|gstatic\.com$/i.test(url.hostname)
  if(analytics || (supabase&&!['GET','HEAD','OPTIONS'].includes(method))){
    report.blocked.push({method,url:url.href,reason:analytics?'analytics':'write'})
    return route.abort('blockedbyclient')
  }
  if(supabase) report.reads.push({method,path:url.pathname,query:url.search})
  if(!local&&!supabase&&!google) return route.abort('blockedbyclient')
  await route.continue()
})

const norm=v=>String(v||'').replace(/\s+/g,' ').trim()

async function reachResults(){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
  await page.waitForFunction(()=>/\d+\s*PRODUCTS/.test(document.querySelector('.research-status')?.textContent||''),null,{timeout:90000})
  const currentSearch=page.locator('.switch-find-search input')
  await currentSearch.fill('AATU')
  const currentRow=page.locator('.switch-find-result').filter({hasText:/AATU/}).filter({hasText:/연어/}).first()
  await currentRow.waitFor({state:'visible',timeout:30000})
  await currentRow.click()
  await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
  const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
  await sku.waitFor({state:'visible',timeout:30000})
  await sku.click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.locator('.switch-no-change').click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('button',{name:'후보 제품 보기 →'}).click()
  await page.locator('.switch-results-stage').waitFor({state:'visible',timeout:90000})
}

function goRow(){
  return page.locator('.switch-candidate-row').filter({hasText:/GO! SOLUTIONS/}).filter({hasText:/LID 오리/}).first()
}
function naturalRow(){
  return page.locator('.switch-candidate-row').filter({hasText:/내추럴발란스/}).first()
}
async function compareDockState(){
  return page.locator('.switch-compare-dock').evaluate(el=>{
    const r=el.getBoundingClientRect()
    return {
      text:el.textContent.replace(/\s+/g,' ').trim(),
      top:r.top,bottom:r.bottom,
      inViewport:r.bottom>0&&r.top<innerHeight,
    }
  })
}

await reachResults()
const search=page.locator('input[aria-label="후보 제품 검색"]')
await search.waitFor({state:'visible',timeout:30000})

await search.fill('GO!')
const aRow=goRow()
await aRow.waitFor({state:'visible',timeout:30000})
await aRow.click()
const inspector=page.locator('.switch-candidate-inspector')
await inspector.waitFor({state:'visible',timeout:30000})
assert.match(norm(await inspector.textContent()),/GO! SOLUTIONS.*LID 오리/)
const add=inspector.locator('.switch-inspector-actions button').first()
assert.match(norm(await add.textContent()),/비교에 추가/)
await add.click()
assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/LID 오리/)

await search.fill('내추럴발란스')
const bRow=naturalRow()
await bRow.waitFor({state:'visible',timeout:30000})
assert.equal(await aRow.count(),0,'candidate A row should be removed by B search while inspector stays open')
assert.match(norm(await inspector.textContent()),/GO! SOLUTIONS.*LID 오리/)
await page.screenshot({path:OUT+'/01-a-open-b-search-1440x900.png',fullPage:false})

const close=inspector.locator('.switch-preview-topline button')
await close.focus()
assert.equal(await close.evaluate(el=>document.activeElement===el),true)
await page.keyboard.press('Enter')
await inspector.waitFor({state:'detached',timeout:30000})
assert.equal(await search.evaluate(el=>document.activeElement===el),true,'filtered-out A close must fall back to candidate search input')
assert.equal(await search.inputValue(),'내추럴발란스')
const dockAfterB=await compareDockState()
assert.match(dockAfterB.text,/LID 오리/)
assert.match(norm(await page.locator('.switch-session-bar').textContent()),/AATU.*연어/)
assert.match(norm(await page.locator('.switch-session-bar').textContent()),/1 kg/)
await page.screenshot({path:OUT+'/02-b-search-after-keyboard-close-1440x900.png',fullPage:false})

await page.locator('.switch-compare-dock').scrollIntoViewIfNeeded()
const dockVisibleB=await compareDockState()
assert.equal(dockVisibleB.inViewport,true)
await page.screenshot({path:OUT+'/03-b-search-dock-visible-1440x900.png',fullPage:false})

await search.scrollIntoViewIfNeeded()
await search.fill('GO!')
await goRow().waitFor({state:'visible',timeout:30000})
await goRow().click()
await inspector.waitFor({state:'visible',timeout:30000})
await search.fill('__검색결과없음__')
const zero=page.locator('.switch-candidate-list .switch-state-message').filter({hasText:'이름 검색 결과가 없습니다.'}).first()
await zero.waitFor({state:'visible',timeout:30000})
assert.equal(await goRow().count(),0,'candidate A row should be absent in zero-result search')
assert.match(norm(await page.locator('.switch-compare-dock').textContent()),/LID 오리/)
const closeZero=inspector.locator('.switch-preview-topline button')
await closeZero.focus()
assert.equal(await closeZero.evaluate(el=>document.activeElement===el),true)
await page.keyboard.press('Enter')
await inspector.waitFor({state:'detached',timeout:30000})
assert.equal(await search.evaluate(el=>document.activeElement===el),true)
assert.equal(await search.inputValue(),'__검색결과없음__')
assert.match(norm(await zero.textContent()),/검색 지우기/)
const dockAfterZero=await compareDockState()
assert.match(dockAfterZero.text,/LID 오리/)
await page.screenshot({path:OUT+'/04-zero-search-after-keyboard-close-1440x900.png',fullPage:false})

const layout=await page.evaluate(()=>{
  const doc=document.scrollingElement||document.documentElement
  const stage=document.querySelector('.switch-results-stage')
  const workspace=document.querySelector('.switch-results-workspace')
  const input=document.querySelector('input[aria-label="후보 제품 검색"]')
  return {
    viewport:{width:innerWidth,height:innerHeight},
    document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth},
    stage:{clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth},
    workspace:{clientWidth:workspace.clientWidth,scrollWidth:workspace.scrollWidth},
    activeElement:document.activeElement===input?'candidate-search':document.activeElement?.tagName,
    query:input.value,
  }
})
assert.ok(layout.document.scrollWidth<=layout.document.clientWidth+1)
assert.ok(layout.stage.scrollWidth<=layout.stage.clientWidth+1)
assert.ok(layout.workspace.scrollWidth<=layout.workspace.clientWidth+1)
assert.equal(layout.activeElement,'candidate-search')

report.desktop={
  bSearch:{
    query:'내추럴발란스',
    focusAfterClose:'candidate-search',
    comparedCandidate:'GO! SOLUTIONS LID 오리',
    dockImmediatelyAfterClose:dockAfterB,
    dockAfterScroll:dockVisibleB,
  },
  zeroSearch:{
    query:'__검색결과없음__',
    focusAfterClose:'candidate-search',
    comparedCandidate:'GO! SOLUTIONS LID 오리',
    dock:dockAfterZero,
  },
  currentFood:'AATU 연어',
  currentVariant:'1 kg',
  layout,
}

assert.ok(report.reads.length>0)
assert.ok(report.reads.every(row=>['GET','HEAD','OPTIONS'].includes(row.method)))
assert.equal(report.blocked.filter(row=>row.reason==='write').length,0)
await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
await context.close()
await browser.close()
