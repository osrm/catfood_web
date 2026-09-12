import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch, sleep, js, info, pointer, typeText, network } from './mobile-mode-qa-helpers.mjs'

const BASE='https://osrm.github.io/catfood_web/'
const TARGET_SHA=process.env.TARGET_SHA
const OUT='qa-artifacts'
const STORAGE_KEY='catfood.switch-session.v1'
const LABELS=['조건으로 찾기','제품 찾기','현재 사료']
mkdirSync(OUT,{recursive:true})
assert.equal(TARGET_SHA,'963a3b6591965ef144294f0f1d9521033adeea95','unexpected merge SHA')

const readSwitch=c=>c.eval(`(()=>{const raw=sessionStorage.getItem(${js(STORAGE_KEY)});return raw?JSON.parse(raw).state:null})()`)
const visibleSwitch=c=>c.eval(`({product:document.querySelector('.switch-reference-product strong')?.textContent.trim()||null,sku:document.querySelector('.switch-reference-sku strong')?.textContent.trim()||null,heading:document.querySelector('.switch-step-header h1')?.textContent.trim()||document.querySelector('.switch-find-hero h1')?.textContent.trim()||null})`)

async function shot(c,name,result){const file=`360x844-${name}.png`;await c.shot(`${OUT}/${file}`);result.captures.push(file)}

async function navLayout(c){
  return c.eval(`(()=>{const nav=document.querySelector('.mode-nav'),top=document.querySelector('.research-topbar'),main=document.querySelector('.switch-find-stage,.switch-step-layout,.switch-results-stage');const inspect=n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{text:n.textContent.trim(),ariaCurrent:n.getAttribute('aria-current'),rect:[r.left,r.top,r.width,r.height],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,rendered:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,centerHit:Boolean(h&&(h===n||n.contains(h)))}};const tr=top?.getBoundingClientRect(),mr=main?.getBoundingClientRect();return{innerWidth,documentWidth:document.documentElement.scrollWidth,topbar:tr?[tr.left,tr.top,tr.width,tr.height,tr.bottom]:null,main:mr?[mr.left,mr.top,mr.width,mr.height]:null,buttons:[...document.querySelectorAll('.mode-nav .mode-button')].map(inspect)}})()`)
}

function assertMobileNav(layout){
  assert.deepEqual(layout.buttons.map(x=>x.text),LABELS,'mode order')
  assert.equal(layout.buttons[2].ariaCurrent,'page','current-food aria-current')
  assert.ok(layout.documentWidth<=layout.innerWidth+1,'horizontal overflow')
  assert.ok(layout.topbar&&layout.topbar[3]>=103&&layout.topbar[3]<=106,`topbar height ${layout.topbar?.[3]}`)
  assert.ok(layout.main&&layout.main[1]>=layout.topbar[4]-1,'topbar overlaps content')
  for(const b of layout.buttons){
    assert.equal(b.rendered,true,`not rendered ${b.text}`)
    assert.equal(b.centerHit,true,`not hit-testable ${b.text}`)
    assert.ok(b.scrollWidth<=b.clientWidth+1,`label clipped ${b.text}`)
    assert.ok(Math.abs(b.rect[3]-48)<=1,`wrong mode height ${b.text}`)
  }
}

async function focusModeByKeyboard(c,label){
  await c.eval(`document.activeElement?.blur()`)
  const sequence=[]
  for(let i=0;i<12;i++){
    await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab'})
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab'})
    await sleep(80)
    const state=await c.eval(`(()=>{const n=document.activeElement,s=n?getComputedStyle(n):null,r=n?.getBoundingClientRect();return n?{text:(n.textContent||'').replace(/\\s+/g,' ').trim(),className:n.className,ariaCurrent:n.getAttribute('aria-current'),outlineStyle:s?.outlineStyle||null,outlineWidth:s?.outlineWidth||null,outlineColor:s?.outlineColor||null,outlineOffset:s?.outlineOffset||null,rect:r?[r.left,r.top,r.width,r.height]:null}:null})()`)
    sequence.push(state)
    if(state?.text===label&&String(state.className).includes('mode-button')){
      const confirm=await c.eval(`(()=>{const n=document.activeElement;return{isMode:Boolean(n?.classList?.contains('mode-button')),text:(n?.textContent||'').replace(/\\s+/g,' ').trim()}})()`)
      assert.equal(confirm.isMode,true,'activeElement is not a mode button')
      assert.equal(confirm.text,label,'wrong activeElement text')
      assert.notEqual(state.outlineStyle,'none','mode focus outline missing')
      assert.ok(parseFloat(state.outlineWidth||'0')>=2,'mode focus outline too thin')
      return{sequence,focused:state,activeElement:confirm}
    }
  }
  throw new Error(`keyboard did not reach mode button ${label}: ${JSON.stringify(sequence)}`)
}

