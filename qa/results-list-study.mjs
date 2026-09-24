import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE = 'https://osrm.github.io/catfood_web/'
const OUT = process.env.OUT_DIR || 'qa-output'
const MAIN_SHA = process.env.MAIN_SHA

await mkdir(OUT, { recursive: true })

const report = {
  generatedAt: new Date().toISOString(),
  mainSha: MAIN_SHA,
  blockedAttempts: [],
  publicReads: [],
  lookup: {},
  explore: {},
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
})

async function guardedPage(width, height) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.route('**/*', async route => {
    const req = route.request()
    const method = req.method()
    const url = req.url()
    let parsed = null
    try { parsed = new URL(url) } catch {}

    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      report.blockedAttempts.push({
        reason: 'non-read-method',
        method,
        url: parsed ? parsed.origin + parsed.pathname : url,
      })
      await route.abort('blockedbyclient')
      return
    }
    if (/\/functions\/v1\/|analytics|telemetry|event_log|search-runs|considerations/i.test(url)) {
      report.blockedAttempts.push({
        reason: 'analytics-or-write-endpoint',
        method,
        url: parsed ? parsed.origin + parsed.pathname : url,
      })
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  page.on('response', response => {
    try {
      const u = new URL(response.url())
      if (u.host === 'gnosbstdatkytsyxuapt.supabase.co' && u.pathname.startsWith('/rest/v1/')) {
        report.publicReads.push({
          method: response.request().method(),
          path: u.pathname,
          status: response.status(),
        })
      }
    } catch {}
  })
  return page
}

async function waitResults(page) {
  await page.locator('.research-result-card').first().waitFor({ state: 'visible', timeout: 30000 })
  await page.evaluate(() => document.fonts?.ready)
}

async function settleVisibleImages(page, scrollFirst = true) {
  if (scrollFirst) await page.locator('.research-result-card').first().scrollIntoViewIfNeeded()
  await page.evaluate(async () => {
    const visible = [...document.querySelectorAll('img.research-result-image, img.quick-view-image')].filter(img => {
      const r = img.getBoundingClientRect()
      return r.bottom > 0 && r.top < innerHeight
    })
    await Promise.all(visible.map(img => img.decode?.().catch(() => undefined)))
  })
}

async function readCards(page) {
  return page.locator('.research-result-card').evaluateAll(cards => cards.map(card => {
    const rect = card.getBoundingClientRect()
    const identity = card.querySelector('.research-result-identity')
    const name = card.querySelector('.research-result-identity strong')
    const brand = card.querySelector('.research-result-brand')
    const meta = card.querySelector('.research-result-meta')
    const packages = card.querySelector('.research-result-packages')
    const image = card.querySelector('.research-result-image, .image-placeholder')
    const facts = card.querySelector('.research-result-facts')
    const relations = [...card.querySelectorAll('.relation-line')].map(line => ({
      kind: line.classList.contains('is-confirmed') ? 'confirmed' : line.classList.contains('is-unknown') ? 'unknown' : 'other',
      label: line.querySelector('span')?.textContent?.trim() || '',
      value: line.querySelector('strong')?.textContent?.trim() || '',
      fontSize: getComputedStyle(line).fontSize,
    }))
    const open = card.querySelector('.research-result-open')
    const cs = getComputedStyle(card)
    const ns = name ? getComputedStyle(name) : null
    return {
      productId: card.dataset.productId || '',
      selected: card.classList.contains('is-selected'),
      brand: brand?.textContent?.trim() || '',
      name: name?.textContent?.trim() || '',
      meta: meta?.textContent?.trim() || '',
      packages: packages?.textContent?.trim() || '',
      facts: facts?.textContent?.replace(/\s+/g, ' ').trim() || '',
      relations,
      open: open?.textContent?.trim() || '',
      rect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height},
      cardFontSize: cs.fontSize,
      nameFontSize: ns?.fontSize || null,
      nameLineHeight: ns?.lineHeight || null,
      nameScrollWidth: name?.scrollWidth || null,
      nameClientWidth: name?.clientWidth || null,
      nameScrollHeight: name?.scrollHeight || null,
      nameClientHeight: name?.clientHeight || null,
      identityWidth: identity?.getBoundingClientRect().width || null,
      image:{
        tag:image?.tagName || null,
        src:image instanceof HTMLImageElement ? image.currentSrc || image.src : null,
        naturalWidth:image instanceof HTMLImageElement ? image.naturalWidth : null,
        complete:image instanceof HTMLImageElement ? image.complete : null,
        width:image?.getBoundingClientRect().width || null,
        height:image?.getBoundingClientRect().height || null,
      },
    }
  }))
}

async function frameMetrics(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const el = document.querySelector(selector)
      if (!(el instanceof HTMLElement)) return null
      const r = el.getBoundingClientRect()
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}
    }
    const shell = document.querySelector('.research-shell')
    return {
      viewport:{width:innerWidth,height:innerHeight},
      documentWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth,
      shell:rect('.research-shell'),
      workspace:rect('.research-workspace'),
      filters:rect('.research-filters'),
      results:rect('.research-results'),
      quickView:rect('.research-quick-view'),
      criteria:rect('.criteria-bar'),
      resultsHeading:rect('.research-results-heading'),
      shellOverflowY:shell instanceof HTMLElement ? getComputedStyle(shell).overflowY : null,
    }
  })
}

