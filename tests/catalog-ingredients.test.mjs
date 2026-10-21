import assert from 'node:assert/strict'
import { before, after, beforeEach, afterEach, test } from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
const dom = new JSDOM('<div id="root"></div>', {url:'https://catfood.test/'})
globalThis.window=dom.window; globalThis.document=dom.window.document; globalThis.sessionStorage=dom.window.sessionStorage
window.HTMLElement.prototype.scrollIntoView=function(){}
globalThis.IS_REACT_ACT_ENVIRONMENT=true
const {createRoot}=await import('react-dom/client')
const nativeFetch=globalThis.fetch
let app,root,temp,rows,requests,factsHandler
function product(id, name, overrides = {}) {
  return {
    product_id: id,
    brand: 'Test Brand',
    canonical_name: name,
    feed_type: '건식',
    life_stage: 'adult',
    display_image_url: null,
    representative_variant_id: null,
    representative_package_size_text: null,
    representative_package_weight_g: null,
    representative_units_per_sale: null,
    representative_sale_total_weight_g: null,
    variant_count: 0,
    has_variants: false,
    ingredient_declaration_count: 0,
    full_ingredient_declaration_count: 0,
    has_ingredient_details: false,
    has_full_ingredient_declaration: false,
    nutrition_panel_count: 0,
    has_nutrition_details: false,
    manufacturing_observation_count: 0,
    has_manufacturing_details: false,
    manufacturing_country_codes: [],
    market_observation_count: 0,
    has_market_details: false,
    assessed_market_country_codes: [],
    current_market_country_codes: [],
    formula_match_market_country_codes: [],
    ingredient_term_result_count: 0,
    confirmed_present_ingredient_terms: [],
    direct_evidence_ingredient_terms: [],
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
    official_targets: [],
    features: [],
    recipe_families: [],
    recipe_details: [],
    official_recipe_traits: [],
    ...overrides,
  }
}

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
before(async()=>{
 await mkdir(resolve('node_modules/.cache'),{recursive:true})
 temp=await mkdtemp(resolve('node_modules/.cache/catalog-facts-'))
 const result=await build({configFile:false,logLevel:'silent',define:{'import.meta.env.DEV':'false','import.meta.env.VITE_DECISION_INTAKE_ENABLED':'"false"','import.meta.env.VITE_SUPABASE_URL':'"https://api.test"','import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'"test-key"'},build:{ssr:'tests/entry.ts',write:false,minify:false}})
 const file=resolve(temp,'entry.mjs');await writeFile(file,result.output.find(x=>x.type==='chunk'&&x.isEntry).code);app=await import(pathToFileURL(file).href)
})
after(async()=>{globalThis.fetch=nativeFetch;dom.window.close();if(temp)await rm(temp,{recursive:true})})
beforeEach(()=>{
 dom.reconfigure({url:'https://catfood.test/'});sessionStorage.clear();document.getElementById('root').replaceChildren()
 rows=[product('product_0000000000000001','Alpha',{confirmed_present_ingredient_terms:['chicken'],direct_evidence_ingredient_terms:['chicken'],ingredient_term_result_count:2}),product('product_0000000000000002','Beta',{reviewed_not_found_ingredient_terms:['chicken'],ingredient_term_result_count:2})]
 requests=[];factsHandler=async(url)=>Response.json(url.searchParams.has('product_id') ? rows.filter(row=>'eq.'+row.product_id===url.searchParams.get('product_id')) : rows)
 globalThis.fetch=window.fetch=async(input,init={})=>{
   const url=new URL(String(input));assert.equal(url.origin,'https://api.test');requests.push({url,signal:init.signal})
   if(url.pathname.endsWith('/effective_product_catalog_summary'))return url.searchParams.get('select').split(',').includes('ingredient_term_result_count')?factsHandler(url,init):Response.json(rows)
   if(url.pathname.endsWith('/compare_product_ingredients_scoped'))return Response.json(rows.map(row=>({product_id:row.product_id,ingredient_names:['chicken','peas'],raw_text:'chicken, peas',ingredient_count:2,completeness_status:'full',declaration_scope:'product'})))
   return Response.json([])
 };root=createRoot(document.getElementById('root'))
})
afterEach(async()=>{await act(async()=>root.unmount())})
const text=()=>document.body.textContent
const facts=()=>requests.filter(x=>x.url.pathname.endsWith('/effective_product_catalog_summary') && x.url.searchParams.get('select')?.split(',').includes('ingredient_term_result_count'))
async function mount(query=''){window.history.replaceState(null,'','/'+query);await act(async()=>root.render(createElement(app.App)))}
async function click(label){const button=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(label));assert.ok(button,'missing '+label);await act(async()=>button.click())}
async function settle(p,body){await act(async()=>p.resolve(Response.json(body)))}

test('basic catalog projects 33 fields and keeps unfetched facts null, not empty',async()=>{
 const products=await app.fetchCatalog();const q=requests[0].url.searchParams.get('select').split(',')
 assert.equal(q.length,33);assert.ok(!q.includes('confirmed_present_ingredient_terms'))
 assert.equal(products[0].ingredient_term_result_count,null);assert.equal(products[0].confirmed_present_ingredient_terms,null)
 assert.equal(products[0].direct_evidence_ingredient_terms,null);assert.equal(products[0].canonical_name,'Alpha');assert.equal(facts().length,0)
})
test('fact API accepts loaded empty facts but rejects missing, duplicate, foreign and malformed rows',async()=>{
 const ids=rows.map(x=>x.product_id);const loaded=await app.fetchCatalogIngredientFacts(ids);assert.equal(loaded.length,2);assert.equal('brand' in loaded[0],false)
 assert.equal(facts()[0].url.searchParams.get('select').split(',').length,7)
 for(const invalid of [[rows[0]],[rows[0],rows[0]],[rows[0],{...rows[1],product_id:'foreign'}],[rows[0],{...rows[1],reviewed_not_found_ingredient_terms:null}],[rows[0],{...rows[1],confirmed_present_ingredient_terms:['chicken',1]}]]){
   factsHandler=async()=>Response.json(invalid);await assert.rejects(app.fetchCatalogIngredientFacts(ids))
 }
})
test('HOME and pure name search do not start a fact read',async()=>{
 await mount();assert.equal(facts().length,0)
 await click('제품 찾기');assert.equal(facts().length,0)
 const input=document.querySelector('input[type="search"]');await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'Alpha');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
 assert.match(text(),/Alpha/);assert.equal(facts().length,0)
})
test('ingredient exclusion deep link waits, then excludes confirmed products without calling pending evidence unknown',async()=>{
 const p=deferred();factsHandler=()=>p.promise
 await mount('?view=workspace&mode=explore&applied=1&feed=건식&age=adult&avoidIngredients=chicken')
 assert.equal(facts().length,1);assert.match(text(),/원료 확인 정보를 불러오는 중/);assert.doesNotMatch(text(),/검색 결과가 없습니다|원료 미확인|검토 자료에서 못 찾음/)
 await settle(p,rows)
 const cards=[...document.querySelectorAll('[data-product-id]')];assert.ok(cards.some(x=>x.dataset.productId===rows[1].product_id));assert.ok(!cards.some(x=>x.dataset.productId===rows[0].product_id))
 assert.equal(facts().length,1)
})
test('detail summary retries only its product and does not mark catalog-wide facts loaded',async()=>{
 let p=deferred();factsHandler=()=>p.promise
 await mount('?view=workspace&mode=lookup&q=Alpha&detail='+rows[0].product_id)
 assert.match(text(),/Alpha/);assert.match(text(),/원료 확인 정보를 불러오는 중/);assert.doesNotMatch(text(),/직접 확인 원료/)
 await act(async()=>p.resolve(new Response('failure',{status:503})));assert.match(text(),/원료 확인 정보를 불러오지 못했습니다/);assert.match(text(),/Alpha/)
 factsHandler=async()=>Response.json([rows[0]]);const beforeRetry=requests.length;await click('다시 시도');assert.match(text(),/직접 확인 원료/);assert.match(text(),/닭/);assert.equal(facts().length,2);assert.equal(requests.length,beforeRetry+1)
 await click('돌아가기');await click('Alpha');await click('상세 보기');assert.equal(facts().length,3)
 assert.ok(facts().every(request=>request.url.searchParams.get('product_id')==='eq.'+rows[0].product_id))
})
test('aborted catalog generation cannot apply an old ingredient response after unmount',async()=>{
 const p=deferred();factsHandler=()=>p.promise
 await mount('?view=workspace&mode=explore&applied=1&avoidIngredients=chicken');const signal=facts()[0].signal
 await act(async()=>root.unmount());assert.equal(signal.aborted,true)
 root=createRoot(document.getElementById('root'));factsHandler=async()=>Response.json(rows)
 await mount('?view=workspace&mode=lookup&q=Alpha');await settle(p,rows);assert.match(text(),/Alpha/);assert.equal(facts().length,1)
})

test('comparison overview and nutrition skip facts; ingredients and detail reuse the completed read',async()=>{
 await mount('?view=workspace&mode=lookup&q=Alpha&compare='+rows.map(r=>r.product_id).join(',')+'&compareOpen=1')
 assert.equal(facts().length,0)
 await click('영양');assert.equal(facts().length,0)
 const p=deferred();factsHandler=()=>p.promise;await click('원재료');assert.equal(facts().length,1)
 assert.match(text(),/원료 확인 정보를 불러오는 중/);assert.match(text(),/chicken, peas/)
 await settle(p,rows);assert.match(text(),/직접 확인 원료/)
 await click('개요');await click('원재료');assert.equal(facts().length,1)
 await click('상세 보기');await click('비교로 돌아가기');assert.equal(facts().length,1)
 assert.match(window.location.search,/compare=/)
})
test('restored SWITCH current and SKU skip facts; results failure and retry preserve current, variant and comparison',async()=>{
 const session=app.createInitialSwitchSession('Alpha');session.currentProductId=rows[0].product_id;session.variantSelection={kind:'unknown',variantId:null};session.step='sku';session.compareIds=[rows[1].product_id]
 app.writeSwitchSession(session,window.sessionStorage)
 await mount('?view=workspace&mode=switch');assert.equal(facts().length,0)
 await act(async()=>root.unmount());root=createRoot(document.getElementById('root'))
 session.step='results';app.writeSwitchSession(session,window.sessionStorage);factsHandler=async()=>new Response('failure',{status:503})
 await mount('?view=workspace&mode=switch');assert.match(text(),/원료 확인 정보를 불러오지 못했습니다/)
 let saved=app.readSwitchSession(window.sessionStorage);assert.equal(saved.currentProductId,rows[0].product_id);assert.equal(saved.variantSelection.kind,'unknown');assert.deepEqual(saved.compareIds,[rows[1].product_id])
 factsHandler=async()=>Response.json(rows);await click('다시 시도');assert.match(text(),/Beta/);assert.equal(facts().length,2)
 saved=app.readSwitchSession(window.sessionStorage);assert.deepEqual(saved.compareIds,[rows[1].product_id]);assert.equal(saved.step,'results')
})

test('name lookup carrying applied ingredient conditions stays usable without a phantom loading notice',async()=>{
 await mount('?view=workspace&mode=lookup&q=Alpha&applied=1&avoidIngredients=chicken')
 await click('Alpha');assert.match(text(),/Alpha/);assert.equal(facts().length,0);assert.doesNotMatch(text(),/원료 확인 정보를 불러오는 중/)
 await click('비교에 추가');await click('닫기');await click('비교 보기');assert.equal(facts().length,1)
})


test('product fact API filters exactly one product and rejects incomplete or unrelated results', async () => {
 const id=rows[0].product_id
 const loaded=await app.fetchProductIngredientFacts(id)
 assert.deepEqual(loaded.direct_evidence_ingredient_terms,['chicken'])
 assert.equal(facts()[0].url.searchParams.get('product_id'),'eq.'+id)
 assert.equal(facts()[0].url.searchParams.get('limit'),'1')
 for(const invalid of [[],[rows[1]],[rows[0],rows[0]],[{...rows[0],direct_evidence_ingredient_terms:null}]]){
  factsHandler=async()=>Response.json(invalid)
  await assert.rejects(app.fetchProductIngredientFacts(id))
 }
 factsHandler=async()=>Response.json([{...rows[0],ingredient_term_result_count:0,confirmed_present_ingredient_terms:[],direct_evidence_ingredient_terms:[]}])
 assert.equal((await app.fetchProductIngredientFacts(id)).ingredient_term_result_count,0)
})

test('comparison detail uses one product without starting its hidden ingredients tab global load', async () => {
 const products=await app.fetchCatalog();let globalRequests=0
 const props={items:products.map(product=>({product})),initialTab:'ingredients',onClose(){},onRemove(){},ingredientLoad:{status:'idle',onRequest(){globalRequests++},onRetry(){}}}
 await act(async()=>root.render(createElement(app.CompareView,{...props,detailProductId:rows[0].product_id})))
 assert.equal(facts().length,1)
 assert.equal(facts()[0].url.searchParams.get('product_id'),'eq.'+rows[0].product_id)
 assert.match(text(),/직접 확인 원료/)
 assert.equal(globalRequests,0)
 await act(async()=>root.render(createElement(app.CompareView,{...props,detailProductId:null})))
 assert.equal(globalRequests,1,'the visible comparison ingredients tab still requests complete facts')
})

test('scoped detail response never substitutes for the complete exclusion read after return', async () => {
 await mount('?view=workspace&mode=explore&applied=1&avoidIngredients=chicken&detail='+rows[1].product_id)
 assert.equal(facts().length,1)
 assert.equal(facts()[0].url.searchParams.get('product_id'),'eq.'+rows[1].product_id)
 assert.match(text(),/전체 원재료 2개 확인/)
 await click('돌아가기')
 assert.equal(facts().length,2)
 assert.equal(facts()[1].url.searchParams.get('product_id'),null)
 const cards=[...document.querySelectorAll('[data-product-id]')]
 assert.ok(cards.some(x=>x.dataset.productId===rows[1].product_id))
 assert.ok(!cards.some(x=>x.dataset.productId===rows[0].product_id))
})

test('scoped facts retry deduplicates active clicks and ignores a late previous product response', async () => {
 const products=await app.fetchCatalog(),first=deferred(),retry=deferred()
 factsHandler=()=>first.promise
 await act(async()=>root.render(createElement(app.ProductDetail,{product:products[0],onClose(){}})))
 assert.equal(facts().length,1)
 const oldSignal=facts()[0].signal
 factsHandler=async()=>new Response('failed',{status:503})
 await act(async()=>root.render(createElement(app.ProductDetail,{product:products[1],onClose(){}})))
 assert.equal(oldSignal.aborted,true)
 assert.match(text(),/원료 확인 정보를 불러오지 못했습니다/)
 factsHandler=()=>retry.promise
 const button=[...document.querySelectorAll('button')].find(x=>x.textContent==='다시 시도')
 await act(async()=>{button.click();button.click()})
 assert.equal(facts().length,3)
 await settle(first,[rows[0]])
 assert.doesNotMatch(text(),/직접 확인 원료|전체 원재료 2개 확인/)
 await settle(retry,[rows[1]])
 assert.match(text(),/전체 원재료 2개 확인/)
 assert.doesNotMatch(text(),/직접 확인 원료/)
})

test('restored SWITCH detail skips global facts and retains current product and comparison session', async () => {
 const session=app.createInitialSwitchSession('Alpha')
 session.currentProductId=rows[0].product_id;session.variantSelection={kind:'unknown',variantId:null};session.step='results';session.compareIds=[rows[1].product_id];session.detailProductId=rows[1].product_id
 app.writeSwitchSession(session,window.sessionStorage)
 await mount('?view=workspace&mode=switch')
 assert.equal(facts().length,1)
 assert.equal(facts()[0].url.searchParams.get('product_id'),'eq.'+rows[1].product_id)
 const saved=app.readSwitchSession(window.sessionStorage)
 assert.equal(saved.currentProductId,rows[0].product_id)
 assert.deepEqual(saved.compareIds,[rows[1].product_id])
 assert.equal(saved.variantSelection.kind,'unknown')
})
