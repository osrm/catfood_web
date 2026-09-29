import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const nativeFetch = globalThis.fetch
let app, root, temp, handler

function product(id='product_scope_test', overrides={}) {
  return {
    product_id:id, brand:'Scope Brand', canonical_name:'제조국 포장 범위 테스트 제품', feed_type:'건식', life_stage:'adult',
    display_image_url:null, representative_variant_id:null, representative_package_size_text:null, representative_package_weight_g:null,
    representative_units_per_sale:null, representative_sale_total_weight_g:null, variant_count:3, has_variants:true,
    ingredient_declaration_count:0, full_ingredient_declaration_count:0, has_ingredient_details:false, has_full_ingredient_declaration:false,
    nutrition_panel_count:0, has_nutrition_details:false, manufacturing_observation_count:1, has_manufacturing_details:true,
    manufacturing_country_codes:['KR'], manufacturing_has_variant_scope:true,
    market_observation_count:0, has_market_details:false, assessed_market_country_codes:[], current_market_country_codes:[],
    formula_match_market_country_codes:[], ingredient_term_result_count:0, confirmed_present_ingredient_terms:[],
    direct_evidence_ingredient_terms:[], flavor_associated_ingredient_terms:[], reviewed_not_found_ingredient_terms:[],
    insufficient_evidence_ingredient_terms:[], official_targets:[], features:[], recipe_families:[], recipe_details:[], official_recipe_traits:[],
    ...overrides,
  }
}
function variant(productId,id,label,rank=1){return {product_id:productId,variant_id:id,package_size_text:label,package_weight_g:null,units_per_sale:1,sale_total_weight_g:null,sales_bundle_status:null,display_rank:rank,variant_count:3,formula_evidence_status:'confirmed',recipe_families:[],recipe_details:[],official_recipe_traits:[],ingredient_term_result_count:0,confirmed_present_ingredient_terms:[],direct_evidence_ingredient_terms:[],flavor_associated_ingredient_terms:[],reviewed_not_found_ingredient_terms:[],insufficient_evidence_ingredient_terms:[]}}
function scope(productId,variantId,country,rank=1,observationScope='variant'){return {product_id:productId,variant_id:variantId,observation_scope:observationScope,country_code:country,manufacturer:null,plant:null,is_current_resolved_formula:false,display_rank:rank}}
function primary(productId,country='KR',observationScope='variant',overrides={}){return {product_id:productId,observation_scope:observationScope,country_code:country,manufacturer:null,plant:null,is_current_resolved_formula:false,...overrides}}
function deferred(){let resolvePromise,rejectPromise;const promise=new Promise((resolve,reject)=>{resolvePromise=resolve;rejectPromise=reject});return {promise,resolve:resolvePromise,reject:rejectPromise}}

async function bundle(){
  const result=await build({configFile:false,logLevel:'silent',define:{'import.meta.env.DEV':'false','import.meta.env.VITE_DECISION_INTAKE_ENABLED':'"false"','import.meta.env.VITE_SUPABASE_URL':'"https://api.test"','import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'"test-key"'},build:{ssr:'tests/entry.ts',write:false,minify:false}})
  const chunk=result.output.find(item=>item.type==='chunk'&&item.isEntry),file=resolve(temp,'manufacturing-scope.mjs')
  await writeFile(file,chunk.code);return import(pathToFileURL(file).href)
}
before(async()=>{await mkdir('node_modules/.cache',{recursive:true});temp=await mkdtemp(resolve('node_modules/.cache/catfood-manufacturing-scope-'));app=await bundle()})
after(async()=>{globalThis.fetch=nativeFetch;dom.window.close();await rm(temp,{recursive:true})})
beforeEach(()=>{
  document.body.innerHTML='<div id="root"></div>'
  handler=async()=>Response.json([])
  globalThis.fetch=window.fetch=async(input)=>handler(new URL(input instanceof Request?input.url:String(input)))
  root=createRoot(document.getElementById('root'))
})
afterEach(async()=>{await act(async()=>root.unmount())})
async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0))})}
async function renderDetail(target){await act(async()=>{root.render(createElement(app.ProductDetail,{product:target,onClose(){},initialTab:'context'}));await Promise.resolve()});await settle()}
async function renderCompare(items){await act(async()=>{root.render(createElement(app.CompareView,{items,onClose(){},onRemove(){}}));await Promise.resolve()});await settle()}
function detailManufacturingText(){return [...document.querySelectorAll('.detail-section')].find(node=>node.textContent.includes('제조 정보'))?.textContent??''}
function routes({variants=[],primaryRow=null,scopeRows=[],manufacturingStatus=200,variantResponse=null,markets=[],marketStatus=200}={}){
  return async(url)=>{
    if(url.pathname.endsWith('/switch_current_variant_options')) return variantResponse??Response.json(variants)
    if(url.pathname.endsWith('/product_detail_manufacturing')) return manufacturingStatus===200?Response.json(primaryRow?[primaryRow]:[]):new Response('temporary',{status:manufacturingStatus})
    if(url.pathname.endsWith('/product_detail_manufacturing_scope')) return manufacturingStatus===200?Response.json(scopeRows):new Response('temporary',{status:manufacturingStatus})
    if(url.pathname.endsWith('/product_detail_markets')) return marketStatus===200?Response.json(markets):new Response('temporary',{status:marketStatus})
    return Response.json([])
  }
}

