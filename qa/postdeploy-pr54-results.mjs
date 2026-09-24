import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='https://osrm.github.io/catfood_web/'
const OUT=process.env.OUT_DIR||'postdeploy-output'
await mkdir(OUT,{recursive:true})
const report={
  expectedMergeSha:'730d9b7a332e27606ce3af879b102d1c83493116',
  generatedAt:new Date().toISOString(),
  blockedWrites:[],
  blockedAnalytics:[],
  allowedExternal:[],
  lookup:{},
  explore:{},
}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function newPage(width,height){
  const context=await browser.newContext({
    viewport:{width,height},
    serviceWorkers:'block',
  })
  const page=await context.newPage()
  await page.setExtraHTTPHeaders({'Cache-Control':'no-cache','Pragma':'no-cache'})
  await page.route('**/*',async route=>{
    const request=route.request()
    const method=request.method()
    const url=request.url()
    const analytics=/functions\/v1|search-runs|considerations|event_log|analytics|telemetry/i.test(url)
    const writeLike=!['GET','HEAD','OPTIONS'].includes(method)
    if(analytics||writeLike){
      const entry={method,url}
      if(analytics) report.blockedAnalytics.push(entry)
      if(writeLike) report.blockedWrites.push(entry)
      await route.abort('blockedbyclient')
      return
    }
    if(!url.startsWith(BASE)) report.allowedExternal.push({method,url})
    await route.continue()
  })
  return {page,context}
}

async function settle(page){
  await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:30000})
  await page.evaluate(async()=>{await document.fonts?.ready})
}

async function waitVisibleImages(page){
  return page.evaluate(async()=>{
    const images=[...document.querySelectorAll('img')].filter(img=>{
      const r=img.getBoundingClientRect()
      return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight
    })
    await Promise.all(images.map(img=>img.decode().catch(()=>undefined)))
    return images.map(img=>({
      src:img.currentSrc||img.src,
      complete:img.complete,
      naturalWidth:img.naturalWidth,
      naturalHeight:img.naturalHeight,
      className:img.className,
    }))
  })
}

async function pointerClick(page,locator){
  await locator.scrollIntoViewIfNeeded()
  const b=await locator.boundingBox()
  assert.ok(b,'pointer target has a box')
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2)
  await page.mouse.click(b.x+b.width/2,b.y+b.height/2)
}

async function rows(page){
  return page.evaluate(()=>{
    const rect=(el)=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}
    }
    const visible=(el)=>{
      if(!(el instanceof HTMLElement)) return false
      const s=getComputedStyle(el),r=el.getBoundingClientRect()
      return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0
    }
    return [...document.querySelectorAll('.research-result-card')].map((card,index)=>{
      const name=card.querySelector('.research-result-identity strong')
      const packages=card.querySelector('.research-result-packages')
      const identity=card.querySelector('.research-result-identity')
      const image=card.querySelector('.research-result-image,.image-placeholder')
      const action=card.querySelector('.research-result-open')
      const relation=card.querySelector('.relation-line')
      const relationLabel=relation?.querySelector('span')
      const relationValue=relation?.querySelector('strong')
      const ns=name?getComputedStyle(name):null
      return {
        index,
        id:card.dataset.productId||'',
        selected:card.classList.contains('is-selected'),
        name:name?.textContent?.trim()||'',
        packagesText:packages?.textContent?.trim()||'',
        fontSize:ns?.fontSize||null,
        lineHeight:ns?.lineHeight||null,
        nameBox:rect(name),
        identity:rect(identity),
        image:visible(image)?rect(image):null,
        action:visible(action)?rect(action):null,
        packages:visible(packages)?rect(packages):null,
        relation:visible(relation)?rect(relation):null,
        relationLabelFont:relationLabel?getComputedStyle(relationLabel).fontSize:null,
        relationValueFont:relationValue?getComputedStyle(relationValue).fontSize:null,
        nameClient:{w:name?.clientWidth||0,h:name?.clientHeight||0},
        nameScroll:{w:name?.scrollWidth||0,h:name?.scrollHeight||0},
        packageClient:{w:packages?.clientWidth||0,h:packages?.clientHeight||0},
        packageScroll:{w:packages?.scrollWidth||0,h:packages?.scrollHeight||0},
        card:rect(card),
      }
    })
  })
}

async function shell(page){
  return page.evaluate(()=>{
    const rect=(el)=>{
      if(!(el instanceof HTMLElement)) return null
      const r=el.getBoundingClientRect()
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}
    }
    const results=document.querySelector('.research-results')
    const quick=document.querySelector('.research-quick-view')
    return {
      documentWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth,
      viewportWidth:innerWidth,
      results:rect(results),
      quick:rect(quick),
      resultsDisplay:results?getComputedStyle(results).display:null,
      quickDisplay:quick?getComputedStyle(quick).display:null,
    }
  })
}

