import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launch, sleep, js, pointer, typeText, topbar, network } from './mobile-mode-nav-qa-helpers.mjs'

const BASE='http://127.0.0.1:4173/catfood_web/'
const TARGET_SHA=process.env.TARGET_SHA
const OUT='qa-artifacts/mobile-mode-navigation-consistency'
const STORAGE_KEY='catfood.switch-session.v1'
const LABELS=['조건으로 찾기','제품 찾기','현재 사료']
mkdirSync(OUT,{recursive:true})
assert.ok(TARGET_SHA,'TARGET_SHA is required')

const readSwitch=c=>c.eval(`(()=>{const raw=sessionStorage.getItem(${js(STORAGE_KEY)});return raw?JSON.parse(raw).state:null})()`)
const visibleSwitch=c=>c.eval(`({product:document.querySelector('.switch-reference-product strong')?.textContent.trim()||null,sku:document.querySelector('.switch-reference-sku strong')?.textContent.trim()||null,heading:document.querySelector('.switch-step-header h1')?.textContent.trim()||document.querySelector('.switch-find-hero h1')?.textContent.trim()||null})`)
const urlState=c=>c.eval(`({href:location.href,search:location.search,historyLength:history.length})`)

async function pressTab(c){
  await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab'})
  await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab'})
  await sleep(90)
  return c.eval(`(()=>{const n=document.activeElement,s=n?getComputedStyle(n):null,r=n?.getBoundingClientRect();return n?{text:n.textContent.replace(/\\s+/g,' ').trim(),ariaLabel:n.getAttribute('aria-label'),ariaCurrent:n.getAttribute('aria-current'),className:n.className,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,rect:r?[r.left,r.top,r.width,r.height]:null,inViewport:Boolean(r&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight)}:null})()`)
}

async function layout(c){
  return c.eval(`(()=>{const nav=document.querySelector('.mode-nav'),top=document.querySelector('.research-topbar');if(!nav||!top)return null;const ns=getComputedStyle(nav),nr=nav.getBoundingClientRect(),tr=top.getBoundingClientRect();const buttons=[...nav.querySelectorAll('.mode-button')].map(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y),range=document.createRange();range.selectNodeContents(n);return{text:n.textContent.trim(),ariaCurrent:n.getAttribute('aria-current'),className:n.className,rect:[r.left,r.top,r.width,r.height],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,height:s.height,whiteSpace:s.whiteSpace,textRects:[...range.getClientRects()].length,centerHit:Boolean(h&&(h===n||n.contains(h)))}});return{viewport:{innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,dpr:devicePixelRatio},document:{scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},topbar:[tr.left,tr.top,tr.width,tr.height,tr.bottom],nav:{rect:[nr.left,nr.top,nr.width,nr.height],clientWidth:nav.clientWidth,scrollWidth:nav.scrollWidth,clientHeight:nav.clientHeight,scrollHeight:nav.scrollHeight,overflowX:ns.overflowX,overflowY:ns.overflowY,display:ns.display,gridTemplateColumns:ns.gridTemplateColumns,gap:ns.gap},buttons}})()`)
}

function assertLayout(value,{width,active,mobile}){
  assert.ok(value,`missing layout ${width}`)
  assert.equal(value.viewport.innerWidth,width,`innerWidth ${width}`)
  assert.equal(value.viewport.dpr,1,`DPR ${width}`)
  assert.deepEqual(value.buttons.map(x=>x.text),LABELS,`mode order ${width}`)
  assert.equal(value.buttons.filter(x=>x.ariaCurrent==='page').length,1,`aria-current count ${width}`)
  assert.equal(value.buttons.find(x=>x.ariaCurrent==='page')?.text,active,`active mode ${width}`)
  assert.ok(value.document.scrollWidth<=value.viewport.clientWidth+1,`document horizontal overflow ${width}: ${JSON.stringify(value.document)}`)
  assert.ok(value.nav.scrollWidth<=value.nav.clientWidth+1,`nav horizontal scroll ${width}: ${JSON.stringify(value.nav)}`)
  assert.ok(value.nav.scrollHeight<=value.nav.clientHeight+1,`nav vertical scroll ${width}: ${JSON.stringify(value.nav)}`)
  for(const button of value.buttons){
    assert.ok(button.rect[3]>=44,`button below 44px ${width}: ${JSON.stringify(button)}`)
    assert.equal(button.centerHit,true,`pointer hit-test failed ${width}: ${button.text}`)
    assert.ok(button.scrollWidth<=button.clientWidth+1,`button clipped ${width}: ${JSON.stringify(button)}`)
    assert.equal(button.textRects,1,`button wrapped ${width}: ${button.text}`)
  }
  if(mobile){
    assert.equal(value.nav.display,'grid',`mobile nav not grid ${width}`)
    assert.equal(value.nav.overflowX,'visible',`mobile nav overflowX ${width}`)
    assert.equal(value.nav.overflowY,'visible',`mobile nav overflowY ${width}`)
    const widths=value.buttons.map(x=>x.rect[2]);assert.ok(Math.max(...widths)-Math.min(...widths)<=1.5,`mobile columns unequal ${width}: ${widths}`)
    for(const button of value.buttons) assert.ok(Math.abs(button.rect[3]-48)<=1,`mobile button not 48px ${width}: ${button.rect[3]}`)
  } else if(width<=1120){
    for(const button of value.buttons) assert.ok(Math.abs(button.rect[3]-48)<=1,`responsive button not 48px ${width}: ${button.rect[3]}`)
  } else {
    for(const button of value.buttons) assert.ok(Math.abs(button.rect[3]-56)<=1,`desktop button changed ${width}: ${button.rect[3]}`)
    assert.ok(value.topbar[3]<80,`desktop topbar stacked ${width}: ${value.topbar[3]}`)
  }
}

