import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launch, sleep, js, info, pointer, typeText, topbar, network } from './mobile-mode-qa-helpers.mjs'

const BASE='http://127.0.0.1:4173/catfood_web/'
const TARGET_SHA=process.env.TARGET_SHA
const OUT='qa-artifacts'
const STORAGE_KEY='catfood.switch-session.v1'
const LABELS=['조건으로 찾기','제품 찾기','현재 사료']
mkdirSync(OUT,{recursive:true})
assert.ok(TARGET_SHA,'TARGET_SHA is required')

const readSwitch=c=>c.eval(`(()=>{const raw=sessionStorage.getItem(${js(STORAGE_KEY)});return raw?JSON.parse(raw).state:null})()`)
const visibleSwitch=c=>c.eval(`({product:document.querySelector('.switch-reference-product strong')?.textContent.trim()||null,sku:document.querySelector('.switch-reference-sku strong')?.textContent.trim()||null,heading:document.querySelector('.switch-step-header h1')?.textContent.trim()||document.querySelector('.switch-find-hero h1')?.textContent.trim()||null})`)

async function pressTab(c){
  await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab'})
  await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab'})
  await sleep(90)
  return c.eval(`(()=>{const n=document.activeElement,s=n?getComputedStyle(n):null,r=n?.getBoundingClientRect();return n?{text:n.textContent.replace(/\\s+/g,' ').trim(),ariaLabel:n.getAttribute('aria-label'),ariaCurrent:n.getAttribute('aria-current'),className:n.className,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,rect:r?[r.left,r.top,r.width,r.height]:null,inViewport:Boolean(r&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight)}:null})()`)
}

async function navLayout(c){
  return c.eval(`(()=>{const nav=document.querySelector('.mode-nav'),top=document.querySelector('.research-topbar'),main=document.querySelector('.switch-find-stage,.switch-step-layout,.switch-results-stage');const inspect=n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{text:n.textContent.trim(),ariaCurrent:n.getAttribute('aria-current'),rect:[r.left,r.top,r.width,r.height],clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,rendered:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,centerHit:Boolean(h&&(h===n||n.contains(h)))}};const nr=nav?.getBoundingClientRect(),tr=top?.getBoundingClientRect(),mr=main?.getBoundingClientRect();return{innerWidth,documentWidth:document.documentElement.scrollWidth,nav:nr?[nr.left,nr.top,nr.width,nr.height]:null,topbar:tr?[tr.left,tr.top,tr.width,tr.height,tr.bottom]:null,main:mr?[mr.left,mr.top,mr.width,mr.height]:null,buttons:[...document.querySelectorAll('.mode-nav .mode-button')].map(inspect)}})()`)
}

function assertNavLayout(layout,{mobileStack}){
  assert.deepEqual(layout.buttons.map(x=>x.text),LABELS,'mode order')
  for(const b of layout.buttons){
    assert.equal(b.rendered,true,`not rendered: ${b.text}`)
    assert.equal(b.centerHit,true,`not hit-testable: ${b.text}`)
    assert.ok(b.scrollWidth<=b.clientWidth+1,`label clipped: ${JSON.stringify(b)}`)
  }
  assert.equal(layout.buttons[2].ariaCurrent,'page','SWITCH current mode aria-current')
  assert.ok(layout.documentWidth<=layout.innerWidth+1,`document overflow: ${JSON.stringify(layout)}`)
  if(layout.topbar&&layout.main)assert.ok(layout.main[1]>=layout.topbar[4]-1,`topbar overlaps main: ${JSON.stringify(layout)}`)
  if(mobileStack){
    assert.ok(layout.topbar[3]>=103&&layout.topbar[3]<=106,`mobile topbar height: ${layout.topbar[3]}`)
    for(const b of layout.buttons)assert.ok(Math.abs(b.rect[3]-48)<=1,`mobile mode height: ${JSON.stringify(b)}`)
    const widths=layout.buttons.map(b=>b.rect[2]);assert.ok(Math.max(...widths)-Math.min(...widths)<=1.5,`mobile columns unequal: ${widths}`)
  } else {
    assert.ok(layout.topbar[3]<100,`desktop/tablet topbar unexpectedly stacked: ${layout.topbar[3]}`)
  }
}

