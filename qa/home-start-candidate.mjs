import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE = 'http://127.0.0.1:4173/'
const OUT = process.env.OUT_DIR || 'qa-output'
const PRODUCT_SHA = process.env.PRODUCT_SHA

await mkdir(OUT, { recursive: true })

const report = {
  generatedAt: new Date().toISOString(),
  productSha: PRODUCT_SHA,
  blockedNonGet: [],
  blockedAnalyticsGet: [],
  apiReads: [],
  screenshots: {},
  metrics: {},
  interactions: {},
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
      report.blockedNonGet.push({
        method,
        url: parsed ? parsed.origin + parsed.pathname : url,
      })
      await route.abort('blockedbyclient')
      return
    }

    if (/\/functions\/v1\/|analytics|telemetry|event_log/i.test(url)) {
      report.blockedAnalyticsGet.push({
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
        report.apiReads.push({
          method: response.request().method(),
          path: u.pathname,
          status: response.status(),
        })
      }
    } catch {}
  })

  return page
}

async function waitHome(page) {
  await page.locator('.home-start-copy h1').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForFunction(() => {
    const text = document.querySelector('.home-catalog-status')?.textContent || ''
    return /\d[\d,]*개/.test(text) && !text.includes('—')
  }, null, { timeout: 30000 })
  await page.evaluate(() => document.fonts?.ready)
}

async function openHome(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await waitHome(page)
}

async function layoutMetrics(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector)
      if (!(el instanceof HTMLElement)) return null
      const r = el.getBoundingClientRect()
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }
    }
    const buttons = [...document.querySelectorAll('.home-entry-search-submit, .home-entry-route > button, .home-reading-note button')]
      .map(el => {
        const r = el.getBoundingClientRect()
        return {
          text: el.textContent?.replace(/\s+/g, ' ').trim() || '',
          width:r.width, height:r.height, top:r.top, bottom:r.bottom, left:r.left, right:r.right,
        }
      })
    const descriptions = [...document.querySelectorAll('.home-entry-route p')].map(el => ({
      text: el.textContent?.trim() || '',
      fontSize: getComputedStyle(el).fontSize,
      lineHeight: getComputedStyle(el).lineHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
    return {
      viewport:{width:innerWidth,height:innerHeight},
      documentWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth,
      board:rect('.home-entry-board'),
      lookup:rect('.home-entry-lookup'),
      routes:rect('.home-entry-routes'),
      switchRoute:rect('.home-entry-route:nth-child(1)'),
      exploreRoute:rect('.home-entry-route:nth-child(2)'),
      title:document.querySelector('.home-start-copy h1')?.textContent?.trim() || null,
      catalog:document.querySelector('.home-catalog-status')?.textContent?.replace(/\s+/g,' ').trim() || null,
      lookupTitle:document.querySelector('.home-entry-lookup h2')?.textContent?.trim() || null,
      routeTitles:[...document.querySelectorAll('.home-entry-route h2')].map(el=>el.textContent?.trim()),
      descriptions,
      buttons,
      readingText:document.querySelector('.home-reading-note')?.textContent?.replace(/\s+/g,' ').trim() || null,
      order:[...document.querySelectorAll('.home-entry-lookup, .home-entry-route')].map(el=>({
        className:el.className,
        top:el.getBoundingClientRect().top,
      })),
    }
  })
}

async function checkFocus(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.keyboard.press('Tab')
  const firstTag = await page.evaluate(() => document.activeElement?.tagName)
  const firstType = await page.evaluate(() => document.activeElement?.getAttribute('type'))
  assert.equal(firstTag, 'INPUT', 'first keyboard target is lookup input')
  assert.equal(firstType, 'search', 'first keyboard target is search input')

  const fieldFocus = await page.locator('.home-entry-search-field').evaluate(el => ({
    borderColor:getComputedStyle(el).borderColor,
    boxShadow:getComputedStyle(el).boxShadow,
  }))
  assert.notEqual(fieldFocus.boxShadow, 'none', 'search field exposes a visible focus-within ring')

  const input = page.getByRole('searchbox', { name:'브랜드 또는 제품명 검색' })
  await input.fill('focus check')
  await page.locator('.home-entry-search-submit').waitFor({ state:'visible' })
  await page.waitForFunction(() => {
    const button = document.querySelector('.home-entry-search-submit')
    return button instanceof HTMLButtonElement && !button.disabled
  })

  await page.keyboard.press('Tab')
  const submitFocus = await page.locator('.home-entry-search-submit').evaluate(el => ({
    focused:document.activeElement === el,
    outlineWidth:getComputedStyle(el).outlineWidth,
    outlineStyle:getComputedStyle(el).outlineStyle,
  }))
  assert.equal(submitFocus.focused, true, 'enabled search submit follows the lookup input')
  assert.notEqual(submitFocus.outlineStyle, 'none', 'button keeps app focus-visible outline')
  assert.ok(parseFloat(submitFocus.outlineWidth) >= 2, 'button focus outline is at least 2px')

  await input.fill('')
  return { fieldFocus, submitFocus }
}

