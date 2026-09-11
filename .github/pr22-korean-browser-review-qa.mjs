import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/'
const API_PORT = 4174
const SOURCE_SHA = process.env.SOURCE_SHA ?? 'unknown'
const OUT = 'qa-artifacts'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function product(id, name, overrides = {}) {
  return {
    product_id: id,
    brand: 'Test Brand',
    canonical_name: name,
    feed_type: '건식',
    life_stage: 'adult',
    display_image_url: null,
    representative_variant_id: null,
    representative_package_size_text: null,
    representative_package_weight_g: null,
    representative_units_per_sale: null,
    representative_sale_total_weight_g: null,
    variant_count: 0,
    has_variants: false,
    ingredient_declaration_count: 0,
    full_ingredient_declaration_count: 0,
    has_ingredient_details: false,
    has_full_ingredient_declaration: false,
    nutrition_panel_count: 0,
    has_nutrition_details: false,
    manufacturing_observation_count: 0,
    has_manufacturing_details: false,
    manufacturing_country_codes: [],
    market_observation_count: 0,
    has_market_details: false,
    assessed_market_country_codes: [],
    current_market_country_codes: [],
    formula_match_market_country_codes: [],
    ingredient_term_result_count: 0,
    confirmed_present_ingredient_terms: [],
    direct_evidence_ingredient_terms: [],
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
    official_targets: [],
    features: [],
    recipe_families: [],
    recipe_details: [],
    official_recipe_traits: [],
    ...overrides,
  }
}

function variant(productId, variantId, size, rank = 1) {
  return {
    product_id: productId,
    variant_id: variantId,
    package_size_text: size,
    package_weight_g: size === '1 kg' ? 1000 : size === '2 kg' ? 2000 : 85,
    units_per_sale: 1,
    sale_total_weight_g: size === '1 kg' ? 1000 : size === '2 kg' ? 2000 : 85,
    sales_bundle_status: null,
    display_rank: rank,
    variant_count: 2,
    formula_evidence_status: 'confirmed',
    recipe_families: ['poultry'],
    recipe_details: ['chicken'],
    official_recipe_traits: [],
    ingredient_term_result_count: 1,
    confirmed_present_ingredient_terms: ['chicken'],
    direct_evidence_ingredient_terms: ['chicken'],
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: [],
  }
}

const current = product('product_qa_current', '현재 건식 사료', {
  brand: '현재브랜드', feed_type: '건식', life_stage: 'adult', variant_count: 2, has_variants: true,
  official_targets: ['indoor'], features: ['digestive'], recipe_families: ['poultry'], recipe_details: ['chicken'],
  confirmed_present_ingredient_terms: ['chicken'], direct_evidence_ingredient_terms: ['chicken'],
})
const single = product('product_qa_single', '단일 규격 건식', {
  brand: '단일브랜드', feed_type: '건식', life_stage: 'adult', variant_count: 1, has_variants: true,
  official_targets: ['indoor'], recipe_families: ['poultry'], recipe_details: ['chicken'],
  confirmed_present_ingredient_terms: ['chicken'], direct_evidence_ingredient_terms: ['chicken'],
})
const candidateA = product('product_qa_candidate_a', '전환 습식 A', {
  brand: '새브랜드A', feed_type: '습식', life_stage: 'adult', variant_count: 1, has_variants: true,
  official_targets: ['indoor'], features: ['digestive'], recipe_families: ['fish'], recipe_details: ['salmon'],
  reviewed_not_found_ingredient_terms: ['chicken'],
})
const candidateB = product('product_qa_candidate_b', '전환 습식 B', {
  brand: '새브랜드B', feed_type: '습식', life_stage: 'adult', variant_count: 1, has_variants: true,
  official_targets: ['indoor'], features: ['digestive'], recipe_families: ['fish'], recipe_details: ['tuna'],
  reviewed_not_found_ingredient_terms: ['chicken'],
})
const blockedDry = product('product_qa_blocked_dry', '제외될 건식 후보', {
  brand: '새브랜드C', feed_type: '건식', life_stage: 'adult', official_targets: ['indoor'],
  features: ['digestive'], recipe_families: ['fish'], reviewed_not_found_ingredient_terms: ['chicken'],
})
const products = [current, single, candidateA, candidateB, blockedDry]
const variantsByProduct = new Map([
  [current.product_id, [variant(current.product_id, 'variant_current_1', '1 kg', 1), variant(current.product_id, 'variant_current_2', '2 kg', 2)]],
  [single.product_id, [variant(single.product_id, 'variant_single_1', '1 kg', 1)]],
  [candidateA.product_id, [variant(candidateA.product_id, 'variant_candidate_a', '85 g', 1)]],
  [candidateB.product_id, [variant(candidateB.product_id, 'variant_candidate_b', '85 g', 1)]],
])

