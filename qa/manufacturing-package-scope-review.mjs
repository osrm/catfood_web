import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE=process.env.CANDIDATE_URL||'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'manufacturing-package-scope-output'
await mkdir(OUT,{recursive:true})
const blocked=[]
const OVERFLOW_TOLERANCE_PX=1 // allow subpixel/layout rounding only; >1px is a failure
// Fixture-only browser evidence; this does not claim live API validation.
const report={sourceSha:process.env.CANDIDATE_SHA||process.env.GITHUB_SHA,fixtureOnly:true,blocked,views:{}}

function product(id,name,countries,variantScope,overrides={}){
 return {product_id:id,brand:'Scope Brand',canonical_name:name,feed_type:'건식',life_stage:'adult',display_image_url:null,representative_variant_id:null,representative_package_size_text:'3.5 kg',representative_package_weight_g:3500,representative_units_per_sale:1,representative_sale_total_weight_g:3500,variant_count:3,has_variants:true,ingredient_declaration_count:0,full_ingredient_declaration_count:0,has_ingredient_details:false,has_full_ingredient_declaration:false,nutrition_panel_count:0,has_nutrition_details:false,manufacturing_observation_count:countries.length,has_manufacturing_details:countries.length>0,manufacturing_country_codes:countries,manufacturing_has_variant_scope:variantScope,market_observation_count:0,has_market_details:false,assessed_market_country_codes:[],current_market_country_codes:[],formula_match_market_country_codes:[],ingredient_term_result_count:0,confirmed_present_ingredient_terms:[],direct_evidence_ingredient_terms:[],flavor_associated_ingredient_terms:[],reviewed_not_found_ingredient_terms:[],insufficient_evidence_ingredient_terms:[],official_targets:[],features:[],recipe_families:[],recipe_details:[],official_recipe_traits:[],...overrides}
}
const dental=product('product_1111111111111111','덴탈케어 제조국 범위 테스트',['KR'],true)
const multi=product('product_2222222222222222','여러 포장과 복수 제조국을 가진 아주 긴 테스트 제품명',['US','TH','CA','NZ','AU','GB'],true,{representative_package_size_text:'아주 긴 판매 규격 이름 12.345 kg'})
const current=product('product_3333333333333333','현재 사료',['KR'],false,{brand:'Current Brand',variant_count:1,has_variants:true})
const products=[dental,multi,current]
const variants={
 [dental.product_id]:[
  {product_id:dental.product_id,variant_id:'variant_1111111111111111',package_size_text:'1.5 kg',package_weight_g:1500,units_per_sale:1,sale_total_weight_g:1500,sales_bundle_status:'not_a_bundle',display_rank:1,variant_count:3,formula_evidence_status:'confirmed',recipe_families:[],recipe_details:[],official_recipe_traits:[],ingredient_term_result_count:0,confirmed_present_ingredient_terms:[],direct_evidence_ingredient_terms:[],flavor_associated_ingredient_terms:[],reviewed_not_found_ingredient_terms:[],insufficient_evidence_ingredient_terms:[]},
  {product_id:dental.product_id,variant_id:'variant_1111111111111112',package_size_text:'3.5 kg',package_weight_g:3500,units_per_sale:1,sale_total_weight_g:3500,sales_bundle_status:'not_a_bundle',display_rank:2,variant_count:3,formula_evidence_status:'confirmed',recipe_families:[],recipe_details:[],official_recipe_traits:[],ingredient_term_result_count:0,confirmed_present_ingredient_terms:[],direct_evidence_ingredient_terms:[],flavor_associated_ingredient_terms:[],reviewed_not_found_ingredient_terms:[],insufficient_evidence_ingredient_terms:[]},
  {product_id:dental.product_id,variant_id:'variant_1111111111111113',package_size_text:'8 kg',package_weight_g:8000,units_per_sale:1,sale_total_weight_g:8000,sales_bundle_status:'not_a_bundle',display_rank:3,variant_count:3,formula_evidence_status:'confirmed',recipe_families:[],recipe_details:[],official_recipe_traits:[],ingredient_term_result_count:0,confirmed_present_ingredient_terms:[],direct_evidence_ingredient_terms:[],flavor_associated_ingredient_terms:[],reviewed_not_found_ingredient_terms:[],insufficient_evidence_ingredient_terms:[]}
 ],
 [multi.product_id]:[
  {product_id:multi.product_id,variant_id:'variant_2222222222222221',package_size_text:'2 kg',package_weight_g:2000,units_per_sale:1,sale_total_weight_g:2000,sales_bundle_status:'not_a_bundle',display_rank:1,variant_count:2,formula_evidence_status:'confirmed',recipe_families:[],recipe_details:[],official_recipe_traits:[],ingredient_term_result_count:0,confirmed_present_ingredient_terms:[],direct_evidence_ingredient_terms:[],flavor_associated_ingredient_terms:[],reviewed_not_found_ingredient_terms:[],insufficient_evidence_ingredient_terms:[]},
  {product_id:multi.product_id,variant_id:'variant_2222222222222222',package_size_text:'아주 긴 판매 규격 이름 12.345 kg',package_weight_g:12345,units_per_sale:1,sale_total_weight_g:12345,sales_bundle_status:'not_a_bundle',display_rank:2,variant_count:2,formula_evidence_status:'confirmed',recipe_families:[],recipe_details:[],official_recipe_traits:[],ingredient_term_result_count:0,confirmed_present_ingredient_terms:[],direct_evidence_ingredient_terms:[],flavor_associated_ingredient_terms:[],reviewed_not_found_ingredient_terms:[],insufficient_evidence_ingredient_terms:[]}
 ],
 [current.product_id]:[{product_id:current.product_id,variant_id:'variant_3333333333333331',package_size_text:'1 kg',package_weight_g:1000,units_per_sale:1,sale_total_weight_g:1000,sales_bundle_status:'not_a_bundle',display_rank:1,variant_count:1,formula_evidence_status:'confirmed',recipe_families:[],recipe_details:[],official_recipe_traits:[],ingredient_term_result_count:0,confirmed_present_ingredient_terms:[],direct_evidence_ingredient_terms:[],flavor_associated_ingredient_terms:[],reviewed_not_found_ingredient_terms:[],insufficient_evidence_ingredient_terms:[]}]
}
const scopeRows={
 [dental.product_id]:[{product_id:dental.product_id,variant_id:'variant_1111111111111112',observation_scope:'variant',country_code:'KR',manufacturer:null,plant:null,is_current_resolved_formula:false,display_rank:1}],
 [multi.product_id]:[
  {product_id:multi.product_id,variant_id:'variant_2222222222222221',observation_scope:'variant',country_code:'US',manufacturer:null,plant:null,is_current_resolved_formula:false,display_rank:1},
  {product_id:multi.product_id,variant_id:'variant_2222222222222221',observation_scope:'variant',country_code:'TH',manufacturer:null,plant:null,is_current_resolved_formula:false,display_rank:2},
  {product_id:multi.product_id,variant_id:'variant_2222222222222222',observation_scope:'variant',country_code:'CA',manufacturer:null,plant:null,is_current_resolved_formula:false,display_rank:3},
  {product_id:multi.product_id,variant_id:'variant_2222222222222222',observation_scope:'variant',country_code:'NZ',manufacturer:null,plant:null,is_current_resolved_formula:false,display_rank:4},
  {product_id:multi.product_id,variant_id:'variant_2222222222222222',observation_scope:'variant',country_code:'AU',manufacturer:null,plant:null,is_current_resolved_formula:false,display_rank:5},
  {product_id:multi.product_id,variant_id:'variant_2222222222222222',observation_scope:'variant',country_code:'GB',manufacturer:null,plant:null,is_current_resolved_formula:false,display_rank:6}
 ],
 [current.product_id]:[{product_id:current.product_id,variant_id:null,observation_scope:'product',country_code:'KR',manufacturer:null,plant:null,is_current_resolved_formula:false,display_rank:1}]
}
function json(route,body){return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']})
async function pageAt(w,h){
 const context=await browser.newContext({viewport:{width:w,height:h},serviceWorkers:'block'}),page=await context.newPage()
 // Installed before the first navigation: writes/analytics are never allowed to leave the fixture browser.
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),method=req.method()
  if(!['GET','HEAD','OPTIONS'].includes(method)||/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(url.pathname)){blocked.push({method,url:url.href});return route.abort('blockedbyclient')}
  if(url.origin==='https://api.test'||url.hostname.endsWith('.supabase.co')){
   const name=url.pathname.split('/').at(-1)
   if(name==='effective_product_catalog_summary') return json(route,products)
   if(name==='switch_current_variant_options'){const id=(url.searchParams.get('product_id')||'').replace(/^eq\./,'');return json(route,variants[id]||[])}
   if(name==='product_detail_manufacturing'){const id=(url.searchParams.get('product_id')||'').replace(/^eq\./,'');const row=(scopeRows[id]||[])[0];return json(route,row?[{...row,variant_id:undefined,display_rank:undefined}]:[])}
   if(name==='product_detail_manufacturing_scope'){const id=(url.searchParams.get('product_id')||'').replace(/^eq\./,'');return json(route,scopeRows[id]||[])}
   if(name==='compare_product_nutrition'||name==='compare_product_ingredients'||name==='product_detail_markets') return json(route,[])
   return json(route,[])
  }
  await route.continue()
 })
 return {context,page}
}
async function screenshotView(page,path){await page.screenshot({path:`${OUT}/${path}`,fullPage:false})}
async function assertVisibleNoHorizontalOverflow(page,selector,label,textNeedle=null){
 const metrics=await page.locator(selector).evaluateAll((nodes,args)=>nodes.map(n=>{
  const style=getComputedStyle(n),rect=n.getBoundingClientRect(),text=(n.textContent||'').trim()
  const visible=style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&rect.width>0&&rect.height>0
  return {text,visible,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,overflowPx:n.scrollWidth-n.clientWidth}
 }).filter(x=>x.visible&&(!args.textNeedle||x.text.includes(args.textNeedle))),{textNeedle})
 assert.ok(metrics.length>0,`${label}: expected at least one visible target`)
 for(const metric of metrics) assert.ok(metric.overflowPx<=OVERFLOW_TOLERANCE_PX,`${label}: visible target horizontally overflows by ${metric.overflowPx}px: ${metric.text}`)
 return metrics
}
async function assertNoHorizontalPageOverflow(page,label){
 const metrics=await page.evaluate(()=>{
  const doc=document.scrollingElement||document.documentElement
  const visible=node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0}
  const owners=[...document.querySelectorAll('*')].filter(node=>visible(node)&&['auto','scroll'].includes(getComputedStyle(node).overflowX)&&node.scrollWidth>node.clientWidth)
    .map(node=>({kind:'scroll-owner',tag:node.tagName,className:node.className,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,overflowPx:node.scrollWidth-node.clientWidth}))
  return {document:{kind:'document',scrollWidth:doc.scrollWidth,clientWidth:doc.clientWidth,overflowPx:doc.scrollWidth-doc.clientWidth},owners}
 })
 assert.ok(metrics.document.clientWidth>0,`${label}: document scroll owner must be measurable`)
 assert.ok(metrics.document.overflowPx<=OVERFLOW_TOLERANCE_PX,`${label}: document horizontally overflows by ${metrics.document.overflowPx}px`)
 for(const owner of metrics.owners) assert.ok(owner.overflowPx<=OVERFLOW_TOLERANCE_PX,`${label}: visible horizontal scroll owner overflows by ${owner.overflowPx}px`)
 return metrics
}
for(const [label,w,h] of [['390',390,844],['1440',1440,900]]){
 const {context,page}=await pageAt(w,h)
 await page.goto(`${BASE}?view=workspace&mode=lookup&detail=${dental.product_id}&detailTab=context`,{waitUntil:'domcontentloaded'})
 await page.getByText('3.5 kg · 한국').waitFor()
 assert.equal(await page.getByText(/1\.5 kg · 한국/).count(),0);assert.equal(await page.getByText(/8 kg · 한국/).count(),0)
 await screenshotView(page,`${label}-detail.png`)
 const detailTargets=await assertVisibleNoHorizontalOverflow(page,'.detail-fact strong,.detail-note',`${label} detail manufacturing value`,'3.5 kg · 한국')
 const detailPage=await assertNoHorizontalPageOverflow(page,`${label} detail`)
 report.views[`${label}-detail`]={text:(await page.locator('.detail-document').innerText()).slice(0,1800),targets:detailTargets,horizontalLayout:detailPage,overflowTolerancePx:OVERFLOW_TOLERANCE_PX}

 await page.goto(`${BASE}?view=workspace&mode=lookup&compare=${dental.product_id},${multi.product_id}&compareOpen=1`,{waitUntil:'domcontentloaded'})
 await page.locator('.compare-stage').waitFor();assert.match(await page.locator('.compare-stage').innerText(),/확인된 포장 기준/)
 await page.evaluate(()=>{const xs=[...document.querySelectorAll('*')].filter(n=>n.textContent?.trim()==='제조국'&&n.getClientRects().length);xs.at(-1)?.scrollIntoView({block:'center'})})
 await screenshotView(page,`${label}-compare.png`)
 const compareTargets=await assertVisibleNoHorizontalOverflow(page,'.compare-cell,.compare-mobile-two-product-value',`${label} compare manufacturing value`,'확인된 포장 기준')
 const comparePage=await assertNoHorizontalPageOverflow(page,`${label} compare`)
 report.views[`${label}-compare`]={text:(await page.locator('.compare-stage').innerText()).slice(0,2200),targets:compareTargets,horizontalLayout:comparePage,overflowTolerancePx:OVERFLOW_TOLERANCE_PX}

 await page.goto(`${BASE}?view=workspace&mode=switch`,{waitUntil:'domcontentloaded'})
 const search=page.locator('.switch-find-search input');await search.fill('현재 사료');await page.locator('.switch-find-result').filter({hasText:'현재 사료'}).click();await page.getByRole('button',{name:/이 제품을 현재 사료로 선택/}).click()
 await page.locator('.switch-sku-option').filter({hasText:'1 kg'}).click();await page.locator('.switch-step-actions .switch-primary-action').click()
 await page.getByRole('button',{name:'다른 브랜드로 보기'}).click();await page.locator('.switch-step-actions .switch-primary-action').click()
 await page.locator('.switch-step-actions .switch-primary-action').click();await page.locator('.switch-candidate-row').filter({hasText:multi.canonical_name}).click()
 await page.locator('.switch-candidate-inspector').waitFor();assert.match(await page.locator('.switch-candidate-inspector').innerText(),/확인된 포장 기준/)
 await page.evaluate(()=>{const xs=[...document.querySelectorAll('.switch-candidate-inspector dt')].filter(n=>n.textContent?.trim()==='제조국');xs[0]?.scrollIntoView({block:'center'})})
 await screenshotView(page,`${label}-inspector.png`)
 const inspectorTargets=await assertVisibleNoHorizontalOverflow(page,'.switch-inspector-section dd',`${label} inspector manufacturing value`,'확인된 포장 기준')
 const inspectorName=await assertVisibleNoHorizontalOverflow(page,'.switch-inspector-identity h1',`${label} inspector long product name`)
 const inspectorPage=await assertNoHorizontalPageOverflow(page,`${label} inspector`)
 report.views[`${label}-inspector`]={text:(await page.locator('.switch-candidate-inspector').innerText()).slice(0,2200),targets:inspectorTargets,longName:inspectorName,horizontalLayout:inspectorPage,overflowTolerancePx:OVERFLOW_TOLERANCE_PX}
 await context.close()
}
assert.ok(blocked.every(x=>!['GET','HEAD','OPTIONS'].includes(x.method)||/search-runs|considerations|event_log|analytics|telemetry|functions\/v1/i.test(x.url)))
await writeFile(`${OUT}/report.json`,JSON.stringify(report,null,2))
await browser.close()