async function focusEvidence(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  const sequence=[]
  for(let i=0;i<40;i+=1){
    await page.keyboard.press('Tab')
    const active=await page.evaluate(() => {
      const el=document.activeElement
      return {
        tag:el?.tagName||'',
        className:el instanceof HTMLElement ? el.className : '',
        text:el?.textContent?.replace(/\s+/g,' ').trim().slice(0,80)||'',
        productId:el instanceof HTMLElement ? el.dataset.productId || null : null,
      }
    })
    sequence.push(active)
    if(active.className.includes('research-result-card')){
      const style=await page.evaluate(() => {
        const el=document.activeElement
        if(!(el instanceof HTMLElement)) return null
        const cs=getComputedStyle(el)
        return {outline:cs.outline,outlineOffset:cs.outlineOffset}
      })
      return {sequence,style}
    }
  }
  return {sequence,style:null}
}

async function captureBrowse({mode,width,height,url,file}) {
  const page=await guardedPage(width,height)
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000})
  await waitResults(page)
  const results=page.locator('.research-results')
  await results.scrollIntoViewIfNeeded()
  await settleVisibleImages(page)
  const cards=await readCards(page)
  const metrics=await frameMetrics(page)
  const focus=await focusEvidence(page)
  assert.equal(metrics.documentWidth,width,mode+' browse: no document horizontal overflow')
  assert.equal(metrics.bodyWidth,width,mode+' browse: no body horizontal overflow')
  assert.ok(cards.length>0,mode+' browse: has result cards')
  assert.ok(cards.every(c => (c.nameScrollWidth ?? 0) <= (c.nameClientWidth ?? 0)+2),mode+' browse: names do not overflow horizontally')
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  await page.close()
  return {url,cards,metrics,focus}
}

async function captureSelected({mode,width,height,url,file,pickUnknown=false}) {
  const page=await guardedPage(width,height)
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000})
  await waitResults(page)
  let target=page.locator('.research-result-card').first()
  if(pickUnknown){
    const unknown=page.locator('.research-result-card:has(.relation-line.is-unknown)').first()
    if(await unknown.count()) target=unknown
  }
  const selectedProductId=await target.getAttribute('data-product-id')
  await target.click()
  await page.locator('.research-quick-view').waitFor({state:'visible',timeout:20000})
  await settleVisibleImages(page, false)
  const cards=await readCards(page)
  const metrics=await frameMetrics(page)
  const quick=await page.locator('.research-quick-view').evaluate(el => {
    const r=el.getBoundingClientRect()
    const title=el.querySelector('.quick-view-identity h1')
    const actions=[...el.querySelectorAll('.quick-view-actions button')].map(btn=>{
      const b=btn.getBoundingClientRect()
      return {text:btn.textContent?.replace(/\s+/g,' ').trim()||'',width:b.width,height:b.height,fontSize:getComputedStyle(btn).fontSize}
    })
    return {
      rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},
      title:title?.textContent?.trim()||'',
      titleFontSize:title ? getComputedStyle(title).fontSize : null,
      actions,
      relationText:el.querySelector('.quick-view-section')?.textContent?.replace(/\s+/g,' ').trim()||'',
    }
  })
  assert.ok(quick.actions.every(a=>a.height>=42),mode+' selected: quick actions remain usable')
  await page.screenshot({path:OUT+'/'+file,fullPage:false})
  await page.close()
  return {url,selectedProductId,cards,metrics,quick}
}

const lookupUrl=BASE+'?view=workspace&mode=lookup&q=GO%21+SOLUTIONS'
const exploreUrl=BASE+'?view=workspace&applied=1&feed='+encodeURIComponent('건식')+'&targets=indoor'

report.lookup.mobileBrowse=await captureBrowse({
  mode:'lookup',width:390,height:844,url:lookupUrl,file:'current-lookup-mobile-390x844-browse.png'
})
report.lookup.desktopSelected=await captureSelected({
  mode:'lookup',width:1440,height:900,url:lookupUrl,file:'current-lookup-desktop-1440x900-selected.png'
})
report.explore.mobileBrowse=await captureBrowse({
  mode:'explore',width:390,height:844,url:exploreUrl,file:'current-explore-mobile-390x844-browse.png'
})
report.explore.desktopSelected=await captureSelected({
  mode:'explore',width:1440,height:900,url:exploreUrl,file:'current-explore-desktop-1440x900-selected.png',pickUnknown:true
})

assert.ok(report.explore.mobileBrowse.cards.some(c=>c.relations.some(r=>r.kind==='unknown')),'EXPLORE sample includes unknown relation')
assert.ok(report.explore.mobileBrowse.cards.some(c=>c.relations.some(r=>r.kind==='confirmed')),'EXPLORE sample includes confirmed relation')
assert.ok(report.publicReads.length>0,'public reads observed')
assert.ok(report.publicReads.every(x=>['GET','HEAD','OPTIONS'].includes(x.method) && x.status>=200 && x.status<300),'all transmitted Data API requests are successful reads')

await writeFile(OUT+'/current-results-study.json',JSON.stringify(report,null,2))
console.log('CURRENT_RESULTS_STUDY='+JSON.stringify(report))
await browser.close()
