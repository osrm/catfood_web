import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE = 'https://osrm.github.io/catfood_web/'
const OUT = process.env.OUT_DIR || 'qa-output'
const GO = { id:'product_31bc515d78d43d5d', q:'GO!', title:'카니보 치킨&칠면조&오리' }
const MONGE = { id:'product_11dc2e0bf60b0874', q:'몬지', title:'몬지 비와일드 그레인프리 어덜트 연어' }

await mkdir(OUT, { recursive: true })

const report = {
  generatedAt: new Date().toISOString(),
  deployedMergeSha: process.env.EXPECTED_MERGE_SHA,
  blockedWriteAttempts: [],
  blockedAnalyticsAttempts: [],
  restResponses: [],
  storageResponses: [],
  go390: null,
  monge390: null,
  go1440: null,
}

function detailUrl(product) {
  const u = new URL(BASE)
  u.searchParams.set('view','workspace')
  u.searchParams.set('mode','lookup')
  u.searchParams.set('q',product.q)
  u.searchParams.set('detail',product.id)
  u.searchParams.set('detailTab','overview')
  return u.toString()
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
})

async function makePage(width, height) {
  const page = await browser.newPage({ viewport: { width, height } })

  // Installed before first navigation: no production write or analytics call is allowed.
  await page.route('**/*', async route => {
    const request = route.request()
    const method = request.method()
    const url = request.url()

    if (!['GET','HEAD','OPTIONS'].includes(method)) {
      report.blockedWriteAttempts.push({ method, url: new URL(url).origin + new URL(url).pathname })
      await route.abort('blockedbyclient')
      return
    }

    if (/\/functions\/v1\/|analytics|telemetry|event_log/i.test(url)) {
      report.blockedAnalyticsAttempts.push({ method, url: new URL(url).origin + new URL(url).pathname })
      await route.abort('blockedbyclient')
      return
    }

    await route.continue()
  })

  page.on('response', response => {
    try {
      const u = new URL(response.url())
      if (u.host === 'gnosbstdatkytsyxuapt.supabase.co' && u.pathname.startsWith('/rest/v1/')) {
        report.restResponses.push({
          method: response.request().method(),
          path: u.pathname,
          status: response.status(),
        })
      }
      if (u.host === 'gnosbstdatkytsyxuapt.supabase.co' && u.pathname.startsWith('/storage/v1/object/public/')) {
        report.storageResponses.push({
          method: response.request().method(),
          path: u.pathname,
          status: response.status(),
        })
      }
    } catch {}
  })

  return page
}

async function waitDetail(page) {
  await page.waitForSelector('.detail-stage', { timeout: 30000 })
  await page.waitForSelector('.detail-identity h1', { timeout: 30000 })
  await page.waitForFunction(
    () => ![...document.querySelectorAll('.detail-state')].some(node => node.textContent?.includes('불러오는 중')),
    null,
    { timeout: 30000 },
  )
  assert.equal(await page.locator('.detail-state.is-error').count(), 0, 'no detail load error')
  await page.evaluate(() => document.fonts?.ready)
  await page.waitForFunction(() => {
    const image = document.querySelector('.detail-product-image')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  }, null, { timeout: 30000 })
}

