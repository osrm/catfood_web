import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, request as playwrightRequest } from 'playwright-core'

const BASE = 'http://127.0.0.1:4173/'
const GO = 'product_31bc515d78d43d5d'
const MONGE = 'product_11dc2e0bf60b0874'
const outDir = 'qa-output'
await mkdir(outDir, { recursive: true })

const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] })
const liveApi = await playwrightRequest.newContext({
  extraHTTPHeaders: {
    apikey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '',
    'Accept-Profile': 'api',
  },
})
const report = {
  sourceSha: process.env.EXPECTED_SHA,
  blockedWrites: [],
  live: [],
  breakpoints: [],
  interactions: {},
  mockedStates: {},
  fonts: {},
}

const mode = {
  nutritionFirstFailure: false,
  ingredientEmpty: false,
  variantDelayMs: 0,
}
const requestCounts = new Map()

function resetMode() {
  mode.nutritionFirstFailure = false
  mode.ingredientEmpty = false
  mode.variantDelayMs = 0
  requestCounts.clear()
}

async function makePage(width, height) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.route('**/*', async (route) => {
    const request = route.request()
    const method = request.method()
    const url = request.url()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      report.blockedWrites.push({ method, url })
      await route.abort('blockedbyclient')
      return
    }
    let pathname = ''
    try { pathname = new URL(url).pathname } catch {}
    const key = pathname.split('/').at(-1) || pathname
    const isLiveRest = url.startsWith((process.env.VITE_SUPABASE_URL || '') + '/rest/v1/')
    if (isLiveRest && method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-allow-headers': 'apikey, accept-profile, content-type',
        },
        body: '',
      })
      return
    }
    if (isLiveRest) requestCounts.set(key, (requestCounts.get(key) || 0) + 1)

    if (mode.nutritionFirstFailure && key === 'compare_product_nutrition' && requestCounts.get(key) === 1) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'candidate mock failure' })
      return
    }
    if (mode.ingredientEmpty && key === 'compare_product_ingredients') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      return
    }
    if (mode.variantDelayMs && key === 'switch_current_variant_options' && requestCounts.get(key) === 1) {
      const response = await liveApi.get(url)
      await new Promise((resolve) => setTimeout(resolve, mode.variantDelayMs))
      await route.fulfill({
        status: response.status(),
        headers: { ...response.headers(), 'access-control-allow-origin': '*' },
        body: await response.body(),
      })
      return
    }
    if (isLiveRest && ['GET', 'HEAD'].includes(method)) {
      const response = method === 'HEAD' ? await liveApi.head(url) : await liveApi.get(url)
      await route.fulfill({
        status: response.status(),
        headers: { ...response.headers(), 'access-control-allow-origin': '*' },
        body: method === 'HEAD' ? '' : await response.body(),
      })
      return
    }
    await route.continue()
  })
  return page
}

function detailUrl(id, query, tab = 'overview') {
  const params = new URLSearchParams({
    view: 'workspace',
    mode: 'lookup',
    q: query,
    detail: id,
    detailTab: tab,
  })
  return BASE + '?' + params.toString()
}

async function waitDetail(page, { settled = true } = {}) {
  try {
    await page.waitForSelector('.detail-stage', { timeout: 12000 })
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      body: document.body.innerText.slice(0, 5000),
      html: document.body.innerHTML.slice(0, 5000),
    }))
    await writeFile(`${outDir}/detail-timeout.json`, JSON.stringify(diagnostic, null, 2))
    await page.screenshot({ path: `${outDir}/detail-timeout.png`, fullPage: false })
    throw new Error(`detail-stage did not open: ${JSON.stringify(diagnostic)}; ${error}`)
  }
  await page.waitForSelector('.detail-identity h1', { timeout: 10000 })
  if (settled) {
    await page.waitForFunction(() => ![...document.querySelectorAll('.detail-state')].some((node) => node.textContent?.includes('불러오는 중')), null, { timeout: 20000 })
  }
  await page.evaluate(() => document.fonts?.ready)
}

