import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE = 'https://osrm.github.io/catfood_web/'
const OUT = process.env.OUT_DIR || 'qa-output'
const MERGE_SHA = process.env.MERGE_SHA

await mkdir(OUT, { recursive: true })

const report = {
  generatedAt: new Date().toISOString(),
  mergeSha: MERGE_SHA,
  blockedAttempts: [],
  transmittedPublicReads: [],
  mobile390: null,
  desktop1440: null,
  journeys: {},
  readingGuide: null,
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
})

async function pageWithGuard(width, height) {
  const page = await browser.newPage({ viewport: { width, height } })

  // Installed before the first navigation. Writes and analytics never leave the browser.
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

    if (/\/functions\/v1\/|analytics|telemetry|event_log/i.test(url)) {
      report.blockedAttempts.push({
        reason: 'analytics-or-function',
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
        report.transmittedPublicReads.push({
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

async function getHomeMetrics(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const el = document.querySelector(selector)
      if (!(el instanceof HTMLElement)) return null
      const r = el.getBoundingClientRect()
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }
    }
    const fit = selector => [...document.querySelectorAll(selector)].map(el => ({
      text: el.textContent?.replace(/\s+/g, ' ').trim() || '',
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowX: getComputedStyle(el).overflowX,
      overflowY: getComputedStyle(el).overflowY,
      textOverflow: getComputedStyle(el).textOverflow,
    }))
    const buttons = [...document.querySelectorAll('.home-entry-search-submit, .home-entry-route > button')].map(el => {
      const r = el.getBoundingClientRect()
      return {
        text: el.textContent?.replace(/\s+/g, ' ').trim() || '',
        height: r.height,
        width: r.width,
        top: r.top,
        bottom: r.bottom,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }
    })
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      board: rect('.home-entry-board'),
      lookup: rect('.home-entry-lookup'),
      routes: rect('.home-entry-routes'),
      switchRoute: rect('.home-entry-route:nth-child(1)'),
      exploreRoute: rect('.home-entry-route:nth-child(2)'),
      routeDescriptions: [...document.querySelectorAll('.home-entry-route p')].map(el => ({
        text: el.textContent?.trim() || '',
        fontSize: getComputedStyle(el).fontSize,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      })),
      buttons,
      textFit: fit('.home-start-copy h1, .home-entry-lookup h2, .home-entry-route h2, .home-entry-route p'),
      searchField: (() => {
        const field = document.querySelector('.home-entry-search-field')
        const input = document.querySelector('.home-entry-search-field input')
        if (!(field instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return null
        const fr = field.getBoundingClientRect()
        const ir = input.getBoundingClientRect()
        return {
          field: { left:fr.left, right:fr.right, width:fr.width, height:fr.height, scrollWidth:field.scrollWidth, clientWidth:field.clientWidth },
          input: { left:ir.left, right:ir.right, width:ir.width, height:ir.height, scrollWidth:input.scrollWidth, clientWidth:input.clientWidth, placeholder:input.placeholder },
        }
      })(),
    }
  })
}

async function pointerClick(page, locator, label) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  assert.ok(box, label + ': pointer target has a box')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

async function returnHomeByPointer(page, label) {
  const home = page.getByRole('button', { name: 'CATFOOD 홈으로 이동' })
  await home.waitFor({ state: 'visible', timeout: 20000 })
  await pointerClick(page, home, label + ': HOME')
  await waitHome(page)
}

// Mobile live HOME + requested start/return journeys.
{
  const page = await pageWithGuard(390, 844)
  await openHome(page)

  const metrics = await getHomeMetrics(page)
  assert.equal(metrics.documentWidth, 390, 'mobile: no document horizontal overflow')
  assert.equal(metrics.bodyWidth, 390, 'mobile: no body horizontal overflow')
  assert.ok(metrics.routeDescriptions.every(x => x.fontSize === '14px'), 'mobile: route descriptions are 14px')
  assert.ok(metrics.routeDescriptions.every(x => x.scrollWidth <= x.clientWidth + 1 && x.scrollHeight <= x.clientHeight + 1), 'mobile: descriptions are not clipped')
  assert.ok(metrics.buttons.length === 3 && metrics.buttons.every(x => x.height >= 44), 'mobile: all three start CTAs are >=44px')
  assert.ok(metrics.buttons.every(x => x.scrollWidth <= x.clientWidth + 1 && x.scrollHeight <= x.clientHeight + 1), 'mobile: CTA text is not clipped')
  assert.ok(metrics.textFit.every(x => x.scrollWidth <= x.clientWidth + 2 && (x.scrollHeight <= x.clientHeight + 2 || !['hidden','clip'].includes(x.overflowY))), 'mobile: HOME copy is not clipped')
  assert.ok(metrics.lookup && metrics.switchRoute && metrics.exploreRoute, 'mobile: path geometry exists')
  assert.ok(metrics.lookup.top < metrics.switchRoute.top && metrics.switchRoute.top < metrics.exploreRoute.top, 'mobile: lookup → switch → explore order')

  await page.screenshot({ path: OUT + '/pages-home-390x844.png', fullPage: false })

  // Actual search submit -> LOOKUP -> HOME.
  const search = page.getByRole('searchbox', { name: '브랜드 또는 제품명 검색' })
  await search.fill('GO! SOLUTIONS')
  const submit = page.getByRole('button', { name: '검색' })
  await pointerClick(page, submit, 'search submit')
  await page.locator('.research-shell').waitFor({ state: 'visible', timeout: 20000 })
  assert.match(page.url(), /mode=lookup/, 'search enters LOOKUP')
  report.journeys.lookup = { entered: true, url: page.url() }
  await returnHomeByPointer(page, 'LOOKUP return')
  assert.equal(new URL(page.url()).search, '', 'LOOKUP HOME return clears workspace query state')

  // SWITCH start -> HOME only.
  const switchStart = page.getByRole('button', { name: /현재 사료로 시작/ })
  await pointerClick(page, switchStart, 'SWITCH start')
  await page.getByRole('button', { name: 'CATFOOD 홈으로 이동' }).waitFor({ state: 'visible', timeout: 20000 })
  assert.match(page.url(), /mode=switch/, 'SWITCH start enters switch mode')
  report.journeys.switch = { entered: true, url: page.url() }
  await returnHomeByPointer(page, 'SWITCH return')
  assert.equal(new URL(page.url()).search, '', 'SWITCH HOME return clears workspace query state')

  // EXPLORE start -> HOME only.
  const exploreStart = page.getByRole('button', { name: /조건 고르기/ })
  await pointerClick(page, exploreStart, 'EXPLORE start')
  await page.locator('.research-shell').waitFor({ state: 'visible', timeout: 20000 })
  assert.equal((await page.locator('.mode-button[aria-current="page"]').innerText()).trim(), '조건으로 찾기', 'EXPLORE active mode is visible')
  report.journeys.explore = { entered: true, url: page.url() }
  await returnHomeByPointer(page, 'EXPLORE return')
  assert.equal(new URL(page.url()).search, '', 'EXPLORE HOME return clears workspace query state')

  // Actual Tab traversal -> reading-guide trigger -> Enter.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const shell = document.querySelector('.home-shell')
    if (shell instanceof HTMLElement) shell.scrollTop = 0
  })

  const tabSequence = []
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab')
    const active = await page.evaluate(() => ({
      tag: document.activeElement?.tagName || '',
      text: document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() || '',
    }))
    tabSequence.push(active)
    if (active.text.includes('정보 읽는 기준 보기')) break
  }
  assert.ok(tabSequence.at(-1)?.text.includes('정보 읽는 기준 보기'), 'reading guide trigger reached through actual Tab')

  const beforeUrl = page.url()
  const beforeHistory = await page.evaluate(() => history.length)
  await page.keyboard.press('Enter')

  await page.waitForFunction(() => {
    const heading = document.getElementById('home-guides-title')
    if (!(heading instanceof HTMLElement)) return false
    const r = heading.getBoundingClientRect()
    return document.activeElement === heading && r.top >= 0 && r.bottom <= innerHeight
  }, null, { timeout: 10000 })

  const destination = await page.evaluate(() => {
    const heading = document.getElementById('home-guides-title')
    const r = heading?.getBoundingClientRect()
    return {
      activeId: document.activeElement?.id || null,
      tabIndex: heading instanceof HTMLElement ? heading.tabIndex : null,
      rect: r ? { top:r.top, bottom:r.bottom, height:r.height } : null,
      viewportHeight: innerHeight,
      url: location.href,
      historyLength: history.length,
    }
  })
  assert.equal(destination.activeId, 'home-guides-title', 'reading guide heading receives focus')
  assert.equal(destination.tabIndex, -1, 'reading guide heading remains outside normal Tab order')
  assert.ok(destination.rect && destination.rect.top >= 0 && destination.rect.bottom <= destination.viewportHeight, 'reading guide heading is fully visible')
  assert.equal(destination.url, beforeUrl, 'reading-guide action leaves URL unchanged')
  assert.equal(destination.historyLength, beforeHistory, 'reading-guide action leaves history length unchanged')

  await page.keyboard.press('Tab')
  const afterTab = await page.evaluate(() => {
    const heading = document.getElementById('home-guides-title')
    const active = document.activeElement
    return {
      tag: active?.tagName || '',
      text: active?.textContent?.replace(/\s+/g, ' ').trim() || '',
      followsHeading: Boolean(heading && active && (heading.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING)),
    }
  })
  assert.equal(afterTab.followsHeading, true, 'next Tab continues after reading-guide heading')

  report.readingGuide = { tabSequence, destination, afterTab }
  report.mobile390 = metrics
  await page.close()
}

