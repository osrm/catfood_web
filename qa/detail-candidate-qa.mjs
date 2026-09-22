import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const BASE = 'http://127.0.0.1:4173/'
const GO = 'product_31bc515d78d43d5d'
const MONGE = 'product_11dc2e0bf60b0874'

const PRODUCTS = [
  {
    product_id: MONGE, brand: '몬지', canonical_name: '몬지 비와일드 그레인프리 어덜트 연어', feed_type: '건식', life_stage: 'adult',
    display_image_url: 'https://gnosbstdatkytsyxuapt.supabase.co/storage/v1/object/public/product-images/products/product_11dc2e0bf60b0874.webp',
    representative_variant_id: 'variant_a7e54c1a2d10a1ba', representative_package_size_text: '1.5 kg', representative_package_weight_g: 1500,
    representative_units_per_sale: 1, representative_sale_total_weight_g: 1500, variant_count: 2, has_variants: true,
    ingredient_declaration_count: 2, full_ingredient_declaration_count: 1, has_ingredient_details: true, has_full_ingredient_declaration: true,
    nutrition_panel_count: 2, has_nutrition_details: true, manufacturing_observation_count: 1, has_manufacturing_details: true,
    manufacturing_country_codes: ['IT'], market_observation_count: 5, has_market_details: true,
    assessed_market_country_codes: ['AU','CA','IT','NZ','US'], current_market_country_codes: ['IT'], formula_match_market_country_codes: ['IT'],
    ingredient_term_result_count: 23, confirmed_present_ingredient_terms: ['chicken','salmon'], direct_evidence_ingredient_terms: ['chicken','salmon'],
    flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: ['anchovy','beef','boar','cod','duck','egg','goat','goose','herring','lamb','mackerel','menhaden','pork','quail','rabbit','sardine','trout','tuna','turkey','venison','whitefish'],
    official_targets: [], features: [], recipe_families: ['fish'], recipe_details: ['salmon'], official_recipe_traits: ['grain_free'],
  },
  {
    product_id: GO, brand: 'GO! SOLUTIONS', canonical_name: '카니보 치킨&칠면조&오리', feed_type: '건식', life_stage: 'all_life_stages',
    display_image_url: 'https://gnosbstdatkytsyxuapt.supabase.co/storage/v1/object/public/product-images/go-solutions/product_31bc515d78d43d5d.webp',
    representative_variant_id: 'variant_84846bb9f583a35b', representative_package_size_text: '1.36 kg', representative_package_weight_g: 1360,
    representative_units_per_sale: 1, representative_sale_total_weight_g: 1360, variant_count: 3, has_variants: true,
    ingredient_declaration_count: 2, full_ingredient_declaration_count: 1, has_ingredient_details: true, has_full_ingredient_declaration: true,
    nutrition_panel_count: 2, has_nutrition_details: true, manufacturing_observation_count: 1, has_manufacturing_details: true,
    manufacturing_country_codes: ['CA'], market_observation_count: 6, has_market_details: true,
    assessed_market_country_codes: ['AU','CA','FR','GB','NZ','US'], current_market_country_codes: ['CA','FR','NZ','US'], formula_match_market_country_codes: ['CA','FR','NZ','US'],
    ingredient_term_result_count: 23, confirmed_present_ingredient_terms: ['chicken','duck','egg','salmon','trout','turkey'],
    direct_evidence_ingredient_terms: ['chicken','duck','egg','salmon','trout','turkey'], flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: ['anchovy','beef','boar','cod','goat','goose','herring','lamb','mackerel','menhaden','pork','quail','rabbit','sardine','tuna','venison','whitefish'],
    insufficient_evidence_ingredient_terms: [], official_targets: [], features: [], recipe_families: ['poultry'], recipe_details: ['chicken','duck','turkey'], official_recipe_traits: ['grain_free'],
  },
]