async function metrics(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.detail-stage')
    const layout = document.querySelector('.detail-layout')
    const title = document.querySelector('.detail-identity h1')
    const image = document.querySelector('.detail-product-image')
    const placeholder = document.querySelector('.detail-image-placeholder')
    const cs = title ? getComputedStyle(title) : null
    const layoutStyle = layout ? getComputedStyle(layout) : null
    return {
      title: title?.textContent?.trim() || null,
      titleLineClamp: cs?.webkitLineClamp || null,
      titleOverflow: cs?.overflow || null,
      stageClientWidth: stage?.clientWidth || 0,
      stageScrollWidth: stage?.scrollWidth || 0,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      horizontalOverflow: Boolean((stage && stage.scrollWidth > stage.clientWidth + 1) || document.documentElement.scrollWidth > innerWidth + 1),
      layoutDisplay: layoutStyle?.display || null,
      gridTemplateColumns: layoutStyle?.gridTemplateColumns || null,
      image: image ? { complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight } : null,
      placeholder: Boolean(placeholder),
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({ text: tab.textContent?.trim(), selected: tab.getAttribute('aria-selected') })),
    }
  })
}

async function captureAllTabs(id, query, productTag, width, height) {
  resetMode()
  const page = await makePage(width, height)
  await page.goto(detailUrl(id, query), { waitUntil: 'domcontentloaded', timeout: 20000 })
  await waitDetail(page)
  const initial = await metrics(page)
  assert.equal(initial.horizontalOverflow, false, `${productTag} ${width}: no horizontal overflow`)
  assert.ok(initial.title, `${productTag}: full product title is present`)
  assert.notEqual(initial.titleLineClamp, '1', `${productTag}: title is not line-clamped`)
  if (initial.image) assert.ok(initial.image.complete && initial.image.naturalWidth > 0, `${productTag}: product image loads`)
  else assert.equal(initial.placeholder, true, `${productTag}: missing image has explicit placeholder`)

  const tabs = [
    ['overview', '개요'],
    ['nutrition', '영양'],
    ['ingredients', '원재료'],
    ['context', '제조 · 유통'],
  ]
  const panels = {}
  for (const [key] of tabs) {
    await page.click(`#detail-tab-${key}`)
    await page.waitForFunction((tabKey) => document.querySelector(`#detail-tab-${tabKey}`)?.getAttribute('aria-selected') === 'true', key)
    await page.waitForFunction(() => ![...document.querySelectorAll('.detail-state')].some((node) => node.textContent?.includes('불러오는 중')), null, { timeout: 20000 })
    const alignment = await page.evaluate(() => {
      const heading = document.querySelector('.detail-section-heading')
      const tabsEl = document.querySelector('.detail-tabs')
      if (!heading || !tabsEl) return null
      const h = heading.getBoundingClientRect()
      const t = tabsEl.getBoundingClientRect()
      return { headingTop: h.top, tabsBottom: t.bottom, ok: h.top >= t.bottom - 3 }
    })
    assert.ok(alignment?.ok, `${productTag} ${width} ${key}: switched heading is not hidden by sticky tabs`)
    panels[key] = (await page.locator('.detail-body').innerText()).slice(0, 1800)
    await page.screenshot({ path: `${outDir}/${productTag}-${key}-${width}.png`, fullPage: false })
  }
  const after = await metrics(page)
  report.live.push({ product: productTag, id, width, height, initial, after, panels })
  await page.close()
}

for (const product of [
  { id: GO, query: 'GO!', tag: 'go' },
  { id: MONGE, query: '몬지', tag: 'monge' },
]) {
  await captureAllTabs(product.id, product.query, product.tag, 390, 844)
  await captureAllTabs(product.id, product.query, product.tag, 1440, 1000)
}

