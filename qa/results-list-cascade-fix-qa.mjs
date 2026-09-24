import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE='http://127.0.0.1:4173/'
const OUT=process.env.OUT_DIR||'qa-output'
await mkdir(OUT,{recursive:true})
const report={head:process.env.GITHUB_SHA||null,generatedAt:new Date().toISOString(),blockedWrites:[],states:{},mobile:{}}

const browser=await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function pageFor(width,height){
  const page=await browser.newPage({viewport:{width,height}})
  await page.route('**/*',async route=>{
    const req=route.request()
    if(!['GET','HEAD','OPTIONS'].includes(req.method())){
      report.blockedWrites.push({method:req.method(),url:req.url()})
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  return page
}

async function settle(page){
  await page.locator('.research-result-card').first().waitFor({state:'visible',timeout:30000})
  await page.evaluate(async()=>{await document.fonts?.ready})
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
      const s=getComputedStyle(el), r=el.getBoundingClientRect()
      return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0
    }
    return [...document.querySelectorAll('.research-result-card')].map((card,index)=>{
      const name=card.querySelector('.research-result-identity strong')
      const identity=card.querySelector('.research-result-identity')
      const image=card.querySelector('.research-result-image,.image-placeholder')
      const packages=card.querySelector('.research-result-packages')
      const relation=card.querySelector('.result-relations,.result-relation-empty')
      const action=card.querySelector('.research-result-open')
      const style=name?getComputedStyle(name):null
      return {
        index,
        id:card.dataset.productId||'',
        selected:card.classList.contains('is-selected'),
        name:name?.textContent?.trim()||'',
        fontSize:style?.fontSize||null,
        lineHeight:style?.lineHeight||null,
        nameOverflow:style?.overflow||null,
        nameWhiteSpace:style?.whiteSpace||null,
        card:rect(card),
        nameBox:rect(name),
        identity:rect(identity),
        image:visible(image)?rect(image):null,
        packages:visible(packages)?rect(packages):null,
        relation:visible(relation)?rect(relation):null,
        action:visible(action)?rect(action):null,
        nameClient:{w:name?.clientWidth||0,h:name?.clientHeight||0},
        nameScroll:{w:name?.scrollWidth||0,h:name?.scrollHeight||0},
        packageClient:{w:packages?.clientWidth||0,h:packages?.clientHeight||0},
        packageScroll:{w:packages?.scrollWidth||0,h:packages?.scrollHeight||0},
      }
    })
  })
}

function assertType(row,label){
  assert.equal(row.fontSize,'16px',label+': font-size 16px')
  assert.ok(Math.abs(parseFloat(row.lineHeight)-23.2)<0.25,label+': line-height 1.45 at 16px')
  assert.ok(row.nameScroll.w<=row.nameClient.w+2,label+': name has no horizontal clipping')
  assert.ok(row.nameScroll.h<=row.nameClient.h+2,label+': wrapped name has no vertical clipping')
  assert.ok(row.packageScroll.w<=row.packageClient.w+2,label+': package has no horizontal clipping')
  assert.ok(row.packageScroll.h<=row.packageClient.h+2,label+': package has no vertical clipping')
}

function overlap(a,b){
  if(!a||!b) return false
  return Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 &&
    Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1
}

function assertGeometry(row,label){
  for(const [name,box] of [['identity',row.identity],['image',row.image],['relation',row.relation],['action',row.action]]){
    if(!box) continue
    assert.ok(box.left>=row.card.left-1&&box.right<=row.card.right+1,label+': '+name+' stays inside row horizontally')
    assert.ok(box.top>=row.card.top-1&&box.bottom<=row.card.bottom+1,label+': '+name+' stays inside row vertically')
  }
  assert.equal(overlap(row.image,row.identity),false,label+': image and identity do not overlap')
  if(row.relation){
    assert.equal(overlap(row.image,row.relation),false,label+': image and relation do not overlap')
    assert.equal(overlap(row.identity,row.relation),false,label+': identity and relation do not overlap')
  }
  if(row.action){
    assert.equal(overlap(row.image,row.action),false,label+': image and action do not overlap')
    assert.equal(overlap(row.identity,row.action),false,label+': identity and action do not overlap')
    assert.equal(overlap(row.relation,row.action),false,label+': relation and action do not overlap')
  }
}