const VARIANTS = [
  { product_id:MONGE, variant_id:'variant_a7e54c1a2d10a1ba', package_size_text:'1.5 kg', package_weight_g:1500, units_per_sale:1, sale_total_weight_g:1500, sales_bundle_status:'not_a_bundle', display_rank:1, variant_count:2, formula_evidence_status:'confirmed', recipe_families:['fish'], recipe_details:['salmon'], official_recipe_traits:['grain_free'], ingredient_term_result_count:23, confirmed_present_ingredient_terms:['chicken','salmon'], direct_evidence_ingredient_terms:['chicken','salmon'], flavor_associated_ingredient_terms:[], reviewed_not_found_ingredient_terms:[], insufficient_evidence_ingredient_terms:[] },
  { product_id:MONGE, variant_id:'variant_851777873ef16719', package_size_text:'10 kg', package_weight_g:10000, units_per_sale:1, sale_total_weight_g:10000, sales_bundle_status:'not_a_bundle', display_rank:2, variant_count:2, formula_evidence_status:'confirmed', recipe_families:['fish'], recipe_details:['salmon'], official_recipe_traits:['grain_free'], ingredient_term_result_count:23, confirmed_present_ingredient_terms:[], direct_evidence_ingredient_terms:[], flavor_associated_ingredient_terms:[], reviewed_not_found_ingredient_terms:[], insufficient_evidence_ingredient_terms:[] },
  { product_id:GO, variant_id:'variant_84846bb9f583a35b', package_size_text:'1.36 kg', package_weight_g:1360, units_per_sale:1, sale_total_weight_g:1360, sales_bundle_status:'not_a_bundle', display_rank:1, variant_count:3, formula_evidence_status:'confirmed', recipe_families:['poultry'], recipe_details:['chicken','duck','turkey'], official_recipe_traits:['grain_free'], ingredient_term_result_count:23, confirmed_present_ingredient_terms:['chicken','duck','egg','salmon','trout','turkey'], direct_evidence_ingredient_terms:['chicken','duck','egg','salmon','trout','turkey'], flavor_associated_ingredient_terms:[], reviewed_not_found_ingredient_terms:[], insufficient_evidence_ingredient_terms:[] },
  { product_id:GO, variant_id:'variant_ef17fc65c5430cca', package_size_text:'3.63 kg', package_weight_g:3630, units_per_sale:1, sale_total_weight_g:3630, sales_bundle_status:'not_a_bundle', display_rank:2, variant_count:3, formula_evidence_status:'confirmed', recipe_families:['poultry'], recipe_details:['chicken','duck','turkey'], official_recipe_traits:['grain_free'], ingredient_term_result_count:23, confirmed_present_ingredient_terms:['chicken','duck','egg','salmon','trout','turkey'], direct_evidence_ingredient_terms:['chicken','duck','egg','salmon','trout','turkey'], flavor_associated_ingredient_terms:[], reviewed_not_found_ingredient_terms:[], insufficient_evidence_ingredient_terms:[] },
  { product_id:GO, variant_id:'variant_90a3f62d58c8f704', package_size_text:'7.26 kg', package_weight_g:7260, units_per_sale:1, sale_total_weight_g:7260, sales_bundle_status:'not_a_bundle', display_rank:3, variant_count:3, formula_evidence_status:'confirmed', recipe_families:['poultry'], recipe_details:['chicken','duck','turkey'], official_recipe_traits:['grain_free'], ingredient_term_result_count:23, confirmed_present_ingredient_terms:['chicken','duck','egg','salmon','trout','turkey'], direct_evidence_ingredient_terms:['chicken','duck','egg','salmon','trout','turkey'], flavor_associated_ingredient_terms:[], reviewed_not_found_ingredient_terms:[], insufficient_evidence_ingredient_terms:[] },
]

