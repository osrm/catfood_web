import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core')
const BASE = process.env.CANDIDATE_URL || 'http://127.0.0.1:4173/'
const OUT = process.env.OUT_DIR || 'reason-led-switch-output'
await mkdir(OUT, { recursive: true })
const royal = 'product_5b13354ad9792881', alleva = 'product_2bd53155d56271cf'
const reason = 'QA_PRIVATE_REASON 원료가 구체적으로 적힌 다른 사료도 알아보고 싶어요.'
const positives = 'QA_PRIVATE_POSITIVE 잘 먹고 있어요. 건식은 유지하고 싶어요.'
const note = '어유의 어종을 더 확인해 보려고 비교 후보로 남김.'
const report = { sourceSha: process.env.CANDIDATE_SHA, base: BASE, realPublicData: true, syntheticUserInput: true, views: [], errors: [], failedRequests: [], blockedWrites: [], observations: [] }
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' })
let page
try {
  for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, serviceWorkers: 'block' })
    await context.addInitScript(() => {
      window.__blockedWrites = []
      const original = window.fetch.bind(window)
      window.fetch = (input, options) => {
        const method = String(options?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) { window.__blockedWrites.push({ method, url: String(input) }); return Promise.reject(new Error('Read-only review blocked write')) }
        return original(input, options)
      }
    })
    page = await context.newPage()
    page.on('pageerror', e => report.errors.push({ width, error: String(e) }))
    page.on('requestfailed', r => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') report.failedRequests.push({ width, url: r.url(), error: r.failure()?.errorText }) })
    page.on('request', r => assert.doesNotMatch(r.url() + (r.postData() || ''), /QA_PRIVATE_/))
    const button = name => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first()
    async function capture(key, selector = 'body') {
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))]))
      await page.evaluate(() => scrollTo(0, 0))
      const geometry = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }))
      assert.ok(geometry.documentWidth <= width + 1, `${width}-${key}: document overflow`)
      report.views.push({ width, key, geometry, text: (await page.locator(selector).innerText()).slice(0, 16000) })
      await page.screenshot({ path: `${OUT}/${width}-${key}.png`, fullPage: true })
      await page.screenshot({ path: `${OUT}/${width}-${key}-viewport.png` })
    }
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: '어떤 사료를 찾으세요?' }).waitFor({ timeout: 45000 })
    assert.match(await page.locator('.home-purpose-promise').innerText(), /유지할 점과 확인하고 싶은 차이/)
    await capture('home')
    await (await button('먹이는 사료 찾기 →')).click()
    await page.locator('.switch-find-search input').fill('AATU')
    await page.locator('.switch-find-result').filter({ hasText: /연어/ }).first().click({ timeout: 45000 })
    await page.locator('.switch-sku-option').filter({ hasText: /1\s*kg|1[,.]?000\s*g/i }).first().click()
    await page.locator('.switch-step-actions .switch-primary-action').click()
    await page.getByRole('heading', { name: '이번에는 무엇을 확인하고 싶나요?' }).waitFor({ timeout: 45000 })
    await page.getByRole('button', { name: /원료가 얼마나 구체적으로/ }).click()
    assert.equal(await page.locator('.switch-other-conditions').getAttribute('open'), null)
    await page.locator('.decision-purpose-writing summary').click()
    await page.getByLabel('사료를 바꾸려는 이유', { exact: true }).fill(reason)
    await page.getByLabel('지금 사료에서 좋았던 점', { exact: true }).fill(positives)
    await (await button('건식 유지')).click()
    await capture('purpose', '.switch-step-main')
    await page.locator('.switch-step-actions .switch-primary-action').click()
    await page.locator('.switch-candidate-row').first().waitFor({ timeout: 45000 })
    assert.match(await page.locator('.switch-session-bar').textContent(), /QA_PRIVATE_REASON/)
    await page.getByRole('searchbox', { name: '후보 제품 검색' }).fill('노르웨이 숲')
    const royalRow = page.locator(`.switch-candidate-row[data-product-id="${royal}"]`)
    await royalRow.locator('.ingredient-list-reason').getByText(/어유.*세부 어종 미기재/).waitFor({ timeout: 45000 })
    await capture('royal-source', '.switch-results-stage')
    await page.locator(`[data-switch-compare-product-id="${royal}"]`).click()
    await page.getByRole('searchbox', { name: '후보 제품 검색' }).fill('Equilibrium Indoor')
    const allevaRow = page.locator(`.switch-candidate-row[data-product-id="${alleva}"]`)
    await allevaRow.locator('.ingredient-list-reason').getByText(/fish oil.*herring.*청어/i).waitFor({ timeout: 45000 })
    await capture('alleva-source', '.switch-results-stage')
    await page.locator(`[data-switch-compare-product-id="${alleva}"]`).click()
    await page.locator('.switch-compare-dock button').click()
    await page.getByRole('tab', { name: '원재료', selected: true }).waitFor()
    assert.match(await page.locator('.compare-stage > .decision-purpose-summary').textContent(), /QA_PRIVATE_REASON/)
    assert.equal(await page.locator('.comparison-highlights').count(), 0)
    await page.getByText(/어유.*세부 어종 미기재/).filter({ visible: true }).first().waitFor({ timeout: 45000 })
    await capture('compare', '.compare-stage')
    const picker = page.locator('.compare-mobile-candidate-toggle')
    if (await picker.isVisible()) {
      await picker.click(); await page.locator(`.compare-mobile-candidate-options [data-product-id="${alleva}"]`).click()
      await page.getByText(/fish oil.*herring.*청어/i).filter({ visible: true }).first().waitFor()
      await capture('compare-pair', '.compare-stage')
      await picker.click(); await page.locator(`.compare-mobile-candidate-options [data-product-id="${royal}"]`).click()
    }
    const retain = page.locator('.journey-retain').filter({ has: page.locator('> strong').filter({ hasText: '노르웨이 숲' }) })
    await retain.getByRole('button', { name: '후보로 남기기', exact: true }).click()
    await page.locator('.journey-records li').filter({ hasText: '노르웨이 숲' }).getByText('당시 조건과 내 메모', { exact: true }).click()
    await page.getByRole('button', { name: '후보 메모 쓰기', exact: true }).click()
    await page.locator('dialog textarea').fill(note); await (await button('메모 남기기')).click()
    await (await button('아직 못 고름')).click()
    await (await button('기록 복사')).click()
    const copy = await page.getByRole('textbox', { name: '복사할 검토 기록' }).inputValue()
    for (const text of [reason, positives, note, '노르웨이 숲', '이번 정리: 아직 못 고름']) assert.ok(copy.includes(text), text)
    assert.doesNotMatch(await page.evaluate(() => location.href + JSON.stringify(history.state)), /QA_PRIVATE_/)
    await capture('record', 'dialog')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.compare-stage > .decision-purpose-summary').waitFor({ timeout: 45000 })
    assert.match(await page.locator('.compare-stage > .decision-purpose-summary').textContent(), /QA_PRIVATE_REASON/)
    assert.match(await page.locator('.journey-records').innerText(), /이 후보를 남길 때의 이유와 경험/)
    const records = await page.evaluate(() => JSON.parse(sessionStorage.getItem('catfood.switch-review.v1')))
    assert.equal(records.retained[0].context.purpose.reason, reason)
    assert.equal(records.outcome.context.purpose.positives, positives)
    const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('catfood.switch-session.v1')).state)
    assert.deepEqual(state.change.features, []); assert.deepEqual(state.ingredientAvoidTerms, [])
    assert.equal(state.keep.feedType, '건식')
    assert.match(records.retained[0].context.variantLabel, /1\s*kg/i)
    assert.equal(state.currentProductId, records.retained[0].context.current.productId)
    assert.equal(state.variantSelection.variantId, records.retained[0].context.variantId)
    await capture('restored', '.compare-stage')
    report.observations.push({ width, currentPackagePreserved: true, selectedFocus: records.purpose.focus, sourceWordingDistinguished: true, reasonsSnapshotPreserved: true, observationsNotInferredAsClaims: true })
    report.blockedWrites.push(...await page.evaluate(() => window.__blockedWrites))
    await context.close()
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blockedWrites, [])
} catch (error) {
  report.failure = String(error)
  if (page && !page.isClosed()) { report.failureText = await page.locator('body').innerText(); await page.screenshot({ path: `${OUT}/failure.png` }) }
  throw error
} finally { await browser.close(); await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2)) }
console.log(JSON.stringify({ views: report.views.length, observations: report.observations, errors: report.errors, failedRequests: report.failedRequests, blockedWrites: report.blockedWrites }, null, 2))
