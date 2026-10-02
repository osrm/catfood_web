import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE = 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = 'b418be11a0bba14487303f86a02b50b98da1a37b'
const OUT = process.env.OUT_DIR || 'pr97-postdeploy-output'
const GO = 'product_a0e685be674c6617'

await mkdir(OUT, { recursive: true })
const report = {
  pagesUrl: BASE,
  deployedMergeSha: MERGE_SHA,
  browser: {},
  blocked: [],
  reads: [],
  screens: {},
  assertions: {},
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
})
report.browser = {
  version: await browser.version(),
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
}
const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim()

async function pageAt(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' })
  const page = await context.newPage()
  // Install before the first navigation. Block analytics and every write method.
  await page.route('**/*', async (route) => {
    const req = route.request()
    const method = req.method()
    const url = new URL(req.url())
    const analytics = /search-runs|considerations|event_log|analytics|telemetry|functions\/v1|google-analytics|googletagmanager/i.test(url.href)
    const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(method)
    if (analytics || !readOnly) {
      report.blocked.push({ method, url: url.href, reason: analytics ? 'analytics' : 'write' })
      return route.abort('blockedbyclient')
    }
    report.reads.push({ method, origin: url.origin, path: url.pathname })
    await route.continue()
  })
  return { context, page }
}

async function settle(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready
    const visible = [...document.images].filter((img) => {
      const r = img.getBoundingClientRect()
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
    })
    await Promise.all(visible.map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
      const done = () => resolve()
      img.addEventListener('load', done, { once: true })
      img.addEventListener('error', done, { once: true })
      setTimeout(done, 4000)
    })))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function metrics(page, rootSelector) {
  return page.evaluate((selector) => {
    const doc = document.scrollingElement || document.documentElement
    const root = document.querySelector(selector)
    const html = getComputedStyle(document.documentElement)
    const body = getComputedStyle(document.body)
    return {
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight },
      document: { clientWidth: doc.clientWidth, scrollWidth: doc.scrollWidth, overflowX: doc.scrollWidth - doc.clientWidth },
      root: root ? { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, overflowX: root.scrollWidth - root.clientWidth } : null,
      tokens: {
        bg: html.getPropertyValue('--cf-bg').trim(),
        surface: html.getPropertyValue('--cf-surface').trim(),
        ink: html.getPropertyValue('--cf-ink').trim(),
        accent: html.getPropertyValue('--cf-accent').trim(),
        line: html.getPropertyValue('--cf-line').trim(),
      },
      body: { backgroundColor: body.backgroundColor, color: body.color, fontFamily: body.fontFamily },
    }
  }, rootSelector)
}

async function capture(page, key, filename, rootSelector) {
  await settle(page)
  const m = await metrics(page, rootSelector)
  assert.ok(m.document.overflowX <= 1, `${key}: document horizontal overflow ${m.document.overflowX}`)
  assert.equal(m.tokens.bg.toUpperCase(), '#FAF9F6')
  assert.equal(m.tokens.ink.toUpperCase(), '#252B2C')
  assert.equal(m.tokens.accent.toUpperCase(), '#BC3D2C')
  assert.match(m.body.fontFamily, /Noto Sans KR/)
  report.screens[key] = m
  await page.screenshot({ path: `${OUT}/${filename}`, fullPage: false })
}

async function waitHome(page) {
  await page.waitForFunction(() => /현재 확인된 제품\s*\d+개/.test(document.body.innerText), null, { timeout: 90000 })
}

