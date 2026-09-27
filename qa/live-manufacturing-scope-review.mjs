import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'live-manufacturing-scope-output'
const DENTAL='product_fb71a7fa2fae880b'
const MULTI='product_02ae546cb45b4515'
const blocked=[]
const report={sourceSha:process.env.CANDIDATE_SHA,liveApi:true,blockedAttempts:0,httpGets:[],views:{}}
await mkdir(OUT,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})

const wanted=/effective_product_catalog_summary|switch_current_variant_options|product_detail_manufacturing(?:_scope)?/
async function pageAt(w,h){
 const context=await browser.newContext({viewport:{width:w,height:h},serviceWorkers:'block'}),page=await context.newPage()
 await page.route('**/*',async route=>{
  const req=route.request(),url=req.url(),method=req.method()
  const analytics=/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url)
  if(!['GET','HEAD','OPTIONS'].includes(method)||analytics){blocked.push({method,path:new URL(url).pathname,analytics});report.blockedAttempts++;return route.abort('blockedbyclient')}
  await route.continue()
 })
 page.on('response',async res=>{
  const req=res.request(),url=res.url()
  if(req.method()!=='GET'||!url.includes('.supabase.co/rest/v1/')||!wanted.test(url))return
  const u=new URL(url),entry={path:u.pathname.split('/').at(-1),status:res.status(),productFilter:u.searchParams.get('product_id')||null,fields:[]}
  try{const body=await res.json();const rows=Array.isArray(body)?body:[];entry.fields=rows.filter(x=>!entry.productFilter||[DENTAL,MULTI].includes(x.product_id)).slice(0,6).map(x=>({product_id:x.product_id,variant_id:x.variant_id??undefined,package_size_text:x.package_size_text??undefined,country_code:x.country_code??undefined,observation_scope:x.observation_scope??undefined,manufacturing_country_codes:x.manufacturing_country_codes??undefined,manufacturing_has_variant_scope:x.manufacturing_has_variant_scope??undefined}))}catch{}
  report.httpGets.push(entry)
 })
 return{context,page}
}
async function noOverflow(page,loc,label){
 const m=await loc.evaluate(el=>{const r=el.getBoundingClientRect();return{text:(el.textContent||'').trim(),visible:r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden',scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}})
 assert.ok(m.visible,label+' not visible');assert.ok(m.scrollWidth-m.clientWidth<=1,label+' horizontal overflow');return m
}
async function shot(page,name){await page.screenshot({path:`${OUT}/${name}.png`,fullPage:false})}
async function firstVisible(locator,label){for(let i=0;i<await locator.count();i++)if(await locator.nth(i).isVisible())return locator.nth(i);throw new Error(label+' visible target not found')}
async function detail(page,label){
 await page.goto(`${BASE}?view=workspace&mode=lookup&detail=${DENTAL}&detailTab=context`,{waitUntil:'domcontentloaded'})
 const target=page.getByText('3.5 kg · 한국',{exact:false}).first();await target.waitFor({state:'visible',timeout:30000})
 assert.equal(await page.getByText(/1\.5 kg · 한국/).count(),0);assert.equal(await page.getByText(/8 kg · 한국/).count(),0)
 await target.scrollIntoViewIfNeeded();const m=await noOverflow(page,target,label+' detail')
 await shot(page,label+'-detail');report.views[label+'-detail']={pass:true,manufacturing:m.text,notExpandedTo:['1.5 kg','8 kg'],metrics:m}
 return norm(await page.locator('.detail-identity h1').textContent())
}
const norm=v=>String(v||'').replace(/\s+/g,' ').trim()
async function compare(page,label){
 await page.goto(`${BASE}?view=workspace&mode=lookup&compare=${DENTAL},${MULTI}&compareOpen=1`,{waitUntil:'domcontentloaded'})
 const stage=page.locator('.compare-stage');await stage.waitFor({state:'visible',timeout:30000})
 const values=stage.getByText(/확인된 포장 기준/);assert.ok(await values.count()>0)
 const target=await firstVisible(values,label+' compare');await target.scrollIntoViewIfNeeded();const m=await noOverflow(page,target,label+' compare')
 await shot(page,label+'-compare');report.views[label+'-compare']={pass:true,value:m.text,metrics:m}
}
async function button(page,name){const xs=page.getByRole('button',{name,exact:true});for(let i=0;i<await xs.count();i++)if(await xs.nth(i).isVisible())return xs.nth(i);throw new Error('button '+name)}
async function inspector(page,label,dentalName){
 await page.goto(`${BASE}?view=workspace&mode=switch`,{waitUntil:'domcontentloaded'})
 await page.getByRole('button',{name:'현재 사료로 시작 →'}).click()
 await page.waitForFunction(()=>document.querySelector('.research-status')?.textContent?.includes('데이터 연결됨'),null,{timeout:30000})
 const search=page.locator('.switch-find-search input');await search.fill('AATU')
 const row=page.locator('.switch-find-result').filter({hasText:/연어/}).first();await row.waitFor({state:'visible'});await row.click()
 await page.getByRole('button',{name:'이 제품을 현재 사료로 선택 →'}).click()
 const sku=page.locator('.switch-sku-option').first();await sku.waitFor({state:'visible'});await sku.click();await page.locator('.switch-step-actions .switch-primary-action').click()
 await (await button(page,'다른 브랜드로 보기')).click()
 await page.locator('.switch-step-actions .switch-primary-action').click()
 await page.getByRole('heading',{name:'무엇을 그대로 유지할까요?'}).waitFor()
 await (await button(page,'건식 유지')).click()
 await page.locator('.switch-step-actions .switch-primary-action').click()
 const candidate=page.locator('.switch-candidate-row').filter({hasText:dentalName}).first();await candidate.waitFor({state:'visible',timeout:30000});await candidate.click()
 const panel=page.locator('.switch-candidate-inspector');await panel.waitFor({state:'visible'})
 const target=await firstVisible(panel.getByText(/확인된 포장 기준/),label+' inspector');await target.waitFor({state:'visible'});await target.scrollIntoViewIfNeeded();const m=await noOverflow(page,target,label+' inspector')
 await shot(page,label+'-inspector');report.views[label+'-inspector']={pass:true,candidate:dentalName,value:m.text,metrics:m}
}
for(const [label,w,h] of [['390',390,844],['1440',1440,900]]){
 const {context,page}=await pageAt(w,h)
 const dentalName=await detail(page,label);await compare(page,label);await inspector(page,label,dentalName);await context.close()
}
assert.ok(report.httpGets.some(x=>x.path==='effective_product_catalog_summary'&&x.status===200))
assert.ok(report.httpGets.some(x=>x.path==='switch_current_variant_options'&&x.status===200))
assert.ok(report.httpGets.some(x=>x.path==='product_detail_manufacturing'&&x.status===200))
assert.ok(report.httpGets.some(x=>x.path==='product_detail_manufacturing_scope'&&x.status===200))
assert.ok(blocked.every(x=>x.analytics||!['GET','HEAD','OPTIONS'].includes(x.method)))
await writeFile(OUT+'/report.json',JSON.stringify(report,null,2));await browser.close()