const NUTRITION = [
  { product_id:MONGE, variant_id:null, observation_scope:'product', market_code:'KR', panel_type:'source_declaration', protein_pct:36, protein_qualifier:'min', fat_pct:10, fat_qualifier:'min', fiber_pct:3.5, fiber_qualifier:'max', moisture_pct:5.5, moisture_qualifier:'max', ash_pct:7.5, ash_qualifier:'max', kcal_per_kg:null, kcal_per_100g:null, energy_basis:null, is_korea_market_observation:true, is_current_resolved_formula:false, additional_nutrients:[{unit:'%',amount:1,raw_name:'Calcium',qualifier:'min',nutrient_key:'calcium'},{unit:'%',amount:0.9,raw_name:'Phosphorus',qualifier:'min',nutrient_key:'phosphorus'}], supplemental_nutrition_fields:[], supplemental_observation_scope:null, supplemental_market_code:null, supplemental_is_current_resolved_formula:false, basis_specific_nutrition_basis:null, basis_specific_nutrition_values:null },
  { product_id:GO, variant_id:null, observation_scope:'product', market_code:'KR', panel_type:'source_declaration', protein_pct:46, protein_qualifier:'min', fat_pct:18, fat_qualifier:'min', fiber_pct:1.5, fiber_qualifier:'max', moisture_pct:10, moisture_qualifier:'max', ash_pct:9, ash_qualifier:'max', kcal_per_kg:4298, kcal_per_100g:null, energy_basis:'direct_manufacturer', is_korea_market_observation:true, is_current_resolved_formula:false, additional_nutrients:[{unit:'%',amount:1.6,raw_name:'Calcium',qualifier:'min',nutrient_key:'calcium'},{unit:'%',amount:1.1,raw_name:'Phosphorus',qualifier:'min',nutrient_key:'phosphorus'}], supplemental_nutrition_fields:['energy'], supplemental_observation_scope:'formula', supplemental_market_code:null, supplemental_is_current_resolved_formula:true, basis_specific_nutrition_basis:null, basis_specific_nutrition_values:null },
]

const GO_INGREDIENTS = ['chicken meal','de-boned chicken','de-boned turkey','duck meal','turkey meal','salmon meal','de-boned trout','chicken fat (preserved with mixed tocopherols)','natural fish flavour','peas','potatoes','whole dried egg','potato flour','tapioca','de-boned salmon','de-boned duck','salmon oil','pumpkin','apples','carrots','bananas','blueberries','cranberries','lentils','broccoli','cottage cheese','suncured alfalfa','sweet potatoes','blackberries','squash','papayas','pomegranate','phosphoric acid','salt','potassium chloride','DL-methionine','taurine','choline chloride','dried chicory root','dried Lactobacillus acidophilus fermentation product','dried Enterococcus faecium fermentation product','dried Aspergillus oryzae fermentation extract','dried Bacillus subtilis fermentation extract','vitamins (vitamin E supplement, niacin, L-ascorbyl-2-polyphosphate (a source of vitamin C), thiamine mononitrate, biotin, vitamin A supplement, d-calcium pantothenate, beta-carotene, riboflavin, pyridoxine hydrochloride, vitamin B12 supplement, vitamin D3 supplement, folic acid)','minerals (zinc proteinate, ferrous sulphate, zinc oxide, iron proteinate, copper sulphate, sodium selenite, copper proteinate, manganese proteinate, manganous oxide, calcium iodate)','yucca schidigera extract','dried rosemary']
const INGREDIENTS = [
  { product_id:MONGE, variant_id:null, observation_scope:'product', market_code:'KR', declaration_scope:'trusted_specialty_retailer', completeness_status:'partial', raw_text:'수분을 제거한 연어 38%, 신선한 닭고기 15%, 천연 항산화제로 보존된 닭고기 오일 13%, 감자, 완두콩, 감자 단백질, 가수분해된 동물성 단백질(돼지), 사탕무우박, 천연 항산화제로 보존된 연어 오일, 맥주 효모, 완두 섬유, 미네랄, 만난올리고당, 스피룰리나 등', ingredient_names:[], ingredient_count:0, is_korea_market_observation:true, is_current_resolved_formula:false, supplemental_full_raw_text:null, supplemental_full_ingredient_names:[], supplemental_full_ingredient_count:0, supplemental_observation_scope:null, supplemental_market_code:null, supplemental_is_current_resolved_formula:false },
  { product_id:GO, variant_id:null, observation_scope:'formula', market_code:null, declaration_scope:null, completeness_status:'full', raw_text:GO_INGREDIENTS.join(', '), ingredient_names:GO_INGREDIENTS, ingredient_count:47, is_korea_market_observation:false, is_current_resolved_formula:true, supplemental_full_raw_text:null, supplemental_full_ingredient_names:[], supplemental_full_ingredient_count:0, supplemental_observation_scope:null, supplemental_market_code:null, supplemental_is_current_resolved_formula:false },
]

