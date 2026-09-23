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
  blockedAttempts: [],
  publicReads: [],
  mobile390: null,
  desktop1440: null,
  readingGuide: null,
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
})

async function guardedPage(width, height) {
  const page = await browser.newPage({ viewport: { width, height } })

  // Install before the first navigation: only public reads may leave the browser.
  await page.route('**/*', async route => {
    const request = route.request()
    const method = request.method()
    const url = request.url()
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
      const url = new URL(response.url())
      if (url.host === 'gnosbstdatkytsyxuapt.supabase.co' && url.pathname.startsWith('/rest/v1/')) {
        report.publicReads.push({
          method: response.request().method(),
          path: url.pathname,
          status: response.status(),
        })
      }
    } catch {}
  })

  return page
}

async function openHome(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.locator('.home-start-copy h1').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForFunction(() => {
    const text = document.querySelector('.home-catalog-status')?.textContent || ''
    return /\d[\d,]*개/.test(text) && !text.includes('—')
  }, null, { timeout: 30000 })
  await page.evaluate(() => document.fonts?.ready)
}

async function homeMetrics(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const el = document.querySelector(selector)
      if (!(el instanceof HTMLElement)) return null
      const r = el.getBoundingClientRect()
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }
    }
    const fit = selector => [...document.querySelectorAll(selector)].map(el => {
      const style = getComputedStyle(el)
      return {
        text: el.textContent?.replace(/\s+/g, ' ').trim() || '',
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      }
    })

    const shell = document.querySelector('.home-shell')
    const header = document.querySelector('.home-header')
    const inner = document.querySelector('.home-header-inner')
    const logo = document.querySelector('.home-logo')
    const shellStyle = shell instanceof HTMLElement ? getComputedStyle(shell) : null
    const headerStyle = header instanceof HTMLElement ? getComputedStyle(header) : null

    return {
      viewport: { width: innerWidth, height: innerHeight },
      computedBackground: shellStyle?.backgroundColor ?? null,
      shell: shell instanceof HTMLElement ? {
        rect: rect('.home-shell'),
        height: shellStyle?.height ?? null,
        overflowY: shellStyle?.overflowY ?? null,
        overflowX: shellStyle?.overflowX ?? null,
        clientHeight: shell.clientHeight,
        scrollHeight: shell.scrollHeight,
        scrollTop: shell.scrollTop,
      } : null,
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        bodyScrollWidth: document.body.scrollWidth,
      },
      header: header instanceof HTMLElement ? {
        rect: rect('.home-header'),
        height: headerStyle?.height ?? null,
        flexShrink: headerStyle?.flexShrink ?? null,
      } : null,
      headerInner: rect('.home-header-inner'),
      logo: rect('.home-logo'),
      board: rect('.home-entry-board'),
      lookup: rect('.home-entry-lookup'),
      routes: rect('.home-entry-routes'),
      switchRoute: rect('.home-entry-route:nth-child(1)'),
      exploreRoute: rect('.home-entry-route:nth-child(2)'),
      pathTitles: [
        document.querySelector('.home-entry-lookup h2')?.textContent?.trim() || '',
        ...[...document.querySelectorAll('.home-entry-route h2')].map(el => el.textContent?.trim() || ''),
      ],
      fit: fit('.home-start-copy h1, .home-entry-lookup h2, .home-entry-route h2, .home-entry-route p, .home-entry-route > button, .home-entry-search-submit'),
    }
  })
}

function assertCommon(metrics, expectedHeaderHeight, key) {
  assert.equal(metrics.computedBackground, 'rgb(243, 241, 236)', key + ': approved HOME background is the final computed value')
  assert.ok(metrics.header, key + ': header metrics exist')
  assert.ok(Math.abs(metrics.header.rect.height - expectedHeaderHeight) <= 0.5, key + ': header rendered height is restored')
  assert.equal(metrics.header.flexShrink, '0', key + ': header cannot shrink in HOME flex column')
  assert.equal(metrics.document.scrollWidth, metrics.viewport.width, key + ': no document horizontal overflow')
  assert.equal(metrics.document.bodyScrollWidth, metrics.viewport.width, key + ': no body horizontal overflow')
  assert.ok(metrics.shell && ['auto', 'scroll'].includes(metrics.shell.overflowY), key + ': HOME shell remains the vertical scroll owner')
  assert.ok(metrics.shell.scrollHeight > metrics.shell.clientHeight, key + ': HOME shell remains document-length scroll content')
  assert.deepEqual(metrics.pathTitles, ['브랜드·제품명 검색', '현재 사료에서 바꾸기', '조건으로 찾아보기'], key + ': three start paths remain unchanged')
  assert.ok(metrics.headerInner && metrics.logo, key + ': logo/header geometry exists')
  assert.ok(metrics.logo.left >= metrics.headerInner.left - 0.5 && metrics.logo.right <= metrics.headerInner.right + 0.5, key + ': logo stays within intended header inset')
  assert.ok(metrics.logo.top >= metrics.header.rect.top && metrics.logo.bottom <= metrics.header.rect.bottom, key + ': logo stays vertically within restored header')
  assert.ok(metrics.fit.every(item => item.scrollWidth <= item.clientWidth + 2), key + ': start-path text/buttons have no horizontal clipping')
  assert.ok(metrics.fit.every(item => item.scrollHeight <= item.clientHeight + 2 || !['hidden', 'clip'].includes(item.overflowY)), key + ': start-path text/buttons are not vertically clipped')
}