let writeRequests = 0
let variantFailuresRemaining = 0
const apiServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'apikey,accept-profile,content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
  if (req.method !== 'GET') { writeRequests += 1; res.statusCode = 405; res.end('writes disabled'); return }
  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (url.pathname.endsWith('/effective_product_catalog_summary')) { res.end(JSON.stringify(products)); return }
  if (url.pathname.endsWith('/switch_current_variant_options')) {
    const filter = url.searchParams.get('product_id')
    if (filter?.startsWith('eq.')) {
      const productId = filter.slice(3)
      if (variantFailuresRemaining > 0 && productId === current.product_id) {
        variantFailuresRemaining -= 1
        res.statusCode = 503
        res.end(JSON.stringify({ error: 'temporary variant failure' }))
        return
      }
      res.end(JSON.stringify(variantsByProduct.get(productId) ?? [])); return
    }
    const rows = [...variantsByProduct.values()].flat().map((row) => ({
      product_id: row.product_id,
      variant_id: row.variant_id,
      package_size_text: row.package_size_text,
      package_weight_g: row.package_weight_g,
      units_per_sale: row.units_per_sale,
      sale_total_weight_g: row.sale_total_weight_g,
      display_rank: row.display_rank,
    }))
    res.end(JSON.stringify(rows)); return
  }
  res.end('[]')
})
await new Promise((resolve) => apiServer.listen(API_PORT, '127.0.0.1', resolve))

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map() }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('DOM.enable'); await this.send('CSS.enable')
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, ms = 30000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(80)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, 'document ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'root content')
    await this.eval('document.fonts?.ready'); await sleep(180)
  }
  async reload() {
    await this.send('Page.reload', { ignoreCache: true })
    await this.wait(`document.readyState === 'complete'`, 'reload ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'reload root')
    await this.eval('document.fonts?.ready'); await sleep(180)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready'); await sleep(100)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }
  async platformFonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId, `missing node for font check: ${selector}`)
    const result = await this.send('CSS.getPlatformFontsForNode', { nodeId })
    return result.fonts ?? []
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const bin = '/usr/bin/google-chrome'
  assert.ok(existsSync(bin), 'hosted runner Chrome unavailable')
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
  const port = 9990 + (process.pid % 8)
  const dir = `/tmp/pr22-switch-review-qa-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) { const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect(); return { cdp, version, proc, dir } }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

const js = (value) => JSON.stringify(value)
async function clickExact(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${js(text)}); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing exact button: ${text}`); await sleep(100)
}
async function clickContains(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing button containing: ${text}`); await sleep(100)
}
async function clickSelectorContaining(cdp, selector, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll(${js(selector)})].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing ${selector} containing: ${text}`); await sleep(100)
}
async function setInput(cdp, selector, value) {
  const ok = await cdp.eval(`(() => { const n=document.querySelector(${js(selector)}); if(!n)return false; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(n,${js(value)}); n.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(ok, true, `missing input ${selector}`); await sleep(120)
}
async function historyBack(cdp, expression, label) {
  await cdp.eval('history.back()')
  await cdp.wait(expression, label)
  await sleep(100)
}
async function historyForward(cdp, expression, label) {
  await cdp.eval('history.forward()')
  await cdp.wait(expression, label)
  await sleep(100)
}

async function chooseCurrent(cdp, name) {
  await setInput(cdp, '.switch-find-search input', name)
  await cdp.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes(${js(name)}))`, `search ${name}`)
  await clickSelectorContaining(cdp, '.switch-find-result', name)
  await clickContains(cdp, '이 제품을 현재 사료로 선택')
  await cdp.wait(`document.body.innerText.includes('현재 먹이는 규격을 골라주세요')`, 'SKU step')
}