async function enterSwitch(c){
  await c.wait(`document.querySelector('.home-shell')`,'home')
  await pointer(c,'button','현재 사료로 시작하기 →')
  await c.wait(`document.querySelector('.switch-find-stage,.switch-step-layout,.switch-results-stage')`,'switch entry')
}

async function assertBrand(c,label){
  const brand=await info(c,'.research-brand')
  const ax=await c.axName('.research-brand')
  assert.equal(brand?.ariaLabel,'CATFOOD 홈으로 이동',`${label} aria-label`)
  assert.equal(ax?.name,'CATFOOD 홈으로 이동',`${label} AX name`)
  assert.equal(ax?.role,'button',`${label} AX role`)
  return{brand,ax}
}

async function assertKeyboard(c){
  await c.eval(`document.activeElement?.blur()`)
  const sequence=[]
  for(let i=0;i<4;i++)sequence.push(await pressTab(c))
  assert.equal(sequence[0]?.ariaLabel,'CATFOOD 홈으로 이동','first keyboard target is home')
  assert.deepEqual(sequence.slice(1).map(x=>x?.text),LABELS,'keyboard mode order')
  for(const x of sequence){
    assert.ok(x?.inViewport,`keyboard target outside viewport: ${JSON.stringify(x)}`)
    assert.notEqual(x?.outlineStyle,'none',`focus outline missing: ${JSON.stringify(x)}`)
    assert.ok(parseFloat(x?.outlineWidth||'0')>=2,`focus outline too small: ${JSON.stringify(x)}`)
  }
  assert.equal(sequence[3]?.ariaCurrent,'page','focused current mode remains aria-current')
  return sequence
}

async function setupRealSwitchState(c){
  await c.wait(`document.querySelector('.switch-find-search input')`,'switch search')
  await typeText(c,'.switch-find-search input','AATU 연어')
  await c.wait(`document.querySelectorAll('.switch-find-result').length>0`,'AATU results')
  const result=await pointer(c,'.switch-find-result',null,0)
  const product=await c.eval(`document.querySelector('.switch-find-result.is-selected strong')?.textContent.trim()`)
  await c.wait(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('이 제품을 현재 사료로 선택'))`,'confirm current product')
  const confirm=await pointer(c,'button','이 제품을 현재 사료로 선택 →')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`,'sku list')
  const sku=await pointer(c,'.switch-sku-option',null,0)
  await c.wait(`document.querySelector('.switch-sku-option.is-selected')`,'sku selected')
  const skuOptionText=await c.eval(`document.querySelector('.switch-sku-option.is-selected')?.textContent.replace(/\\s+/g,' ').trim()`)
  const nextSku=await pointer(c,'.switch-step-actions button','다음 →')
  await c.wait(`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 바꾸고 싶나요')`,'CHANGE')
  const change=await pointer(c,'button.switch-choice','다른 브랜드로 보기')
  const nextChange=await pointer(c,'.switch-step-actions button','다음 →')
  await c.wait(`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 그대로 유지할까요')`,'KEEP')
  const keepText=await c.eval(`[...document.querySelectorAll('button.switch-choice.wide')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()).find(t=>t.endsWith('유지'))||null`)
  assert.ok(keepText,'KEEP choice unavailable')
  const keep=await pointer(c,'button.switch-choice.wide',keepText)
  const state=await readSwitch(c)
  const visible=await visibleSwitch(c)
  assert.ok(state?.currentProductId,'real product id missing')
  assert.ok(state?.currentVariantId,'real variant id missing')
  assert.equal(state?.change?.brand,true,'CHANGE brand selection missing')
  assert.ok(visible.sku&&!visible.sku.includes('확인 중'),'real SKU not visible before exit')
  return{result,product,confirm,sku,skuOptionText,nextSku,change,nextChange,keep,keepText,state,visible}
}

async function route(c,label,waitExpr,waitLabel){
  const control=await pointer(c,'.mode-nav .mode-button',label)
  await c.wait(waitExpr,waitLabel)
  return control
}