async function captureViewport(width, height, key, filename) {
  const page = await guardedPage(width, height)
  await openHome(page)
  const metrics = await layoutMetrics(page)

  assert.equal(metrics.title, '사료를 찾는 방법을 고르세요.', key + ': final title')
  assert.equal(metrics.lookupTitle, '브랜드·제품명 검색', key + ': lookup title')
  assert.deepEqual(metrics.routeTitles, ['현재 사료에서 바꾸기', '조건으로 찾아보기'], key + ': route titles')
  assert.ok(metrics.catalog && !metrics.catalog.includes('—'), key + ': dynamic catalog count resolved')
  assert.equal(metrics.documentWidth, width, key + ': no document horizontal overflow')
  assert.equal(metrics.bodyWidth, width, key + ': no body horizontal overflow')
  assert.ok(metrics.descriptions.every(x => x.fontSize === '14px'), key + ': both route descriptions are 14px')
  assert.ok(metrics.descriptions.every(x => x.scrollWidth <= x.clientWidth + 1 && x.scrollHeight <= x.clientHeight + 1), key + ': route descriptions are not clipped')
  assert.ok(metrics.buttons.every(x => x.height >= 44), key + ': all start/read buttons are at least 44px tall')

  if (width <= 820) {
    assert.ok(metrics.order[0].top < metrics.order[1].top && metrics.order[1].top < metrics.order[2].top, key + ': mobile order is lookup → switch → explore')
    const exploreButton = metrics.buttons.find(x => x.text.includes('조건 고르기'))
    assert.ok(exploreButton && exploreButton.bottom <= height, key + ': all three start CTAs remain in first viewport without shrinking')
  } else {
    assert.ok(metrics.lookup && metrics.routes && metrics.lookup.right <= metrics.routes.left + 1, key + ': desktop lookup is left of route column')
    assert.ok(metrics.lookup.width > metrics.routes.width, key + ': desktop lookup receives more horizontal space')
    assert.ok(metrics.switchRoute && metrics.exploreRoute && metrics.switchRoute.bottom <= metrics.exploreRoute.top + 1, key + ': switch/explore stack vertically')
  }

  const focus = await checkFocus(page)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.screenshot({ path: OUT + '/' + filename, fullPage: false })

  report.metrics[key] = { ...metrics, focus }
  report.screenshots[key] = filename
  await page.close()
}

async function breakpointCheck(width, expected) {
  const page = await guardedPage(width, 900)
  await openHome(page)
  const geometry = await page.evaluate(() => {
    const lookup = document.querySelector('.home-entry-lookup')?.getBoundingClientRect()
    const routes = document.querySelector('.home-entry-routes')?.getBoundingClientRect()
    if (!lookup || !routes) return null
    return {
      lookup:{left:lookup.left,right:lookup.right,top:lookup.top,bottom:lookup.bottom},
      routes:{left:routes.left,right:routes.right,top:routes.top,bottom:routes.bottom},
    }
  })
  assert.ok(geometry, 'breakpoint geometry exists at ' + width)
  const stacked = geometry.routes.top >= geometry.lookup.bottom - 1
  const sideBySide = geometry.lookup.right <= geometry.routes.left + 1 && Math.abs(geometry.lookup.top - geometry.routes.top) <= 1
  if (expected === 'stacked') assert.equal(stacked, true, width + ': stacked below breakpoint')
  else assert.equal(sideBySide, true, width + ': side-by-side above breakpoint')
  await page.close()
  return { width, expected, geometry, stacked, sideBySide }
}

async function returnHome(page, keyboard=false) {
  const home = page.getByRole('button', { name: 'CATFOOD 홈으로 이동' })
  await home.waitFor({ state:'visible', timeout:20000 })
  if (keyboard) {
    await home.focus()
    await page.keyboard.press('Enter')
  } else {
    await home.click()
  }
  await waitHome(page)
}