async function desktopFlow(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.nav(`${BASE}?view=workspace&mode=switch`)
  await cdp.wait(`document.body.innerText.includes('데이터 연결됨')`, 'desktop catalog connected')
  await chooseCurrent(cdp, current.canonical_name)
  await clickSelectorContaining(cdp, '.switch-sku-option', '1 kg')
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'desktop change')
  await clickExact(cdp, '습식')
  const ingredientClicked = await cdp.eval(`(() => { const n=document.querySelector('.switch-current-ingredients button'); if(!n)return false; n.click(); return true })()`)
  assert.equal(ingredientClicked, true, 'current ingredient avoid control missing')
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'desktop keep')
  await clickExact(cdp, '실내묘')
  await clickContains(cdp, '후보 제품 보기')
  await cdp.wait(`document.querySelector('.switch-results-stage')`, 'desktop results')
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-desktop-results.png`)
  const initialSummary = await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent ?? ''`)
  assert.match(initialSummary, /CHANGE.*습식.*피함 · 닭/s)
  assert.match(initialSummary, /KEEP.*실내묘/s)

  await clickExact(cdp, '조건 수정')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'restored results to change')
  await clickExact(cdp, '← 사용 규격')
  await cdp.wait(`document.body.innerText.includes('현재 먹이는 규격을 골라주세요')`, 'explicit SKU destination')
  assert.equal(await cdp.eval(`Boolean(document.querySelector('.switch-results-stage'))`), false, 'explicit SKU back returned to results')
  const selectedSku = await cdp.eval(`document.querySelector('.switch-sku-option.is-selected')?.textContent ?? ''`)
  assert.match(selectedSku, /1 kg/)
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-desktop-explicit-sku-back.png`)

  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'SKU to change again')
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'CHANGE to KEEP again')
  await clickExact(cdp, '← 바꿀 것 수정')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'explicit change destination')
  assert.equal(await cdp.eval(`Boolean(document.querySelector('.switch-results-stage'))`), false, 'explicit CHANGE back returned to results')
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-desktop-explicit-change-back.png`)
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'change to keep for results')
  await clickContains(cdp, '후보 제품 보기')
  await cdp.wait(`document.querySelector('.switch-results-stage')`, 'results after explicit destination checks')

  await clickExact(cdp, '제품 찾기')
  await cdp.wait(`document.querySelector('.lookup-input')`, 'lookup roundtrip')
  await clickExact(cdp, '현재 사료')
  await cdp.wait(`document.querySelector('.switch-results-stage')`, 'switch roundtrip results')
  const roundtripSummary = await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent ?? ''`)
  assert.equal(roundtripSummary, initialSummary, 'mode roundtrip changed SWITCH summary')

  await clickSelectorContaining(cdp, '.switch-candidate-row', candidateA.canonical_name)
  await clickContains(cdp, '상세 보기')
  await cdp.wait(`document.querySelector('.detail-stage')`, 'candidate detail')
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-desktop-detail.png`)
  await historyBack(cdp, `document.querySelector('.switch-candidate-inspector') && !document.querySelector('.detail-stage')`, 'candidate detail back')
  await historyForward(cdp, `document.querySelector('.detail-stage')`, 'candidate detail forward')
  await historyBack(cdp, `document.querySelector('.switch-candidate-inspector')`, 'candidate detail back second')

  await clickContains(cdp, '비교에 추가')
  await clickSelectorContaining(cdp, '.switch-candidate-row', candidateB.canonical_name)
  await clickContains(cdp, '비교에 추가')
  await clickContains(cdp, '비교 보기')
  await cdp.wait(`document.querySelector('.compare-stage')`, 'compare open')
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-desktop-compare.png`)
  const compareBefore = await cdp.eval(`document.querySelector('.compare-stage')?.textContent ?? ''`)
  assert.match(compareBefore, /전환 습식 A/); assert.match(compareBefore, /전환 습식 B/)

  const detailOpened = await cdp.eval(`(() => { const h=[...document.querySelectorAll('.compare-product-head')].find(n=>n.textContent.includes(${js(candidateB.canonical_name)})); const b=h?.querySelector('.compare-detail-link'); if(!b)return false; b.click(); return true })()`)
  assert.equal(detailOpened, true, 'compare detail link missing')
  await cdp.wait(`document.querySelector('.detail-stage')`, 'compare detail')
  await historyBack(cdp, `document.querySelector('.compare-stage') && !document.querySelector('.detail-stage')`, 'compare detail back')

  const removed = await cdp.eval(`(() => { const n=document.querySelector(${js(`button[aria-label="${candidateA.canonical_name} 비교에서 제거"]`)}); if(!n)return false; n.click(); return true })()`)
  assert.equal(removed, true, 'compare removal missing')
  await historyBack(cdp, `document.querySelector('.switch-results-stage') && !document.querySelector('.compare-stage')`, 'compare browser back')
  const dock = await cdp.eval(`document.querySelector('.switch-compare-dock')?.textContent ?? ''`)
  assert.doesNotMatch(dock, /전환 습식 A/)
  assert.match(dock, /전환 습식 B/)
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-desktop-compare-removal-back.png`)

  const fonts = await cdp.platformFonts('.switch-session-bar')
  assert.ok(fonts.some((font) => /Noto Sans CJK KR/i.test(font.familyName) && font.glyphCount > 0), `desktop Korean text did not use Noto CJK KR: ${JSON.stringify(fonts)}`)
  return { initialSummary, roundtripSummary, dock, fonts }
}

