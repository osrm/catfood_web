import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'candidate-output'
await mkdir(OUT,{recursive:true})

const report={candidateSha:process.env.GITHUB_SHA||null,blockedWrites:[],blockedAnalytics:[],scenarios:{}}
const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function makePage(width,height){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'})
  const page=await context.newPage()
  await page.route('**/*',async route=>{
    const req=route.request(),method=req.method(),url=req.url()
    const analytics=/functions\/v1|search-runs|considerations|event_log|analytics|telemetry/i.test(url)
    const write=!['GET','HEAD','OPTIONS'].includes(method)
    if(analytics||write){
      if(analytics) report.blockedAnalytics.push({method,url})
      if(write) report.blockedWrites.push({method,url})
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  return {page,context}
}

async function enterAppliedResults(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
  await page.getByRole('button',{name:'조건 고르기 →'}).waitFor({state:'visible',timeout:30000})
  await page.getByRole('button',{name:'조건 고르기 →'}).click()
  await page.getByRole('button',{name:'건식',exact:true}).click()
  await page.getByRole('button',{name:'이 조건으로 찾기',exact:true}).click()
  await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:30000})
}

async function hitTarget(page,selector){
  return page.locator(selector).evaluate(el=>{
    const r=el.getBoundingClientRect()
    const x=r.left+r.width/2,y=r.top+r.height/2
    const hit=document.elementFromPoint(x,y)
    return {
      center:{x,y},
      rect:{top:r.top,left:r.left,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
      hitText:hit?.textContent?.replace(/\s+/g,' ').trim()||null,
      hitsSelf:hit===el||Boolean(hit?.closest(selector)===el),
    }
  })
}

async function keyboardActions(page){
  await page.locator('body').click({position:{x:2,y:2}})
  if(await page.evaluate(()=>document.activeElement instanceof HTMLElement)) await page.evaluate(()=>document.activeElement?.blur())
  const seen=[]
  for(let i=0;i<50;i++){
    await page.keyboard.press('Tab')
    const active=await page.evaluate(()=>{
      const el=document.activeElement
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect(),s=getComputedStyle(el)
      const extent=(parseFloat(s.outlineWidth)||0)+(parseFloat(s.outlineOffset)||0)
      return {
        text:el.textContent?.replace(/\s+/g,' ').trim()||'',
        cls:el.className,
        outline:s.outline,
        outlineWidth:s.outlineWidth,
        focusBox:{top:r.top-extent,bottom:r.bottom+extent,left:r.left-extent,right:r.right+extent},
      }
    })
    if(active) seen.push(active)
    if(active?.text==='이 조건으로 찾기') break
  }
  const reset=seen.find(x=>x.text==='초기화')
  const apply=seen.find(x=>x.text==='이 조건으로 찾기')
  assert.ok(reset,'keyboard reaches reset')
  assert.ok(apply,'keyboard reaches apply')
  assert.ok(parseFloat(reset.outlineWidth)>=2,'reset focus ring visible')
  assert.ok(parseFloat(apply.outlineWidth)>=2,'apply focus ring visible')
  return {seen,reset,apply}
}

async function scenario(width,height,key){
  const {page,context}=await makePage(width,height)
  await enterAppliedResults(page)

  await page.locator('.research-result-card').first().click()
  await page.locator('.research-quick-view').waitFor({state:'visible'})
  await page.locator('.quick-view-actions .switch-compare-action').first().click()
  await page.locator('.switch-compare-dock').waitFor({state:'visible'})

  const dockBefore=await page.locator('.switch-compare-dock').evaluate(el=>{
    const r=el.getBoundingClientRect()
    return {text:el.textContent?.replace(/\s+/g,' ').trim(),rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}
  })
  assert.match(dockBefore.text,/비교 1\/5/,'result dock shows queued compare item')
  const compareBefore=new URL(page.url()).searchParams.get('compare')
  assert.ok(compareBefore,'compare ID written to navigation state before edit')

  const dockButton=page.getByRole('button',{name:'비교 보기 →',exact:true})
  await dockButton.focus()
  assert.equal(await dockButton.evaluate(el=>document.activeElement===el),true,'result dock remains keyboard focusable')

  await page.getByRole('button',{name:'닫기 ×',exact:true}).click()
  await page.locator('.criteria-bar > button').click()
  await page.locator('.condition-actions').waitFor({state:'visible'})

  assert.equal(await page.locator('.switch-compare-dock').count(),0,'dock absent while editing')
  assert.equal(await page.getByRole('button',{name:'비교 보기 →',exact:true}).count(),0,'dock action absent from focus targets')
  const compareDuring=new URL(page.url()).searchParams.get('compare')
  assert.equal(compareDuring,compareBefore,'entering edit preserves queued compare IDs')

  const resetHit=await hitTarget(page,'.condition-actions .secondary-action')
  const applyHit=await hitTarget(page,'.condition-actions .primary-action')
  assert.equal(resetHit.hitsSelf,true,'reset center hit-test resolves to reset button')
  assert.equal(applyHit.hitsSelf,true,'apply center hit-test resolves to apply button')

  const keyboard=await keyboardActions(page)
  await page.screenshot({path:OUT+'/'+key+'-editing-with-compare-queued.png',fullPage:false})

  await page.locator('.condition-actions .primary-action').click()
  await page.locator('.research-result-card').first().waitFor({state:'visible'})
  assert.equal(new URL(page.url()).searchParams.get('compare'),null,'applying conditions retains existing compare reset policy')
  assert.equal(await page.locator('.switch-compare-dock').count(),0,'dock cleared after apply reset')

  report.scenarios[key]={dockBefore,compareBefore,compareDuring,resetHit,applyHit,keyboard}
  await context.close()
}

await scenario(390,844,'mobile-390x844')
await scenario(1440,700,'desktop-1440x700')

await writeFile(OUT+'/measurements.json',JSON.stringify(report,null,2))
console.log('COMPARE_DOCK_EDIT_QA='+JSON.stringify({
  sha:report.candidateSha,
  mobile:report.scenarios['mobile-390x844'],
  desktop:report.scenarios['desktop-1440x700'],
  blockedWrites:report.blockedWrites.length,
  blockedAnalytics:report.blockedAnalytics.length,
}))
await browser.close()