const MANUFACTURING = [
  { product_id:MONGE, observation_scope:'product', country_code:'IT', manufacturer:'Monge & C. S.p.A.', plant:'Via Savigliano 31, 12030 Monasterolo di Savigliano (CN), Italy', is_current_resolved_formula:false },
  { product_id:GO, observation_scope:'product', country_code:'CA', manufacturer:null, plant:null, is_current_resolved_formula:false },
]
const MARKETS = [
  [MONGE,'AU','distribution_not_confirmed','not_found',1],[MONGE,'CA','distribution_not_confirmed','not_found',2],[MONGE,'IT','current_product_confirmed','exact_same',3],[MONGE,'NZ','distribution_not_confirmed','not_found',4],[MONGE,'US','distribution_not_confirmed','not_found',5],
  [GO,'AU','distribution_not_confirmed','not_found',1],[GO,'CA','current_product_confirmed','same_formula_different_package',2],[GO,'FR','current_product_confirmed','same_formula_different_package',3],[GO,'GB','distribution_not_confirmed','not_found',4],[GO,'NZ','current_product_confirmed','same_formula_different_package',5],[GO,'US','current_product_confirmed','same_formula_different_package',6],
].map(([product_id,country_code,distribution_status,formula_correspondence_status,display_rank]) => ({ product_id,country_code,distribution_status,formula_correspondence_status,counterpart_name:null,assessed_at:'2026-08-25',display_rank }))
const outDir = 'qa-output'
await mkdir(outDir, { recursive: true })

const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] })
const report = {
  sourceSha: process.env.EXPECTED_SHA,
  blockedWrites: [],
  blockedAnalytics: [],
  liveApi: [],
  fixture: [],
  breakpoints: [],
  interactions: {},
  mockedStates: {},
  fonts: {},
}

const mode = {
  nutritionFirstFailure: false,
  ingredientEmpty: false,
  variantDelayMs: 0,
}
const requestCounts = new Map()

function resetMode() {
  mode.nutritionFirstFailure = false
  mode.ingredientEmpty = false
  mode.variantDelayMs = 0
  requestCounts.clear()
}

async function makePage(width, height, { mockApi = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.route('**/*', async (route) => {
    const request = route.request()
    const method = request.method()
    const url = request.url()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      report.blockedWrites.push({ method, url })
      await route.abort('blockedbyclient')
      return
    }
    if (/\/functions\/v1\/|analytics|telemetry|event_log/i.test(url)) {
      report.blockedAnalytics.push({ method, url })
      await route.abort('blockedbyclient')
      return
    }
    let pathname = ''
    try { pathname = new URL(url).pathname } catch {}
    const key = pathname.split('/').at(-1) || pathname
    const isRest = url.includes('/rest/v1/')
    if (!mockApi) {
      await route.continue()
      return
    }
    if (isRest && method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: '' })
      return
    }
    if (isRest) requestCounts.set(key, (requestCounts.get(key) || 0) + 1)

    if (mode.nutritionFirstFailure && key === 'compare_product_nutrition' && requestCounts.get(key) === 1) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'candidate mock failure' })
      return
    }
    if (mode.ingredientEmpty && key === 'compare_product_ingredients') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      return
    }

    if (isRest && ['GET', 'HEAD'].includes(method)) {
      const parsed = new URL(url)
      const filter = parsed.searchParams.get('product_id')
      const id = filter?.startsWith('eq.') ? filter.slice(3) : filter?.startsWith('in.(') ? filter.slice(4, -1).split(',')[0] : null
      let payload
      if (key === 'effective_product_catalog_summary') payload = PRODUCTS
      else if (key === 'switch_current_variant_options') payload = id ? VARIANTS.filter((row) => row.product_id === id) : VARIANTS
      else if (key === 'compare_product_nutrition') payload = NUTRITION.filter((row) => !id || row.product_id === id)
      else if (key === 'compare_product_ingredients') payload = INGREDIENTS.filter((row) => !id || row.product_id === id)
      else if (key === 'product_detail_manufacturing') payload = MANUFACTURING.filter((row) => !id || row.product_id === id)
      else if (key === 'product_detail_markets') payload = MARKETS.filter((row) => !id || row.product_id === id)
      else payload = []
      if (mode.variantDelayMs && key === 'switch_current_variant_options' && id && requestCounts.get(key) === 2) {
        await new Promise((resolve) => setTimeout(resolve, mode.variantDelayMs))
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
      return
    }

    await route.continue()
  })
  return page
}

function detailUrl(id, query, tab = 'overview') {
  const params = new URLSearchParams({
    view: 'workspace',
    mode: 'lookup',
    q: query,
    detail: id,
    detailTab: tab,
  })
  return BASE + '?' + params.toString()
}

