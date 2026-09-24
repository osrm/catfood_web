import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE = 'http://127.0.0.1:4173/'
const OUT = process.env.OUT_DIR || 'qa-output'
await mkdir(OUT, { recursive: true })

const report = {
  head: process.env.GITHUB_SHA || null,
  generatedAt: new Date().toISOString(),
  blockedWrites: [],
  allowedExternalRequests: [],
  states: {},
  interactions: {},
  breakpoints: {},
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
})

async function makePage(width, height) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.route('**/*', async (route) => {
    const request = route.request()
    const method = request.method()
    const url = request.url()
    const local = url.startsWith('http://127.0.0.1:4173/')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      report.blockedWrites.push({ method, url })
      await route.abort('blockedbyclient')
      return
    }
    if (!local) report.allowedExternalRequests.push({ method, url })
    await route.continue()
  })
  return page
}

async function waitForResults(page) {
  await page.locator('.research-result-card').first().waitFor({ state: 'visible', timeout: 30000 })
  await page.evaluate(async () => {
    await document.fonts?.ready
    const images = [...document.querySelectorAll('img')]
    await Promise.all(images.filter((img) => {
      const r = img.getBoundingClientRect()
      return r.bottom > 0 && r.top < innerHeight
    }).map((img) => img.decode?.().catch(() => undefined)))
  })
}

async function box(locator) {
  const value = await locator.boundingBox()
  return value ? { left: value.x, top: value.y, width: value.width, height: value.height, right: value.x + value.width, bottom: value.y + value.height } : null
}

async function measureBrowse(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!(el instanceof HTMLElement)) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const cards = [...document.querySelectorAll('.research-result-card')].map((card) => {
      const name = card.querySelector('.research-result-identity strong')
      const packages = card.querySelector('.research-result-packages')
      const image = card.querySelector('.research-result-image, .image-placeholder')
      const action = card.querySelector('.research-result-open')
      const relation = card.querySelector('.relation-line')
      const relationLabel = relation?.querySelector('span')
      const relationValue = relation?.querySelector('strong')
      return {
        id: card.dataset.productId || '',
        name: name?.textContent?.trim() || '',
        packages: packages?.textContent?.trim() || '',
        unknown: card.querySelector('.relation-line.is-unknown')?.textContent?.replace(/\s+/g, ' ').trim() || '',
        card: rect(card),
        identity: rect(card.querySelector('.research-result-identity')),
        image: rect(image),
        action: rect(action),
        nameBox: rect(name),
        packagesBox: rect(packages),
        nameFont: name ? getComputedStyle(name).fontSize : null,
        nameOverflow: name ? getComputedStyle(name).overflow : null,
        nameWhiteSpace: name ? getComputedStyle(name).whiteSpace : null,
        packagesOverflow: packages ? getComputedStyle(packages).overflow : null,
        relationLabelFont: relationLabel ? getComputedStyle(relationLabel).fontSize : null,
        relationValueFont: relationValue ? getComputedStyle(relationValue).fontSize : null,
        nameScrollWidth: name?.scrollWidth || 0,
        nameClientWidth: name?.clientWidth || 0,
        nameScrollHeight: name?.scrollHeight || 0,
        nameClientHeight: name?.clientHeight || 0,
        packagesScrollWidth: packages?.scrollWidth || 0,
        packagesClientWidth: packages?.clientWidth || 0,
        packagesScrollHeight: packages?.scrollHeight || 0,
        packagesClientHeight: packages?.clientHeight || 0,
      }
    })
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      workspace: rect(document.querySelector('.research-workspace')),
      results: rect(document.querySelector('.research-results')),
      quickView: rect(document.querySelector('.research-quick-view')),
      cards,
      resultCountText: document.querySelector('.research-results-heading')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    }
  })
}