function overlap(a,b){
  if(!a||!b) return false
  return Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 &&
    Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1
}

function assertName(row,label){
  assert.equal(row.fontSize,'16px',label+': result name is 16px')
  assert.ok(Math.abs(parseFloat(row.lineHeight)-23.2)<0.25,label+': result name line-height is 1.45')
  assert.ok(row.nameScroll.w<=row.nameClient.w+2,label+': result name not horizontally clipped')
  assert.ok(row.nameScroll.h<=row.nameClient.h+2,label+': result name not vertically clipped')
  assert.ok(row.packageScroll.w<=row.packageClient.w+2,label+': package text not horizontally clipped')
  assert.ok(row.packageScroll.h<=row.packageClient.h+2,label+': package text not vertically clipped')
}

function assertRowGeometry(row,label){
  for(const [name,box] of [['identity',row.identity],['image',row.image],['packages',row.packages],['relation',row.relation],['action',row.action]]){
    if(!box) continue
    assert.ok(box.left>=row.card.left-1&&box.right<=row.card.right+1,label+': '+name+' stays within row horizontally')
    assert.ok(box.top>=row.card.top-1&&box.bottom<=row.card.bottom+1,label+': '+name+' stays within row vertically')
  }
  assert.equal(overlap(row.image,row.identity),false,label+': image/identity do not overlap')
  if(row.relation){
    assert.equal(overlap(row.image,row.relation),false,label+': image/relation do not overlap')
    assert.equal(overlap(row.identity,row.relation),false,label+': identity/relation do not overlap')
  }
}

async function lookupMobile(){
  const {page,context}=await newPage(390,844)
  const url=BASE+'?view=workspace&mode=lookup&q=GO%21%20SOLUTIONS'
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000})
  await settle(page)
  const images=await waitVisibleImages(page)
  assert.ok(images.some(x=>/research-result-image/.test(String(x.className))&&x.complete&&x.naturalWidth>0),'LOOKUP: at least one visible real product image loaded')

  const before=await rows(page)
  assert.ok(before.length>0,'LOOKUP: result rows exist')
  before.forEach((row,i)=>{
    assertName(row,'LOOKUP mobile row '+i)
    assert.ok(row.image&&row.action,'LOOKUP mobile row '+i+': image/action exist')
    assert.ok(Math.abs(row.image.left-row.action.left)<=1,'LOOKUP mobile row '+i+': action aligned below image')
    assert.ok(Math.abs(row.image.width-row.action.width)<=1,'LOOKUP mobile row '+i+': action width matches image')
    assert.ok(row.action.top>=row.image.bottom-1,'LOOKUP mobile row '+i+': action below image')
    assert.ok(row.action.height>=44,'LOOKUP mobile row '+i+': action >=44px')
    assertRowGeometry(row,'LOOKUP mobile row '+i)
  })
  let sh=await shell(page)
  assert.equal(sh.documentWidth,390,'LOOKUP mobile: no document horizontal overflow')
  assert.equal(sh.bodyWidth,390,'LOOKUP mobile: no body horizontal overflow')
  await page.screenshot({path:OUT+'/lookup-mobile-390-browse.png',fullPage:false})

  await pointerClick(page,page.locator('.research-result-card').first())
  await page.locator('.research-quick-view').waitFor({state:'visible',timeout:10000})
  const openImages=await waitVisibleImages(page)
  assert.ok(openImages.some(x=>x.complete&&x.naturalWidth>0),'LOOKUP quick view: visible image loaded')
  sh=await shell(page)
  assert.equal(sh.resultsDisplay,'none','LOOKUP mobile: result list hidden while quick view is open')
  assert.equal(sh.documentWidth,390,'LOOKUP mobile open: no horizontal overflow')
  await page.screenshot({path:OUT+'/lookup-mobile-390-open.png',fullPage:false})

  await pointerClick(page,page.locator('.quick-view-topline button'))
  await page.locator('.research-quick-view').waitFor({state:'detached',timeout:10000})
  const closed=await rows(page)
  closed.forEach((row,i)=>assertName(row,'LOOKUP mobile closed row '+i))
  report.lookup={url,images,before,closed}
  await context.close()
}

