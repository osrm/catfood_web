import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
const BASE='https://osrm.github.io/catfood_web/',OUT=process.env.OUT_DIR||'postdeploy-manufacturing-output'
const DENTAL='product_fb71a7fa2fae880b',OTHER='product_02ae546cb45b4515',blocked=[]
const report={mergeSha:process.env.MERGE_SHA,pagesUrl:BASE,liveApi:true,blockedAttempts:0,httpGets:[],views:{},failure:null}
await mkdir(OUT,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
let activePage=null,activeName=null
async function saveFailure(error){report.failure={view:activeName,url:activePage?.url()||null,error:error instanceof Error?error.message:String(error)};if(activePage&&!activePage.isClosed())try{await activePage.screenshot({path:OUT+'/failure-'+(activeName||'unknown')+'.png',fullPage:false})}catch{};await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))}
async function open(w,h){
 const context=await browser.newContext({viewport:{width:w,height:h},serviceWorkers:'block'}),page=await context.newPage()
 await page.route('**/*',async route=>{const req=route.request(),u=req.url(),m=req.method(),bad=/search-runs|considerations|event_log|analytics|telemetry|functions\\/v1/i.test(u);if(!['GET','HEAD','OPTIONS'].includes(m)||bad){blocked.push({method:m,path:new URL(u).pathname});report.blockedAttempts++;return route.abort('blockedbyclient')}await route.continue()})
 page.on('response',async res=>{const req=res.request(),u=res.url();if(req.method()!=='GET'||!u.includes('.supabase.co/rest/v1/'))return;const url=new URL(u),name=url.pathname.split('/').at(-1);if(!/effective_product_catalog_summary|switch_current_variant_options|product_detail_manufacturing(?:_scope)?/.test(name))return;const e={endpoint:name,status:res.status(),productFilter:url.searchParams.get('product_id')||null,fields:[]};try{const body=await res.json(),rows=Array.isArray(body)?body:[];e.fields=rows.filter(x=>[DENTAL,OTHER].includes(x.product_id)||e.productFilter?.includes(x.product_id)).slice(0,5).map(x=>({product_id:x.product_id,variant_id:x.variant_id??undefined,package_size_text:x.package_size_text??undefined,country_code:x.country_code??undefined,observation_scope:x.observation_scope??undefined,manufacturing_country_codes:x.manufacturing_country_codes??undefined,manufacturing_has_variant_scope:x.manufacturing_has_variant_scope??undefined}))}catch{}report.httpGets.push(e)})
 return{context,page}
}
async function waitVisible(locator,label,timeout=30000){await locator.first().waitFor({state:'attached',timeout});const deadline=Date.now()+timeout;while(Date.now()<deadline){for(let i=0;i<await locator.count();i++){const x=locator.nth(i);if(await x.isVisible())return x}await new Promise(r=>setTimeout(r,100))}throw new Error(label+' visible target timed out')}
async function metric(page,loc,label){const m=await loc.evaluate(el=>{const r=el.getBoundingClientRect();return{text:(el.textContent||'').trim(),scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,top:r.top,bottom:r.bottom,left:r.left,right:r.right,viewportHeight:window.innerHeight}});assert.ok(m.top>=-1&&m.bottom<=m.viewportHeight+1,label+' not inside viewport');assert.ok(m.scrollWidth-m.clientWidth<=1,label+' clipped');return m}
try{
 {activeName='390-detail';const {context,page}=await open(390,844);activePage=page
  await page.goto(`${BASE}?view=workspace&mode=lookup&detail=${DENTAL}&detailTab=context`,{waitUntil:'domcontentloaded'})
  const value=await waitVisible(page.getByText('3.5 kg · 한국',{exact:false}),'detail manufacturing');await value.scrollIntoViewIfNeeded()
  const note=await waitVisible(page.getByText(/제조국은 확인한 포장을 기준으로 안내합니다/),'detail scope note');await note.scrollIntoViewIfNeeded()
  const vm=await metric(page,value,'detail manufacturing'),nm=await metric(page,note,'detail note')
  assert.equal(await page.getByText(/1\\.5 kg · 한국/).count(),0);assert.equal(await page.getByText(/8 kg · 한국/).count(),0)
  await page.screenshot({path:OUT+'/390-detail.png',fullPage:false});report.views.detail390={pass:true,url:page.url(),value:vm.text,note:nm.text,notExpandedTo:['1.5 kg','8 kg'],metrics:{value:vm,note:nm}};await context.close();activePage=null}
 {activeName='1440-compare';const {context,page}=await open(1440,900);activePage=page
  await page.goto(`${BASE}?view=workspace&mode=lookup&compare=${DENTAL},${OTHER}&compareOpen=1`,{waitUntil:'domcontentloaded'})
  const stage=page.locator('.compare-stage');await stage.waitFor({state:'visible',timeout:30000})
  const target=await waitVisible(stage.getByText(/확인된 포장 기준/),'compare manufacturing');await target.scrollIntoViewIfNeeded();const m=await metric(page,target,'compare manufacturing')
  assert.match(m.text,/확인된 포장 기준/);await page.screenshot({path:OUT+'/1440-compare.png',fullPage:false});report.views.compare1440={pass:true,url:page.url(),value:m.text,metrics:m};await context.close();activePage=null}
 assert.ok(report.httpGets.some(x=>x.endpoint==='effective_product_catalog_summary'&&x.status===200))
 assert.ok(report.httpGets.some(x=>x.endpoint==='switch_current_variant_options'&&x.status===200))
 assert.ok(report.httpGets.some(x=>x.endpoint==='product_detail_manufacturing'&&x.status===200))
 assert.ok(report.httpGets.some(x=>x.endpoint==='product_detail_manufacturing_scope'&&x.status===200))
 await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))
}catch(error){await saveFailure(error);throw error}finally{await browser.close()}