async function measureSelected(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!(el instanceof HTMLElement)) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const results = document.querySelector('.research-results')
    const quick = document.querySelector('.research-quick-view')
    const quickName = document.querySelector('.quick-view-identity h1')
    const packageValue = [...document.querySelectorAll('.quick-view-section .definition')].find((row) => row.querySelector('dt')?.textContent?.trim() === '판매 규격')?.querySelector('dd')
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      workspace: rect(document.querySelector('.research-workspace')),
      results: rect(results),
      resultsDisplay: results ? getComputedStyle(results).display : null,
      quickView: rect(quick),
      quickDisplay: quick ? getComputedStyle(quick).display : null,
      quickName: quickName?.textContent?.trim() || '',
      quickNameBox: rect(quickName),
      quickNameOverflow: quickName ? getComputedStyle(quickName).overflow : null,
      quickPackage: packageValue?.textContent?.trim() || '',
      quickPackageBox: rect(packageValue),
      quickPackageOverflow: packageValue ? getComputedStyle(packageValue).overflow : null,
      quickUnknown: document.querySelector('.quick-view-section .definition:nth-child(2) dd')?.textContent?.trim() || '',
    }
  })
}

async function chooseCard(page, { requireUnknown = false } = {}) {
  const candidates = await page.locator('.research-result-card').evaluateAll((cards, requireUnknownValue) => cards.map((card, index) => {
    const name = card.querySelector('.research-result-identity strong')?.textContent?.trim() || ''
    const unknown = card.querySelector('.relation-line.is-unknown')?.textContent?.replace(/\s+/g, ' ').trim() || ''
    return { index, name, unknown, eligible: !requireUnknownValue || Boolean(unknown) }
  }), requireUnknown)
  const eligible = candidates.filter((item) => item.eligible)
  assert.ok(eligible.length, requireUnknown ? 'EXPLORE has an unknown result case' : 'results exist')
  return eligible.sort((a, b) => b.name.length - a.name.length)[0]
}

async function assertBrowseLayout(metrics, key) {
  assert.equal(metrics.documentWidth, metrics.viewport.width, key + ': no document horizontal overflow')
  assert.equal(metrics.bodyWidth, metrics.viewport.width, key + ': no body horizontal overflow')
  assert.ok(metrics.cards.length > 0, key + ': result cards exist')
  assert.ok(metrics.cards.every((card) => card.nameFont === '16px'), key + ': product names are 16px')
  const relationCards = metrics.cards.filter((card) => card.relationLabelFont)
  if (relationCards.length) {
    assert.ok(relationCards.every((card) => card.relationLabelFont === '12px' && card.relationValueFont === '13px'), key + ': relation typography is 12/13px')
  }
  assert.ok(metrics.cards.every((card) => card.nameScrollWidth <= card.nameClientWidth + 2), key + ': names have no horizontal clipping')
  assert.ok(metrics.cards.every((card) => card.nameScrollHeight <= card.nameClientHeight + 2), key + ': names have no vertical clipping')
  assert.ok(metrics.cards.every((card) => card.packagesScrollWidth <= card.packagesClientWidth + 2), key + ': packages have no horizontal clipping')
  assert.ok(metrics.cards.every((card) => card.packagesScrollHeight <= card.packagesClientHeight + 2), key + ': packages have no vertical clipping')
}

async function assertMobileRail(metrics, key) {
  for (const card of metrics.cards) {
    assert.ok(card.image && card.action && card.identity, key + ': image/action/identity boxes exist')
    assert.ok(Math.abs(card.image.left - card.action.left) <= 1, key + ': action aligns below image')
    assert.ok(Math.abs(card.image.width - card.action.width) <= 1, key + ': action matches image rail width')
    assert.ok(card.action.top >= card.image.bottom - 1, key + ': action is below image')
    assert.ok(card.identity.left >= card.image.right + 8, key + ': identity receives right-column width')
    assert.ok(card.action.height >= 44, key + ': action keeps 44px target height')
  }
}