for (const width of [360, 768, 959, 961, 1024]) {
  resetMode()
  const page = await makePage(width, width === 360 ? 800 : 900)
  await page.goto(detailUrl(GO, 'GO!'), { waitUntil: 'domcontentloaded', timeout: 20000 })
  await waitDetail(page)
  const result = await metrics(page)
  assert.equal(result.horizontalOverflow, false, `GO ${width}: no horizontal overflow`)
  if (width <= 960) assert.equal(result.layoutDisplay, 'block', `GO ${width}: one-column layout`)
  if (width > 960) assert.equal(result.layoutDisplay, 'grid', `GO ${width}: two-column layout`)
  report.breakpoints.push({ width, ...result })
  await page.screenshot({ path: `${outDir}/go-overview-${width}.png`, fullPage: false })
  await page.close()
}

resetMode()
{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(GO, 'GO!'), { waitUntil: 'domcontentloaded', timeout: 20000 })
  await waitDetail(page)

  await page.focus('#detail-tab-overview')
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-tab-nutrition')
  assert.equal(await page.getAttribute('#detail-tab-nutrition', 'aria-selected'), 'true')
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-tab-context')
  await page.keyboard.press('Home')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-tab-overview')

  await page.click('#detail-tab-ingredients')
  await page.evaluate(() => {
    const stage = document.querySelector('.detail-stage')
    if (stage) stage.scrollTop = Math.min(320, Math.max(0, stage.scrollHeight - stage.clientHeight))
  })
  const before = await page.evaluate(() => document.querySelector('.detail-stage')?.scrollTop || 0)
  await page.click('#detail-tab-ingredients')
  const sameTab = await page.evaluate(() => document.querySelector('.detail-stage')?.scrollTop || 0)
  assert.ok(Math.abs(sameTab - before) <= 2, 'reselecting the current tab preserves the reading position')

  await page.click('#detail-tab-nutrition')
  const aligned = await page.evaluate(() => {
    const heading = document.querySelector('.detail-section-heading')
    const tabs = document.querySelector('.detail-tabs')
    const topbar = document.querySelector('.detail-topbar')
    if (!heading || !tabs || !topbar) return null
    const h = heading.getBoundingClientRect()
    const t = tabs.getBoundingClientRect()
    return { ok: h.top >= t.bottom - 3, headingTop: h.top, tabsBottom: t.bottom }
  })
  assert.ok(aligned?.ok, 'explicit tab change positions the new heading below sticky navigation')

  await page.evaluate(() => { const stage = document.querySelector('.detail-stage'); if (stage) stage.scrollTop = 500 })
  const sticky = await page.evaluate(() => {
    const topbar = document.querySelector('.detail-topbar')?.getBoundingClientRect()
    const tabs = document.querySelector('.detail-tabs')?.getBoundingClientRect()
    return { topbarTop: topbar?.top, tabsTop: tabs?.top }
  })
  assert.ok(Math.abs(sticky.topbarTop || 0) <= 1, 'topbar stays sticky in the actual detail scroller')
  assert.ok(Math.abs((sticky.tabsTop || 0) - 56) <= 2, 'mobile tabs stay below the sticky topbar')

  await page.click('.detail-topbar button')
  await page.waitForFunction(() => !document.querySelector('.detail-stage') && document.querySelector('.research-results'))
  report.interactions = { keyboard: true, sameTabScroll: { before, after: sameTab }, aligned, sticky, parentReturn: true }
  await page.close()
}