async function runMobile(width,height){
  const tag=`${width}x${height}`,result={width,height,captures:[],status:'running'},browser=await launch(width,height),c=browser.c
  const shot=async name=>{const file=`${tag}-${name}.png`;await c.shot(`${OUT}/${file}`);result.captures.push(file)}
  try{
    result.chrome=browser.version
    await c.nav(BASE)
    await c.wait(`/\\d/.test(document.querySelector('.home-search-console-copy small')?.textContent||'')`,'catalog loaded')
    result.fonts=await c.fonts('.home-start h1')
    assert.ok(result.fonts.some(f=>f.familyName.includes('Noto Sans CJK KR')),'Korean font mismatch')
    await enterSwitch(c)
    result.switchBrand=await assertBrand(c,'SWITCH')
    result.initialTopbar=await topbar(c)
    result.initialLayout=await navLayout(c)
    assertNavLayout(result.initialLayout,{mobileStack:true})
    result.keyboard=await assertKeyboard(c)
    await shot('01-switch-nav-focused')

    result.setup=await setupRealSwitchState(c)
    result.stateBefore=result.setup.state
    result.visibleBefore=result.setup.visible
    await shot('02-switch-keep-before-roundtrip')

    result.toLookup=await route(c,'제품 찾기',`document.querySelector('.lookup-input')`,'lookup direct')
    result.lookupBrand=await assertBrand(c,'App lookup')
    const lookupTop=await topbar(c)
    assert.equal(lookupTop.active?.text,'제품 찾기','lookup active mode')
    assert.equal(lookupTop.active?.ariaCurrent,'page','lookup aria-current')
    result.backToSwitch=await route(c,'현재 사료',`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 그대로 유지할까요')`,'SWITCH restored from lookup')
    result.requeryInitial=await visibleSwitch(c)
    await c.wait(`(()=>{const t=document.querySelector('.switch-reference-sku strong')?.textContent.trim();return t&& !t.includes('확인 중')})()`,'SKU requery complete')
    result.visibleAfterLookup=await visibleSwitch(c)
    result.stateAfterLookup=await readSwitch(c)
    assert.equal(JSON.stringify(result.stateAfterLookup),JSON.stringify(result.stateBefore),'SWITCH state changed across lookup')
    assert.equal(result.visibleAfterLookup.sku,result.visibleBefore.sku,'real SKU label changed after lookup roundtrip')
    await shot('03-switch-after-lookup-requery')

    result.toExplore=await route(c,'조건으로 찾기',`document.querySelector('.research-workspace')`,'explore direct')
    const exploreTop=await topbar(c)
    assert.equal(exploreTop.active?.text,'조건으로 찾기','explore active mode')
    assert.equal(exploreTop.active?.ariaCurrent,'page','explore aria-current')
    result.exploreBrand=await assertBrand(c,'App explore')
    result.exploreBack=await route(c,'현재 사료',`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 그대로 유지할까요')`,'SWITCH restored from explore')
    await c.wait(`(()=>{const t=document.querySelector('.switch-reference-sku strong')?.textContent.trim();return t&& !t.includes('확인 중')})()`,'SKU complete after explore')
    result.stateAfterExplore=await readSwitch(c)
    assert.equal(JSON.stringify(result.stateAfterExplore),JSON.stringify(result.stateBefore),'SWITCH state changed across explore')

    await route(c,'제품 찾기',`document.querySelector('.lookup-input')`,'lookup for quick view')
    await typeText(c,'.lookup-input','몬지')
    await c.wait(`document.querySelectorAll('.research-result-card').length>0`,'lookup results for quick view')
    result.quickOpen=await pointer(c,'.research-result-card',null,0)
    await c.wait(`document.querySelector('.research-quick-view')`,'quick view open')
    result.quickHiddenTopbar=await topbar(c)
    assert.ok(result.quickHiddenTopbar.buttons.every(b=>!b.rendered),'quick-view mode nav policy changed')
    await shot('04-quick-view-hidden-mode-nav')
    result.quickClose=await pointer(c,'.quick-view-topline button','닫기 ×')
    await c.wait(`!document.querySelector('.research-quick-view')`,'quick view close')
    result.quickListTopbar=await topbar(c)
    assert.ok(result.quickListTopbar.buttons.every(b=>b.rendered&&b.inViewport&&b.centerHit),'mode nav not restored after quick-view close')
    result.quickOtherMode=await route(c,'조건으로 찾기',`document.querySelector('.research-workspace')`,'other mode after quick-view close')
    result.quickBackSwitch=await route(c,'현재 사료',`document.querySelector('.switch-step-header h1')?.textContent.includes('무엇을 그대로 유지할까요')`,'SWITCH after quick-view path')
    result.finalLayout=await navLayout(c)
    assertNavLayout(result.finalLayout,{mobileStack:true})
    await shot('05-switch-final')

    result.network=await network(c)
    assert.equal(result.network.sentAnalytics.length,0,'analytics request escaped blocker')
    assert.equal(result.network.sentWrites.length,0,'production write escaped blocker')
    result.status='pass'
    return result
  }catch(error){
    result.status='failed';result.error=error instanceof Error?`${error.name}: ${error.message}`:String(error)
    try{await shot('99-failure')}catch{}
    throw Object.assign(error instanceof Error?error:new Error(String(error)),{qaResult:result})
  }finally{
    c.close();browser.proc.kill('SIGTERM');rmSync(browser.dir,{recursive:true,force:true})
  }
}