async function waitDetail(page, { settled = true } = {}) {
  try {
    await page.waitForSelector('.detail-stage', { timeout: 12000 })
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      body: document.body.innerText.slice(0, 5000),
      html: document.body.innerHTML.slice(0, 5000),
    }))
    await writeFile(`${outDir}/detail-timeout.json`, JSON.stringify(diagnostic, null, 2))
    await page.screenshot({ path: `${outDir}/detail-timeout.png`, fullPage: false })
    throw new Error(`detail-stage did not open: ${JSON.stringify(diagnostic)}; ${error}`)
  }
  await page.waitForSelector('.detail-identity h1', { timeout: 10000 })
  if (settled) {
    await page.waitForFunction(() => ![...document.querySelectorAll('.detail-state')].some((node) => node.textContent?.includes('불러오는 중')), null, { timeout: 20000 })
  }
  await page.evaluate(() => document.fonts?.ready)
}

async function metrics(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.detail-stage')
    const layout = document.querySelector('.detail-layout')
    const title = document.querySelector('.detail-identity h1')
    const image = document.querySelector('.detail-product-image')
    const placeholder = document.querySelector('.detail-image-placeholder')
    const cs = title ? getComputedStyle(title) : null
    const layoutStyle = layout ? getComputedStyle(layout) : null
    return {
      title: title?.textContent?.trim() || null,
      titleLineClamp: cs?.webkitLineClamp || null,
      titleOverflow: cs?.overflow || null,
      stageClientWidth: stage?.clientWidth || 0,
      stageScrollWidth: stage?.scrollWidth || 0,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      horizontalOverflow: Boolean((stage && stage.scrollWidth > stage.clientWidth + 1) || document.documentElement.scrollWidth > innerWidth + 1),
      layoutDisplay: layoutStyle?.display || null,
      gridTemplateColumns: layoutStyle?.gridTemplateColumns || null,
      image: image ? { complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight } : null,
      placeholder: Boolean(placeholder),
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({ text: tab.textContent?.trim(), selected: tab.getAttribute('aria-selected') })),
    }
  })
}

async function captureAllTabs(id, query, productTag, width, height, { mockApi = true, bucket = 'fixture' } = {}) {
  resetMode()
  const page = await makePage(width, height, { mockApi })
  await page.goto(detailUrl(id, query), { waitUntil: 'commit', timeout: 20000 })
  await waitDetail(page)
  const initial = await metrics(page)
  assert.equal(initial.horizontalOverflow, false, `${productTag} ${width}: no horizontal overflow`)
  assert.ok(initial.title, `${productTag}: full product title is present`)
  assert.notEqual(initial.titleLineClamp, '1', `${productTag}: title is not line-clamped`)
  if (initial.image) assert.ok(initial.image.complete && initial.image.naturalWidth > 0, `${productTag}: product image loads`)
  else assert.equal(initial.placeholder, true, `${productTag}: missing image has explicit placeholder`)

  const tabs = [
    ['overview', '개요'],
    ['nutrition', '영양'],
    ['ingredients', '원재료'],
    ['context', '제조 · 유통'],
  ]
  const panels = {}
  for (const [key] of tabs) {
    await page.click(`#detail-tab-${key}`)
    await page.waitForFunction((tabKey) => document.querySelector(`#detail-tab-${tabKey}`)?.getAttribute('aria-selected') === 'true', key)
    await page.waitForFunction(() => ![...document.querySelectorAll('.detail-state')].some((node) => node.textContent?.includes('불러오는 중')), null, { timeout: 20000 })
    const alignment = await page.evaluate(() => {
      const heading = document.querySelector('.detail-section-heading')
      const tabsEl = document.querySelector('.detail-tabs')
      if (!heading || !tabsEl) return null
      const h = heading.getBoundingClientRect()
      const t = tabsEl.getBoundingClientRect()
      return { headingTop: h.top, tabsBottom: t.bottom, ok: h.top >= t.bottom - 3 }
    })
    assert.ok(alignment?.ok, `${productTag} ${width} ${key}: switched heading is not hidden by sticky tabs`)
    panels[key] = (await page.locator('.detail-body').innerText()).slice(0, 1800)
    await page.screenshot({ path: `${outDir}/${bucket}-${productTag}-${key}-${width}.png`, fullPage: false })
  }
  const after = await metrics(page)
  report[bucket].push({ product: productTag, id, width, height, initial, after, panels })
  await page.close()
}