test('detail links KR only to the exact 3.5 kg variant and never expands it to 1.5/8 kg',async()=>{
  const p=product('product_dental_fixture')
  handler=routes({variants:[variant(p.product_id,'v15','1.5 kg',1),variant(p.product_id,'v35','3.5 kg',2),variant(p.product_id,'v8','8 kg',3)],primaryRow:primary(p.product_id),scopeRows:[scope(p.product_id,'v35','KR')]})
  await renderDetail(p)
  const text=detailManufacturingText()
  assert.match(text,/제조국한국3\.5 kg 포장에서 확인/)
  assert.match(text,/확인되지 않은 다른 규격에는 적용하지 않습니다/)
  assert.doesNotMatch(text,/1\.5 kg 포장에서 확인/)
  assert.doesNotMatch(text,/8 kg 포장에서 확인/)
})

test('detail preserves multiple countries on one variant and separate country links across variants',async()=>{
  const p=product('product_multi_fixture',{manufacturing_country_codes:['US','TH','CA']})
  handler=routes({variants:[variant(p.product_id,'va','2 kg',1),variant(p.product_id,'vb','4 kg',2)],primaryRow:primary(p.product_id,'US'),scopeRows:[scope(p.product_id,'va','US',1),scope(p.product_id,'va','TH',2),scope(p.product_id,'vb','CA',3)]})
  await renderDetail(p)
  const text=detailManufacturingText()
  assert.match(text,/미국 · 태국2 kg 포장에서 확인/)
  assert.match(text,/캐나다4 kg 포장에서 확인/)
})

test('product-scope and no-country states remain distinct from variant scope',async()=>{
  const p=product('product_product_scope',{manufacturing_has_variant_scope:false,manufacturing_country_codes:['TH']})
  handler=routes({primaryRow:primary(p.product_id,'TH','product'),scopeRows:[scope(p.product_id,null,'TH',1,'product')]})
  await renderDetail(p)
  assert.match(detailManufacturingText(),/제조국태국/)
  assert.doesNotMatch(detailManufacturingText(),/포장 기준|확인한 포장/)

  await act(async()=>root.unmount());document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'))
  const empty=product('product_no_country',{manufacturing_observation_count:0,has_manufacturing_details:false,manufacturing_country_codes:[],manufacturing_has_variant_scope:false})
  handler=routes()
  await renderDetail(empty)
  assert.match(detailManufacturingText(),/확인된 제조 정보가 없습니다/)
})

test('unmatched variant stays package-scoped while SKU lookup is pending or failed',async()=>{
  const p=product('product_unmatched_fixture'),pending=deferred()
  handler=routes({primaryRow:primary(p.product_id),scopeRows:[scope(p.product_id,'missing_variant','KR')],variantResponse:pending.promise})
  await renderDetail(p)
  assert.match(detailManufacturingText(),/한국포장 규격 확인 중/)
  assert.doesNotMatch(detailManufacturingText(),/3\.5 kg 포장에서 확인/)

  await act(async()=>{pending.reject(new Error('variant failed'));await Promise.resolve()});await settle()
  const text=detailManufacturingText()
  assert.match(text,/한국포장 규격 조회 실패/)
  assert.match(text,/일부 포장 규격은 연결 정보를 확인하지 못했습니다/)
  assert.doesNotMatch(text,/제품 전체|3\.5 kg 포장에서 확인/)
})

test('manufacturing request failure is an error and retry re-runs both manufacturing reads',async()=>{
  const p=product('product_retry_fixture')
  let primaryCalls=0,scopeCalls=0,fail=true
  handler=async(url)=>{
    if(url.pathname.endsWith('/switch_current_variant_options')) return Response.json([variant(p.product_id,'v35','3.5 kg')])
    if(url.pathname.endsWith('/product_detail_manufacturing')){primaryCalls++;return fail?new Response('temporary',{status:503}):Response.json([primary(p.product_id)])}
    if(url.pathname.endsWith('/product_detail_manufacturing_scope')){scopeCalls++;return fail?new Response('temporary',{status:503}):Response.json([scope(p.product_id,'v35','KR')])}
    return Response.json([])
  }
  await renderDetail(p)
  assert.match(document.querySelector('[role="alert"]').textContent,/제조 정보를 불러오지 못했습니다/)
  assert.doesNotMatch(detailManufacturingText(),/확인된 제조 정보가 없습니다/)
  fail=false
  const retry=[...document.querySelectorAll('[role="alert"] button')].find(node=>node.textContent.includes('다시 시도'));assert.ok(retry)
  await act(async()=>{retry.click();await Promise.resolve()});await settle()
  assert.equal(document.querySelector('[role="alert"]'),null)
  assert.match(detailManufacturingText(),/한국3\.5 kg 포장에서 확인/)
  assert.equal(primaryCalls,2);assert.equal(scopeCalls,2)
})