async function desktopMode(mode){
  const query=mode==='lookup'
    ? '?view=workspace&mode=lookup&q=GO%21%20SOLUTIONS'
    : '?view=workspace&mode=explore&applied=1&feed=%EA%B1%B4%EC%8B%9D&targets=indoor'
  const page=await pageFor(1440,900)
  await page.goto(BASE+query,{waitUntil:'domcontentloaded',timeout:30000})
  await settle(page)

  const before=await rows(page)
  assert.ok(before.length>1,mode+': at least two rows before opening')
  before.forEach((row,i)=>{assertType(row,mode+' before row '+i);assertGeometry(row,mode+' before row '+i)})
  const longest=before.reduce((best,row)=>row.name.length>best.name.length?row:best,before[0])
  await page.screenshot({path:OUT+'/'+mode+'-1440-before.png',fullPage:false})

  await page.locator('.research-result-card').nth(longest.index).click()
  await page.locator('.research-quick-view').waitFor({state:'visible'})
  const open=await rows(page)
  const selected=open.find(row=>row.selected)
  const other=open.find(row=>!row.selected)
  assert.ok(selected,mode+': selected row exists after opening')
  assert.ok(other,mode+': non-selected row exists after opening')
  assertType(selected,mode+' open selected')
  assertType(other,mode+' open non-selected')
  assertGeometry(selected,mode+' open selected')
  assertGeometry(other,mode+' open non-selected')
  assert.ok(selected.name.length===longest.name.length,mode+': longest selected name preserved')
  await page.screenshot({path:OUT+'/'+mode+'-1440-open.png',fullPage:false})

  await page.locator('.quick-view-topline button').click()
  await page.locator('.research-quick-view').waitFor({state:'detached'})
  const closed=await rows(page)
  assert.ok(closed.every(row=>!row.selected),mode+': selection clears after close')
  closed.forEach((row,i)=>{assertType(row,mode+' closed row '+i);assertGeometry(row,mode+' closed row '+i)})
  await page.screenshot({path:OUT+'/'+mode+'-1440-closed.png',fullPage:false})

  report.states[mode]={query,longest:{index:longest.index,name:longest.name},before,open:{selected,other},closed}
  await page.close()
}

async function mobileMode(mode){
  const query=mode==='lookup'
    ? '?view=workspace&mode=lookup&q=GO%21%20SOLUTIONS'
    : '?view=workspace&mode=explore&applied=1&feed=%EA%B1%B4%EC%8B%9D&targets=indoor'
  const page=await pageFor(390,844)
  await page.goto(BASE+query,{waitUntil:'domcontentloaded',timeout:30000})
  await settle(page)
  const measured=await rows(page)
  assert.ok(measured.length,mode+' mobile: rows exist')
  measured.forEach((row,i)=>{
    assertType(row,mode+' mobile row '+i)
    assert.ok(row.image&&row.action,mode+' mobile row '+i+': image/action exist')
    assert.ok(Math.abs(row.image.left-row.action.left)<=1,mode+' mobile row '+i+': action aligns below image')
    assert.ok(Math.abs(row.image.width-row.action.width)<=1,mode+' mobile row '+i+': action matches image rail')
    assert.ok(row.action.top>=row.image.bottom-1,mode+' mobile row '+i+': action is below image')
    assert.ok(row.action.height>=44,mode+' mobile row '+i+': action remains >=44px')
  })
  report.mobile[mode]=measured
  await page.screenshot({path:OUT+'/'+mode+'-390-browse.png',fullPage:false})
  await page.close()
}

await desktopMode('lookup')
await desktopMode('explore')
await mobileMode('lookup')
await mobileMode('explore')

assert.equal(report.blockedWrites.length,0,'narrow read-only QA should not attempt writes')
await writeFile(OUT+'/cascade-fix-measurements.json',JSON.stringify(report,null,2))
console.log('CASCADE_FIX_QA='+JSON.stringify({
  head:report.head,
  lookupLongest:report.states.lookup.longest.name,
  exploreLongest:report.states.explore.longest.name,
  blockedWrites:report.blockedWrites.length,
}))
await browser.close()
