import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.BASE_URL||'https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'detail-overview-live-output'
const targets=[
  {slug:'go',id:'product_31bc515d78d43d5d',name:'카니보 치킨&칠면조&오리',width:390,height:844},
  {slug:'monge',id:'product_285ec8eafca0bec8',name:'몬지 모노프로틴(L.I.D) 그레인프리 플레이크 온리 포크',width:1440,height:900},
]
await mkdir(OUT,{recursive:true})
const report={pages:true,deploySha:process.env.PRODUCT_SHA,blocked:[],views:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

for(const target of targets){
  const context=await browser.newContext({viewport:{width:target.width,height:target.height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method()
    if(!['GET','HEAD','OPTIONS'].includes(method)||/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)){
      report.blocked.push({method,url:url.href})
      return route.abort('blockedbyclient')
    }
    await route.continue()
  })

  await page.goto(BASE+'?view=workspace&mode=lookup&detail='+target.id+'&detailTab=nutrition',{waitUntil:'domcontentloaded'})
  const title=page.locator('.detail-identity h1');await title.waitFor();assert.ok((await title.innerText()).includes(target.name))
  const img=page.locator('.detail-identity img').first();await img.waitFor({state:'visible'})
  await page.waitForFunction(()=>{const x=document.querySelector('.detail-identity img');return x&&x.complete&&x.naturalWidth>0})

  const panel=page.locator('#detail-panel-nutrition')
  await panel.locator('.detail-nutrition-list').first().waitFor({timeout:90000})
  const text=await panel.innerText()
  const flat=text.replace(/\s+/g,'')
  assert.ok(!text.includes('자료 기준과 보완 범위'))
  assert.ok(!text.includes('최소·최대·평균 등 출처의 한정자와 단위를 그대로 표시합니다'))
  assert.equal(await panel.locator('details').count(),0)

  if(target.slug==='go'){
    for(const expected of ['4,298kcal/kg','조단백질46%이상','조지방18%이상','조섬유1.5%이하','수분10%이하','조회분9%이하']) assert.ok(flat.includes(expected),expected)
    const supplement='열량 · 현재 확인 배합 기준으로 보완'
    assert.equal((text.match(new RegExp(supplement,'g'))||[]).length,1)
    const note=panel.locator('.detail-evidence-context').filter({hasText:supplement})
    assert.equal(await note.count(),1)
    await note.scrollIntoViewIfNeeded()
    assert.ok(await note.isVisible())
  } else {
    for(const expected of ['열량미확인','조단백질13%','조지방8%','조섬유0.6%','수분79%','조회분1%']) assert.ok(flat.includes(expected),expected)
  }

  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)
  assert.ok(overflow<=1,'horizontal overflow '+overflow)
  const file=target.slug+'-'+target.width+'x'+target.height+'.png'
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  report.views[target.slug]={
    file,
    title:await title.innerText(),
    text,
    overflow,
    image:await img.evaluate(x=>({src:x.currentSrc||x.src,naturalWidth:x.naturalWidth,naturalHeight:x.naturalHeight})),
  }
  await context.close()
}

assert.equal(report.blocked.length,0)
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
await browser.close()