test('compare renders the variant-scope boolean as confirmed-package scope, not partial coverage',async()=>{
  const scoped=product('product_compare_scoped',{canonical_name:'범위 있음',manufacturing_country_codes:['KR'],manufacturing_has_variant_scope:true})
  const whole=product('product_compare_product',{canonical_name:'제품 범위',manufacturing_country_codes:['TH'],manufacturing_has_variant_scope:false})
  await renderCompare([{product:scoped},{product:whole}])
  const text=document.querySelector('.compare-stage').textContent
  assert.match(text,/대한민국 · 확인된 포장 기준/)
  assert.match(text,/태국/)
  assert.doesNotMatch(text,/일부 포장 기준|태국 · 확인된 포장 기준/)
})


test('loaded unmatched variant keeps country package-scoped instead of falling back to whole-product meaning',async()=>{
  const p=product('product_loaded_unmatched')
  handler=routes({variants:[variant(p.product_id,'other_variant','1.5 kg')],primaryRow:primary(p.product_id),scopeRows:[scope(p.product_id,'missing_variant','KR')]})
  await renderDetail(p)
  const text=detailManufacturingText()
  assert.match(text,/한국연결된 포장 규격을 확인하지 못했습니다/)
  assert.match(text,/확인되지 않은 다른 규격에는 적용하지 않습니다/)
  assert.doesNotMatch(text,/1\.5 kg 포장에서 확인|제품 전체/)
})

test('additional manufacturing facts render only in a default-closed non-empty disclosure',async()=>{
  const p=product('product_extra_manufacturing')
  handler=routes({
    variants:[variant(p.product_id,'v35','3.5 kg')],
    primaryRow:primary(p.product_id,'KR','variant',{manufacturer:'Maker Co.',plant:'Plant A'}),
    scopeRows:[scope(p.product_id,'v35','KR')],
  })
  await renderDetail(p)
  const summary=[...document.querySelectorAll('summary')].find(node=>node.textContent.trim()==='추가 제조 정보 보기')
  assert.ok(summary)
  assert.equal(summary.parentElement.open,false)
  summary.parentElement.open=true
  assert.match(summary.parentElement.textContent,/제조 업체Maker Co\./)
  assert.match(summary.parentElement.textContent,/제조 공장Plant A/)

  await act(async()=>root.unmount());document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'))
  const empty=product('product_no_extra_manufacturing')
  handler=routes({variants:[variant(empty.product_id,'v35','3.5 kg')],primaryRow:primary(empty.product_id),scopeRows:[scope(empty.product_id,'v35','KR')]})
  await renderDetail(empty)
  assert.equal([...document.querySelectorAll('summary')].some(node=>node.textContent.trim()==='추가 제조 정보 보기'),false)
  assert.doesNotMatch(detailManufacturingText(),/제조 업체.*확인하지 못했습니다|공장.*확인하지 못했습니다/)
})

test('overseas market rows stay intact behind disclosure while empty and error states remain outside',async()=>{
  const p=product('product_market_disclosure')
  const market={product_id:p.product_id,country_code:'JP',distribution_status:'current_product_confirmed',formula_correspondence_status:'different_generation',counterpart_name:'Local Name',assessed_at:'2026-09-01',display_rank:1}
  handler=routes({primaryRow:primary(p.product_id,'TH','product'),markets:[market]})
  await renderDetail(p)
  const summary=[...document.querySelectorAll('summary')].find(node=>node.textContent.trim()==='해외 판매 · 배합 보기')
  assert.ok(summary)
  assert.equal(summary.parentElement.open,false)
  assert.equal([...document.querySelectorAll('.detail-section-heading h2')].some(node=>node.textContent.trim()==='해외 판매 · 배합 보기'),false)
  summary.parentElement.open=true
  assert.match(summary.parentElement.textContent,/일본/)
  assert.match(summary.parentElement.textContent,/2026-09-01 확인/)
  assert.match(summary.parentElement.textContent,/현재 제품 유통 확인/)
  assert.match(summary.parentElement.textContent,/다른 세대 확인/)
  assert.match(summary.parentElement.textContent,/Local Name/)

  await act(async()=>root.unmount());document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'))
  handler=routes({primaryRow:primary(p.product_id,'TH','product'),markets:[]})
  await renderDetail(p)
  assert.equal([...document.querySelectorAll('summary')].some(node=>node.textContent.trim()==='해외 판매 · 배합 보기'),false)
  assert.match(document.body.textContent,/확인된 해외 유통 정보가 없습니다/)

  await act(async()=>root.unmount());document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'))
  handler=routes({primaryRow:primary(p.product_id,'TH','product'),marketStatus:503})
  await renderDetail(p)
  assert.equal([...document.querySelectorAll('summary')].some(node=>node.textContent.trim()==='해외 판매 · 배합 보기'),false)
  assert.match(document.querySelector('[role="alert"]')?.textContent??'',/유통 정보를 불러오지 못했습니다/)
  assert.match(document.querySelector('[role="alert"]')?.textContent??'',/다시 시도/)
})
