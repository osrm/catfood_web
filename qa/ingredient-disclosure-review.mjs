import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core')

const BASE = process.env.CANDIDATE_URL || 'http://127.0.0.1:4173/'
const OUT = process.env.OUT_DIR || 'ingredient-disclosure-output'
await mkdir(OUT, { recursive: true })
const report = { sourceSha: process.env.CANDIDATE_SHA, fixtureOnly: true, blockedWrites: [], errors: [], views: {} }

// Synthetic source text only: no production facts or product assertions are changed.
function product(id, name, full) {
  return { product_id: id, brand: '표기 확인 예시', canonical_name: name, feed_type: '건식', life_stage: 'adult',
    display_image_url: null, representative_variant_id: null, representative_package_size_text: '1 kg',
    representative_package_weight_g: 1000, variant_count: 0, has_variants: false,
    ingredient_declaration_count: 1, full_ingredient_declaration_count: full ? 1 : 0,
    has_ingredient_details: true, has_full_ingredient_declaration: full,
    nutrition_panel_count: 0, has_nutrition_details: false, manufacturing_observation_count: 0,
    has_manufacturing_details: false, manufacturing_country_codes: [], market_observation_count: 0,
    has_market_details: false, assessed_market_country_codes: [], current_market_country_codes: [],
    formula_match_market_country_codes: [], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: ['chicken'], direct_evidence_ingredient_terms: ['chicken'],
    flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: ['salmon'], official_targets: [], features: [],
    recipe_families: [], recipe_details: [], official_recipe_traits: [] }
}
const full = product('product_1111111111111111', '전체 원료표와 어유의 세부 표기를 확인하는 예시', true)
const partial = product('product_2222222222222222', '일부 원료표와 해외 자료의 적용 범위를 확인하는 예시', false)
const specified = product('product_3333333333333333', '세부 어종이 기재된 원료표 예시', true)
const products = [full, partial, specified]
const sources = products.map((p, i) => ({ product_id: p.product_id, variant_id: null, observation_scope: 'product',
  market_code: i === 1 ? 'JP' : 'KR', declaration_scope: 'product', completeness_status: i === 1 ? 'partial' : 'full',
  raw_text: i === 2 ? '닭고기, 어유(정어리, 멸치), 쌀, 비타민' : '닭고기, 어유, 천연향료, 쌀',
  ingredient_names: i === 2 ? ['닭고기', '어유(정어리, 멸치)', '쌀', '비타민'] : ['닭고기', '어유', '천연향료', '쌀'],
  ingredient_count: 4, is_korea_market_observation: i !== 1, is_current_resolved_formula: false }))
function selectedRows(url, rows) {
  const filter = url.searchParams.get('p_product_ids') || url.searchParams.get('product_id')
  return filter ? rows.filter(row => filter.includes(row.product_id)) : rows
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' })
let activePage
try {
  for (const [width, height] of [[390, 844], [820, 1000], [1440, 1000]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' })
    const page = await context.newPage()
    activePage = page
    page.on('pageerror', error => report.errors.push(String(error)))
    const reads = []
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url())
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || /functions\/v1|analytics|telemetry|search-runs|considerations/.test(url.pathname)) {
        report.blockedWrites.push({ method: req.method(), url: req.url() }); return route.abort()
      }
      if (url.hostname.endsWith('.supabase.co') || url.origin === 'https://api.test') {
        const endpoint = url.pathname.split('/').at(-1)
        reads.push(endpoint)
        const body = endpoint === 'effective_product_catalog_summary' ? selectedRows(url, products)
          : endpoint === 'compare_product_ingredients_scoped' ? selectedRows(url, sources) : []
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      }
      if (req.url().startsWith(BASE) || req.url().startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/')) return route.continue()
      return route.abort()
    })
    async function capture(name, selector) {
      await page.evaluate(() => document.fonts.ready)
      const target = page.locator(selector).first()
      await target.waitFor({ state: 'visible' })
      const geometry = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }))
      assert.ok(geometry.documentWidth <= width + 1, name + ': document overflow')
      const overflow = await page.locator('.ingredient-disclosure, .ingredient-disclosure-example').evaluateAll(nodes => nodes
        .filter(node => node.getClientRects().length).map(node => node.scrollWidth - node.clientWidth))
      assert.ok(overflow.every(value => value <= 1), name + ': wording overflow')
      report.views[width + '-' + name] = { geometry, text: (await target.innerText()).slice(0, 4500) }
      await page.screenshot({ path: `${OUT}/${width}-${name}.png`, fullPage: true })
    }
    await page.goto(`${BASE}?view=workspace&mode=lookup&q=${encodeURIComponent('표기 확인 예시')}&selected=${partial.product_id}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('group', { name: '원료 정보 확인 범위' }).waitFor()
    const quickText = await page.getByRole('group', { name: '원료 정보 확인 범위' }).innerText()
    assert.match(quickText, /일부 원료표 확인/)
    assert.match(quickText, /어유[\s\S]*세부 어종 미표기/)
    await page.getByText(/한국 판매 제품과 같은 배합인지 미확인/).filter({ visible: true }).first().waitFor()
    assert.equal(reads.filter(name => name === 'compare_product_ingredients_scoped').length, 1)
    await capture('quick-view', '.ingredient-composition-inspector')

    await page.goto(`${BASE}?view=workspace&mode=lookup&detail=${partial.product_id}&detailTab=ingredients`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('group', { name: '원료 정보 확인 범위' }).waitFor()
    assert.match(await page.locator('.detail-document').innerText(), /일부 원료표 확인[\s\S]*세부 어종 미표기/)
    await capture('partial-detail', '.detail-document')

    await page.goto(`${BASE}?view=workspace&mode=lookup&detail=${full.product_id}&detailTab=ingredients`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('group', { name: '원료 정보 확인 범위' }).waitFor()
    assert.match(await page.locator('.ingredient-disclosure').innerText(), /전체 원료표 확인[\s\S]*세부 어종 미표기/)
    await capture('full-detail', '.detail-document')

    await page.goto(`${BASE}?view=workspace&mode=lookup&detail=${specified.product_id}&detailTab=ingredients`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('group', { name: '원료 정보 확인 범위' }).waitFor()
    assert.equal(await page.locator('.ingredient-disclosure-example').count(), 1)
    assert.match(await page.locator('.ingredient-disclosure-example').innerText(), /어유\(정어리, 멸치\)/)
    assert.doesNotMatch(await page.locator('.ingredient-disclosure').innerText(), /세부 어종 미표기/)
    await capture('specified-detail', '.detail-document')

    await page.goto(`${BASE}?view=workspace&mode=lookup&compare=${full.product_id},${partial.product_id}&compareOpen=1&compareTab=ingredients`, { waitUntil: 'domcontentloaded' })
    await page.getByText(/일부 원료표 확인.*어유/).filter({ visible: true }).first().waitFor()
    assert.match(await page.locator('.compare-stage').innerText(), /전체 원료표 확인/)
    await capture('compare', '.compare-stage')
    await context.close()
  }
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
  await browser.close()
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2))
}
console.log(`Ingredient disclosure browser QA passed: ${Object.keys(report.views).length} views`)