async function generalFlow(width, height, label) {
  const { context, page } = await pageAt(width, height)
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await waitHome(page)
  assert.match(norm(await page.locator('.home-start-copy h1').textContent()), /이 사료와 저 사료,\s*뭐가 다를까요\?/)
  assert.match(norm(await page.locator('.home-start-copy > p').textContent()), /원재료와 영양 성분을 한곳에서 확인할 수 있어요/)
  await capture(page, `${label}-home`, `01-${label}-home.png`, '.home-shell')

  const homeSearch = page.getByRole('searchbox', { name: '브랜드 또는 제품명 검색' })
  await homeSearch.fill('GO!')
  await page.getByRole('button', { name: '검색', exact: true }).click()
  const goRow = page.locator('.research-result-row').filter({ hasText: /GO! SOLUTIONS/ }).filter({ hasText: /LID 오리/ }).first()
  await goRow.waitFor({ state: 'visible', timeout: 90000 })
  assert.equal(await page.getByRole('button', { name: '제품 찾기', exact: true }).getAttribute('aria-current'), 'page')
  await capture(page, `${label}-list`, `02-${label}-list.png`, '.research-shell')

  const goCompare = goRow.locator('.research-result-compare')
  await goCompare.click()
  assert.equal(await goCompare.getAttribute('aria-pressed'), 'true')
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()), /비교 1\/5/)

  await goRow.locator('.research-result-card').click()
  const quick = page.locator('.research-quick-view')
  await quick.waitFor({ state: 'visible', timeout: 30000 })
  assert.match(norm(await quick.locator('.quick-view-actions').textContent()), /비교에서 제거/)
  await quick.getByRole('button', { name: '상세 보기 →' }).click()
  const detail = page.locator('.detail-stage')
  await detail.waitFor({ state: 'visible', timeout: 30000 })
  assert.match(norm(await page.locator('.detail-identity-actions').textContent()), /비교에서 제거/)

  await page.getByRole('tab', { name: '원재료', exact: true }).click()
  const rawSummary = page.locator('.detail-source-disclosure summary').filter({ hasText: '원문 보기' }).first()
  await rawSummary.waitFor({ state: 'visible', timeout: 90000 })
  await rawSummary.click()
  const rawText = page.locator('.detail-source-disclosure .detail-ingredient-copy').first()
  await rawText.waitFor({ state: 'visible', timeout: 30000 })
  const raw = norm(await rawText.textContent())
  assert.ok(raw.length > 30)
  await rawSummary.scrollIntoViewIfNeeded()
  await capture(page, `${label}-detail`, `03-${label}-detail-ingredients.png`, '.detail-stage')

  await page.getByRole('tab', { name: '영양', exact: true }).click()
  const energy = page.locator('.detail-energy strong')
  await energy.waitFor({ state: 'visible', timeout: 90000 })
  const energyText = norm(await energy.textContent())
  const nutritionText = norm(await page.locator('#detail-panel-nutrition').textContent())
  const detailScope = norm(await page.locator('#detail-panel-nutrition .detail-evidence-context').first().textContent())
  assert.match(energyText, /kcal/i)
  assert.match(nutritionText, /%/)
  assert.ok(detailScope.length > 0)
  report.assertions[`${label}-detail`] = { compareState: '비교에서 제거', rawTextLength: raw.length, energy: energyText, scope: detailScope }

  await page.getByRole('button', { name: /䯌아렌 기/ }).first().click()
  await page.locator('.research-results').waitFor({ state: 'visible', timeout: 30000 })
  if (await quick.isVisible().catch(() => false)) await quick.locator('.quick-view-topline button').click()

  const lookup = page.locator('.lookup-input')
  await lookup.fill('AATU')
  const aatuRow = page.locator('.research-result-row').filter({ hasText: /AATU/ }).filter({ hasText: /연어/ }).first()
  await aatuRow.waitFor({ state: 'visible', timeout: 90000 })
  await aatuRow.locator('.research-result-compare').click()
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()), /비교 2\/5/)
  await page.locator('.switch-compare-dock').getByRole('button', { name: '비교 보기 →' }).click()
  const compare = page.locator('.compare-stage')
  await compare.waitFor({ state: 'visible', timeout: 30000 })
  assert.ok(await page.locator('.compare-product-head').count() >= 2)

  await page.getByRole('tab', { name: '영양', exact: true }).click()
  await page.waitForFunction(() => /kcal\/100g/.test(document.querySelector('#compare-panel-nutrition')?.textContent || ''), null, { timeout: 90000 })
  const compareNutrition = norm(await page.locator('#compare-panel-nutrition').textContent())
  assert.match(compareNutrition, /kcal\/100g/)
  assert.match(compareNutrition, /자료 범위/)
  report.assertions[`${label}-compare-nutrition`] = { hasNormalizedEnergy: true, hasScope: true }

  await page.getByRole('tab', { name: '원재료', exact: true }).click()
  const sourceSummary = page.locator('#compare-panel-ingredients .compare-evidence-disclosure summary').filter({ hasText: '출처 원문 보기' }).first()
  await sourceSummary.waitFor({ state: 'visible', timeout: 90000 })
  await sourceSummary.click()
  const sourceText = page.locator('#compare-panel-ingredients .compare-ingredient-text').first()
  await sourceText.waitFor({ state: 'visible', timeout: 30000 })
  assert.ok(norm(await sourceText.textContent()).length > 30)
  await sourceSummary.scrollIntoViewIfNeeded()
  await capture(page, `${label}-general-compare`, `04-${label}-general-compare-ingredients.png`, '.compare-stage')
  report.assertions[`${label}-general-compare`] = { productCount: await page.locator('.compare-product-head').count(), rawAccessible: true }

  await context.close()
}

