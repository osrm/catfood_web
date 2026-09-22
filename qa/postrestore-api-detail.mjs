import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const PAGES = 'https://osrm.github.io/catfood_web/'
const CANDIDATE = 'http://127.0.0.1:4173/'
const API = (process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || ''
const OUT = process.env.OUT_DIR || 'qa-output'
const GO = 'product_31bc515d78d43d5d'
const MONGE = 'product_11dc2e0bf60b0874'
await mkdir(OUT, { recursive: true })

const products = [
  { tag:'go', id:GO, q:'GO!', expectedTitle:'카니보 치킨&칠면조&오리' },
  { tag:'monge', id:MONGE, q:'몬지', expectedTitle:'몬지 비와일드 그레인프리 어덜트 연어' },
]
const endpoints = [
  'effective_product_catalog_summary',
  'switch_current_variant_options',
  'compare_product_nutrition',
  'compare_product_ingredients',
  'product_detail_manufacturing',
  'product_detail_markets',
]

function detailUrl(base, p) {
  const u = new URL(base)
  u.searchParams.set('view','workspace')
  u.searchParams.set('mode','lookup')
  u.searchParams.set('q',p.q)
  u.searchParams.set('detail',p.id)
  u.searchParams.set('detailTab','overview')
  return u.toString()
}

async function apiGet(view) {
  const u = new URL(API + '/rest/v1/' + view)
  u.searchParams.set('select','*')
  u.searchParams.set('product_id','in.(' + GO + ',' + MONGE + ')')
  u.searchParams.set('limit','20')
  const r = await fetch(u,{headers:{apikey:KEY,'Accept-Profile':'api'}})
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return {
    view,
    status:r.status,
    ok:r.ok,
    rowCount:Array.isArray(body)?body.length:null,
    firstKeys:Array.isArray(body) && body[0] ? Object.keys(body[0]).sort() : [],
    products:Array.isArray(body) ? [...new Set(body.map(x=>x.product_id).filter(Boolean))].sort() : [],
    error: r.ok ? null : String(text).slice(0,300),
  }
}

async function profileProbe(profile) {
  const u = new URL(API + '/rest/v1/effective_product_catalog_summary')
  u.searchParams.set('select','product_id')
  u.searchParams.set('limit','1')
  const r = await fetch(u,{headers:{apikey:KEY,'Accept-Profile':profile}})
  return {profile,status:r.status,body:(await r.text()).slice(0,300)}
}

const report = {
  generatedAt:new Date().toISOString(),
  expectedCandidateSha:process.env.EXPECTED_SHA,
  api:[],
  profileProbes:[],
  pages:[],
  candidate:[],
  blockedWrites:[],
  blockedAnalytics:[],
}

for (const e of endpoints) report.api.push(await apiGet(e))
report.profileProbes.push(await profileProbe('public'))
report.profileProbes.push(await profileProbe('graphql_public'))
console.log('CATFOOD_POSTRESTORE_API=' + JSON.stringify(report.api))
console.log('CATFOOD_POSTRESTORE_PROFILES=' + JSON.stringify(report.profileProbes))
for (const e of report.api) assert.equal(e.status,200,e.view + ' GET must succeed')
for (const p of report.profileProbes) {
  assert.equal(p.status,406,p.profile + ' PostgREST profile must remain unexposed')
  assert.match(p.body,/Invalid schema/i)
}

const browser = await chromium.launch({
  headless:true,
  executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args:['--no-sandbox'],
})

async function makePage(width,height) {
  const page = await browser.newPage({viewport:{width,height}})
  await page.route('**/*', async route => {
    const req = route.request()
    const method = req.method()
    const url = req.url()
    if (!['GET','HEAD','OPTIONS'].includes(method)) {
      const u = new URL(url)
      report.blockedWrites.push({method,url:u.origin + u.pathname})
      await route.abort('blockedbyclient')
      return
    }
    if (/\/functions\/v1\/|analytics|telemetry|event_log/i.test(url)) {
      const u = new URL(url)
      report.blockedAnalytics.push({method,url:u.origin + u.pathname})
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  return page
}

async function waitSettled(page) {
  await page.waitForSelector('.detail-stage',{timeout:20000})
  await page.waitForSelector('.detail-identity h1',{timeout:20000})
  await page.waitForFunction(() => ![...document.querySelectorAll('.detail-state')].some(n => n.textContent?.includes('불러오는 중')), null, {timeout:30000})
  await page.evaluate(() => document.fonts?.ready)
}

async function inspect(base,label,p,width,height) {
  const page = await makePage(width,height)
  const apiResponses = []
  page.on('response', response => {
    try {
      const u = new URL(response.url())
      if (u.host === 'gnosbstdatkytsyxuapt.supabase.co' && u.pathname.startsWith('/rest/v1/')) {
        apiResponses.push({path:u.pathname,status:response.status()})
      }
    } catch {}
  })
  await page.goto(detailUrl(base,p),{waitUntil:'domcontentloaded',timeout:30000})
  await waitSettled(page)

  const overview = await page.evaluate(() => {
    const img = document.querySelector('.detail-product-image')
    const title = document.querySelector('.detail-identity h1')?.textContent?.trim() || null
    const body = document.querySelector('.detail-body')?.textContent || ''
    return {
      title,
      errorVisible:Boolean(document.querySelector('.detail-state.is-error')),
      bodyLength:body.trim().length,
      image: img instanceof HTMLImageElement ? {
        complete:img.complete,
        naturalWidth:img.naturalWidth,
        naturalHeight:img.naturalHeight,
        src:img.currentSrc || img.src,
      } : null,
      placeholder:Boolean(document.querySelector('.detail-image-placeholder')),
    }
  })
  assert.equal(overview.title,p.expectedTitle,label + ' ' + p.tag + ' ' + width + ': title')
  assert.equal(overview.errorVisible,false,label + ' ' + p.tag + ' ' + width + ': no error')
  assert.ok(overview.bodyLength>30,label + ' ' + p.tag + ' ' + width + ': live detail body')
  assert.ok(overview.image && overview.image.complete && overview.image.naturalWidth>0,label + ' ' + p.tag + ' ' + width + ': actual image loaded')
  assert.match(overview.image.src,/\/storage\/v1\/object\/public\//,label + ' ' + p.tag + ': public storage image')

  const panels = {}
  for (const tab of ['nutrition','ingredients','context']) {
    await page.click('#detail-tab-' + tab)
    await page.waitForFunction(k => document.querySelector('#detail-tab-' + k)?.getAttribute('aria-selected') === 'true', tab)
    await page.waitForFunction(() => ![...document.querySelectorAll('.detail-state')].some(n => n.textContent?.includes('불러오는 중')), null, {timeout:20000})
    const state = await page.evaluate(() => ({
      error:Boolean(document.querySelector('.detail-state.is-error')),
      text:(document.querySelector('.detail-body')?.textContent || '').replace(/\s+/g,' ').trim().slice(0,1000),
    }))
    assert.equal(state.error,false,label + ' ' + p.tag + ' ' + width + ' ' + tab + ': no error')
    assert.ok(state.text.length>20,label + ' ' + p.tag + ' ' + width + ' ' + tab + ': populated')
    panels[tab]=state.text
  }
  await page.click('#detail-tab-overview')
  await page.waitForFunction(() => document.querySelector('#detail-tab-overview')?.getAttribute('aria-selected') === 'true')
  const screenshot = OUT + '/' + label + '-' + p.tag + '-overview-' + width + '.png'
  await page.screenshot({path:screenshot,fullPage:false})
  const result = {product:p.tag,width,height,overview,panels,apiResponses,screenshot}
  await page.close()
  return result
}

for (const tuple of [
  ['pages',PAGES,'pages'],
  ['candidate',CANDIDATE,'candidate'],
]) {
  const label=tuple[0], base=tuple[1], bucket=tuple[2]
  for (const p of products) {
    report[bucket].push(await inspect(base,label,p,390,844))
    report[bucket].push(await inspect(base,label,p,1440,1000))
  }
}

assert.equal(report.blockedWrites.length,0,'no write request attempted before/during live detail QA')
await writeFile(OUT + '/report.json',JSON.stringify(report,null,2))
console.log('CATFOOD_POSTRESTORE_REPORT=' + JSON.stringify(report))
await browser.close()
