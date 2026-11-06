import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core')
const BASE = process.env.CANDIDATE_URL || 'http://127.0.0.1:4173/'
const OUT = process.env.OUT_DIR || 'ingredient-disclosure-live-output'
await mkdir(OUT, { recursive: true })
const products = [
  { id: 'product_5b13354ad9792881', key: 'royalcanin', expected: /어유[\s\S]*세부 어종 미표기/, scope: '한국 자료 · 제품 자료' },
  { id: 'product_2bd53155d56271cf', key: 'alleva', expected: /전체 원료표 확인/, scope: '국내 동일 배합 확인 자료 · 배합 자료' },
  { id: 'product_3bbce42b94471540', key: 'feline', expected: /일부 원료표 확인/, scope: '한국 자료 · 확인한 포장 기준' },
  { id: 'product_072fbf975f493006', key: 'inaba', expected: /일부 원료표 확인/, scope: '한국 자료 · 제품 자료' },
]
const report = { base: BASE, sourceSha: process.env.CANDIDATE_SHA, realPublicData: true, blockedWrites: [], errors: [], requests: [], sources: {}, views: {} }
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' })
let activePage
const responseReads = []
try {
  for (const [width, height] of [[390, 844], [1440, 1000]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' })
    const page = await context.newPage()
    activePage = page
    page.on('pageerror', e => report.errors.push(String(e)))
    page.on('response', res => {
      if (!res.url().includes('/rest/v1/')) return
      const url = new URL(res.url())
      report.requests.push({ path: url.pathname, status: res.status() })
      if (url.pathname.endsWith('/compare_product_ingredients_scoped')) responseReads.push(res.json().then(rows => {
        for (const row of rows) report.sources[row.product_id] = row
      }).catch(() => {}))
    })
    await page.route('**/*', async route => {
      const req = route.request(), url = req.url()
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || /functions\/v1|analytics|telemetry|search-runs|considerations/.test(url)) {
        report.blockedWrites.push({ method: req.method(), url }); return route.abort()
      }
      if (url.startsWith(BASE) || url.startsWith('https://gnosbstdatkytsyxuapt.supabase.co/rest/v1/') || url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/') || req.resourceType() === 'image') return route.continue()
      return route.abort()
    })
    async function capture(key, selector) {
      await page.evaluate(() => document.fonts.ready)
      await page.locator(selector).first().waitFor()
      await page.locator(selector).first().evaluate(el => el.scrollIntoView({ block: 'start' }))
      await page.locator(selector).first().evaluate(async root => {
        await Promise.all([...root.querySelectorAll('img')].map(img => img.decode().catch(() => {})))
      })
      const geometry = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }))
      assert.ok(geometry.documentWidth <= width + 1, key + ': page overflow')
      report.views[width + '-' + key] = { geometry, text: (await page.locator(selector).first().innerText()).slice(0, 9000) }
      await page.screenshot({ path: `${OUT}/${width}-${key}.png`, fullPage: true })
    }
    for (const product of products) {
      await page.goto(`${BASE}?view=workspace&mode=lookup&detail=${product.id}&detailTab=ingredients`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('group', { name: '원료 정보 확인 범위' }).waitFor({ timeout: 45000 })
      assert.match(await page.locator('.ingredient-disclosure').innerText(), product.expected)
      assert.equal(await page.locator('.ingredient-disclosure .ingredient-source-scope strong').innerText(), product.scope)
      await capture(product.key + '-detail', '.detail-document')
      if (product.key === 'feline') {
        // A source heading explicitly naming chicken must not claim the species was omitted.
        assert.doesNotMatch(await page.locator('.ingredient-disclosure').innerText(), /세부 동물 종류 미표기/)
      }
    }
    await page.goto(`${BASE}?view=workspace&mode=lookup&q=${encodeURIComponent('로얄캐닌')}&selected=${products[0].id}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('group', { name: '원료 정보 확인 범위' }).waitFor({ timeout: 45000 })
    assert.match(await page.locator('.ingredient-disclosure').innerText(), /세부 어종 미표기/)
    assert.equal(await page.locator('.ingredient-disclosure .ingredient-source-scope strong').innerText(), products[0].scope)
    await capture('quick-view', '.ingredient-composition-inspector')
    await page.goto(`${BASE}?view=workspace&mode=lookup&compare=${products[0].id},${products[1].id}&compareOpen=1&compareTab=ingredients`, { waitUntil: 'domcontentloaded' })
    await page.getByText(/어유.*세부 어종 미표기/).filter({ visible: true }).first().waitFor({ timeout: 45000 })
    assert.ok((await page.locator('.compare-stage').innerText()).includes(products[0].scope))
    assert.ok((await page.locator('.compare-stage').innerText()).includes(products[1].scope))
    assert.equal(await page.locator('.comparison-highlights').count(), 0, 'ingredients uses the primary comparison')
    assert.match(await page.locator('.compare-stage').innerText(), /fish oil \(herring\)/i)
    assert.match(await page.locator('.compare-stage').innerText(), /청어를 명시한 오일/)
    await capture('compare', '.compare-stage')
    await page.getByRole('tab', { name: '개요', exact: true }).click()
    const highlights = page.locator('.comparison-highlights').filter({ visible: true })
    await highlights.getByRole('heading', { name: '핵심 차이 먼저 보기' }).waitFor()
    assert.match(await highlights.innerText(), /브랜드: 로얄캐닌 → Alleva/)
    assert.doesNotMatch(await highlights.innerText(), /사료 형태: 건식 → 건식/)
    await capture('compare-overview', '.compare-stage')
    if (width === 390) {
      await page.goto(`${BASE}?view=workspace&mode=lookup&compare=${products.slice(0, 3).map(product => product.id).join(',')}&compareOpen=1&compareTab=overview`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('combobox', { name: '표시 제품 1 선택' }).selectOption(products[2].id)
      assert.match(await highlights.locator('header').innerText(), /Feline Natural/)
      assert.doesNotMatch(await highlights.locator('header').innerText(), /로얄캐닌/)
      await capture('compare-pair-changed', '.compare-stage')
    }
    await context.close()
  }
  await Promise.all(responseReads)
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.blockedWrites, [])
} catch (error) {
  report.failure = String(error)
  if (activePage && !activePage.isClosed()) {
    report.failureText = await activePage.locator('body').innerText()
    await activePage.screenshot({ path: `${OUT}/failure.png`, fullPage: true })
  }
  throw error
} finally {
  await Promise.all(responseReads)
  await browser.close()
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2))
}
console.log(`Live public-data disclosure QA passed: ${Object.keys(report.views).length} views`)