async function waitMode(c,mode){
  if(mode==='lookup') return c.wait(`document.querySelector('.lookup-input')`,'lookup')
  if(mode==='explore') return c.wait(`document.querySelector('.research-workspace')&&document.querySelector('.condition-group-title')&&!document.querySelector('.lookup-input')&&!document.querySelector('.switch-find-stage,.switch-step-layout,.switch-results-stage')`,'explore')
  return c.wait(`document.querySelector('.switch-find-stage,.switch-step-layout,.switch-results-stage')`,'switch')
}

async function route(c,label,mode){
  const click=await pointer(c,'.mode-nav .mode-button',label)
  await waitMode(c,mode)
  const state=await urlState(c)
  const nav=await topbar(c)
  const active=nav.buttons.filter(button=>button.ariaCurrent==='page')
  assert.equal(active.length,1,`aria-current count after ${label}`)
  assert.equal(active[0]?.text,label,`active mode after ${label}`)
  const actualMode=new URLSearchParams(state.search).get('mode')
  const expectedMode=mode==='explore'?null:mode
  assert.equal(actualMode,expectedMode,`URL mode after ${label}`)
  return{click,state,active:active[0],topbar:nav}
}

async function modeCycle(c,width,{shots=false}={}){
  const result={width,modes:{},clicks:{}}
  await c.nav(`${BASE}?view=workspace&mode=lookup`);await waitMode(c,'lookup')
  result.modes.lookup=await layout(c);assertLayout(result.modes.lookup,{width,active:'제품 찾기',mobile:width<=760})
  result.clicks.toExplore=await route(c,'조건으로 찾기','explore')
  result.modes.explore=await layout(c);assertLayout(result.modes.explore,{width,active:'조건으로 찾기',mobile:width<=760})
  if(width===360||width===390) assert.ok(result.modes.explore.viewport.innerWidth-result.modes.explore.viewport.clientWidth>=14,`classic scrollbar not consuming width ${width}: ${JSON.stringify(result.modes.explore.viewport)}`)
  if(shots) await c.shot(`${OUT}/${width}x844-explore.png`)
  result.clicks.toSwitch=await route(c,'현재 사료','switch')
  result.modes.switch=await layout(c);assertLayout(result.modes.switch,{width,active:'현재 사료',mobile:width<=760})
  if(shots) await c.shot(`${OUT}/${width}x844-switch.png`)
  result.clicks.backLookup=await route(c,'제품 찾기','lookup')
  return result
}