resetMode()
mode.nutritionFirstFailure = true
{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(GO, 'GO!', 'nutrition'), { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector('.detail-stage')
  await page.waitForSelector('.detail-state.is-error', { timeout: 20000 })
  const errorText = await page.locator('.detail-state.is-error').innerText()
  assert.match(errorText, /영양 정보를 불러오지 못했습니다/)
  assert.match(errorText, /다시 시도/)
  assert.doesNotMatch(await page.locator('.detail-body').innerText(), /확인된 영양 정보가 없습니다/)
  const beforeRetry = Object.fromEntries(requestCounts)
  await page.click('.detail-state.is-error button')
  await page.waitForFunction(() => !document.querySelector('.detail-state.is-error') && ![...document.querySelectorAll('.detail-state')].some((node) => node.textContent?.includes('불러오는 중')), null, { timeout: 20000 })
  const afterRetry = Object.fromEntries(requestCounts)
  for (const key of ['switch_current_variant_options','compare_product_nutrition','compare_product_ingredients','product_detail_manufacturing','product_detail_markets']) {
    assert.ok((afterRetry[key] || 0) >= (beforeRetry[key] || 0) + 1, `retry reloads ${key}`)
  }
  report.mockedStates.error = { errorText, beforeRetry, afterRetry }
  await page.screenshot({ path: `${outDir}/mock-error-recovered-390.png`, fullPage: false })
  await page.close()
}

resetMode()
mode.ingredientEmpty = true
{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(MONGE, '몬지', 'ingredients'), { waitUntil: 'domcontentloaded', timeout: 20000 })
  await waitDetail(page)
  const text = await page.locator('.detail-body').innerText()
  assert.match(text, /확인된 원재료 정보가 없습니다/)
  assert.equal(await page.locator('.detail-state.is-error').count(), 0)
  report.mockedStates.empty = { text: text.slice(0, 800), hasRetry: false }
  await page.screenshot({ path: `${outDir}/mock-empty-ingredients-390.png`, fullPage: false })
  await page.close()
}

resetMode()
mode.variantDelayMs = 1200
{
  const page = await makePage(390, 844)
  const nav = page.goto(detailUrl(GO, 'GO!', 'overview'), { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector('.detail-stage', { timeout: 20000 })
  await page.waitForFunction(() => document.body.textContent?.includes('판매 규격을 불러오는 중입니다.'), null, { timeout: 5000 })
  const loadingText = await page.locator('.detail-body').innerText()
  assert.match(loadingText, /판매 규격을 불러오는 중입니다/)
  await nav
  await waitDetail(page)
  const settledText = await page.locator('.detail-body').innerText()
  assert.doesNotMatch(settledText, /판매 규격을 불러오는 중입니다/)
  report.mockedStates.delay = { loadingSeen: true, settled: true }
  await page.close()
}

{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(MONGE, '몬지', 'ingredients'), { waitUntil: 'domcontentloaded', timeout: 20000 })
  await waitDetail(page)
  const raw = await page.evaluate(() => {
    const el = document.querySelector('.detail-ingredient-copy')
    const stage = document.querySelector('.detail-stage')
    return {
      rawPresent: Boolean(el),
      rawScrollWidth: el?.scrollWidth || 0,
      rawClientWidth: el?.clientWidth || 0,
      stageScrollWidth: stage?.scrollWidth || 0,
      stageClientWidth: stage?.clientWidth || 0,
    }
  })
  assert.ok(!raw.rawPresent || raw.rawScrollWidth <= raw.rawClientWidth + 1, 'long source text wraps at mobile width')
  assert.ok(raw.stageScrollWidth <= raw.stageClientWidth + 1, 'ingredient view has no horizontal overflow')
  report.interactions.mobileRaw = raw
  report.fonts = await page.evaluate(async () => {
    await document.fonts.ready
    return {
      serif: document.fonts.check('16px "Noto Serif KR"'),
      sans: document.fonts.check('16px "Noto Sans KR"'),
    }
  })
  await page.close()
}

assert.equal(report.blockedWrites.length, 0, 'candidate attempted no POST/PUT/PATCH/DELETE requests with decision intake disabled')
await writeFile(`${outDir}/report.json`, JSON.stringify(report, null, 2))
console.log('CATFOOD_DETAIL_QA_REPORT=' + JSON.stringify(report))
await liveApi.dispose()
await browser.close()