async function exploreDesktop(){
  const {page,context}=await newPage(1440,900)
  const url=BASE+'?view=workspace&mode=explore&applied=1&feed=%EA%B1%B4%EC%8B%9D&targets=indoor'
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000})
  await settle(page)
  const images=await waitVisibleImages(page)
  assert.ok(images.some(x=>/research-result-image/.test(String(x.className))&&x.complete&&x.naturalWidth>0),'EXPLORE: at least one visible real product image loaded')

  const before=await rows(page)
  assert.ok(before.length>1,'EXPLORE: multiple rows exist')
  before.forEach((row,i)=>{
    assertName(row,'EXPLORE before row '+i)
    if(row.relationLabelFont){
      assert.equal(row.relationLabelFont,'12px','EXPLORE before row '+i+': relation label 12px')
      assert.equal(row.relationValueFont,'13px','EXPLORE before row '+i+': relation value 13px')
    }
    assertRowGeometry(row,'EXPLORE before row '+i)
  })
  let sh=await shell(page)
  assert.equal(sh.documentWidth,1440,'EXPLORE before: no document horizontal overflow')
  assert.equal(sh.bodyWidth,1440,'EXPLORE before: no body horizontal overflow')
  await page.screenshot({path:OUT+'/explore-desktop-1440-before.png',fullPage:false})

  const longest=before.reduce((best,row)=>row.name.length>best.name.length?row:best,before[0])
  await pointerClick(page,page.locator('.research-result-card').nth(longest.index))
  await page.locator('.research-quick-view').waitFor({state:'visible',timeout:10000})
  const openImages=await waitVisibleImages(page)
  assert.ok(openImages.some(x=>x.complete&&x.naturalWidth>0),'EXPLORE open: visible image loaded')

  const open=await rows(page)
  const selected=open.find(row=>row.selected)
  const other=open.find(row=>!row.selected)
  assert.ok(selected,'EXPLORE open: selected row exists')
  assert.ok(other,'EXPLORE open: non-selected row exists')
  assertName(selected,'EXPLORE open selected')
  assertName(other,'EXPLORE open non-selected')
  assertRowGeometry(selected,'EXPLORE open selected')
  assertRowGeometry(other,'EXPLORE open non-selected')
  assert.ok(selected.name.length===longest.name.length,'EXPLORE open: longest name preserved')
  assert.ok(selected.nameBox&&selected.nameBox.height>=parseFloat(selected.lineHeight)-1,'EXPLORE open: long name has natural line box')
  const visibleRelations=open.filter(row=>row.relationLabelFont)
  assert.ok(visibleRelations.length>0,'EXPLORE open: relation rows remain visible')
  visibleRelations.forEach((row,i)=>{
    assert.equal(row.relationLabelFont,'12px','EXPLORE open relation '+i+': label 12px')
    assert.equal(row.relationValueFont,'13px','EXPLORE open relation '+i+': value 13px')
  })

  sh=await shell(page)
  assert.ok(sh.results&&sh.quick,'EXPLORE open: result and quick-view panes exist')
  const share=sh.results.width/(sh.results.width+sh.quick.width)
  assert.ok(share>=0.485&&share<=0.495,'EXPLORE open: results/quick view is about 49:51')
  assert.equal(sh.documentWidth,1440,'EXPLORE open: no document horizontal overflow')
  assert.equal(sh.bodyWidth,1440,'EXPLORE open: no body horizontal overflow')
  await page.screenshot({path:OUT+'/explore-desktop-1440-open.png',fullPage:false})

  await pointerClick(page,page.locator('.quick-view-topline button'))
  await page.locator('.research-quick-view').waitFor({state:'detached',timeout:10000})
  const closed=await rows(page)
  closed.forEach((row,i)=>{
    assertName(row,'EXPLORE closed row '+i)
    if(row.relationLabelFont){
      assert.equal(row.relationLabelFont,'12px','EXPLORE closed row '+i+': relation label 12px')
      assert.equal(row.relationValueFont,'13px','EXPLORE closed row '+i+': relation value 13px')
    }
    assertRowGeometry(row,'EXPLORE closed row '+i)
  })
  sh=await shell(page)
  assert.equal(sh.documentWidth,1440,'EXPLORE closed: no document horizontal overflow')
  await page.screenshot({path:OUT+'/explore-desktop-1440-closed.png',fullPage:false})

  report.explore={url,images,longest,before,open:{selected,other,visibleRelationCount:visibleRelations.length,resultsShare:share},closed}
  await context.close()
}

await lookupMobile()
await exploreDesktop()

assert.ok(report.allowedExternal.every(r=>['GET','HEAD','OPTIONS'].includes(r.method)),'only public read methods were allowed')
await writeFile(OUT+'/postdeploy-measurements.json',JSON.stringify(report,null,2))
console.log('POSTDEPLOY='+JSON.stringify({
  expectedMergeSha:report.expectedMergeSha,
  lookupRows:report.lookup.before.length,
  exploreRows:report.explore.before.length,
  exploreLongest:report.explore.longest.name,
  blockedWrites:report.blockedWrites.length,
  blockedAnalytics:report.blockedAnalytics.length,
  resultsShare:report.explore.open.resultsShare,
}))
await browser.close()