// Desktop live HOME layout only.
{
  const page = await pageWithGuard(1440, 900)
  await openHome(page)

  const metrics = await getHomeMetrics(page)
  assert.equal(metrics.documentWidth, 1440, 'desktop: no document horizontal overflow')
  assert.equal(metrics.bodyWidth, 1440, 'desktop: no body horizontal overflow')
  assert.ok(metrics.routeDescriptions.every(x => x.fontSize === '14px'), 'desktop: route descriptions are 14px')
  assert.ok(metrics.routeDescriptions.every(x => x.scrollWidth <= x.clientWidth + 1 && x.scrollHeight <= x.clientHeight + 1), 'desktop: descriptions are not clipped')
  assert.ok(metrics.buttons.every(x => x.height >= 44), 'desktop: start CTA buttons are >=44px')
  assert.ok(metrics.buttons.every(x => x.scrollWidth <= x.clientWidth + 1 && x.scrollHeight <= x.clientHeight + 1), 'desktop: buttons are not clipped')
  assert.ok(metrics.textFit.every(x => x.scrollWidth <= x.clientWidth + 2 && (x.scrollHeight <= x.clientHeight + 2 || !['hidden','clip'].includes(x.overflowY))), 'desktop: text is not clipped')
  assert.ok(metrics.lookup && metrics.routes && metrics.lookup.right <= metrics.routes.left + 1, 'desktop: lookup is left of route column')
  assert.ok(metrics.lookup.width > metrics.routes.width, 'desktop: lookup receives more horizontal space')
  assert.ok(metrics.switchRoute && metrics.exploreRoute && metrics.switchRoute.bottom <= metrics.exploreRoute.top + 1, 'desktop: switch/explore are vertically stacked')
  assert.ok(metrics.searchField && metrics.searchField.field.scrollWidth <= metrics.searchField.field.clientWidth + 1, 'desktop: search field does not overflow')
  assert.ok(metrics.searchField && metrics.searchField.input.scrollWidth <= metrics.searchField.input.clientWidth + 1, 'desktop: search input does not overflow')

  await page.screenshot({ path: OUT + '/pages-home-1440x900.png', fullPage: false })
  report.desktop1440 = metrics
  await page.close()
}