async function interactionChecks() {
  // Pointer LOOKUP submit + pointer HOME return.
  {
    const page = await guardedPage(390, 844)
    await openHome(page)
    await page.getByRole('searchbox', { name:'브랜드 또는 제품명 검색' }).fill('GO! SOLUTIONS')
    await page.getByRole('button', { name:'검색' }).click()
    await page.locator('.research-shell').waitFor({ state:'visible', timeout:20000 })
    assert.match(page.url(), /mode=lookup/, 'pointer search enters LOOKUP')
    assert.match(decodeURIComponent(page.url()), /q=GO!.*SOLUTIONS/, 'pointer search preserves query')
    await returnHome(page, false)
    report.interactions.lookupPointer = true
    report.interactions.homeReturnPointer = true
    await page.close()
  }

  // Keyboard Enter LOOKUP submit.
  {
    const page = await guardedPage(390, 844)
    await openHome(page)
    const input = page.getByRole('searchbox', { name:'브랜드 또는 제품명 검색' })
    await input.focus()
    await input.fill('로얄캐닌')
    await page.keyboard.press('Enter')
    await page.locator('.research-shell').waitFor({ state:'visible', timeout:20000 })
    assert.match(page.url(), /mode=lookup/, 'keyboard Enter enters LOOKUP')
    report.interactions.lookupKeyboardEnter = true
    await page.close()
  }

  // SWITCH pointer entry + keyboard HOME return.
  {
    const page = await guardedPage(390, 844)
    await openHome(page)
    await page.getByRole('button', { name:/현재 사료로 시작/ }).click()
    await page.getByRole('button', { name:'CATFOOD 홈으로 이동' }).waitFor({ state:'visible', timeout:20000 })
    assert.match(page.url(), /mode=switch/, 'pointer route enters SWITCH')
    report.interactions.switchPointer = true
    await returnHome(page, true)
    report.interactions.homeReturnKeyboard = true
    await page.close()
  }

  // EXPLORE keyboard entry.
  {
    const page = await guardedPage(390, 844)
    await openHome(page)
    const button = page.getByRole('button', { name:/조건 고르기/ })
    await button.focus()
    await page.keyboard.press('Enter')
    await page.locator('.research-shell').waitFor({ state:'visible', timeout:20000 })
    const active = await page.locator('.mode-button[aria-current="page"]').innerText()
    assert.equal(active.trim(), '조건으로 찾기', 'keyboard route enters EXPLORE')
    report.interactions.exploreKeyboard = true
    await page.close()
  }

  // Reading-guide access stays inside HOME and does not change URL/history contract.
  {
    const page = await guardedPage(390, 844)
    await openHome(page)
    const before = page.url()
    const button = page.getByRole('button', { name:/정보 읽는 기준 보기/ })
    await button.focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.scrollY > 100, null, { timeout:10000 })
    const guideVisible = await page.locator('#home-guides-title').evaluate(el => {
      const r = el.getBoundingClientRect()
      return r.bottom > 0 && r.top < innerHeight
    })
    assert.equal(guideVisible, true, 'reading-guide button reveals existing guide section')
    assert.equal(page.url(), before, 'reading-guide access does not mutate URL')
    report.interactions.readingGuideKeyboard = true
    await page.close()
  }
}

await captureViewport(390, 844, 'mobile390', 'candidate-home-390x844.png')
await captureViewport(1440, 900, 'desktop1440', 'candidate-home-1440x900.png')
report.metrics.breakpointBelow = await breakpointCheck(819, 'stacked')
report.metrics.breakpointAbove = await breakpointCheck(821, 'sideBySide')
await interactionChecks()

assert.ok(report.apiReads.length > 0, 'candidate used live public API reads')
assert.ok(report.apiReads.every(x => ['GET','HEAD','OPTIONS'].includes(x.method)), 'only safe read methods reached public Data API')
assert.ok(report.apiReads.every(x => x.status >= 200 && x.status < 300), 'all observed public Data API reads were 2xx')

const short = [
  'CATFOOD HOME candidate QA',
  'product head: ' + PRODUCT_SHA,
  '390x844: PASS',
  '1440x900: PASS',
  'route descriptions: 14px at both target viewports',
  'buttons: all measured >=44px',
  'horizontal overflow/clipping: none at target viewports',
  'breakpoint: 819 stacked / 821 side-by-side',
  'pointer search: PASS',
  'keyboard Enter search: PASS',
  'SWITCH pointer entry: PASS',
  'EXPLORE keyboard entry: PASS',
  'reading guide keyboard access: PASS',
  'HOME return pointer + keyboard: PASS',
  'blocked non-GET attempts: ' + report.blockedNonGet.length,
  'blocked analytics GET attempts: ' + report.blockedAnalyticsGet.length,
  'public API reads: ' + report.apiReads.length + ' (all 2xx)',
].join('\n') + '\n'

await writeFile(OUT + '/report.json', JSON.stringify(report, null, 2))
await writeFile(OUT + '/report.txt', short)
console.log('CATFOOD_HOME_CANDIDATE=' + JSON.stringify(report))
console.log(short)

await browser.close()
