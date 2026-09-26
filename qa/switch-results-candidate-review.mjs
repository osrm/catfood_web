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
async function waitVisibleImages(page){await page.waitForFunction(()=>[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth}).every(i=>i.complete&&i.naturalWidth>0),null,{timeout:10000})}
async function tabUntil(page,predicate,{reverse=false,max=80}={}){for(let i=1;i<=max;i++){await page.keyboard.press(reverse?'Shift+Tab':'Tab');const state=await page.evaluate(()=>({text:(document.activeElement?.textContent||'').replace(/\s+/g,' ').trim(),cls:document.activeElement?.className||'',tag:document.activeElement?.tagName||''}));if(predicate(state))return{steps:i,...state}}throw new Error('tab target not reached')}
async function metrics(page){return page.evaluate(()=>{const q=s=>document.querySelector(s),R=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}},S=e=>{if(!e)return null;const s=getComputedStyle(e);return{fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,wordBreak:s.wordBreak,overflowWrap:s.overflowWrap,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow}};const rows=[...document.querySelectorAll('.switch-candidate-row')],visible=rows.filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'});return{viewport:{w:innerWidth,h:innerHeight},document:{w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight},session:R(q('.switch-session-bar')),visibleRowCount:visible.length,firstCandidate:R(visible[0]),firstIdentity:S(visible[0]?.querySelector('.switch-candidate-identity>strong')),firstRelation:S(visible[0]?.querySelector('.switch-relation-line>strong')),selectedIdentity:S(q('.switch-candidate-row.is-selected .switch-candidate-identity>strong')),selectedRelation:S(q('.switch-candidate-row.is-selected .switch-relation-line>strong')),inspector:R(q('.switch-candidate-inspector')),identity:R(q('.switch-inspector-identity')),actions:R(q('.switch-inspector-actions')),actionButtons:[...document.querySelectorAll('.switch-inspector-actions button')].map(R),decision:R(q('.switch-inspector-decision')),facts:R([...document.querySelectorAll('.switch-inspector-section')].at(-1)),inspectorIdentity:S(q('.switch-inspector-identity h1')),inspectorRelation:S(q('.switch-inspector-decision dd'))}})}
async function exercise(page,key){
 const rows=page.locator('.switch-candidate-row'),count=await rows.count();assert.ok(count>0)
 const beforeOpen=await metrics(page);assert.equal(beforeOpen.firstIdentity.fontSize,'17px');assert.equal(beforeOpen.firstRelation.fontSize,'13px')
 const texts=[];for(let i=0;i<count;i++)texts.push(norm(await rows.nth(i).textContent()))
 const unknownIndex=texts.findIndex(t=>t.includes('미확인'));const longIndex=texts.reduce((best,t,i)=>t.length>texts[best].length?i:best,0)
 const selected=rows.first();await selected.click();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'});await waitVisibleImages(page)
 const openMetrics=await metrics(page);assert.equal(openMetrics.inspectorRelation.fontSize,'13px')
 if(key.startsWith('desktop')){assert.equal(openMetrics.selectedIdentity.fontSize,'17px');assert.equal(openMetrics.selectedRelation.fontSize,'13px')}
 const relationText=norm(await selected.textContent()),unknownText=unknownIndex>=0?texts[unknownIndex]:null,longText=texts[longIndex]
 // Pointer opened the inspector; from the selected row, reach controls only with real Tab traversal.
 const closeReach=await tabUntil(page,x=>x.text.includes('닫기 ×'))
 const addReach=await tabUntil(page,x=>/비교에 추가|비교에서 제거/.test(x.text));await page.keyboard.press('Enter')
 const add=page.locator('.switch-inspector-actions button').first();assert.match(norm(await add.textContent()),/비교에서 제거/)
 const detailReach=await tabUntil(page,x=>x.text.includes('상세 보기'));await page.keyboard.press('Enter');await page.locator('.detail-stage').waitFor({state:'visible'})
 await page.goBack();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'})
 // After history restoration, traverse from the selected row again; no .focus() shortcut.
 const closeReachAfterBack=await tabUntil(page,x=>x.text.includes('닫기 ×'))
 const addReachAfterBack=await tabUntil(page,x=>x.text.includes('비교에서 제거'));await page.keyboard.press('Enter');assert.doesNotMatch(norm(await add.textContent()),/비교에서 제거/)
 const closeByShiftTab=await tabUntil(page,x=>x.text.includes('닫기 ×'),{reverse:true});await page.keyboard.press('Enter');await page.locator('.switch-candidate-inspector').waitFor({state:'detached'})
 const focusAfterKeyboard=await page.evaluate(()=>({cls:document.activeElement?.className||'',text:document.activeElement?.textContent?.replace(/\s+/g,' ').trim()||'',insideInspector:!!document.activeElement?.closest('.switch-candidate-inspector')}));assert.match(focusAfterKeyboard.cls,/switch-candidate-row/);assert.equal(focusAfterKeyboard.insideInspector,false)
 const afterClose=await metrics(page);assert.equal(afterClose.firstIdentity.fontSize,'17px');assert.equal(afterClose.firstRelation.fontSize,'13px')
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('.switch-candidate-inspector')),false)
 await selected.click();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'});await page.locator('.switch-preview-topline button').click();await page.locator('.switch-candidate-inspector').waitFor({state:'detached'})
 const focusAfterPointer=await page.evaluate(()=>document.activeElement?.className||'');assert.match(focusAfterPointer,/switch-candidate-row/)
 return{candidateCount:count,relationText,unknownCandidate:unknownText,longCandidate:longText,beforeOpen,openMetrics,afterClose,tabTraversal:{closeReach,addReach,detailReach,closeReachAfterBack,addReachAfterBack,closeByShiftTab},focusAfterKeyboard,focusAfterPointer}
}
for(const [key,w,h] of [['mobile-390x844',390,844],['desktop-1440x900',1440,900]]){
 const {context,page}=await pageAt(w,h);await setup(page);await waitVisibleImages(page);await page.screenshot({path:`${OUT}/${key}-results.png`,fullPage:false})
 await page.locator('.switch-candidate-row').first().click();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'});await waitVisibleImages(page);await page.screenshot({path:`${OUT}/${key}-inspector.png`,fullPage:false})
 await page.locator('.switch-preview-topline button').click();await page.locator('.switch-candidate-inspector').waitFor({state:'detached'})
 report.scenarios[key]=await exercise(page,key);await context.close()
}
for(const [key,w,h] of [['boundary-760',760,844],['boundary-761',761,844]]){
 const {context,page}=await pageAt(w,h);await setup(page);const before=await metrics(page);assert.equal(before.firstIdentity.fontSize,'17px');assert.equal(before.firstRelation.fontSize,'13px')
 await page.locator('.switch-candidate-row').first().click();await page.locator('.switch-candidate-inspector').waitFor({state:'visible'});await waitVisibleImages(page);const m=await metrics(page);assert.equal(m.inspectorRelation.fontSize,'13px')
 report.scenarios[key]={before,open:m};await context.close()
}
{
 const {context,page}=await pageAt(1440,700);await setup(page);await page.locator('.switch-candidate-row').first().click();const inspector=page.locator('.switch-candidate-inspector');await inspector.waitFor({state:'visible'});await waitVisibleImages(page)
 const action=page.locator('.switch-inspector-actions button').first();const actionCheck=await action.evaluate(el=>{const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},center:{x,y},hit:!!hit&&(hit===el||el.contains(hit)),text:(hit?.textContent||'').trim()}})
 assert.ok(actionCheck.rect.top>=0&&actionCheck.rect.bottom<=700&&actionCheck.hit)
 const scroll=page.locator('.switch-inspector-scroll'),box=await scroll.boundingBox();assert.ok(box);await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,900)
 const wheelState=await page.evaluate(()=>document.querySelector('.switch-inspector-scroll')?.scrollTop||0);assert.ok(wheelState>0)
 const facts=page.locator('.switch-inspector-section').last();const factsCheck=await facts.evaluate(el=>{const r=el.getBoundingClientRect(),x=Math.max(r.left+1,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(r.top+1,Math.min(innerHeight-1,r.top+Math.min(r.height/2,40))),hit=document.elementFromPoint(x,y);return{rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},center:{x,y},hit:!!hit&&(hit===el||el.contains(hit)),text:(hit?.textContent||'').trim()}})
 assert.ok(factsCheck.rect.top<700&&factsCheck.rect.bottom>0&&factsCheck.hit)
 await page.keyboard.press('Home');const closeReach=await tabUntil(page,x=>x.text.includes('닫기 ×'));const addReach=await tabUntil(page,x=>/비교에 추가|비교에서 제거/.test(x.text))
 const focusedCheck=await page.evaluate(()=>{const el=document.activeElement,r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},center:{x,y},hit:!!hit&&(hit===el||el.contains(hit)),text:(el.textContent||'').trim()}})
 assert.ok(focusedCheck.rect.top>=0&&focusedCheck.rect.bottom<=700&&focusedCheck.hit)
 report.scenarios['desktop-short-1440x700']={actionCheck,wheelState,factsCheck,closeReach,addReach,focusedCheck};await context.close()
}
assert.ok(report.blocked.every(x=>x.analytics||!['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2));await browser.close()