assert.ok(report.transmittedPublicReads.length > 0, 'live Pages used public Data API reads')
assert.ok(report.transmittedPublicReads.every(x => ['GET', 'HEAD', 'OPTIONS'].includes(x.method)), 'only public read methods were transmitted to Data API')
assert.ok(report.transmittedPublicReads.every(x => x.status >= 200 && x.status < 300), 'all transmitted public Data API reads succeeded')

const short = [
  'PR #51 live Pages postdeploy',
  'merge SHA: ' + MERGE_SHA,
  '390x844 HOME layout: PASS',
  'mobile descriptions 14px / start CTAs >=44px / no clipping or horizontal overflow: PASS',
  'search -> LOOKUP -> HOME: PASS',
  'SWITCH start -> HOME: PASS',
  'EXPLORE start -> HOME: PASS',
  'actual Tab -> reading guide -> Enter focus/visibility/next Tab: PASS',
  'reading-guide URL/history unchanged: PASS',
  '1440x900 left LOOKUP / right SWITCH+EXPLORE layout: PASS',
  'desktop descriptions 14px / search and copy no clipping or overlap: PASS',
  'blocked attempts: ' + report.blockedAttempts.length,
  'transmitted public Data API reads: ' + report.transmittedPublicReads.length + ' (all 2xx)',
].join('\n') + '\n'

await writeFile(OUT + '/report.json', JSON.stringify(report, null, 2))
await writeFile(OUT + '/report.txt', short)
console.log('CATFOOD_PR51_POSTDEPLOY=' + JSON.stringify(report))
console.log(short)

await browser.close()