async function keyboardCheck(c){
  await c.nav(`${BASE}?view=workspace&mode=switch`);await waitMode(c,'switch')
  const brand=await c.eval(`(()=>{const n=document.querySelector('.research-brand');return n?{tag:n.tagName,tabIndex:n.tabIndex,disabled:Boolean(n.disabled),ariaLabel:n.getAttribute('aria-label')}:null})()`)
  assert.ok(brand,'brand keyboard target missing')
  assert.equal(brand.tag,'BUTTON','brand is not a button')
  assert.ok(brand.tabIndex>=0,'brand removed from tab order')
  assert.equal(brand.disabled,false,'brand disabled')
  assert.equal(brand.ariaLabel,'CATFOOD 홈으로 이동','brand aria-label changed')
  await c.eval(`document.querySelector('.research-brand')?.focus()`)
  const sequence=[]
  for(let i=0;i<3;i++) sequence.push(await pressTab(c))
  assert.deepEqual(sequence.map(x=>x?.text),LABELS,'keyboard mode order')
  for(const x of sequence){assert.ok(x?.inViewport,`keyboard target outside viewport ${JSON.stringify(x)}`);assert.notEqual(x?.outlineStyle,'none',`focus outline missing ${JSON.stringify(x)}`);assert.ok(parseFloat(x?.outlineWidth||'0')>=2,`focus outline too small ${JSON.stringify(x)}`)}
  assert.equal(sequence[2]?.ariaCurrent,'page','focused current mode aria-current')
  return{brand,sequence}
}

async function setupRealSwitchState(c){
  await c.nav(`${BASE}?view=workspace&mode=switch`);await waitMode(c,'switch')
  await c.wait(`document.querySelector('.switch-find-search input')`,'switch search')
  await typeText(c,'.switch-find-search input','AATU 연어')
  await c.wait(`document.querySelectorAll('.switch-find-result').length>0`,'AATU results')
  await pointer(c,'.switch-find-result',null,0)
  const product=await c.eval(`document.querySelector('.switch-find-result.is-selected strong')?.textContent.trim()`)
  await c.wait(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('이 제품을 현재 사료로 선택'))`,'confirm current product')
  await pointer(c,'button','이 제품을 현재 사료로 선택 →')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`,'sku list')
  await pointer(c,'.switch-sku-option',null,0)
  await c.wait(`document.querySelector('.switch-sku-option.is-selected')`,'sku selected')
  const skuOption=await c.eval(`document.querySelector('.switch-sku-option.is-selected')?.textContent.replace(/\\s+/g,' ').trim()`)
  await pointer(c,'.switch-step-actions button','다음 →')
  await c.wait(`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 바꾸고 싶나요')`,'CHANGE')
  await pointer(c,'button.switch-choice','다른 브랜드로 보기')
  await pointer(c,'.switch-step-actions button','다음 →')
  await c.wait(`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 그대로 유지할까요')`,'KEEP')
  const keepText=await c.eval(`[...document.querySelectorAll('button.switch-choice.wide')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()).find(t=>t.endsWith('유지'))||null`)
  assert.ok(keepText,'KEEP choice unavailable')
  await pointer(c,'button.switch-choice.wide',keepText)
  const state=await readSwitch(c),visible=await visibleSwitch(c),url=await urlState(c)
  assert.ok(state?.currentProductId,'real product id missing');assert.ok(state?.currentVariantId,'real variant id missing');assert.equal(state?.change?.brand,true,'CHANGE missing');assert.ok(visible.sku&&!visible.sku.includes('확인 중'),'real SKU missing')
  return{product,skuOption,keepText,state,visible,url}
}

async function roundtripState(c){
  const before=await setupRealSwitchState(c)
  await c.shot(`${OUT}/360x844-switch-state-before.png`)
  const toLookup=await route(c,'제품 찾기','lookup')
  const lookupUrl=await urlState(c)
  const backLookup=await route(c,'현재 사료','switch')
  await c.wait(`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 그대로 유지할까요')`,'restore KEEP after lookup')
  await c.wait(`(()=>{const t=document.querySelector('.switch-reference-sku strong')?.textContent.trim();return t&&!t.includes('확인 중')})()`,'SKU after lookup')
  const afterLookup={state:await readSwitch(c),visible:await visibleSwitch(c),url:await urlState(c)}
  assert.equal(JSON.stringify(afterLookup.state),JSON.stringify(before.state),'switch state changed across lookup')
  assert.equal(afterLookup.visible.sku,before.visible.sku,'SKU changed across lookup')
  const toExplore=await route(c,'조건으로 찾기','explore')
  const exploreUrl=await urlState(c)
  const backExplore=await route(c,'현재 사료','switch')
  await c.wait(`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 그대로 유지할까요')`,'restore KEEP after explore')
  await c.wait(`(()=>{const t=document.querySelector('.switch-reference-sku strong')?.textContent.trim();return t&&!t.includes('확인 중')})()`,'SKU after explore')
  const afterExplore={state:await readSwitch(c),visible:await visibleSwitch(c),url:await urlState(c)}
  assert.equal(JSON.stringify(afterExplore.state),JSON.stringify(before.state),'switch state changed across explore')
  assert.equal(afterExplore.visible.sku,before.visible.sku,'SKU changed across explore')
  await c.shot(`${OUT}/360x844-switch-state-after.png`)
  return{before,toLookup,lookupUrl,backLookup,afterLookup,toExplore,exploreUrl,backExplore,afterExplore}
}

