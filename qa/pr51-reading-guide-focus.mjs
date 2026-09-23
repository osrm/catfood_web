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
  blockedAnalytics: [],
  apiReads: [],
  keyboard: null,
  pointer: null,
  reducedMotion: null,
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
})

async function guardedPage({ reducedMotion = 'no-preference' } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.emulateMedia({ reducedMotion })

  await page.route('**/*', async route => {
    const req = route.request()
    const method = req.method()
    const url = req.url()
    let parsed = null
    try { parsed = new URL(url) } catch {}

    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      report.blockedNonGet.push({ method, url: parsed ? parsed.origin + parsed.pathname : url })
      await route.abort('blockedbyclient')
      return
    }

    if (/\/functions\/v1\/|analytics|telemetry|event_log/i.test(url)) {
      report.blockedAnalytics.push({ method, url: parsed ? parsed.origin + parsed.pathname : url })
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

async function openHome(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.locator('.home-start-copy h1').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForFunction(() => {
    const text = document.querySelector('.home-catalog-status')?.textContent || ''
    return /\d[\d,]*개/.test(text) && !text.includes('—')
  }, null, { timeout: 30000 })
}

async function tabToReadingGuide(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const shell = document.querySelector('.home-shell')
    if (shell instanceof HTMLElement) shell.scrollTop = 0
  })

  const seen = []
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab')
    const active = await page.evaluate(() => {
      const el = document.activeElement
      return {
        tag: el?.tagName || '',
        text: el?.textContent?.replace(/\s+/g, ' ').trim() || '',
        className: el instanceof HTMLElement ? el.className : '',
      }
    })
    seen.push(active)
    if (active.text.includes('정보 읽는 기준 보기')) return seen
  }

  assert.fail('reading-guide button was not reached through actual Tab navigation')
}

async function assertDestination(page, initialUrl, initialHistoryLength) {
  await page.waitForFunction(() => {
    const heading = document.getElementById('home-guides-title')
    if (!(heading instanceof HTMLElement)) return false
    const rect = heading.getBoundingClientRect()
    return document.activeElement === heading &&
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight
  }, null, { timeout: 10000 })

  const state = await page.evaluate(() => {
    const heading = document.getElementById('home-guides-title')
    const rect = heading?.getBoundingClientRect()
    return {
      activeId: document.activeElement?.id || null,
      headingTabIndex: heading instanceof HTMLElement ? heading.tabIndex : null,
      rect: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null,
      viewportHeight: innerHeight,
      url: location.href,
      historyLength: history.length,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      shellScrollTop: document.querySelector('.home-shell')?.scrollTop ?? null,
    }
  })

  assert.equal(state.activeId, 'home-guides-title', 'programmatic focus lands on guide heading')
  assert.equal(state.headingTabIndex, -1, 'guide heading stays out of normal Tab order')
  assert.ok(state.rect && state.rect.top >= 0 && state.rect.bottom <= state.viewportHeight, 'focused guide heading is fully visible')
  assert.equal(state.url, initialUrl, 'guide navigation leaves URL unchanged')
  assert.equal(state.historyLength, initialHistoryLength, 'guide navigation leaves history length unchanged')
  assert.ok((state.shellScrollTop ?? 0) > 0, 'HOME scroll container moved to the guide')
  return state
}

// Actual keyboard traversal: no element.focus() shortcut.
{
  const page = await guardedPage()
  await openHome(page)
  const initialUrl = page.url()
  const initialHistoryLength = await page.evaluate(() => history.length)

  const tabSequence = await tabToReadingGuide(page)
  await page.keyboard.press('Enter')
  const destination = await assertDestination(page, initialUrl, initialHistoryLength)

  await page.keyboard.press('Tab')
  const afterTab = await page.evaluate(() => {
    const heading = document.getElementById('home-guides-title')
    const active = document.activeElement
    return {
      tag: active?.tagName || '',
      text: active?.textContent?.replace(/\s+/g, ' ').trim() || '',
      isFollowing: Boolean(
        heading && active && (heading.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING),
      ),
      activeId: active?.id || null,
    }
  })
  assert.equal(afterTab.isFollowing, true, 'Tab after programmatic heading focus continues to a later document control')
  assert.notEqual(afterTab.activeId, 'home-guides-title', 'next Tab leaves the programmatic-only heading')

  report.keyboard = { tabSequence, destination, afterTab }
  await page.close()
}

// Pointer activation.
{
  const page = await guardedPage()
  await openHome(page)
  const initialUrl = page.url()
  const initialHistoryLength = await page.evaluate(() => history.length)

  const trigger = page.getByRole('button', { name: /정보 읽는 기준 보기/ })
  const box = await trigger.boundingBox()
  assert.ok(box, 'pointer trigger has a box')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

  const destination = await assertDestination(page, initialUrl, initialHistoryLength)
  report.pointer = { destination }
  await page.close()
}

// Reduced motion: same destination/focus contract, without requiring smooth scrolling.
{
  const page = await guardedPage({ reducedMotion: 'reduce' })
  await openHome(page)
  const initialUrl = page.url()
  const initialHistoryLength = await page.evaluate(() => history.length)
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true)

  const tabSequence = await tabToReadingGuide(page)
  await page.keyboard.press('Enter')
  const destination = await assertDestination(page, initialUrl, initialHistoryLength)
  assert.equal(destination.reducedMotion, true, 'browser is in reduced-motion mode')

  report.reducedMotion = { tabSequence, destination }
  await page.close()
}

assert.equal(report.blockedNonGet.length, 0, 'candidate attempted no non-read requests')
assert.equal(report.blockedAnalytics.length, 0, 'candidate attempted no analytics requests')
assert.ok(report.apiReads.length > 0, 'candidate used live public Data API reads')
assert.ok(report.apiReads.every(item => ['GET', 'HEAD', 'OPTIONS'].includes(item.method)), 'only read methods reached Data API')
assert.ok(report.apiReads.every(item => item.status >= 200 && item.status < 300), 'all observed Data API reads succeeded')

const short = [
  'PR #51 reading-guide focus QA',
  'product head: ' + PRODUCT_SHA,
  'actual Tab -> reading guide -> Enter: PASS',
  'activeElement -> #home-guides-title: PASS',
  'focused heading fully visible: PASS',
  'next Tab continues after destination: PASS',
  'pointer activation: PASS',
  'reduced-motion activation/focus: PASS',
  'URL/history unchanged: PASS',
  'blocked non-GET attempts: ' + report.blockedNonGet.length,
  'blocked analytics attempts: ' + report.blockedAnalytics.length,
  'public API reads: ' + report.apiReads.length + ' (all 2xx)',
].join('\n') + '\n'

await writeFile(OUT + '/report.json', JSON.stringify(report, null, 2))
await writeFile(OUT + '/report.txt', short)
console.log('CATFOOD_PR51_READING_GUIDE=' + JSON.stringify(report))
console.log(short)

await browser.close()
