import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'consumer-language-live-output'
const views=[[390,844],[1440,900]]
await mkdir(OUT,{recursive:true})
const report={candidate:process.env.PRODUCT_SHA,blocked:[],views:{},interactions:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

async function installGuards(page){
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method()
    if(!['GET','HEAD','OPTIONS'].includes(method)||/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)){
      report.blocked.push({method,url:url.href})
      return route.abort('blockedbyclient')
    }
    await route.continue()
  })
}

for(const [width,height] of views){
  {
    const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
    const page=await context.newPage()
    await installGuards(page)
    await page.goto(BASE,{waitUntil:'domcontentloaded'})
    await page.getByRole('heading',{name:'사료를 찾는 방법을 고르세요.'}).waitFor()
    await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})
    const body=await page.locator('body').innerText()
    assert.ok(body.includes('브랜드·제품명 검색'))
    assert.ok(body.includes('현재 사료에서 바꾸기'))
    assert.ok(body.includes('조건으로 찾아보기'))
    assert.ok(!body.includes('데이터 연결됨'))
    const file='home-'+width+'x'+height+'.png'
    await page.screenshot({path:OUT+'/'+file,fullPage:false})

    const trigger=page.getByRole('button',{name:/정보 읽는 기준 보기/})
    const panel=page.locator('#home-info-panel')
    const heading=page.locator('#home-info-title')
    assert.equal(await trigger.getAttribute('aria-expanded'),'false')
    assert.equal(await panel.isHidden(),true)
    await trigger.click()
    await heading.waitFor({state:'visible'})
    assert.equal(await trigger.getAttribute('aria-expanded'),'true')
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'home-info-title')
    const infoText=await panel.textContent()
    for(const expected of ['비교할 때 알아두면 좋은 4가지','용어집','확인과 미확인을 구분','선택한 조건을 그대로 적용','점수로 대신 결정하지 않음']) assert.ok(infoText.includes(expected),expected)
    const glossary=panel.locator('.home-glossary-item')
    assert.ok(await glossary.count()>=3)
    assert.equal(await glossary.first().getAttribute('open'),null)

    await page.keyboard.press('Tab')
    const close=page.getByRole('button',{name:'정보 안내 닫기'})
    assert.equal(await close.evaluate(el=>el===document.activeElement),true)
    await page.keyboard.press('Enter')
    assert.equal(await panel.isHidden(),true)
    await page.waitForFunction(()=>document.activeElement?.textContent?.includes('정보 읽는 기준 보기'))
    assert.equal(await trigger.evaluate(el=>el===document.activeElement),true)

    report.views['home-'+width]={file,infoHiddenInitially:true,triggerExpandedAfterOpen:'true'}
    report.interactions['home-'+width]={tabToClose:true,enterClose:true,focusReturned:true}
    await context.close()
  }

  {
    const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
    const page=await context.newPage()
    await installGuards(page)
    await page.goto(BASE,{waitUntil:'domcontentloaded'})
    await page.getByText(/현재 확인된 제품 \d+개/).waitFor({timeout:90000})
    await page.getByRole('button',{name:/조건 고르기/}).click()
    const editor=page.locator('.research-filter-scroll')
    await editor.getByText('기본 조건').waitFor()
    const editorText=await editor.textContent()
    assert.equal((editorText.match(/조건 정보가 없는 제품도 결과에 포함됩니다\./g)||[]).length,1)
    for(const removed of ['확인된 불일치만 제외','미확인은 후보에 유지']) assert.ok(!editorText.includes(removed),removed)
    assert.ok(editorText.includes('제품에 표기된 연령 구분을 기준으로 합니다.'))
    assert.ok(editorText.includes('Grain-Free 표기가 없다고 해서 곡물이 들어 있다고 판단하지 않습니다.'))
    assert.ok(!await page.locator('body').innerText().then(text=>text.includes('데이터 연결됨')))
    const brand=page.getByRole('button',{name:'CATFOOD 홈으로 이동'})
    assert.equal(await brand.count(),1)
    const generatedBrand=await brand.evaluate(el=>getComputedStyle(el,'::after').content)
    assert.ok(generatedBrand.includes('CATFOOD'))

    const file='explore-'+width+'x'+height+'.png'
    await page.screenshot({path:OUT+'/'+file,fullPage:false})

    await page.getByRole('button',{name:'이 조건으로 찾기'}).click()
    await page.getByRole('button',{name:'조건 수정'}).first().waitFor({timeout:90000})
    await page.getByRole('button',{name:'조건 수정'}).first().click()
    await editor.getByText('기본 조건').waitFor()
    assert.equal((await editor.textContent()).match(/조건 정보가 없는 제품도 결과에 포함됩니다\./g)?.length,1)

    report.views['explore-'+width]={file,policyCount:1,brandGeneratedContent:generatedBrand}
    report.interactions['explore-'+width]={conditionEditReturned:true}
    await context.close()
  }
}

await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
