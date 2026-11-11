import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core')
const BASE=process.env.CANDIDATE_URL || 'http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR || 'startup-ingredient-output'
await mkdir(OUT,{recursive:true})
const report={base:BASE,sourceSha:process.env.CANDIDATE_SHA,views:{},blockedWrites:[],injectedFailures:[],network:[],errors:[],sourceReads:[],catalogRecoveries:[]}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome'})
let page
try {
  for(const width of [390,1440]) {
    const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'})
    let failBoot=true,failSources=false,catalogTimeoutsRemaining=0
    page=await context.newPage()
    page.on('pageerror',e=>report.errors.push(String(e)))
    page.on('requestfailed',r=>report.network.push({width,url:r.url(),failure:r.failure()}))
    await page.route('**/*',async route=>{
      const req=route.request(),url=req.url()
      if(!['GET','HEAD','OPTIONS'].includes(req.method()) || /functions\/v1|analytics|telemetry|search-runs|considerations/.test(url)){report.blockedWrites.push(url);return route.abort()}
      if(failBoot&&url.startsWith(BASE)&&['script','stylesheet'].includes(req.resourceType())){report.injectedFailures.push({width,kind:'boot',url});return route.abort()}
      if(catalogTimeoutsRemaining>0&&req.method()==='GET'&&url.includes('/rest/v1/effective_product_catalog_summary?')&&url.includes('representative_package_size_text')){
        catalogTimeoutsRemaining--
        report.injectedFailures.push({width,kind:'catalog-timeout',url})
        return route.fulfill({status:500,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},
          body:JSON.stringify({code:'57014',message:'canceling statement due to statement timeout'})})
      }
      if(url.includes('/rest/v1/compare_product_ingredients?')){
        const params=new URL(url).searchParams
        report.sourceReads.push({width,fields:params.get('select'),ids:params.get('product_id'),limit:params.get('limit')})
        if(failSources){report.injectedFailures.push({width,kind:'source',url});return route.abort()}
      }
      return route.continue()
    })
    async function capture(key,selector){
      await page.locator(selector).first().scrollIntoViewIfNeeded()
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),key+': horizontal overflow')
      report.views[width+'-'+key]={url:page.url(),text:await page.locator(selector).first().innerText()}
      await page.screenshot({path:`${OUT}/${width}-${key}.png`})
    }
    const target=BASE+'?view=workspace&mode=explore&applied=1&feed='+encodeURIComponent('건식')+'&age=adult&avoidIngredients=salmon'
    await page.goto(target,{waitUntil:'domcontentloaded'})
    await page.getByText(/화면을 불러오지 못했습니다/).waitFor()
    await page.evaluate(()=>{sessionStorage.setItem('catfood.startup-test-marker','kept');window.__startupDocumentMarker='same document'})
    await capture('boot-failure','#startup-panel')
    await page.getByRole('button',{name:'다시 연결하기',exact:true}).click()
    await page.locator('#startup-panel[role="alert"]').waitFor()
    assert.equal(await page.evaluate(()=>window.__startupDocumentMarker),'same document')
    assert.equal(await page.getByRole('button',{name:'다시 연결하기',exact:true}).isEnabled(),true)
    await capture('boot-retry-failure','#startup-panel')
    failBoot=false
    await page.getByRole('button',{name:'다시 연결하기',exact:true}).click()
    await page.locator('.research-result-card').first().waitFor({timeout:45000})
    assert.equal(await page.locator('#startup-panel').count(),0)
    assert.equal(await page.evaluate(()=>window.__startupDocumentMarker),'same document','retry must not request a new HTML document')
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('catfood.startup-test-marker')),'kept')
    assert.equal(new URL(page.url()).searchParams.get('avoidIngredients'),'salmon')
    for(let i=0;i<25;i++){const more=page.getByRole('button',{name:/제품 더 보기/});if(!await more.count())break;await more.click()}
    const royal=page.locator('.research-result-card[data-product-id="product_5b13354ad9792881"]')
    const royalVerdict = royal.getByText('제조사 표기 · ‘어유’(어종 미표기)', {exact:true})
    await royalVerdict.waitFor({timeout:45000})
    assert.match(await royal.innerText(),/연어 포함 여부/)
    assert.equal(await royal.locator('.ingredient-list-reason').count(),0,'the selected ingredient verdict already shows the oil wording')
    await capture('avoidance-card', '.research-result-card[data-product-id="product_5b13354ad9792881"]')
    await royal.click()
    await page.locator('.research-quick-view .ingredient-questions-button').click({timeout:45000})
    let questions=page.getByRole('dialog',{name:'제품 확인 질문',exact:true})
    await questions.locator('.ingredient-question-options').waitFor({timeout:45000})
    let questionText=await questions.getByRole('textbox',{name:'복사할 제품 확인 질문'}).inputValue()
    assert.match(questionText,/로얄캐닌.*노르웨이/s)
    assert.match(questionText,/어유.*어종/s)
    assert.match(questionText,/연어.*포함 여부/s)
    assert.match(questionText,/답변이나 원료가 없음을 확인한 기록은 아닙니다/)
    await capture('quick-questions','dialog[aria-label="제품 확인 질문"]')
    await questions.getByRole('button',{name:'닫기',exact:true}).click()
    await page.getByRole('button',{name:'닫기 ×',exact:true}).filter({visible:true}).first().click()
    const unknown=page.locator('.result-evidence-group.is-unverified .research-result-card').filter({hasText:'연어 포함 여부'}).first()
    assert.ok(await unknown.count())
    await unknown.locator('.result-relations').waitFor()
    await capture('unknown-card','.result-evidence-group.is-unverified .research-result-card')
    const idsBefore=await page.locator('.research-result-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.productId).sort())
    failSources=true
    catalogTimeoutsRemaining=2
    await page.reload({waitUntil:'domcontentloaded'})
    const sourceFailure=page.getByText('원료표의 추가 안내를 불러오지 못했습니다.',{exact:true})
    const catalogRetry=page.locator('.research-results').getByRole('button',{name:'다시 시도',exact:true})
    await catalogRetry.waitFor({timeout:45000})
    assert.equal(catalogTimeoutsRemaining,0,'both catalog attempts must fail before manual retry is offered')
    assert.equal(new URL(page.url()).searchParams.get('avoidIngredients'),'salmon')
    report.catalogRecoveries.push({width,stage:'after two injected catalog timeouts'})
    await catalogRetry.click()
    await sourceFailure.waitFor({timeout:45000})
    const idsAfter=await page.locator('.research-result-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.productId).sort())
    assert.deepEqual(idsAfter,idsBefore,'additional source failure must preserve filter results')
    assert.equal(await page.locator('.ingredient-list-reason').count(),0,'failed source fetch is not an unavailable-source claim')
    await capture('source-retry','.ingredient-reason-status')
    failSources=false
    await page.getByRole('button',{name:'추가 확인 사항 다시 불러오기',exact:true}).click()
    await royalVerdict.waitFor({timeout:45000})
    await capture('source-recovered','.research-result-card[data-product-id="product_5b13354ad9792881"]')

    await page.goto(BASE,{waitUntil:'domcontentloaded'})
    await page.getByRole('button',{name:'먹이는 사료 찾기 →',exact:true}).click()
    await page.locator('.switch-find-search input').fill('AATU')
    const current=page.locator('.switch-find-result').filter({hasText:'연어'}).first()
    const retryCatalog=page.locator('.switch-state-message.is-error').getByRole('button',{name:'다시 시도',exact:true})
    await current.or(retryCatalog).first().waitFor({timeout:45000})
    if(await retryCatalog.isVisible()) await retryCatalog.click()
    await current.click({timeout:45000})
    const sku=page.locator('.switch-sku-option').filter({hasText:/1\s*kg/}).first();await sku.waitFor();await sku.click()
    await page.locator('.switch-step-actions .switch-primary-action').click()
    await page.getByRole('heading',{name:'무엇을 바꾸고 싶나요?',exact:true}).waitFor()
    const toggle=page.locator('.switch-change-additional-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click()
    const salmon=page.locator('.switch-current-ingredients button').filter({hasText:'연어'}).filter({visible:true}).first();await salmon.waitFor({timeout:45000});await salmon.click()
    await page.getByRole('button',{name:'건식 유지',exact:true}).click()
    await page.locator('.switch-step-actions .switch-primary-action').click()
    await page.locator('.switch-candidate-row').first().waitFor({timeout:45000})
    await page.getByRole('searchbox',{name:'후보 제품 검색'}).fill('로얄캐닌 노르웨이')
    const candidate=page.locator('.switch-candidate-row[data-product-id="product_5b13354ad9792881"]')
    await candidate.locator('.ingredient-list-reason').waitFor({timeout:45000})
    assert.match(await candidate.innerText(),/어유 — 세부 어종 미표기/)
    await capture('switch-reason','.switch-candidate-row[data-product-id="product_5b13354ad9792881"]')
    await candidate.click()
    await page.getByRole('button',{name:'원재료부터 확인 →',exact:true}).filter({visible:true}).first().click()
    await page.getByRole('button',{name:'후보로 남기기',exact:true}).click()
    let retained=page.locator('.journey-records > ul > li').filter({hasText:'노르웨이 숲 어덜트'}).first()
    await retained.getByRole('button',{name:'확인할 질문 정리하기',exact:true}).click()
    questions=page.getByRole('dialog',{name:'제품 확인 질문',exact:true})
    await questions.locator('.ingredient-question-options').waitFor({timeout:45000})
    questionText=await questions.getByRole('textbox',{name:'복사할 제품 확인 질문'}).inputValue()
    assert.match(questionText,/어유.*어종/s);assert.match(questionText,/연어.*포함 여부/s)
    await capture('candidate-questions','dialog[aria-label="제품 확인 질문"]')
    await questions.getByRole('button',{name:'후보 기록에 질문 남기기',exact:true}).click()
    await retained.getByText('확인하려고 남긴 질문',{exact:true}).waitFor()
    assert.match(await retained.innerText(),/질문을 남길 때 살펴본 자료 · 한국 자료 · 제품 자료/)
    assert.doesNotMatch(await retained.innerText(),/답변 미확인/)
    await retained.locator('details > summary').click()
    await retained.getByRole('button',{name:'후보 메모 쓰기',exact:true}).click()
    await page.getByRole('dialog',{name:'후보 메모',exact:true}).getByRole('textbox').fill('원료 구성을 더 확인한 뒤 결정하기')
    await page.getByRole('button',{name:'메모 남기기',exact:true}).click()
    await capture('questions-saved','.journey-records')
    await page.locator('.journey-records').getByRole('button',{name:'기록 복사',exact:true}).click()
    const copy=await page.getByRole('textbox',{name:'복사할 검토 기록',exact:true}).inputValue()
    assert.match(copy,/원료 구성을 더 확인한 뒤 결정하기/)
    assert.match(copy,/확인하려고 남긴 질문[\s\S]*어유[\s\S]*연어/)
    await capture('questions-in-record','dialog[aria-label="검토 기록 복사"]')
    await page.getByRole('dialog',{name:'검토 기록 복사',exact:true}).getByRole('button',{name:'닫기',exact:true}).click()
    await page.reload({waitUntil:'domcontentloaded'})
    retained=page.locator('.journey-records > ul > li').filter({hasText:'노르웨이 숲 어덜트'}).first()
    await retained.getByText('확인하려고 남긴 질문',{exact:true}).waitFor({timeout:45000})
    assert.match(await retained.innerText(),/어유[\s\S]*어종/)
    await retained.locator('details > summary').click()
    assert.match(await retained.innerText(),/원료 구성을 더 확인한 뒤 결정하기/)
    await capture('questions-restored','.journey-records')
    await context.close()
  }
  assert.deepEqual(report.blockedWrites,[])
  assert.deepEqual(report.errors,[])
  const sourceFields=['product_id','variant_id','raw_text','completeness_status','observation_scope','market_code','is_current_resolved_formula']
  const publisherField='is_manufacturer_source'
  assert.ok(report.sourceReads.some(req=>req.fields.split(',').includes(publisherField)))
  for(const req of report.sourceReads){
    const fields=req.fields.split(',')
    assert.deepEqual(fields,fields.at(-1)===publisherField?[...sourceFields,publisherField]:sourceFields)
    assert.ok(Number(req.limit)<=80)
  }
} catch(error) {
  report.failure=String(error)
  if(page&&!page.isClosed()){report.failureText=await page.locator('body').innerText();await page.screenshot({path:OUT+'/failure.png'})}
  throw error
} finally {await browser.close();await writeFile(OUT+'/report.json',JSON.stringify(report,null,2))}
console.log('Startup recovery and ingredient reasons passed: '+Object.keys(report.views).length+' views')