async function runBoundary(width,height){
  const tag=`${width}x${height}`,result={width,height,captures:[],status:'running'},browser=await launch(width,height),c=browser.c
  const shot=async name=>{const file=`${tag}-${name}.png`;await c.shot(`${OUT}/${file}`);result.captures.push(file)}
  try{
    result.chrome=browser.version
    if(width>760){
      await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false,screenWidth:width,screenHeight:height})
      await c.send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',acceptLanguage:'ko-KR,ko;q=0.9,en;q=0.8',platform:'Linux x86_64'})
    }
    await c.nav(BASE)
    await c.wait(`/\\d/.test(document.querySelector('.home-search-console-copy small')?.textContent||'')`,'catalog loaded boundary')
    await enterSwitch(c)
    result.brand=await assertBrand(c,`boundary ${width}`)
    result.topbar=await topbar(c)
    result.layout=await navLayout(c)
    assertNavLayout(result.layout,{mobileStack:width<=760})
    await shot('boundary-switch')
    result.network=await network(c)
    assert.equal(result.network.sentAnalytics.length,0,'analytics request escaped blocker')
    assert.equal(result.network.sentWrites.length,0,'production write escaped blocker')
    result.status='pass';return result
  }catch(error){
    result.status='failed';result.error=error instanceof Error?`${error.name}: ${error.message}`:String(error)
    try{await shot('99-failure')}catch{}
    throw Object.assign(error instanceof Error?error:new Error(String(error)),{qaResult:result})
  }finally{
    c.close();browser.proc.kill('SIGTERM');rmSync(browser.dir,{recursive:true,force:true})
  }
}

const report={targetSha:TARGET_SHA,baseUrl:BASE,environment:'GitHub-hosted headless Chrome with Korean locale/Noto Sans CJK; viewport emulation only, not a physical device or screen reader',mobile:[],boundaries:[],status:'running'}
const save=()=>writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))
try{
  for(const [w,h] of [[360,844],[390,900]]){try{report.mobile.push(await runMobile(w,h))}catch(e){if(e?.qaResult)report.mobile.push(e.qaResult);throw e}finally{save()}}
  for(const [w,h] of [[760,900],[761,900],[1280,900]]){try{report.boundaries.push(await runBoundary(w,h))}catch(e){if(e?.qaResult)report.boundaries.push(e.qaResult);throw e}finally{save()}}
  report.status='pass';save()
  console.log('PR26_MOBILE_SWITCH_MODE_NAV_QA_PASS',JSON.stringify({targetSha:TARGET_SHA,mobile:report.mobile.map(x=>({size:`${x.width}x${x.height}`,skuBefore:x.visibleBefore?.sku,skuAfter:x.visibleAfterLookup?.sku,requeryInitial:x.requeryInitial?.sku,network:x.network})),boundaries:report.boundaries.map(x=>({size:`${x.width}x${x.height}`,topbar:x.layout?.topbar,buttons:x.layout?.buttons.map(b=>({text:b.text,rect:b.rect})),network:x.network}))}))
}catch(error){report.status='failed';report.error=error instanceof Error?`${error.name}: ${error.message}`:String(error);save();throw error}