for (const product of [
  { id: GO, query: 'GO!', tag: 'go' },
  { id: MONGE, query: '몬지', tag: 'monge' },
]) {
  await captureAllTabs(product.id, product.query, product.tag, 390, 844, { mockApi: false, bucket: 'liveApi' })
  await captureAllTabs(product.id, product.query, product.tag, 1440, 1000, { mockApi: false, bucket: 'liveApi' })
}
await captureAllTabs(MONGE, '몬지', 'monge', 360, 800, { mockApi: false, bucket: 'liveApi' })

for (const width of [360, 768, 959, 961, 1024]) {
  resetMode()
  const page = await makePage(width, width === 360 ? 800 : 900)
  await page.goto(detailUrl(GO, 'GO!'), { waitUntil: 'commit', timeout: 20000 })
  await waitDetail(page)
  const result = await metrics(page)
  assert.equal(result.horizontalOverflow, false, `GO ${width}: no horizontal overflow`)
  if (width <= 960) assert.equal(result.layoutDisplay, 'block', `GO ${width}: one-column layout`)
  if (width > 960) assert.equal(result.layoutDisplay, 'grid', `GO ${width}: two-column layout`)
  report.breakpoints.push({ width, ...result })
  await page.screenshot({ path: `${outDir}/go-overview-${width}.png`, fullPage: false })
  await page.close()
}

resetMode()
{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(GO, 'GO!'), { waitUntil: 'commit', timeout: 20000 })
  await waitDetail(page)

  await page.focus('#detail-tab-overview')
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-tab-nutrition')
  assert.equal(await page.getAttribute('#detail-tab-nutrition', 'aria-selected'), 'true')
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-tab-context')
  await page.keyboard.press('Home')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-tab-overview')

  await page.click('#detail-tab-ingredients')
  await page.evaluate(() => {
    const stage = document.querySelector('.detail-stage')
    if (stage) stage.scrollTop = Math.min(320, Math.max(0, stage.scrollHeight - stage.clientHeight))
  })
  const before = await page.evaluate(() => document.querySelector('.detail-stage')?.scrollTop || 0)
  await page.click('#detail-tab-ingredients')
  const sameTab = await page.evaluate(() => document.querySelector('.detail-stage')?.scrollTop || 0)
  assert.ok(Math.abs(sameTab - before) <= 2, 'reselecting the current tab preserves the reading position')

  await page.click('#detail-tab-nutrition')
  const aligned = await page.evaluate(() => {
    const heading = document.querySelector('.detail-section-heading')
    const tabs = document.querySelector('.detail-tabs')
    const topbar = document.querySelector('.detail-topbar')
    if (!heading || !tabs || !topbar) return null
    const h = heading.getBoundingClientRect()
    const t = tabs.getBoundingClientRect()
    return { ok: h.top >= t.bottom - 3, headingTop: h.top, tabsBottom: t.bottom }
  })
  assert.ok(aligned?.ok, 'explicit tab change positions the new heading below sticky navigation')

  await page.evaluate(() => { const stage = document.querySelector('.detail-stage'); if (stage) stage.scrollTop = 500 })
  const sticky = await page.evaluate(() => {
    const topbar = document.querySelector('.detail-topbar')?.getBoundingClientRect()
    const tabs = document.querySelector('.detail-tabs')?.getBoundingClientRect()
    return { topbarTop: topbar?.top, tabsTop: tabs?.top }
  })
  assert.ok(Math.abs(sticky.topbarTop || 0) <= 1, 'topbar stays sticky in the actual detail scroller')
  assert.ok(Math.abs((sticky.tabsTop || 0) - 56) <= 2, 'mobile tabs stay below the sticky topbar')

  await page.click('.detail-topbar button')
  await page.waitForFunction(() => !document.querySelector('.detail-stage') && document.querySelector('.research-results'))
  report.interactions = { keyboard: true, sameTabScroll: { before, after: sameTab }, aligned, sticky, parentReturn: true }
  await page.close()
}