async function tabToReadingGuide(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const shell = document.querySelector('.home-shell')
    if (shell instanceof HTMLElement) shell.scrollTop = 0
  })

  const sequence = []
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab')
    const active = await page.evaluate(() => ({
      tag: document.activeElement?.tagName || '',
      text: document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() || '',
    }))
    sequence.push(active)
    if (active.text.includes('정보 읽는 기준 보기')) return sequence
  }
  assert.fail('reading guide trigger was not reached through actual Tab navigation')
}

// 390×844 candidate render.
{
  const page = await guardedPage(390, 844)
  await openHome(page)
  const metrics = await homeMetrics(page)
  assertCommon(metrics, 62, 'mobile390')
  assert.ok(metrics.lookup && metrics.switchRoute && metrics.exploreRoute, 'mobile390: start path geometry exists')
  assert.ok(metrics.lookup.top < metrics.switchRoute.top && metrics.switchRoute.top < metrics.exploreRoute.top, 'mobile390: search → current food → conditions order remains')

  // The restored header must still preserve the reading-guide movement and focus.
  const beforeUrl = page.url()
  const beforeHistory = await page.evaluate(() => history.length)
  const tabSequence = await tabToReadingGuide(page)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const heading = document.getElementById('home-guides-title')
    if (!(heading instanceof HTMLElement)) return false
    const rect = heading.getBoundingClientRect()
    return document.activeElement === heading && rect.top >= 0 && rect.bottom <= innerHeight
  }, null, { timeout: 10000 })

  const destination = await page.evaluate(() => {
    const heading = document.getElementById('home-guides-title')
    const rect = heading?.getBoundingClientRect()
    return {
      activeId: document.activeElement?.id || null,
      tabIndex: heading instanceof HTMLElement ? heading.tabIndex : null,
      rect: rect ? { top:rect.top, bottom:rect.bottom, height:rect.height } : null,
      viewportHeight: innerHeight,
      url: location.href,
      historyLength: history.length,
      shellScrollTop: document.querySelector('.home-shell')?.scrollTop ?? null,
    }
  })
  assert.equal(destination.activeId, 'home-guides-title', 'mobile390: guide heading receives programmatic focus')
  assert.equal(destination.tabIndex, -1, 'mobile390: guide heading stays outside normal Tab order')
  assert.ok(destination.rect && destination.rect.top >= 0 && destination.rect.bottom <= destination.viewportHeight, 'mobile390: focused guide heading is fully visible')
  assert.ok((destination.shellScrollTop ?? 0) > 0, 'mobile390: existing HOME scroll owner moved to guide')
  assert.equal(destination.url, beforeUrl, 'mobile390: guide move leaves URL unchanged')
  assert.equal(destination.historyLength, beforeHistory, 'mobile390: guide move leaves history unchanged')

  // Return to top for the representative screenshot.
  await page.evaluate(() => {
    const shell = document.querySelector('.home-shell')
    if (shell instanceof HTMLElement) shell.scrollTop = 0
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.screenshot({ path: OUT + '/candidate-home-390x844.png', fullPage: false })

  report.mobile390 = metrics
  report.readingGuide = { tabSequence, destination }
  await page.close()
}

// 1440×900 candidate render.
{
  const page = await guardedPage(1440, 900)
  await openHome(page)
  const metrics = await homeMetrics(page)
  assertCommon(metrics, 68, 'desktop1440')
  assert.ok(metrics.lookup && metrics.routes && metrics.lookup.right <= metrics.routes.left + 1, 'desktop1440: lookup remains left of SWITCH/EXPLORE')
  assert.ok(metrics.switchRoute && metrics.exploreRoute && metrics.switchRoute.bottom <= metrics.exploreRoute.top + 1, 'desktop1440: SWITCH/EXPLORE remain vertically stacked')

  const sideGapLeft = metrics.headerInner.left
  const sideGapRight = metrics.viewport.width - metrics.headerInner.right
  assert.ok(Math.abs(sideGapLeft - sideGapRight) <= 1, 'desktop1440: header/logo inset remains symmetrical')

  await page.screenshot({ path: OUT + '/candidate-home-1440x900.png', fullPage: false })
  report.desktop1440 = metrics
  await page.close()
}

assert.equal(report.blockedAttempts.length, 0, 'candidate attempted no blocked write/analytics requests')
assert.ok(report.publicReads.length > 0, 'candidate used live public Data API reads')
assert.ok(report.publicReads.every(item => ['GET', 'HEAD', 'OPTIONS'].includes(item.method)), 'only public read methods were transmitted')
assert.ok(report.publicReads.every(item => item.status >= 200 && item.status < 300), 'all public Data API reads succeeded')

const short = [
  'PR #52 HOME CSS candidate QA',
  'product head: ' + PRODUCT_SHA,
  '390x844 computed background #f3f1ec: PASS',
  '390x844 header height 62px / flex-shrink 0: PASS',
  '1440x900 computed background #f3f1ec: PASS',
  '1440x900 header height 68px / flex-shrink 0: PASS',
  'logo inset / three start paths / no horizontal overflow or clipping: PASS',
  'HOME shell remains vertical scroll owner: PASS',
  'actual Tab -> reading guide -> focus + visible destination: PASS',
  'reading-guide URL/history unchanged: PASS',
  'blocked write/analytics attempts: ' + report.blockedAttempts.length,
  'public API reads: ' + report.publicReads.length + ' (all 2xx)',
].join('\n') + '\n'

await writeFile(OUT + '/report.json', JSON.stringify(report, null, 2))
await writeFile(OUT + '/report.txt', short)
console.log('CATFOOD_PR52_HOME_CSS=' + JSON.stringify(report))
console.log(short)

await browser.close()
