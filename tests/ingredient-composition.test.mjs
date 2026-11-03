import assert from 'node:assert/strict'
import {after,afterEach,before,test} from 'node:test'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'vite'
import {JSDOM} from 'jsdom'
import {act,createElement} from 'react'
const dom=new JSDOM('<div id="root"></div>',{url:'https://catfood.test/'})
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true
const {createRoot}=await import('react-dom/client')
const nativeFetch=globalThis.fetch
let app,temp,root
const source=(names,raw='')=>({product_id:'product_fixture',ingredient_names:names,raw_text:raw})
before(async()=>{
 await mkdir('node_modules/.cache',{recursive:true});temp=await mkdtemp(resolve('node_modules/.cache/composition-'))
 const result=await build({configFile:false,logLevel:'silent',define:{'import.meta.env.DEV':'false','import.meta.env.VITE_SUPABASE_URL':'"https://api.test"','import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'"test-key"'},build:{ssr:'tests/entry.ts',write:false,minify:false}})
 const chunk=result.output.find(x=>x.type==='chunk'&&x.isEntry),file=resolve(temp,'composition.mjs');await writeFile(file,chunk.code);app=await import(pathToFileURL(file).href)
})
afterEach(async()=>{if(root){await act(async()=>root.unmount());root=null}globalThis.fetch=nativeFetch;document.body.innerHTML='<div id="root"></div>'})
after(async()=>{dom.window.close();await rm(temp,{recursive:true})})
test('groups actual meat, fat and flavor separately instead of treating every species as a recipe',()=>{
 assert.deepEqual(app.ingredientComposition(source(['육분(닭, 오리)','동물성유지(돼지, 닭, 오리)','유도단백질(닭, 칠면조)','천연향(닭간/생선)'])),{protein:['닭','오리','칠면조'],fats:['닭','오리','돼지'],eggsDairy:[],flavor:['닭','생선']})
})
test('oil-only and flavor-only animals do not become meat sources',()=>{
 assert.deepEqual(app.ingredientComposition(source(['Salmon Oil','Natural Chicken Flavor','Dried Whole Egg'])),{protein:[],fats:['연어'],eggsDairy:['계란'],flavor:['닭']})
})
test('generic poultry/fish and unspecified animal fat are not narrowed to species',()=>{
 assert.deepEqual(app.ingredientComposition(source(['Poultry meal','Fish meal','Animal Fat'])),{protein:['가금류','생선'],fats:['동물성 지방'],eggsDairy:[],flavor:[]})
 assert.deepEqual(app.ingredientComposition(source(['고등어 (Mackerel Meat) 71%'])).protein,['고등어'])
})
test('reads a Korean summary without splitting the species inside parentheses',()=>{
 assert.deepEqual(app.splitIngredientText('육분(닭, 오리), 닭지방; 천연향(닭간/생선) 등'),['육분(닭, 오리)','닭지방','천연향(닭간/생선) 등'])
 assert.deepEqual(app.ingredientComposition(source([],'뼈를 발라낸 칠면조, 닭고기, 닭지방, 청어 밀, 연어 오일 등')),{protein:['칠면조','닭','청어'],fats:['닭','연어'],eggsDairy:[],flavor:[]})
})
test('does not merge a supplemental formula, trace warning or plant name into the selected source',()=>{
 const row={...source(['Chicken Meal',"Lamb’s quarters",'May contain tuna','corn gluten']),supplemental_full_ingredient_names:['Salmon','Turkey']}
 assert.deepEqual(app.ingredientComposition(row),{protein:['닭'],fats:[],eggsDairy:[],flavor:[]})
})
test('absent rows and plant-only rows do not create absent-animal claims',()=>{
 assert.deepEqual(app.ingredientComposition(null),{protein:[],fats:[],eggsDairy:[],flavor:[]})
 assert.deepEqual(app.ingredientComposition(source(['Peas','Potatoes','Rosemary'])),{protein:[],fats:[],eggsDairy:[],flavor:[]})
})
test('Korean compound oil names, eggshell and a plant named milk thistle retain their actual forms',()=>{
 assert.deepEqual(app.ingredientComposition(source(['생 통우럭(5%)','농어','명태유(5%)','가금 지방','계란껍질','Milk Thistle'])),{protein:['우럭','농어'],fats:['폴락','가금류'],eggsDairy:['계란 껍데기'],flavor:[]})
})
test('literal Japanese and Chinese source words never narrow generic birds or fish',()=>{
 const result=app.ingredientComposition(source(['魚介類（カツオ、マグロ）','鶏肉','油脂類（鶏脂、大豆油）','乾燥全卵','禽肉及禽肉副產品','海洋魚類','蛋胺酸']))
 assert.deepEqual(result.protein,['참치','가다랑어','생선','닭','가금류']);assert.deepEqual(result.fats,['닭']);assert.deepEqual(result.eggsDairy,['계란'])
 assert.deepEqual(app.ingredientComposition(source(['85% サーモン（サーモン生肉 73%、脱水サーモン 12%）'])).protein,['연어'])
})
test('an untranslated or plant-only declaration remains a visible source excerpt, not an empty or absent claim',async()=>{
 root=createRoot(document.getElementById('root'))
 await act(async()=>root.render(createElement(app.IngredientCompositionValue,{row:source(['Peas','Potatoes','Rosemary','Minerals'])})))
 assert.match(document.body.textContent,/원문 표기Peas · Potatoes · Rosemary …/)
 assert.doesNotMatch(document.body.textContent,/미확인|원료 없음|육류·어류/)
})
test('an inspector ignores an old product response after switching to another product',async()=>{
 let oldResolve;const calls=[]
 globalThis.fetch=(url,options)=>{const u=new URL(url);calls.push({url:u,signal:options.signal});return calls.length===1?new Promise(resolve=>{oldResolve=resolve}):Promise.resolve(Response.json([{...source(['Turkey Meal']),product_id:'product_second'}]))}
 root=createRoot(document.getElementById('root'))
 await act(async()=>root.render(createElement(app.IngredientComposition,{productId:'product_first'})))
 await act(async()=>root.render(createElement(app.IngredientComposition,{productId:'product_second'})))
 assert.equal(calls[0].signal.aborted,true);assert.match(document.body.textContent,/칠면조/)
 await act(async()=>oldResolve(Response.json([{...source(['Salmon']),product_id:'product_first'}])))
 assert.doesNotMatch(document.body.textContent,/연어/);assert.match(document.body.textContent,/칠면조/)
 assert.ok(calls.every(x=>x.url.pathname.endsWith('/compare_product_ingredients_scoped')))
})
test('a failed reading stays a retryable load failure, not unknown or no ingredients',async()=>{
 let calls=0;globalThis.fetch=async()=>++calls===1?new Response('unavailable',{status:503}):Response.json([source(['Chicken'])])
 root=createRoot(document.getElementById('root'))
 await act(async()=>root.render(createElement(app.IngredientComposition,{productId:'product_fixture'})))
 assert.match(document.body.textContent,/불러오지 못했습니다/);assert.doesNotMatch(document.body.textContent,/미확인|없음/)
 await act(async()=>document.querySelector('button').click());assert.equal(calls,2);assert.match(document.body.textContent,/닭/)
})

test('disclosure reading names source wording without converting generic fish oil into species',()=>{
 const row={raw_text:'닭고기, 어유, 천연향료, 계란',completeness_status:'full'}
 const reading=app.ingredientDisclosureReading(row)
 assert.equal(reading.label,'일부 원료 종류 포괄 표기')
 assert.deepEqual(reading.examples,['어유','천연향료'])
 assert.match(reading.explanation,/세부 원료 종류를 임의로 추정하지/)
 assert.match(app.ingredientDisclosureSummary(row),/어유 · 천연향료/)
})
test('specifically named oils and flavors are not misclassified as unspecified',()=>{
 const reading=app.ingredientDisclosureReading({raw_text:'닭고기, 어유(정어리, 멸치), 연어 오일, 천연향료(닭간), 계란',completeness_status:'full'})
 assert.equal(reading.examples.length,0)
 assert.match(reading.label,/포괄 표현 미발견/)
 assert.match(reading.explanation,/모든 세부 원료의 공개나 특정 원료의 부재를 보증하지/)
})
test('generic fish extract and unspecified animal fat are shown, not confused with listed species',()=>{
 const reading=app.ingredientDisclosureReading({raw_text:'육분(닭, 오리), 동물성 지방, 생선추출물, 정어리',completeness_status:'full'})
 assert.deepEqual(reading.examples,['동물성 지방','생선추출물'])
})
test('partial, unreadable and supplementary-source-only ingredient evidence never becomes full disclosure',()=>{
 const partial=app.ingredientDisclosureReading({raw_text:'닭고기, 계란',completeness_status:'summary'})
 assert.equal(partial.label,'일부 목록 · 공개 수준 판단 제한')
 const otherFormula=app.ingredientDisclosureReading({raw_text:null,completeness_status:'summary',supplemental_full_raw_text:'연어, 정어리'})
 assert.equal(otherFormula.label,'원료표 원문 미확보')
 assert.deepEqual(otherFormula.examples,[])
})
test('species named in a generic animal-fat parenthesis are not called undisclosed',()=>{
 const reading=app.ingredientDisclosureReading({raw_text:'육분(닭, 오리), 동물성 지방(소), 어유',completeness_status:'full'})
 assert.deepEqual(reading.examples,['어유'])
})
test('the original generic ingredient phrase is not cut off in disclosure comparison',()=>{
 const phrase='생선추출물('+'확인되지 않은 세부 구성 '.repeat(6)+')'
 const reading=app.ingredientDisclosureReading({raw_text:'닭고기, '+phrase,completeness_status:'full'})
 assert.deepEqual(reading.examples,[phrase])
})

test('algae oil is not a generic fish ingredient',()=>{
 const reading=app.ingredientDisclosureReading({raw_text:'닭고기, 미세해양조류오일, 호박',completeness_status:'full'})
 assert.deepEqual(reading.examples,[])
})