async function tabTo(page, predicateSource, max = 60) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab')
    const active = await page.evaluate(() => {
      const el = document.activeElement
      return {
        tag: el?.tagName || '',
        text: el?.textContent?.replace(/\s+/g, ' ').trim() || '',
        className: el instanceof HTMLElement ? el.className : '',
        outline: el instanceof HTMLElement ? getComputedStyle(el).outline : '',
      }
    })
    if (new RegExp(predicateSource).test(active.text)) return active
  }
  throw new Error('Tab target not reached: ' + predicateSource)
}

async function exerciseQuickView(page, modeKey) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  const addFocus = await tabTo(page, '비교에 추가|비교에서 제거')
  assert.match(addFocus.outline, /[1-9]px/, modeKey + ': compare action has visible focus')
  if (!/비교에서 제거/.test(addFocus.text)) {
    await page.keyboard.press('Enter')
    await page.locator('.quick-view-actions button').filter({ hasText: '비교에서 제거' }).waitFor({ state: 'visible' })
  }
  await page.keyboard.press('Enter')
  await page.locator('.quick-view-actions button').filter({ hasText: /비교에 추가|최대 5개/ }).waitFor({ state: 'visible' })
  const detailFocus = await tabTo(page, '상세 보기')
  assert.match(detailFocus.outline, /[1-9]px/, modeKey + ': detail action has visible focus')
  await page.keyboard.press('Enter')
  await page.locator('.detail-stage').waitFor({ state: 'visible' })
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  const backFocus = await tabTo(page, '돌아가기 · 제품 목록')
  assert.match(backFocus.outline, /[1-9]px/, modeKey + ': detail parent-return action has visible focus')
  await page.keyboard.press('Enter')
  await page.locator('.research-quick-view').waitFor({ state: 'visible' })
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  const closeFocus = await tabTo(page, '닫기 ×')
  assert.match(closeFocus.outline, /[1-9]px/, modeKey + ': quick-view close has visible focus')
  await page.keyboard.press('Enter')
  await page.locator('.research-quick-view').waitFor({ state: 'detached' })
  return { addFocus, detailFocus, backFocus, closeFocus }
}