async function quickDetailPolicy(c){
  await route(c,'제품 찾기','lookup')
  await typeText(c,'.lookup-input','몬지')
  await c.wait(`document.querySelectorAll('.research-result-card').length>0`,'lookup results')
  await pointer(c,'.research-result-card',null,0)
  await c.wait(`document.querySelector('.research-quick-view')`,'quick view')
  const quickTop=await topbar(c)
  assert.ok(quickTop.buttons.every(b=>!b.rendered),'quick-view mode-nav policy changed')
  const quickUrl=await urlState(c)
  await pointer(c,'.quick-view-actions .switch-compare-action','상세 보기 →')
  await c.wait(`document.querySelector('.detail-stage')`,'detail stage')
  const detailUrl=await urlState(c)
  assert.ok(new URLSearchParams(detailUrl.search).get('detail'),'detail URL state missing')
  assert.equal(await c.eval(`document.querySelector('.mode-nav')===null`),true,'detail unexpectedly exposes mode nav')
  await c.eval(`history.back()`)
  await c.wait(`document.querySelector('.research-quick-view')`,'quick view restored from detail')
  const restored=await urlState(c)
  assert.equal(restored.search,quickUrl.search,'history did not restore quick view URL')
  await pointer(c,'.quick-view-topline button','닫기 ×')
  await c.wait(`!document.querySelector('.research-quick-view')`,'quick view closed')
  const listTop=await topbar(c)
  assert.ok(listTop.buttons.every(b=>b.rendered&&b.centerHit),'mode nav not restored after quick view')
  return{quickUrl,detailUrl,restored,listTop}
}

async function run(width,height,{full=false,shots=false}={}){
  const browser=await launch(width,height),c=browser.c,result={width,height,chrome:browser.version,status:'running'}
  try{
    await c.nav(BASE);await c.wait(`/\\d/.test(document.querySelector('.home-search-console-copy small')?.textContent||'')`,'catalog loaded')
    result.fonts=await c.fonts('.home-start h1');assert.ok(result.fonts.some(f=>f.familyName.includes('Noto Sans CJK KR')),'Korean font mismatch')
    result.cycle=await modeCycle(c,width,{shots})
    if(full){result.keyboard=await keyboardCheck(c);result.roundtrip=await roundtripState(c);result.quickDetail=await quickDetailPolicy(c)}
    result.network=await network(c);assert.equal(result.network.sentAnalytics.length,0,'analytics escaped blocker');assert.equal(result.network.sentWrites.length,0,'write escaped blocker')
    result.status='pass';return result
  }catch(error){result.status='failed';result.error=error instanceof Error?`${error.name}: ${error.message}`:String(error);try{await c.shot(`${OUT}/${width}x${height}-failure.png`)}catch{};throw Object.assign(error instanceof Error?error:new Error(String(error)),{qaResult:result})}
  finally{c.close();try{browser.proc.kill('SIGTERM')}catch{};await sleep(250);try{rmSync(browser.dir,{recursive:true,force:true})}catch{}}
}

const report={targetSha:TARGET_SHA,environment:'GitHub-hosted Chrome, mobile:false desktop viewport emulation, OverlayScrollbar disabled, DPR=1, Korean Noto font',runs:[],status:'running'}
const save=()=>writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))
try{
  for(const [w,h,options] of [[360,844,{full:true,shots:true}],[390,844,{shots:true}],[760,900,{}],[761,900,{}],[1120,900,{}],[1121,900,{}],[1280,900,{shots:true}]]){
    try{report.runs.push(await run(w,h,options))}catch(error){if(error?.qaResult)report.runs.push(error.qaResult);throw error}finally{save()}
  }
  report.status='pass';save();console.log('MOBILE_MODE_NAV_QA_PASS',JSON.stringify(report.runs.map(r=>({width:r.width,lookup:r.cycle?.modes.lookup?.buttons.map(b=>[b.text,b.rect[3]]),exploreViewport:r.cycle?.modes.explore?.viewport,switch:r.cycle?.modes.switch?.buttons.map(b=>[b.text,b.rect[3]]),network:r.network}))))
}catch(error){report.status='failed';report.error=error instanceof Error?`${error.name}: ${error.message}`:String(error);save();throw error}
