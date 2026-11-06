import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core')
const BASE = process.env.CANDIDATE_URL || 'http://127.0.0.1:4173/'
const OUT = process.env.OUT_DIR || 'ingredient-verdict-priority-output'
const royal = 'product_5b13354ad9792881', unresolved = 'product_e7eb6b131871033e'
const report = { sourceSha: process.env.CANDIDATE_SHA, base: BASE, realPublicData: true, views: [], errors: [], failedRequests: [], blockedWrites: [] }
await mkdir(OUT, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' })
let page
try {
 for (const width of [390, 768, 1440]) {
  const context = await browser.newContext({viewport:{width,height:width===390?844:1000},serviceWorkers:'block'})
  await context.addInitScript(() => {
   window.__blockedWrites=[]; const original=window.fetch.bind(window)
   window.fetch=(input,options)=>{ const method=String(options?.method??(input instanceof Request?input.method:'GET')).toUpperCase(); if(!['GET','HEAD','OPTIONS'].includes(method)){window.__blockedWrites.push({method,url:String(input)});return Promise.reject(new Error('Read-only review blocked write'))}return original(input,options) }
  })
  page=await context.newPage()
  page.on('pageerror',e=>report.errors.push({width,error:String(e)}))
  page.on('requestfailed',r=>{if(r.failure()?.errorText!=='net::ERR_ABORTED')report.failedRequests.push({width,url:r.url(),error:r.failure()?.errorText})})
  const button=name=>page.getByRole('button',{name,exact:true}).filter({visible:true}).first()
  async function capture(key,row) {
   await page.evaluate(()=>Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,2000))]))
   await page.evaluate(()=>scrollTo(0,0))
   const geometry=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}))
   assert.ok(geometry.documentWidth<=width+1,`${width}-${key}: overflow`)
   report.views.push({width,key,geometry,text:await page.locator('main').innerText()})
   await page.screenshot({path:`${OUT}/${width}-${key}.png`,fullPage:true})
   if(row){
    const boxes=await row.evaluate(node=>{const r=el=>{const b=el.getBoundingClientRect();return{top:b.top,bottom:b.bottom}};return{explanation:r(node.querySelector('.candidate-explanation')),action:r(node.querySelector('.switch-candidate-open')),compare:r(node.parentElement.querySelector('.switch-candidate-compare'))}})
    assert.ok(boxes.explanation.bottom<=Math.min(boxes.action.top,boxes.compare.top)+1,`${width}-${key}: explanation/action overlap`)
    await row.evaluate(node=>scrollTo(0,Math.max(0,scrollY+node.getBoundingClientRect().top-80)))
    await row.screenshot({path:`${OUT}/${width}-${key}-card.png`})
   }
  }
  await page.goto(BASE,{waitUntil:'domcontentloaded'})
  await button('먹이는 사료 찾기 →').click({timeout:45000})
  await page.locator('.switch-find-search input').fill('AATU')
  await page.locator('.switch-find-result').filter({hasText:'연어'}).first().click({timeout:45000})
  await page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first().click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?',exact:true}).waitFor()
  await page.getByRole('button',{name:/피하고 싶은 원료가 들어/}).click()
  await page.locator('.switch-current-ingredients button').filter({hasText:'연어'}).filter({visible:true}).first().click({timeout:45000})
  await button('건식 유지').click(); await page.locator('.switch-step-actions .switch-primary-action').click()
  const search=page.getByRole('searchbox',{name:'후보 제품 검색'})
  await search.fill('로얄캐닌 노르웨이')
  const reviewed=page.locator(`.switch-candidate-row[data-product-id="${royal}"]`)
  const primary=reviewed.locator('.is-differences > span > span').first()
  await primary.waitFor({timeout:45000}); assert.match(await primary.innerText(),/^연어 원료.*검토 자료에서 찾지 못함.*부재 보장 아님/)
  await reviewed.locator('.is-unknowns').getByText(/어유.*세부 어종 미기재/).first().waitFor({timeout:45000})
  await capture('reviewed',reviewed)
  await page.locator(`[data-switch-compare-product-id="${royal}"]`).click()
  await search.fill('다이제스티브 케어')
  const unknown=page.locator(`.switch-candidate-row[data-product-id="${unresolved}"]`)
  await unknown.waitFor({timeout:45000})
  assert.match(await unknown.locator('.is-unknowns > span > span').first().innerText(),/^연어 원료:.*근거가 부족/)
  await unknown.locator('.is-unknowns').getByText(/어분.*세부 어종 미기재/).first().waitFor({timeout:45000})
  await capture('unresolved',unknown)
  await page.locator(`[data-switch-compare-product-id="${unresolved}"]`).click(); await page.locator('.switch-compare-dock button').click()
  const retain=page.locator('.journey-retain').filter({has:page.locator('> strong').filter({hasText:'노르웨이 숲'})})
  const picker=page.locator('.compare-mobile-candidate-toggle')
  if(await picker.isVisible() && !await retain.isVisible()){await picker.click();await page.locator(`.compare-mobile-candidate-options [data-product-id="${royal}"]`).click()}
  const lines=await retain.locator('.is-differences > div > span').allTextContents()
  assert.match(lines[0],/^연어 원료.*부재 보장 아님/);assert.ok(lines.some(line=>line.includes('확보한 원료표')))
  await page.locator('.compare-ingredient-reading').getByText(/어유.*세부 어종 미기재/).filter({visible:true}).first().waitFor({timeout:45000})
  await capture('comparison')
  await retain.getByRole('button',{name:'후보로 남기기',exact:true}).click()
  await page.reload({waitUntil:'domcontentloaded'})
  await page.locator('.journey-records .saved-candidate-explanation').waitFor({timeout:45000})
  const records=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('catfood.switch-review.v1')))
  assert.match(records.retained[0].explanation.differences[0],/^연어 원료.*부재 보장 아님/)
  assert.ok(records.retained[0].explanation.differences.some(line=>line.includes('확보한 원료표')))
  await page.locator('.saved-candidate-explanation > summary').click()
  await capture('restored')
  report.blockedWrites.push(...await page.evaluate(()=>window.__blockedWrites)); await context.close()
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.blockedWrites,[])
}catch(error){report.failure=String(error);if(page&&!page.isClosed()){report.failureText=await page.locator('body').innerText();await page.screenshot({path:`${OUT}/failure.png`,fullPage:true})}throw error}
finally{await browser.close();await writeFile(`${OUT}/report.json`,JSON.stringify(report,null,2))}
console.log(JSON.stringify({views:report.views.length,errors:report.errors,failedRequests:report.failedRequests,blockedWrites:report.blockedWrites}))
