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
  transmittedPublicReads: [],
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

async function openHome(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.locator('.home-start-copy h1').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForFunction(() => {
    const text = document.querySelector('.home-catalog-status')?.textContent || ''
    return /\d[\d,]*개/.test(text) && !text.includes('—')
  }, null, { timeout: 30000 })
  await page.evaluate(() => document.fonts?.ready)
}

async function metrics(page) {
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
    }))

    const shell = document.querySelector('.home-shell.home-knowledge-shell')
    const header = document.querySelector('.home-header')
    const logo = document.querySelector('.home-logo')
    const shellStyle = shell instanceof HTMLElement ? getComputedStyle(shell) : null
    const headerStyle = header instanceof HTMLElement ? getComputedStyle(header) : null

    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      shell: rect('.home-shell.home-knowledge-shell'),
      shellComputedBackground: shellStyle?.backgroundColor || null,
      shellHeight: shell instanceof HTMLElement ? shell.getBoundingClientRect().height : null,
      shellClientHeight: shell instanceof HTMLElement ? shell.clientHeight : null,
      shellScrollHeight: shell instanceof HTMLElement ? shell.scrollHeight : null,
      shellOverflowY: shellStyle?.overflowY || null,
      documentScrollHeight: document.documentElement.scrollHeight,
      header: rect('.home-header'),
      headerComputedHeight: headerStyle?.height || null,
      headerFlexShrink: headerStyle?.flexShrink || null,
      headerInner: rect('.home-header-inner'),
      logo: rect('.home-logo'),
      board: rect('.home-entry-board'),
      lookup: rect('.home-entry-lookup'),
      switchRoute: rect('.home-entry-route:nth-child(1)'),
      exploreRoute: rect('.home-entry-route:nth-child(2)'),
      descriptions: [...document.querySelectorAll('.home-entry-route p')].map(el => ({
        text: el.textContent?.trim() || '',
        fontSize: getComputedStyle(el).fontSize,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      })),
      fit: fit('.home-logo, .home-catalog-status, .home-start-copy h1, .home-entry-lookup h2, .home-entry-route h2, .home-entry-route p, .home-entry-route > button, .home-entry-search-field, .home-entry-search-submit'),
      pathOrder: [...document.querySelectorAll('.home-entry-lookup, .home-entry-route')].map(el => ({
        className: el.className,
        top: el.getBoundingClientRect().top,
      })),
    }
  })
}

function assertNoClip(items, label) {
  assert.ok(items.every(x =>
    x.scrollWidth <= x.clientWidth + 2 &&
    (x.scrollHeight <= x.clientHeight + 2 || !['hidden', 'clip'].includes(x.overflowY))
  ), label)
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
  assert.fail('reading guide trigger not reached by Tab')
}

async function verifyViewport(width, height, expectedHeaderHeight, key, file) {
  const page = await guardedPage(width, height)
  await openHome(page)
  const m = await metrics(page)

  assert.equal(m.shellComputedBackground, 'rgb(243, 241, 236)', key + ': HOME computed background')
  assert.ok(Math.abs(m.header.height - expectedHeaderHeight) <= 0.5, key + ': header rect height')
  assert.equal(m.headerComputedHeight, expectedHeaderHeight + 'px', key + ': computed header height')
  assert.equal(m.headerFlexShrink, '0', key + ': header does not shrink')
  assert.equal(m.documentWidth, width, key + ': no document horizontal overflow')
  assert.equal(m.bodyWidth, width, key + ': no body horizontal overflow')
  assert.equal(m.shellClientHeight, height, key + ': HOME shell owns viewport height')
  assert.ok(m.shellScrollHeight > m.shellClientHeight, key + ': HOME shell remains scroll owner')
  assert.equal(m.shellOverflowY, 'auto', key + ': HOME shell keeps overflow-y auto')
  assert.ok(m.logo && m.headerInner, key + ': logo/header geometry exists')
  assert.ok(m.logo.left >= m.headerInner.left - 1 && m.logo.right <= m.headerInner.right + 1, key + ': logo remains inside intended header margins')
  assert.ok(m.logo.top >= m.header.top - 1 && m.logo.bottom <= m.header.bottom + 1, key + ': logo is not vertically clipped')
  assert.ok(m.lookup && m.switchRoute && m.exploreRoute, key + ': all three start paths exist')
  assert.ok(m.descriptions.every(x => x.fontSize === '14px'), key + ': route descriptions unchanged at 14px')
  assertNoClip(m.fit, key + ': logo/start-path copy and controls are not clipped')

  if (width === 390) {
    assert.ok(m.pathOrder[0].top < m.pathOrder[1].top && m.pathOrder[1].top < m.pathOrder[2].top, 'mobile: start path order preserved')
  } else {
    assert.ok(m.lookup.right <= m.switchRoute.left + 1, 'desktop: lookup remains left of route column')
    assert.ok(m.switchRoute.bottom <= m.exploreRoute.top + 1, 'desktop: switch/explore remain stacked')
  }

  await page.screenshot({ path: OUT + '/' + file, fullPage: false })
  report[key] = m

  if (width === 390) {
    const beforeUrl = page.url()
    const beforeHistory = await page.evaluate(() => history.length)
    const sequence = await tabToReadingGuide(page)
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
        shellScrollTop: document.querySelector('.home-shell')?.scrollTop ?? null,
      }
    })

    assert.equal(destination.activeId, 'home-guides-title', 'reading guide heading receives focus')
    assert.equal(destination.tabIndex, -1, 'guide heading remains outside normal Tab order')
    assert.ok(destination.rect && destination.rect.top >= 0 && destination.rect.bottom <= destination.viewportHeight, 'guide heading is fully visible')
    assert.equal(destination.url, beforeUrl, 'reading guide leaves URL unchanged')
    assert.equal(destination.historyLength, beforeHistory, 'reading guide leaves history unchanged')
    assert.ok(destination.shellScrollTop > 0, 'HOME shell scrolls to reading guide')

    report.readingGuide = { sequence, destination }
  }

  await page.close()
}

await verifyViewport(390, 844, 62, 'mobile390', 'candidate-home-390x844.png')
await verifyViewport(1440, 900, 68, 'desktop1440', 'candidate-home-1440x900.png')

assert.equal(report.blockedAttempts.length, 0, 'candidate attempted no write/analytics requests')
assert.ok(report.transmittedPublicReads.length > 0, 'candidate used public Data API reads')
assert.ok(report.transmittedPublicReads.every(x => ['GET','HEAD','OPTIONS'].includes(x.method) && x.status >= 200 && x.status < 300), 'all transmitted Data API requests are successful reads')

const short = [
  'PR #53 HOME CSS candidate QA',
  'product head: ' + PRODUCT_SHA,
  '390x844 computed HOME background #f3f1ec: PASS',
  '390x844 header height 62px / flex-shrink 0: PASS',
  '1440x900 computed HOME background #f3f1ec: PASS',
  '1440x900 header height 68px / flex-shrink 0: PASS',
  'HOME shell remains viewport scroll owner: PASS',
  'logo margins / three start paths / no horizontal overflow or clipping: PASS',
  'reading guide focus after restored header: PASS',
  'blocked attempts: ' + report.blockedAttempts.length,
  'transmitted public Data API reads: ' + report.transmittedPublicReads.length + ' (all 2xx)',
].join('\n') + '\n'

await writeFile(OUT + '/report.json', JSON.stringify(report, null, 2))
await writeFile(OUT + '/report.txt', short)
console.log('CATFOOD_PR53_QA=' + JSON.stringify(report))
console.log(short)

await browser.close()