async function setupRealState(c){
  await c.wait(`document.querySelector('.switch-find-search input')`,'switch search')
  await typeText(c,'.switch-find-search input','AATU 연어')
  await c.wait(`document.querySelectorAll('.switch-find-result').length>0`,'AATU results')
  await pointer(c,'.switch-find-result',null,0)
  const product=await c.eval(`document.querySelector('.switch-find-result.is-selected strong')?.textContent.trim()`)
  await pointer(c,'button','이 제품을 현재 사료로 선택 →')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`,'sku list')
  await pointer(c,'.switch-sku-option',null,0)
  await c.wait(`document.querySelector('.switch-sku-option.is-selected')`,'sku selected')
  const sku=await c.eval(`document.querySelector('.switch-sku-option.is-selected')?.textContent.replace(/\\s+/g,' ').trim()`)
  await pointer(c,'.switch-step-actions button','다음 →')
  await c.wait(`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 바꾸고 싶나요')`,'CHANGE')
  await pointer(c,'button.switch-choice','다른 브랜드로 보기')
  await pointer(c,'.switch-step-actions button','다음 →')
  await c.wait(`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 그대로 유지할까요')`,'KEEP')
  const keepText=await c.eval(`[...document.querySelectorAll('button.switch-choice.wide')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()).find(t=>t.endsWith('유지'))||null`)
  assert.ok(keepText,'KEEP choice unavailable')
  await pointer(c,'button.switch-choice.wide',keepText)
  const state=await readSwitch(c),visible=await visibleSwitch(c)
  assert.ok(state?.currentProductId,'product id missing')
  assert.equal(state?.variantSelection?.kind,'variant','variant selection missing')
  assert.ok(state?.variantSelection?.variantId,'variant id missing')
  assert.equal(state?.changeBrand,true,'CHANGE brand missing')
  assert.ok(visible.sku&&!visible.sku.includes('확인 중'),'real SKU unavailable before roundtrip')
  return{product,sku,keepText,state,visible}
}

async function route(c,label,waitExpr,waitLabel){
  const click=await pointer(c,'.mode-nav .mode-button',label)
  await c.wait(waitExpr,waitLabel)
  return click
}

const result={targetSha:TARGET_SHA,url:BASE,width:360,height:844,status:'running',captures:[]}
const browser=await launch(360,844),c=browser.c
try{
  result.chrome=browser.version
  await c.nav(BASE)
  await c.wait(`/\\d/.test(document.querySelector('.home-search-console-copy small')?.textContent||'')`,'catalog loaded')
  result.fonts=await c.fonts('.home-start h1')
  assert.ok(result.fonts.some(f=>f.familyName.includes('Noto Sans CJK KR')),'Korean font mismatch')
  await pointer(c,'button','현재 사료로 시작하기 →')
  await c.wait(`document.querySelector('.switch-find-stage,.switch-step-layout,.switch-results-stage')`,'SWITCH entry')

  result.brand=await info(c,'.research-brand')
  result.brandAx=await c.axName('.research-brand')
  assert.equal(result.brand?.ariaLabel,'CATFOOD 홈으로 이동','home aria-label')
  assert.equal(result.brandAx?.name,'CATFOOD 홈으로 이동','home AX name')
  assert.equal(result.brandAx?.role,'button','home AX role')
  result.initialLayout=await navLayout(c)
  assertMobileNav(result.initialLayout)

  result.keyboard=await focusModeByKeyboard(c,'제품 찾기')
  await shot(c,'01-mode-button-keyboard-focus',result)
  const beforeShotActive=await c.eval(`(()=>({text:(document.activeElement?.textContent||'').replace(/\\s+/g,' ').trim(),isMode:Boolean(document.activeElement?.classList?.contains('mode-button'))}))()`)
  assert.deepEqual(beforeShotActive,{text:'제품 찾기',isMode:true},'focus moved before screenshot')
  result.focusCaptureActiveElement=beforeShotActive

  result.setup=await setupRealState(c)
  result.stateBefore=result.setup.state
  result.visibleBefore=result.setup.visible
  await shot(c,'02-switch-keep-before-roundtrip',result)

  result.toLookup=await route(c,'제품 찾기',`document.querySelector('.lookup-input')`,'lookup')
  const lookupActive=await c.eval(`document.querySelector('.mode-button.is-active')?.textContent.trim()`)
  assert.equal(lookupActive,'제품 찾기','lookup mode not active')
  result.backToSwitch=await route(c,'현재 사료',`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 그대로 유지할까요')`,'SWITCH restored')
  result.requeryInitial=await visibleSwitch(c)
  await c.wait(`(()=>{const t=document.querySelector('.switch-reference-sku strong')?.textContent.trim();return t&&!t.includes('확인 중')})()`,'SKU requery complete')
  result.visibleAfter=await visibleSwitch(c)
  result.stateAfter=await readSwitch(c)
  assert.equal(JSON.stringify(result.stateAfter),JSON.stringify(result.stateBefore),'SWITCH state changed across lookup')
  assert.equal(result.visibleAfter.sku,result.visibleBefore.sku,'SKU label changed after requery')
  assert.equal(result.visibleAfter.product,result.visibleBefore.product,'product changed after requery')
  result.finalLayout=await navLayout(c)
  assertMobileNav(result.finalLayout)
  await shot(c,'03-switch-after-lookup-requery',result)

  result.network=await network(c)
  assert.equal(result.network.sentAnalytics.length,0,'analytics request escaped blocker')
  assert.equal(result.network.sentWrites.length,0,'production write escaped blocker')
  result.status='pass'
}catch(error){
  result.status='failed'
  result.error=error instanceof Error?`${error.name}: ${error.message}`:String(error)
  try{await shot(c,'99-failure',result)}catch{}
  throw error
}finally{
  try{result.network??=await network(c)}catch{}
  writeFileSync(`${OUT}/report.json`,JSON.stringify(result,null,2))
  c.close();browser.proc.kill('SIGTERM')
}
