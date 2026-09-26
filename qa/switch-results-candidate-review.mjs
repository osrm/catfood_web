import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
const BASE=process.env.CANDIDATE_URL||'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'switch-results-candidate-output'
await mkdir(OUT,{recursive:true})
const report={sourceSha:process.env.CANDIDATE_SHA||process.env.GITHUB_SHA,baseSha:'7f49ac85e20e9873f37e70c08995240032168722',blocked:[],scenarios:{}}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
const norm=v=>String(v||'').replace(/\s+/g,' ').trim()
async function pageAt(w,h){
 const context=await browser.newContext({viewport:{width:w,height:h},serviceWorkers:'block'}),page=await context.newPage()
 await page.route('**/*',async route=>{const req=route.request(),url=req.url(),method=req.method();const external=!url.startsWith(BASE);const allowedRead=['GET','HEAD','OPTIONS'].includes(method);const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url);if(!allowedRead||analytics){report.blocked.push({method,url,analytics});await route.abort('blockedbyclient');return}if(external&&!/supabase\.co|googleapis\.com|gstatic\.com/i.test(url)){await route.abort('blockedbyclient');return}await route.continue()})
 return{context,page}
}
async function visibleButton(page,name){const xs=page.getByRole('button',{name,exact:true});for(let i=0;i<await xs.count();i++)if(await xs.nth(i).isVisible())return xs.nth(i);throw new Error('button not found '+name)}
async function setup(page){
 await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000})
 await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
 await page.waitForFunction(()=>document.querySelector('.research-status')?.textContent?.includes('데이터 연결됨'),null,{timeout:30000})
 await page.locator('.switch-find-search input').fill('AATU')
 const row=page.locator('.switch-find-result').filter({hasText:/연어/}).first();await row.waitFor({state:'visible'});await row.click()
 await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
 const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg|1[,.]?000\s*g/i}).first();await sku.waitFor({state:'visible'});await sku.click();await page.locator('.switch-step-actions .switch-primary-action').click()
 await (await visibleButton(page,'다른 브랜드로 보기')).click()
 const toggle=page.locator('.switch-change-additional-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click()
 await (await visibleButton(page,'시니어')).click();await page.locator('.switch-step-actions .switch-primary-action').click()
 await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor()
 await (await visibleButton(page,'건식 유지')).click();await (await visibleButton(page,'생선')).click()
 await page.locator('.switch-step-actions .switch-primary-action').click();await page.locator('.switch-candidate-row').first().waitFor({state:'visible',timeout:30000})
}
async function waitVisibleImages(page){await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth}).every(i=>i.complete),null,{timeout:10000})}
async function metrics(page){return page.evaluate(()=>{const q=s=>document.querySelector(s),R=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}},S=e=>{if(!e)return null;const s=getComputedStyle(e);return{fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,wordBreak:s.wordBreak,overflowWrap:s.overflowWrap,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow}};const rows=[...document.querySelectorAll('.switch-candidate-row')];return{viewport:{w:innerWidth,h:innerHeight},document:{w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight},session:R(q('.switch-session-bar')),firstCandidate:R(rows[0]),firstIdentity:S(rows[0]?.querySelector('.switch-candidate-identity>strong')),firstRelation:S(rows[0]?.querySelector('.switch-relation-line>strong')),inspector:R(q('.switch-candidate-inspector')),identity:R(q('.switch-inspector-identity')),actions:R(q('.switch-inspector-actions')),decision:R(q('.switch-inspector-decision')),facts:R([...document.querySelectorAll('.switch-inspector-section')].at(-1)),inspectorIdentity:S(q('.switch-inspector-identity h1')),inspectorRelation:S(q('.switch-inspector-decision dd'))}})}
async function exercise(page,key){
 const rows=page.locator('.switch-candidate-row'),count=await rows.count();assert.ok(count>0)
 const texts=[];for(let i=0;i<count;i++)texts.push(norm(await rows.nth(i).textContent()))
 const unknownIndex=texts.findIndex(t=>t.includes('미확인'));const longIndex=texts.reduce((best,t,i)=>t.length>texts[best].length?i:best,0)
 const selected=rows.first();await selected.click();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'})
 await waitVisibleImages(page)
 const openMetrics=await metrics(page)
 const relationText=norm(await selected.textContent())
 const unknownText=unknownIndex>=0?texts[unknownIndex]:null,longText=texts[longIndex]
 const add=page.locator('.switch-inspector-actions button').first();await add.click();assert.match(norm(await add.textContent()),/비교에서 제거/);await add.focus();await page.keyboard.press('Enter');assert.doesNotMatch(norm(await add.textContent()),/비교에서 제거/)
 const detail=page.locator('.switch-inspector-actions button').nth(1);await detail.click();await page.locator('.detail-stage').waitFor({state:'visible'});await page.goBack();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'})
 const close=page.locator('.switch-preview-topline button');await close.focus();await page.keyboard.press('Enter');await page.locator('.switch-candidate-inspector').waitFor({state:'detached'})
 const focusAfterKeyboard=await page.evaluate(()=>({cls:document.activeElement?.className||'',text:document.activeElement?.textContent?.replace(/\s+/g,' ').trim()||'',insideInspector:!!document.activeElement?.closest('.switch-candidate-inspector')}));assert.match(focusAfterKeyboard.cls,/switch-candidate-row/);assert.equal(focusAfterKeyboard.insideInspector,false)
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('.switch-candidate-inspector')),false)
 await selected.click();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'});await page.locator('.switch-preview-topline button').click();await page.locator('.switch-candidate-inspector').waitFor({state:'detached'})
 const focusAfterPointer=await page.evaluate(()=>document.activeElement?.className||'');assert.match(focusAfterPointer,/switch-candidate-row/)
 return{candidateCount:count,relationText,unknownCandidate:unknownText,longCandidate:longText,openMetrics,focusAfterKeyboard,focusAfterPointer}
}
for(const [key,w,h] of [['mobile-390x844',390,844],['desktop-1440x900',1440,900]]){
 const {context,page}=await pageAt(w,h);await setup(page);await waitVisibleImages(page);await page.screenshot({path:`${OUT}/${key}-results.png`,fullPage:false})
 await page.locator('.switch-candidate-row').first().click();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'});await waitVisibleImages(page);await page.screenshot({path:`${OUT}/${key}-inspector.png`,fullPage:false})
 await page.locator('.switch-preview-topline button').click();await page.locator('.switch-candidate-inspector').waitFor({state:'detached'})
 report.scenarios[key]=await exercise(page,key);await context.close()
}
for(const [key,w,h] of [['boundary-760',760,844],['boundary-761',761,844],['desktop-short-1440x700',1440,700]]){
 const {context,page}=await pageAt(w,h);await setup(page);await page.locator('.switch-candidate-row').first().click();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'});await waitVisibleImages(page)
 const m=await metrics(page);const action=page.locator('.switch-inspector-actions button').first();await action.scrollIntoViewIfNeeded();const actionVisible=await action.isVisible();const facts=page.locator('.switch-inspector-section').last();await facts.scrollIntoViewIfNeeded();const factsVisible=await facts.isVisible();report.scenarios[key]={metrics:m,actionVisible,factsVisible};assert.equal(actionVisible,true);assert.equal(factsVisible,true);await context.close()
}
assert.ok(report.blocked.every(x=>x.analytics||!['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2));await browser.close()