async function mouseClick(page, selector) {
  const box = await page.locator(selector).boundingBox()
  assert.ok(box, 'pointer target exists: ' + selector)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

async function identitySnapshot(page) {
  return page.evaluate(() => {
    const title = document.querySelector('.detail-identity h1')?.textContent?.trim() || null
    const image = document.querySelector('.detail-product-image')
    return {
      title,
      image: image instanceof HTMLImageElement ? {
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        src: image.currentSrc || image.src,
      } : null,
      placeholder: Boolean(document.querySelector('.detail-image-placeholder')),
    }
  })
}

async function assertActualImage(identity, label) {
  assert.ok(identity.image, label + ': product image element exists')
  assert.equal(identity.image.complete, true, label + ': image complete')
  assert.ok(identity.image.naturalWidth > 0 && identity.image.naturalHeight > 0, label + ': actual image has natural dimensions')
  assert.match(identity.image.src, /\/storage\/v1\/object\/public\//, label + ': image comes from public product storage')
  assert.equal(identity.placeholder, false, label + ': no placeholder')
}

async function tabAlignment(page) {
  return page.evaluate(() => {
    const heading = document.querySelector('.detail-section-heading')
    const tabs = document.querySelector('.detail-tabs')
    if (!heading || !tabs) return null
    const h = heading.getBoundingClientRect()
    const t = tabs.getBoundingClientRect()
    return {
      headingTop: h.top,
      tabsBottom: t.bottom,
      headingBelowStickyTabs: h.top >= t.bottom - 3,
    }
  })
}

// 390px GO!: live image/full title, nutrition, real-pointer nutrition -> ingredients, sticky alignment, parent return.
{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(GO), { waitUntil:'domcontentloaded', timeout:30000 })
  await waitDetail(page)

  const identity = await identitySnapshot(page)
  assert.equal(identity.title, GO.title, 'GO mobile full title')
  await assertActualImage(identity, 'GO mobile')

  await mouseClick(page, '#detail-tab-nutrition')
  await page.waitForFunction(() => document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected') === 'true')
  const nutritionText = (await page.locator('.detail-body').innerText()).replace(/\s+/g,' ')
  assert.match(nutritionText, /4,298 kcal\/kg/, 'GO mobile energy')
  assert.match(nutritionText, /조단백질\s*46% 이상/, 'GO mobile protein')
  const nutritionAlignment = await tabAlignment(page)
  assert.equal(nutritionAlignment?.headingBelowStickyTabs, true, 'GO mobile nutrition heading below sticky tabs')
  await page.screenshot({ path: OUT + '/pages-go-nutrition-390.png', fullPage:false })

  await mouseClick(page, '#detail-tab-ingredients')
  await page.waitForFunction(() => document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected') === 'true')
  const ingredientText = (await page.locator('.detail-body').innerText()).replace(/\s+/g,' ')
  assert.match(ingredientText, /원재료/, 'GO mobile ingredients panel')
  assert.match(ingredientText, /47개/, 'GO mobile full ingredient list')
  const ingredientAlignment = await tabAlignment(page)
  assert.equal(ingredientAlignment?.headingBelowStickyTabs, true, 'GO mobile ingredient heading below sticky tabs')

  await mouseClick(page, '.detail-topbar button')
  await page.waitForFunction(() => !document.querySelector('.detail-stage') && Boolean(document.querySelector('.research-results')), null, { timeout:20000 })
  const parentReturn = await page.evaluate(() => !document.querySelector('.detail-stage') && Boolean(document.querySelector('.research-results')))

  report.go390 = {
    identity,
    nutrition: nutritionText.slice(0,900),
    ingredients: ingredientText.slice(0,900),
    nutritionAlignment,
    ingredientAlignment,
    pointerTransition: true,
    parentReturn,
  }
  await page.close()
}

// 390px Monge: live image, energy unknown, partial-list semantics and warning.
{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(MONGE), { waitUntil:'domcontentloaded', timeout:30000 })
  await waitDetail(page)

  const identity = await identitySnapshot(page)
  assert.equal(identity.title, MONGE.title, 'Monge mobile full title')
  await assertActualImage(identity, 'Monge mobile')

  await mouseClick(page, '#detail-tab-nutrition')
  await page.waitForFunction(() => document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected') === 'true')
  const nutritionText = (await page.locator('.detail-body').innerText()).replace(/\s+/g,' ')
  assert.match(nutritionText, /열량\s*미확인/, 'Monge mobile energy remains unknown')
  await page.screenshot({ path: OUT + '/pages-monge-nutrition-390.png', fullPage:false })

  await mouseClick(page, '#detail-tab-ingredients')
  await page.waitForFunction(() => document.querySelector('#detail-tab-ingredients')?.getAttribute('aria-selected') === 'true')
  const ingredientText = (await page.locator('.detail-body').innerText()).replace(/\s+/g,' ')
  assert.match(ingredientText, /일부 목록/, 'Monge mobile partial-list status')
  assert.match(ingredientText, /목록에 없는 원료도 포함될 수 있습니다/, 'Monge mobile partial-list warning')
  await page.screenshot({ path: OUT + '/pages-monge-ingredients-390.png', fullPage:false })

  report.monge390 = {
    identity,
    nutrition: nutritionText.slice(0,900),
    ingredients: ingredientText.slice(0,900),
  }
  await page.close()
}

// 1440px GO!: B two-column identity/document layout, live image/nutrition, no clipping/overlap/horizontal overflow.
{
  const page = await makePage(1440, 1000)
  await page.goto(detailUrl(GO), { waitUntil:'domcontentloaded', timeout:30000 })
  await waitDetail(page)

  const identity = await identitySnapshot(page)
  assert.equal(identity.title, GO.title, 'GO desktop full title')
  await assertActualImage(identity, 'GO desktop')

  const layout = await page.evaluate(() => {
    const root = document.querySelector('.detail-layout')
    const identity = document.querySelector('.detail-identity')
    const documentEl = document.querySelector('.detail-document')
    const stage = document.querySelector('.detail-stage')
    if (!(root instanceof HTMLElement) || !(identity instanceof HTMLElement) || !(documentEl instanceof HTMLElement) || !(stage instanceof HTMLElement)) return null
    const cs = getComputedStyle(root)
    const a = identity.getBoundingClientRect()
    const b = documentEl.getBoundingClientRect()
    return {
      display: cs.display,
      gridTemplateColumns: cs.gridTemplateColumns,
      identity: { left:a.left, right:a.right, top:a.top, bottom:a.bottom, width:a.width },
      document: { left:b.left, right:b.right, top:b.top, bottom:b.bottom, width:b.width },
      separatedColumns: a.right <= b.left + 1,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      stageOverflow: stage.scrollWidth > stage.clientWidth + 1,
    }
  })
  assert.equal(layout?.display, 'grid', 'GO desktop detail layout is grid')
  assert.equal(layout?.separatedColumns, true, 'GO desktop identity and document are two distinct columns')
  assert.equal(layout?.documentOverflow, false, 'GO desktop no document horizontal overflow')
  assert.equal(layout?.stageOverflow, false, 'GO desktop no detail-stage horizontal overflow')

  await mouseClick(page, '#detail-tab-nutrition')
  await page.waitForFunction(() => document.querySelector('#detail-tab-nutrition')?.getAttribute('aria-selected') === 'true')
  const nutritionText = (await page.locator('.detail-body').innerText()).replace(/\s+/g,' ')
  assert.match(nutritionText, /4,298 kcal\/kg/, 'GO desktop energy')
  assert.match(nutritionText, /조단백질\s*46% 이상/, 'GO desktop protein')
  assert.match(nutritionText, /조지방\s*18% 이상/, 'GO desktop fat')

  const visual = await page.evaluate(() => {
    const stage = document.querySelector('.detail-stage')
    const body = document.querySelector('.detail-body')
    const rows = [...document.querySelectorAll('.detail-nutrition-row')]
    if (!(stage instanceof HTMLElement) || !(body instanceof HTMLElement)) return null
    const bodyRect = body.getBoundingClientRect()
    return {
      stageClientWidth: stage.clientWidth,
      stageScrollWidth: stage.scrollWidth,
      bodyRect: { left:bodyRect.left, right:bodyRect.right, top:bodyRect.top, bottom:bodyRect.bottom },
      viewportWidth: innerWidth,
      clippedNutritionRows: rows.filter(row => {
        const r = row.getBoundingClientRect()
        return r.left < bodyRect.left - 1 || r.right > bodyRect.right + 1
      }).length,
    }
  })
  assert.equal(visual?.clippedNutritionRows, 0, 'GO desktop nutrition rows are not clipped')
  await page.screenshot({ path: OUT + '/pages-go-nutrition-1440.png', fullPage:false })

  report.go1440 = { identity, layout, nutrition:nutritionText.slice(0,1000), visual }
  await page.close()
}

assert.equal(report.blockedWriteAttempts.length, 0, 'deployed UI attempted no write requests')
assert.equal(report.blockedAnalyticsAttempts.length, 0, 'deployed UI attempted no analytics/telemetry requests')
assert.ok(report.restResponses.length > 0, 'live Pages made public REST reads')
assert.ok(report.restResponses.every(x => ['GET','HEAD','OPTIONS'].includes(x.method) && x.status >= 200 && x.status < 300), 'all observed Data API reads succeeded')
assert.ok(report.storageResponses.some(x => x.status >= 200 && x.status < 300), 'actual product image storage read succeeded')

await writeFile(OUT + '/report.json', JSON.stringify(report, null, 2))
console.log('CATFOOD_PR49_POSTDEPLOY=' + JSON.stringify(report))
await browser.close()