resetMode()
mode.nutritionFirstFailure = true
{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(GO, 'GO!', 'nutrition'), { waitUntil: 'commit', timeout: 20000 })
  await page.waitForSelector('.detail-stage')
  await page.waitForSelector('.detail-state.is-error', { timeout: 20000 })
  const errorText = await page.locator('.detail-state.is-error').innerText()
  assert.match(errorText, /영양 정보를 불러오지 못했습니다/)
  assert.match(errorText, /다시 시도/)
  assert.doesNotMatch(await page.locator('.detail-body').innerText(), /확인된 영양 정보가 없습니다/)
  const beforeRetry = Object.fromEntries(requestCounts)
  await page.click('.detail-state.is-error button')
  await page.waitForFunction(() => !document.querySelector('.detail-state.is-error') && ![...document.querySelectorAll('.detail-state')].some((node) => node.textContent?.includes('불러오는 중')), null, { timeout: 20000 })
  const afterRetry = Object.fromEntries(requestCounts)
  for (const key of ['switch_current_variant_options','compare_product_nutrition','compare_product_ingredients','product_detail_manufacturing','product_detail_markets']) {
    assert.ok((afterRetry[key] || 0) >= (beforeRetry[key] || 0) + 1, `retry reloads ${key}`)
  }
  report.mockedStates.error = { errorText, beforeRetry, afterRetry }
  await page.screenshot({ path: `${outDir}/mock-error-recovered-390.png`, fullPage: false })
  await page.close()
}

resetMode()
mode.ingredientEmpty = true
{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(MONGE, '몬지', 'ingredients'), { waitUntil: 'commit', timeout: 20000 })
  await waitDetail(page)
  const text = await page.locator('.detail-body').innerText()
  assert.match(text, /확인된 원재료 정보가 없습니다/)
  assert.equal(await page.locator('.detail-state.is-error').count(), 0)
  report.mockedStates.empty = { text: text.slice(0, 800), hasRetry: false }
  await page.screenshot({ path: `${outDir}/mock-empty-ingredients-390.png`, fullPage: false })
  await page.close()
}

resetMode()
mode.variantDelayMs = 1200
{
  const page = await makePage(390, 844)
  const nav = page.goto(detailUrl(GO, 'GO!', 'overview'), { waitUntil: 'commit', timeout: 20000 })
  await page.waitForSelector('.detail-stage', { timeout: 20000 })
  await page.waitForFunction(() => document.body.textContent?.includes('판매 규격을 불러오는 중입니다.'), null, { timeout: 5000 })
  const loadingText = await page.locator('.detail-body').innerText()
  assert.match(loadingText, /판매 규격을 불러오는 중입니다/)
  await nav
  await waitDetail(page)
  const settledText = await page.locator('.detail-body').innerText()
  assert.doesNotMatch(settledText, /판매 규격을 불러오는 중입니다/)
  report.mockedStates.delay = { loadingSeen: true, settled: true }
  await page.close()
}

{
  const page = await makePage(390, 844)
  await page.goto(detailUrl(MONGE, '몬지', 'ingredients'), { waitUntil: 'commit', timeout: 20000 })
  await waitDetail(page)
  const raw = await page.evaluate(() => {
    const el = document.querySelector('.detail-ingredient-copy')
    const stage = document.querySelector('.detail-stage')
    return {
      rawPresent: Boolean(el),
      rawScrollWidth: el?.scrollWidth || 0,
      rawClientWidth: el?.clientWidth || 0,
      stageScrollWidth: stage?.scrollWidth || 0,
      stageClientWidth: stage?.clientWidth || 0,
    }
  })
  assert.ok(!raw.rawPresent || raw.rawScrollWidth <= raw.rawClientWidth + 1, 'long source text wraps at mobile width')
  assert.ok(raw.stageScrollWidth <= raw.stageClientWidth + 1, 'ingredient view has no horizontal overflow')
  report.interactions.mobileRaw = raw
  report.fonts = await page.evaluate(async () => {
    await document.fonts.ready
    return {
      serif: document.fonts.check('16px "Noto Serif KR"'),
      sans: document.fonts.check('16px "Noto Sans KR"'),
    }
  })
  await page.close()
}

assert.equal(report.blockedWrites.length, 0, 'candidate attempted no POST/PUT/PATCH/DELETE requests with decision intake disabled')
await writeFile(`${outDir}/report.json`, JSON.stringify(report, null, 2))
console.log('CATFOOD_DETAIL_QA_REPORT=' + JSON.stringify(report))
await browser.close()