async function reachSwitchResults(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await waitHome(page)
  await page.getByRole('button', { name: '현재 사료로 시작 →' }).click()
  const find = page.locator('.switch-find-search input')
  await find.waitFor({ state: 'visible', timeout: 30000 })
  await find.fill('AATU')
  const current = page.locator('.switch-find-result').filter({ hasText: /AATU/ }).filter({ hasText: /연어/ }).first()
  await current.waitFor({ state: 'visible', timeout: 30000 })
  await current.click()
  await page.getByRole('button', { name: '이 제품을 현재 사료로 선택 →' }).click()
  const sku = page.locator('.switch-sku-option').filter({ hasText: /1\s*kg|1[,.]?000\s*g/i }).first()
  await sku.waitFor({ state: 'visible', timeout: 30000 })
  await sku.click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.locator('.switch-no-change').click()
  await page.locator('.switch-step-actions .switch-primary-action').click()
  await page.getByRole('button', { name: '후보 제품 보기 →' }).click()
  await page.locator('.switch-results-stage').waitFor({ state: 'visible', timeout: 90000 })
  await page.waitForFunction(() => {
    const text = document.querySelector('.switch-session-bar')?.textContent || ''
    return text.includes('AATU') && text.includes('연어') && text.includes('1 kg')
  }, null, { timeout: 90000 })
}

async function switchFlow(width, height, label) {
  const { context, page } = await pageAt(width, height)
  await reachSwitchResults(page)
  const search = page.locator('input[aria-label="후보 제품 검색"]')
  await search.fill('GO!')
  const row = page.locator('.switch-candidate-row').filter({ hasText: /GO! SOLUTIONS/ }).filter({ hasText: /LID 오리/ }).first()
  const direct = page.locator(`[data-switch-compare-product-id="${GO}"]`)
  await direct.waitFor({ state: 'visible', timeout: 30000 })
  await direct.click()
  assert.equal(await direct.getAttribute('aria-pressed'), 'true')
  assert.equal(await row.evaluate((el) => el.classList.contains('is-selected')), false)
  assert.equal(await page.locator('.switch-candidate-inspector').count(), 0)
  assert.match(norm(await page.locator('.switch-compare-dock').textContent()), /비교 1\/5.*LID 오리/)
  await direct.scrollIntoViewIfNeeded()
  await capture(page, `${label}-switch`, `05-${label}-switch.png`, '.switch-results-stage')

  await page.locator('.switch-compare-dock').getByRole('button', { name: '비교 보기 →' }).click()
  await page.locator('.compare-stage.is-switch-compare').waitFor({ state: 'visible', timeout: 30000 })
  await page.getByRole('tab', { name: '영양', exact: true }).click()
  await page.waitForFunction(() => /kcal\/100g/.test(document.querySelector('#compare-panel-nutrition')?.textContent || ''), null, { timeout: 90000 })
  const nutrition = norm(await page.locator('#compare-panel-nutrition').textContent())
  assert.match(nutrition, /kcal\/100g/)
  assert.match(nutrition, /자료 범위/)
  report.assertions[`${label}-switch`] = {
    current: 'AATU 연어 · 1 kg',
    candidate: 'GO! SOLUTIONS LID 오리',
    directCompare: true,
    inspectorOpened: false,
    nutritionHasNormalizedEnergy: true,
    nutritionHasScope: true,
  }
  await context.close()
}

for (const [width, height, label] of [[390, 844, 'mobile-390x844'], [1440, 900, 'desktop-1440x900']]) {
  await generalFlow(width, height, label)
  await switchFlow(width, height, label)
}

assert.ok(report.reads.length > 0)
assert.ok(report.reads.every((row) => ['GET', 'HEAD', 'OPTIONS'].includes(row.method)))
assert.equal(report.blocked.filter((row) => row.reason === 'write').length, 0)
report.network = {
  readCount: report.reads.length,
  blockedWrites: report.blocked.filter((row) => row.reason === 'write'),
  blockedAnalytics: report.blocked.filter((row) => row.reason === 'analytics'),
  publicReadOnly: true,
}
await writeFile(`${OUT}/measurements.json`, JSON.stringify(report, null, 2))
await browser.close()
