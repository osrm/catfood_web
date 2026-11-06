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
const questionSource=(raw,extra={})=>({product_id:'product_fixture',raw_text:raw,completeness_status:'full',observation_scope:'product',market_code:'KR',is_current_resolved_formula:false,...extra})
before(async()=>{
 await mkdir('node_modules/.cache',{recursive:true});temp=await mkdtemp(resolve('node_modules/.cache/composition-'))
 const result=await build({configFile:false,logLevel:'silent',define:{'import.meta.env.DEV':'false','import.meta.env.VITE_SUPABASE_URL':'"https://api.test"','import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'"test-key"'},build:{ssr:'tests/entry.ts',write:false,minify:false}})
 const chunk=result.output.find(x=>x.type==='chunk'&&x.isEntry),file=resolve(temp,'composition.mjs');await writeFile(file,chunk.code);app=await import(pathToFileURL(file).href)
})
afterEach(async()=>{if(root){await act(async()=>root.unmount());root=null}globalThis.fetch=nativeFetch;document.body.innerHTML='<div id="root"></div>'})
after(async()=>{dom.window.close();await rm(temp,{recursive:true})})

test('source lenses separate list coverage, wording and applicability without inferring absence',()=>{
 const foreignFull=questionSource('Chicken, Fish Oil',{market_code:'US'})
 assert.equal(app.matchesSourceFilter(foreignFull,'full'),true)
 assert.equal(app.matchesSourceFilter(foreignFull,'wording'),true)
 assert.equal(app.matchesSourceFilter(foreignFull,'scope'),true)
 assert.equal(app.matchesSourceFilter(foreignFull,'missing'),false)
 const partialNamed=questionSource('fish oil (herring)',{completeness_status:'partial'})
 assert.equal(app.matchesSourceFilter(partialNamed,'partial'),true)
 assert.equal(app.matchesSourceFilter(partialNamed,'full'),false)
 assert.equal(app.matchesSourceFilter(partialNamed,'wording'),false)
 const supplementalOnly={...questionSource('  '),supplemental_full_ingredient_names:['Salmon'],ingredient_names:['Chicken']}
 assert.equal(app.matchesSourceFilter(supplementalOnly,'missing'),true)
 assert.equal(app.matchesSourceFilter(supplementalOnly,'full'),false)
 assert.equal(app.matchesSourceFilter(supplementalOnly,'scope'),false)
 assert.equal(app.matchesSourceFilter(undefined,'missing'),true)
 assert.equal(app.matchesSourceFilter(undefined,'all'),true)
 assert.equal(app.parseSourceFilter('quality_score'),'off')
})

const explanationProduct = (extra={}) => ({product_id:'product_explanation',brand:'브랜드',feed_type:'건식',life_stage:'adult',official_targets:[],features:[],recipe_families:[],official_recipe_traits:[],confirmed_present_ingredient_terms:[],reviewed_not_found_ingredient_terms:[],...extra})
const explain = (extra={}) => app.candidateExplanation({current:explanationProduct(),candidate:explanationProduct({product_id:'product_candidate'}),conditions:[],focus:'disclosure',sourceStatus:'loaded',...extra})

test('candidate explanations contrast quoted wording and explicit keep facts without a suitability claim',()=>{
 const result=explain({beforeSource:questionSource('Chicken, Fish Oil'),afterSource:questionSource('Chicken, fish oil (herring)'),conditions:[{source:'keep',kind:'feedType',value:'건식',label:'형태 · 건식'}]})
 assert.match(result.kept.join(' '),/건식.*유지 조건/)
 assert.match(result.differences.join(' '),/현재:.*Fish Oil.*세부 어종 미기재.*후보:.*herring.*청어/)
 assert.ok(result.unknowns.some(line=>/현재:.*세부 어종 미기재/.test(line)))
 assert.ok(!result.unknowns.some(line=>/후보:.*세부 어종 미기재/.test(line)))
 assert.doesNotMatch(JSON.stringify(result),/더 적합|원료 없음|추천 점수/)
 assert.ok(app.validCandidateExplanation(result))
})

test('source failure never becomes missing raw text and partial supplemental material cannot fill source gaps',()=>{
 const failed=explain({sourceStatus:'error',beforeSource:questionSource('Fish Oil'),afterSource:questionSource('fish oil (herring)')})
 assert.deepEqual(failed.differences,[])
 assert.match(failed.unknowns.join(' '),/불러오지 못해/)
 assert.doesNotMatch(failed.unknowns.join(' '),/원문 미확보/)
 const missing=explain({beforeSource:questionSource('Fish Oil'),afterSource:questionSource('',{ingredient_names:['Chicken'],supplemental_full_raw_text:'fish oil (herring)'})})
 assert.ok(missing.unknowns.some(line=>/후보: 원료표 원문 미확보/.test(line)))
 assert.doesNotMatch(JSON.stringify(missing),/herring/)
 const partial=explain({beforeSource:questionSource('Fish Oil'),afterSource:questionSource('fish oil (herring)',{completeness_status:'partial'})})
 assert.match(partial.unknowns.join(' '),/후보: 전체 원료 목록을 확인하지 못/)
})

test('source applicability and current package mismatch remain explicit before wording cautions',()=>{
 const result=explain({currentVariantId:'variant_current_1',beforeSource:questionSource('Fish Oil',{observation_scope:'variant',variant_id:'variant_current_3'}),afterSource:questionSource('fish oil (herring)',{market_code:'US',observation_scope:'formula'})})
 assert.match(result.unknowns[0],/사용 규격의 일치 여부 미확인/)
 assert.match(result.unknowns[0],/후보 자료의 한국 판매 제품 적용 여부 미확인/)
 assert.equal(result.references.length,2)
 const matched=explain({currentVariantId:'variant_current_1',beforeSource:questionSource('Fish Oil',{observation_scope:'variant',variant_id:'variant_current_1'}),afterSource:questionSource('Fish Oil')})
 assert.ok(!matched.unknowns.some(line=>/사용 규격의 일치/.test(line)))
 assert.ok(matched.references.some(line=>/선택한 사용 규격에서 확인/.test(line)))
})

test('an absent feature tag is not a proven improvement and allowed alternate age is a difference',()=>{
 const result=explain({focus:'other',candidate:explanationProduct({life_stage:'all_life_stages',features:['digestive']}),conditions:[{source:'change',kind:'feature',value:'digestive',label:'기능 · 소화'},{source:'keep',kind:'lifeStage',value:'adult',label:'연령 · 성묘'}]})
 assert.match(result.unknowns.join(' '),/후보 표기는 확인했으나 현재 제품의 같은 표기는 미확인/)
 assert.match(result.unknowns.join(' '),/실제 효과/)
 assert.deepEqual(result.kept,[])
 assert.match(result.differences.join(' '),/성묘 → 전연령.*다른 표기/)
 assert.doesNotMatch(result.differences.join(' '),/소화/)
})

test('reviewed-not-found remains an evidence contrast and never becomes ingredient absence',()=>{
 const result=explain({focus:'ingredients',current:explanationProduct({confirmed_present_ingredient_terms:['chicken']}),candidate:explanationProduct({reviewed_not_found_ingredient_terms:['chicken']}),conditions:[{source:'change',kind:'ingredientAvoid',value:'chicken',label:'닭'}]})
 assert.match(result.differences.join(' '),/현재 자료에서 확인.*검토 자료에서 찾지 못함.*부재 보장 아님/)
 assert.doesNotMatch(JSON.stringify(result),/닭 없음|닭이 없/)
})

test('compact cards answer an explicit ingredient avoidance before source and basic differences, with the caveat visible',async()=>{
 const value=explain({focus:'ingredients',current:explanationProduct({confirmed_present_ingredient_terms:['salmon']}),candidate:explanationProduct({feed_type:'습식',reviewed_not_found_ingredient_terms:['salmon']}),beforeSource:questionSource('fish oil (herring)'),afterSource:questionSource('Fish Oil'),conditions:[{source:'change',kind:'feedType',value:'습식',label:'형태 · 습식'},{source:'change',kind:'ingredientAvoid',value:'salmon',label:'연어'}]})
 root=createRoot(document.getElementById('root'))
 await act(async()=>root.render(createElement(app.CandidateExplanationView,{value,compact:true})))
 const visible=document.querySelector('.is-differences').textContent
 assert.match(visible,/연어 원료.*현재 자료에서 확인.*검토 자료에서 찾지 못함.*부재 보장 아님/)
 assert.doesNotMatch(visible,/확보한 원료표|건식 → 습식/)
 await act(async()=>root.render(createElement(app.CandidateExplanationView,{value})))
 assert.match(document.querySelector('.is-differences').textContent,/연어 원료.*확보한 원료표.*건식 → 습식/)
 assert.match(document.querySelector('.is-unknowns').textContent,/Fish Oil.*세부 어종 미기재/)
})

test('unresolved selected ingredients precede general source cautions and stay unresolved after source failure',()=>{
 const input={focus:'ingredients',beforeSource:questionSource('fish oil (herring)'),afterSource:questionSource('Fish Oil',{market_code:'US'}),conditions:[{source:'change',kind:'ingredientAvoid',value:'salmon',label:'연어'}]}
 const value=explain(input)
 assert.match(value.unknowns[0],/^연어 원료: 후보에 포함되는지 판단할 근거가 부족/)
 assert.ok(value.unknowns.some(line=>/한국 판매 제품 적용 여부 미확인/.test(line)))
 assert.ok(value.unknowns.some(line=>/Fish Oil.*세부 어종 미기재/.test(line)))
 const failed=explain({...input,sourceStatus:'error'})
 assert.match(failed.unknowns[0],/^연어 원료:.*근거가 부족/)
 assert.ok(failed.unknowns.some(line=>/불러오지 못해/.test(line)))
 assert.doesNotMatch(failed.unknowns.join(' '),/연어 없음|검토 자료에서 찾지 못함|원문 미확보/)
})

test('explicit avoidance priority is independent of optional reading focus and preserves selected-term order',()=>{
 const conditions=[{source:'change',kind:'ingredientAvoid',value:'salmon',label:'연어'},{source:'change',kind:'ingredientAvoid',value:'chicken',label:'닭'}]
 for(const focus of ['disclosure','ingredients','other','energy']){
  const value=explain({focus,conditions,candidate:explanationProduct({reviewed_not_found_ingredient_terms:['salmon','chicken']}),beforeSource:questionSource('fish oil (herring)'),afterSource:questionSource('Fish Oil')})
  assert.match(value.differences[0],/^연어 원료.*부재 보장 아님/)
  assert.match(value.differences[1],/^닭 원료.*부재 보장 아님/)
 }
})

test('energy explanation requires comparable feed and its own source applicability, including supplemental fields',()=>{
 const energy=(value,extra={})=>({kcal_per_100g:value,observation_scope:'product',market_code:'KR',is_current_resolved_formula:false,...extra})
 const input={focus:'energy',energyStatus:'loaded',beforeEnergy:energy(380),afterEnergy:energy(350)}
 assert.match(explain(input).differences.join(' '),/380 kcal\/100g → 350 kcal\/100g/)
 assert.equal(explain({...input,candidate:explanationProduct({feed_type:'습식'})}).differences.length,0)
 assert.equal(explain({...input,afterEnergy:energy(350,{market_code:'US'})}).differences.length,0)
 assert.equal(explain({...input,afterEnergy:energy(350,{supplemental_nutrition_fields:['energy'],supplemental_observation_scope:'product',supplemental_market_code:'US',supplemental_is_current_resolved_formula:false})}).differences.length,0)
 assert.equal(explain({...input,afterEnergy:energy(350,{observation_scope:'formula'})}).differences.length,0)
 assert.match(explain({...input,afterEnergy:energy(380)}).kept.join(' '),/380.*380/)
 const otherPackage=explain({...input,currentVariantId:'variant_1',beforeEnergy:energy(380,{observation_scope:'variant',variant_id:'variant_3'})})
 assert.match(otherPackage.unknowns.join(' '),/현재 열량 근거 포장.*사용 규격의 일치 여부는 미확인/)
 const supplemental=explain({...input,currentVariantId:'variant_1',beforeEnergy:energy(380,{variant_id:'variant_1',supplemental_nutrition_fields:['energy'],supplemental_observation_scope:'variant',supplemental_market_code:'KR',supplemental_is_current_resolved_formula:false})})
 assert.match(supplemental.unknowns.join(' '),/사용 규격의 일치 여부는 미확인/,'primary variant cannot identify supplemental field source')
 assert.ok(!app.validCandidateExplanation({kept:['x'.repeat(601)],differences:[],unknowns:[],references:[]}))
})

test('focused source cards show literal foreign wording together with applicability caveat',async()=>{
 root=createRoot(document.getElementById('root'))
 await act(async()=>root.render(createElement(app.IngredientListReason,{focused:true,row:questionSource('Fish Oil',{market_code:'US'})})))
 assert.match(document.body.textContent,/전체 원료표 확인/)
 assert.match(document.body.textContent,/Fish Oil.*세부 어종 미기재/)
 assert.match(document.body.textContent,/한국 제품에 적용 여부 미확인/)
 assert.match(document.body.textContent,/US 자료/)
})

test('confirmation questions ask about unspecified species without asserting absence or merging another formula',()=>{
 const questions=app.ingredientQuestions(questionSource('Peas, Fish Oil, Natural Flavor'),['연어'])
 assert.ok(questions.items.some(text=>/Fish Oil.*어종/.test(text)))
 assert.ok(questions.items.some(text=>/Natural Flavor.*구체적인 원료 구성/.test(text)))
 assert.ok(questions.items.some(text=>/연어.*포함 여부/.test(text)))
 assert.equal(app.validIngredientQuestions(questions),true)
 const unresolved=app.ingredientQuestions(questionSource('Fish Oil',{market_code:'US',observation_scope:'formula'}),['연어'])
 assert.ok(unresolved.items.some(text=>/한국.*적용되나요/.test(text)))
 assert.ok(!unresolved.items.some(text=>/Fish Oil/.test(text)),'unmatched material does not become a claim about this product')
 const partial=app.ingredientQuestions(questionSource('동물성 단백질원: 닭고기',{completeness_status:'summary'}))
 assert.ok(partial.items.some(text=>/전체 원료표/.test(text)))
 assert.ok(!partial.items.some(text=>/동물 종류/.test(text)))
 const copy=app.ingredientQuestionsText({productId:'p',brand:'브랜드',name:'제품'},questions)
 assert.match(copy,/답변이나 원료 부재를 확인한 기록은 아닙니다/)
 assert.equal(app.validIngredientQuestions({source:'source',items:Array(6).fill('question')}),false)
 assert.equal(app.validIngredientQuestions({source:'source',items:[' '.repeat(5)]}),false)
})
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
test('opened quick view shows original generic ingredient wording without extra fetch',async()=>{
 let calls=0
 globalThis.fetch=async()=>{calls++;return Response.json([{...source(['Chicken','Fish oil'],'닭고기, 어유'),completeness_status:'full'}])}
 root=createRoot(document.getElementById('root'))
 await act(async()=>root.render(createElement(app.IngredientComposition,{productId:'product_fixture'})))
 assert.equal(calls,1)
 assert.match(document.body.textContent,/원료표 확보전체 원료표 확인/)
 assert.match(document.body.textContent,/표기에서 더 확인할 점/)
 assert.match(document.body.textContent,/세부 어종 미기재/)
 assert.match(document.body.textContent,/어유/)
 assert.match(document.body.textContent,/한국 판매 제품과 같은 배합인지 미확인/)
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
 assert.equal(reading.label,'세부 종류를 추가로 확인할 원료')
 assert.deepEqual(reading.examples,['어유','천연향료'])
 assert.match(reading.explanation,/세부 원료 종류를 임의로 추정하지/)
 assert.match(app.ingredientDisclosureSummary(row),/어유 — 세부 어종 미기재/)
 assert.match(app.ingredientDisclosureSummary(row),/천연향료 — 향료의 세부 구성 미기재/)
})

test('source scope distinguishes country, package and current formula consistently with confirmation questions',()=>{
 const full=questionSource('Peas, Fish Oil')
 assert.equal(app.ingredientSourceScope(full).label,'한국 자료 · 제품 자료')
 assert.equal(app.ingredientSourceScope(full).needsCheck,false)
 const unresolved={...full,observation_scope:'formula'}
 assert.equal(app.ingredientSourceScope(unresolved).needsCheck,true,'Korean material alone does not establish a current formula')
 assert.match(app.ingredientSourceScope(unresolved).label,/같은 배합인지 미확인/)
 assert.ok(!app.ingredientQuestions(unresolved).items.some(item=>item.includes('Fish Oil')))
 const foreign={...full,market_code:'US',observation_scope:'formula',is_current_resolved_formula:true}
 assert.equal(app.ingredientSourceScope(foreign).needsCheck,false)
 assert.match(app.ingredientSourceScope(foreign).label,/US 자료.*국내 동일 배합 확인 자료/)
 assert.match(app.ingredientQuestions(foreign).source,new RegExp(app.ingredientSourceScope(foreign).label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))
 assert.match(app.ingredientSourceScope({...full,observation_scope:'variant'}).label,/확인한 포장 기준/)
 assert.equal(app.ingredientSourceScope({...full,observation_scope:'unknown'}).needsCheck,true)
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

test('partial list coverage stays visible when a generic ingredient is also present',async()=>{
 let calls=0
 globalThis.fetch=async()=>{calls++;return Response.json([{...source(['Chicken','Fish oil'],'닭고기, 어유'),completeness_status:'partial',market_code:'KR'}])}
 root=createRoot(document.getElementById('root'))
 await act(async()=>root.render(createElement(app.IngredientComposition,{productId:'product_fixture'})))
 const text=document.body.textContent
 assert.match(text,/일부 원료표만 확보/)
 assert.match(text,/목록에 없는 원료도 포함될 수 있습니다/)
 assert.match(text,/어유.*세부 어종 미기재/)
 assert.match(text,/한국 자료/)
 assert.doesNotMatch(text,/전체 원료표 확인/)
 assert.match(app.ingredientDisclosureSummary({raw_text:'닭고기, 어유',completeness_status:'partial'}),/^일부 원료표만 확보/)
 assert.equal(calls,1)
})

test('a named species does not identify a different generic oil or an alternative source',()=>{
 for(const phrase of ['연어 및 어유','연어 어분 및 어유','어유(정어리, 기타 어류)','어유(정어리 또는 멸치)','천연향료(닭간/생선)']) {
  const reading=app.ingredientDisclosureReading({raw_text:phrase,completeness_status:'full'})
  assert.deepEqual(reading.examples,[phrase],phrase)
 }
 for(const phrase of ['연어 어유','생선기름(정어리, 멸치)','Fish oil (salmon, tuna)','동물성 지방(소)']) {
  assert.deepEqual(app.ingredientDisclosureReading({raw_text:phrase,completeness_status:'full'}).examples,[],phrase)
 }
 const alternatives=app.ingredientDisclosureReading({raw_text:'어유(정어리 또는 멸치)',completeness_status:'full'})
 assert.equal(alternatives.details[0].note,'사용 어종 구성 미확정')
})

test('unknown list status and missing primary text cannot inherit full coverage from another source',()=>{
 const unknown=app.ingredientDisclosureReading({raw_text:'어유',completeness_status:null})
 assert.equal(unknown.listLabel,'전체 목록 여부 미확인')
 assert.match(app.ingredientDisclosureSummary({raw_text:'어유',completeness_status:null}),/^전체 목록 여부 미확인/)
 const missing=app.ingredientDisclosureReading({raw_text:null,completeness_status:'full',supplemental_full_raw_text:'닭고기, 연어'})
 assert.equal(missing.listLabel,'원료표 원문 미확보')
 assert.deepEqual(missing.examples,[])
})

test('a source heading naming chicken is not a claim that its animal type was omitted',()=>{
 const heading=app.ingredientDisclosureReading({raw_text:'동물성 단백질원: 닭고기, 조개류',completeness_status:'summary'})
 assert.equal(heading.listLabel,'일부 원료표만 확보')
 assert.deepEqual(heading.details,[])
 const mixed=app.ingredientDisclosureReading({raw_text:'동물성 단백질원: 닭고기/생선, 어유',completeness_status:'summary'})
 assert.deepEqual(mixed.details.map(item=>item.note),['세부 어종 미기재','세부 어종 미기재'])
 assert.match(app.ingredientDisclosureReading({raw_text:'동물성 단백질원: 가금류',completeness_status:'summary'}).details[0].note,/세부 동물 종류 미기재/)
})