async function runState(mode, width, height, suffix) {
  const page = await makePage(width, height)
  const query = mode === 'lookup'
    ? '?view=workspace&mode=lookup&q=GO%21%20SOLUTIONS'
    : '?view=workspace&mode=explore&applied=1&feed=%EA%B1%B4%EC%8B%9D&targets=indoor'
  await page.goto(BASE + query, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await waitForResults(page)
  const browse = await measureBrowse(page)
  const key = mode + '-' + suffix
  await assertBrowseLayout(browse, key)
  if (width <= 760) await assertMobileRail(browse, key)
  const target = await chooseCard(page, { requireUnknown: mode === 'explore' })
  const targetCard = page.locator('.research-result-card').nth(target.index)
  await targetCard.scrollIntoViewIfNeeded()
  await targetCard.click()
  await page.locator('.research-quick-view').waitFor({ state: 'visible' })
  const selected = await measureSelected(page)
  assert.equal(selected.documentWidth, width, key + ': selected state has no horizontal document overflow')
  if (width >= 901) {
    assert.ok(selected.results && selected.quickView, key + ': two desktop panes exist')
    const paneTotal = selected.results.width + selected.quickView.width
    const listShare = selected.results.width / paneTotal
    assert.ok(listShare >= 0.485 && listShare <= 0.495, key + ': desktop results pane is about 49%')
  } else {
    assert.equal(selected.resultsDisplay, 'none', key + ': mobile selected state hides the result list')
  }
  assert.ok(selected.quickName, key + ': quick-view full name is present')
  assert.ok(selected.quickPackage, key + ': quick-view full package value is present')
  if (mode === 'explore') assert.ok(selected.quickUnknown && selected.quickUnknown !== '—', key + ': quick-view preserves an unknown case')
  await page.screenshot({ path: OUT + '/' + key + '-selected.png', fullPage: false })
  await page.evaluate(() => document.querySelector('.quick-view-topline button')?.click())
  await page.locator('.research-quick-view').waitFor({ state: 'detached' })
  await page.screenshot({ path: OUT + '/' + key + '-browse.png', fullPage: false })
  report.states[key] = { query, browse, target, selected }
  await page.close()
}

async function interactionScenario(mode, width, height) {
  const page = await makePage(width, height)
  const query = mode === 'lookup'
    ? '?view=workspace&mode=lookup&q=GO%21%20SOLUTIONS'
    : '?view=workspace&mode=explore&applied=1&feed=%EA%B1%B4%EC%8B%9D&targets=indoor'
  await page.goto(BASE + query, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await waitForResults(page)
  const target = await chooseCard(page, { requireUnknown: mode === 'explore' })
  await page.locator('.research-result-card').nth(target.index).click()
  await page.locator('.research-quick-view').waitFor({ state: 'visible' })
  const evidence = await exerciseQuickView(page, mode)
  report.interactions[mode] = { viewport: { width, height }, target, evidence, finalUrl: page.url() }
  await page.close()
}

async function breakpointCheck(width, selected) {
  const page = await makePage(width, 820)
  const query = '?view=workspace&mode=explore&applied=1&feed=%EA%B1%B4%EC%8B%9D&targets=indoor'
  await page.goto(BASE + query, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await waitForResults(page)
  if (selected) {
    const target = await chooseCard(page, { requireUnknown: true })
    await page.locator('.research-result-card').nth(target.index).click()
    await page.locator('.research-quick-view').waitFor({ state: 'visible' })
    const metrics = await measureSelected(page)
    report.breakpoints['selected-' + width] = metrics
  } else {
    const metrics = await measureBrowse(page)
    report.breakpoints['browse-' + width] = metrics
  }
  await page.close()
}

await runState('lookup', 390, 844, 'mobile-390x844')
await runState('lookup', 1440, 900, 'desktop-1440x900')
await runState('explore', 390, 844, 'mobile-390x844')
await runState('explore', 1440, 900, 'desktop-1440x900')
await interactionScenario('lookup', 390, 844)
await interactionScenario('explore', 1440, 900)
await breakpointCheck(760, false)
await breakpointCheck(761, false)
await breakpointCheck(900, true)
await breakpointCheck(901, true)

const b760 = report.breakpoints['browse-760'].cards[0]
const b761 = report.breakpoints['browse-761'].cards[0]
assert.ok(b760.action && b760.image && Math.abs(b760.action.left - b760.image.left) <= 1 && b760.action.top >= b760.image.bottom - 1, '760px uses image/action rail')
assert.ok(b761.action && b761.image && (Math.abs(b761.action.left - b761.image.left) > 2 || b761.action.top < b761.image.bottom - 1), '761px leaves mobile image/action rail')
assert.equal(report.breakpoints['selected-900'].resultsDisplay, 'none', '900px keeps mobile quick-view transition')
assert.notEqual(report.breakpoints['selected-901'].resultsDisplay, 'none', '901px restores desktop result/quick-view split')

const writeLikeAllowed = report.allowedExternalRequests.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
assert.equal(writeLikeAllowed.length, 0, 'only public read requests were allowed')
assert.ok(report.blockedWrites.every((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)), 'write-like requests were blocked before navigation')

await writeFile(OUT + '/results-list-candidate-measurements.json', JSON.stringify(report, null, 2))
console.log('RESULTS_LIST_QA=' + JSON.stringify({
  head: report.head,
  blockedWrites: report.blockedWrites.length,
  states: Object.keys(report.states),
  interactions: Object.keys(report.interactions),
  breakpoints: Object.keys(report.breakpoints),
}))

await browser.close()