async function variantFailureFlow(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  const empty = { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false }
  const snapshot = {
    version: 1,
    state: {
      query: '현재',
      currentProductId: current.product_id,
      variantSelection: { kind: 'variant', variantId: 'variant_current_1' },
      change: { ...empty, feedType: '습식' },
      keep: { ...empty, officialTargets: ['indoor'] },
      changeBrand: false,
      keepBrand: false,
      ingredientAvoidTerms: ['chicken'],
      noChangeIntent: false,
      step: 'results',
      visibleCandidateCount: 40,
      selectedCandidateId: null,
      compareIds: [candidateA.product_id],
      compareOpen: false,
      compareTab: 'overview',
      detailProductId: null,
      detailTab: 'overview',
    },
  }
  variantFailuresRemaining = 1
  await cdp.eval(`sessionStorage.setItem('catfood.switch-session.v1', ${js(JSON.stringify(snapshot))}); history.replaceState(null,'',${js(`${BASE}?view=workspace&mode=switch`)})`)
  await cdp.reload()
  await cdp.wait(`document.body.innerText.includes('데이터 연결됨')`, 'variant failure catalog connected')
  await cdp.wait(`document.querySelector('.switch-variant-status[role="alert"]')`, 'restored variant failure alert')
  const failureSummary = await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent ?? ''`)
  assert.match(failureSummary, /선택한 규격 확인 실패/)
  assert.doesNotMatch(failureSummary, /사용 규격 모름/)
  const storedFailure = JSON.parse(await cdp.eval(`sessionStorage.getItem('catfood.switch-session.v1')`))
  assert.equal(storedFailure.state.variantSelection.kind, 'variant')
  assert.equal(storedFailure.state.variantSelection.variantId, 'variant_current_1')
  assert.equal(storedFailure.state.change.feedType, '습식')
  assert.deepEqual(storedFailure.state.keep.officialTargets, ['indoor'])
  assert.deepEqual(storedFailure.state.ingredientAvoidTerms, ['chicken'])
  assert.deepEqual(storedFailure.state.compareIds, [candidateA.product_id])
  assert.match(await cdp.eval(`document.querySelector('.switch-compare-dock')?.textContent ?? ''`), /전환 습식 A/)
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-desktop-variant-failure.png`)
  const fonts = await cdp.platformFonts('.switch-variant-status')
  assert.ok(fonts.some((font) => /Noto Sans CJK KR/i.test(font.familyName) && font.glyphCount > 0), `variant failure Korean text did not use Noto CJK KR: ${JSON.stringify(fonts)}`)

  await clickSelectorContaining(cdp, '.switch-variant-status button', '다시 시도')
  await cdp.wait(`(document.querySelector('.switch-session-bar')?.textContent ?? '').includes('1 kg') && !document.querySelector('.switch-variant-status[role="alert"]')`, 'variant retry success')
  const successSummary = await cdp.eval(`document.querySelector('.switch-session-bar')?.textContent ?? ''`)
  assert.match(successSummary, /1 kg/)
  assert.doesNotMatch(successSummary, /사용 규격 모름|선택한 규격 확인 실패/)
  const storedSuccess = JSON.parse(await cdp.eval(`sessionStorage.getItem('catfood.switch-session.v1')`))
  assert.equal(storedSuccess.state.variantSelection.variantId, 'variant_current_1')
  assert.equal(storedSuccess.state.change.feedType, '습식')
  assert.deepEqual(storedSuccess.state.keep.officialTargets, ['indoor'])
  assert.deepEqual(storedSuccess.state.ingredientAvoidTerms, ['chicken'])
  assert.deepEqual(storedSuccess.state.compareIds, [candidateA.product_id])
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-desktop-variant-retry.png`)
  return { failureSummary, successSummary, fonts }
}

async function mobileFlow(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true })
  await cdp.eval(`sessionStorage.removeItem('catfood.switch-session.v1'); history.replaceState(null,'',${js(`${BASE}?view=workspace&mode=switch`)})`)
  await cdp.nav(`${BASE}?view=workspace&mode=switch`)
  await chooseCurrent(cdp, single.canonical_name)
  await cdp.wait(`[...document.querySelectorAll('.switch-sku-option')].some(n=>n.textContent.includes('1 kg'))`, 'mobile single SKU')
  await clickContains(cdp, '사용 규격을 모르겠어요')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'mobile change before reload')
  await clickExact(cdp, '습식')
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-mobile-before-reload.png`)

  await cdp.reload()
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'mobile restored change')
  const text = await cdp.eval(`document.body.innerText`)
  assert.match(text, /단일 규격 건식/)
  assert.match(text, /현재 규격\s*사용 규격 모름/)
  assert.match(text, /습식/)
  const stored = JSON.parse(await cdp.eval(`sessionStorage.getItem('catfood.switch-session.v1')`))
  assert.equal(stored.version, 1)
  assert.equal(stored.state.currentProductId, single.product_id)
  assert.equal(stored.state.variantSelection.kind, 'unknown')
  assert.equal(stored.state.change.feedType, '습식')
  await cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-mobile-after-reload.png`)
  const fonts = await cdp.platformFonts('.switch-step-header')
  assert.ok(fonts.some((font) => /Noto Sans CJK KR/i.test(font.familyName) && font.glyphCount > 0), `mobile Korean text did not use Noto CJK KR: ${JSON.stringify(fonts)}`)
  return { stored: { version: stored.version, currentProductId: stored.state.currentProductId, variantKind: stored.state.variantSelection.kind, feedType: stored.state.change.feedType }, fonts }
}

let runtime = null
const report = {
  sourceSha: SOURCE_SHA,
  status: 'starting',
  browserVersion: null,
  viewportChecks: ['1280x900 desktop', '390x900 mobile'],
  mockedCatalog: true,
  analyticsDisabled: true,
  productionWrites: 0,
  cssInjection: false,
  desktop: null,
  variantFailureRetry: null,
  mobile: null,
  error: null,
}
const writeReport = () => writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
writeReport()
try {
  runtime = await launch()
  report.browserVersion = runtime.version
  report.desktop = await desktopFlow(runtime.cdp)
  report.variantFailureRetry = await variantFailureFlow(runtime.cdp)
  report.mobile = await mobileFlow(runtime.cdp)
  assert.equal(writeRequests, 0, 'QA attempted a data/analytics write')
  report.productionWrites = writeRequests
  report.status = 'pass'
  writeReport()
  console.log('PR22_KOREAN_BROWSER_QA_PASS', JSON.stringify({ sourceSha: SOURCE_SHA, browserVersion: runtime.version, desktopSummary: report.desktop.roundtripSummary, compareDock: report.desktop.dock, variantRetry: report.variantFailureRetry.successSummary, mobile: report.mobile.stored, writes: writeRequests }))
} catch (error) {
  report.status = 'fail'
  report.error = error?.stack ?? String(error)
  report.productionWrites = writeRequests
  if (runtime?.cdp) {
    try { await runtime.cdp.shot(`${OUT}/pr22-${SOURCE_SHA.slice(0,8)}-failure.png`) } catch (shotError) { report.failureScreenshotError = shotError?.stack ?? String(shotError) }
  }
  writeReport()
  throw error
} finally {
  writeReport()
  if (runtime) {
    runtime.cdp.close()
    runtime.proc.kill('SIGTERM')
  }
  await new Promise((resolve) => apiServer.close(resolve))
}
