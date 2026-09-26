import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const BASE='http://127.0.0.1:4173/'
const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'})
const page=await context.newPage()
const blockedWrites=[],blockedAnalytics=[]
await page.route('**/*',async route=>{
  const req=route.request(),method=req.method(),url=req.url()
  const analytics=/functions\/v1|search-runs|considerations|event_log|analytics|telemetry/i.test(url)
  const write=!['GET','HEAD','OPTIONS'].includes(method)
  if(analytics||write){
    if(analytics) blockedAnalytics.push({method,url})
    if(write) blockedWrites.push({method,url})
    await route.abort('blockedbyclient')
    return
  }
  await route.continue()
})
const norm=v=>String(v||'').replace(/\s+/g,' ').trim()
async function focusInfo(){
  return page.evaluate(()=>{
    const el=document.activeElement
    if(!(el instanceof HTMLElement)) return null
    const r=el.getBoundingClientRect(),s=getComputedStyle(el)
    const extent=(parseFloat(s.outlineWidth)||0)+(parseFloat(s.outlineOffset)||0)
    return {
      text:String(el.textContent||'').replace(/\s+/g,' ').trim(),
      outlineWidth:s.outlineWidth,
      focusBox:{top:r.top-extent,bottom:r.bottom+extent},
    }
  })
}
async function tabTo(text,max=80){
  for(let i=0;i<max;i++){
    await page.keyboard.press('Tab')
    const f=await focusInfo()
    if(f?.text===text) return f
  }
  return null
}
await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
await page.waitForFunction(()=>document.querySelector('.research-status')?.textContent?.includes('데이터 연결됨')===true,undefined,{timeout:30000})
await page.locator('.switch-find-search input').fill('AATU')
const salmon=page.locator('.switch-find-result').filter({hasText:/연어/}).first()
await salmon.waitFor({state:'visible',timeout:30000})
await salmon.click()
await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
const oneKg=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first()
await oneKg.waitFor({state:'visible',timeout:30000})
await oneKg.click()
await page.locator('.switch-step-actions .switch-primary-action').click()
await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?'}).waitFor({state:'visible'})
await page.getByRole('button',{name:'다른 브랜드로 보기',exact:true}).click()
const toggle=page.locator('.switch-change-additional-toggle')
if(await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
await page.getByRole('button',{name:'시니어',exact:true}).click()

await page.locator('body').click({position:{x:2,y:2}})
await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement) document.activeElement.blur()})
const nextFocus=await tabTo('다음 →')
assert.ok(nextFocus,'Tab reaches CHANGE next action')
assert.ok(parseFloat(nextFocus.outlineWidth)>=2,'CHANGE next has visible focus')
assert.ok(nextFocus.focusBox.top>=0&&nextFocus.focusBox.bottom<=844,'CHANGE next full focus ring visible')
await page.keyboard.press('Enter')
await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor({state:'visible',timeout:10000})

const dry=page.getByRole('button',{name:'건식 유지',exact:true})
if((await dry.getAttribute('aria-pressed'))!=='true') await dry.click()
const fish=page.getByRole('button',{name:'생선',exact:true})
if((await fish.getAttribute('aria-pressed'))!=='true') await fish.click()

await page.locator('.switch-keep-step .switch-primary-action').focus()
await page.keyboard.press('Shift+Tab')
let focus=await focusInfo()
assert.equal(focus?.text,'← 바꿀 것 수정','Shift+Tab reaches KEEP back action')
assert.ok(parseFloat(focus.outlineWidth)>=2,'KEEP back has visible focus')
await page.keyboard.press('Tab')
focus=await focusInfo()
assert.equal(focus?.text,'후보 제품 보기 →','Tab returns to KEEP primary action')
assert.ok(parseFloat(focus.outlineWidth)>=2,'KEEP primary has visible focus')
await page.keyboard.press('Enter')
await page.locator('.switch-results-stage').waitFor({state:'visible',timeout:30000})
assert.ok(await page.locator('.switch-candidate-row').count()>0,'Enter on KEEP primary enters candidates')
console.log('SWITCH_KEYBOARD_ENTER='+JSON.stringify({
  nextFocus,keepPrimary:focus,
  candidateCount:await page.locator('.switch-candidate-row').count(),
  blockedWrites:blockedWrites.length,
  blockedAnalytics:blockedAnalytics.length,
  url:page.url(),
}))
await context.close()
await browser.close()
