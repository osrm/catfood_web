import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

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

function variant(productId, variantId, size, rank) {
  const weight = size === '1 kg' ? 1000 : 2000
  return {
    product_id: productId,
    variant_id: variantId,
    package_size_text: size,
    package_weight_g: weight,
    units_per_sale: 1,
    sale_total_weight_g: weight,
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

const current = product('product_qa_current_back', '현재 건식 사료', {
  brand: '현재브랜드',
  feed_type: '건식',
  life_stage: 'adult',
  variant_count: 2,
  has_variants: true,
  official_targets: ['indoor'],
  features: ['digestive'],
  recipe_families: ['poultry'],
  recipe_details: ['chicken'],
  confirmed_present_ingredient_terms: ['chicken'],
  direct_evidence_ingredient_terms: ['chicken'],
})
const candidate = product('product_qa_candidate_back', '전환 습식 사료', {
  brand: '새브랜드',
  feed_type: '습식',
  life_stage: 'adult',
  official_targets: ['indoor'],
  features: ['digestive'],
  recipe_families: ['fish'],
  recipe_details: ['salmon'],
  reviewed_not_found_ingredient_terms: ['chicken'],
})
const products = [current, candidate]
const currentVariants = [
  variant(current.product_id, 'variant_qa_current_1', '1 kg', 1),
  variant(current.product_id, 'variant_qa_current_2', '2 kg', 2),
]

let writeRequests = 0
const apiServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'apikey,accept-profile,content-type,authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
  if (req.method !== 'GET') { writeRequests += 1; res.statusCode = 405; res.end('writes disabled'); return }
  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (url.pathname.endsWith('/effective_product_catalog_summary')) { res.end(JSON.stringify(products)); return }
  if (url.pathname.endsWith('/switch_current_variant_options')) {
    const filter = url.searchParams.get('product_id')
    if (filter?.startsWith('eq.')) {
      res.end(JSON.stringify(filter.slice(3) === current.product_id ? currentVariants : [])); return
    }
    res.end(JSON.stringify(currentVariants.map((row) => ({
      product_id: row.product_id,
      variant_id: row.variant_id,
      package_size_text: row.package_size_text,
      package_weight_g: row.package_weight_g,
      units_per_sale: row.units_per_sale,
      sale_total_weight_g: row.sale_total_weight_g,
      display_rank: row.display_rank,
    })))); return
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
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('DOM.enable')
    await this.send('CSS.enable')
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, ms = 20000) {
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
    await this.eval('document.fonts?.ready')
    await sleep(180)
  }
  async shot(name) {
    await this.eval('document.fonts?.ready')
    await sleep(100)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    const path = `${OUT}/${name}`
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
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
  const dir = `/tmp/pr22-explicit-back-${process.pid}`
  const proc = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const cdp = new Cdp(page.webSocketDebuggerUrl)
        await cdp.connect()
        return { cdp, version, proc }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

const js = (value) => JSON.stringify(value)
async function clickExact(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${js(text)}); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing exact button: ${text}`)
  await sleep(120)
}
async function clickContains(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing button containing: ${text}`)
  await sleep(120)
}
async function clickSelectorContaining(cdp, selector, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll(${js(selector)})].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing ${selector} containing: ${text}`)
  await sleep(120)
}
async function setInput(cdp, selector, value) {
  const ok = await cdp.eval(`(() => { const n=document.querySelector(${js(selector)}); if(!n)return false; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(n,${js(value)}); n.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(ok, true, `missing input: ${selector}`)
  await sleep(150)
}
async function session(cdp) {
  return cdp.eval(`JSON.parse(sessionStorage.getItem('catfood.switch-session.v1')).state`)
}
async function chooseCurrent(cdp) {
  await setInput(cdp, '.switch-find-search input', current.canonical_name)
  await cdp.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes(${js(current.canonical_name)}))`, 'current search result')
  await clickSelectorContaining(cdp, '.switch-find-result', current.canonical_name)
  await clickContains(cdp, '이 제품을 현재 사료로 선택')
  await cdp.wait(`document.body.innerText.includes('현재 먹이는 규격을 골라주세요')`, 'SKU step')
  await cdp.wait(`[...document.querySelectorAll('.switch-sku-option')].some(n=>n.textContent.includes('1 kg'))`, '1 kg variant')
  await clickSelectorContaining(cdp, '.switch-sku-option', '1 kg')
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE step')
}

const report = { sourceSha: SOURCE_SHA, browserVersion: null, fonts: [], writes: null, states: {}, screenshots: [] }
let runtime
try {
  runtime = await launch()
  const { cdp } = runtime
  report.browserVersion = runtime.version
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.nav(`${BASE}?view=workspace&mode=switch`)
  await cdp.wait(`document.body.innerText.includes('현재 먹이는 사료를 찾으세요')`, 'initial SWITCH screen')
  report.fonts = await cdp.platformFonts('h1')
  assert.ok(report.fonts.some((font) => font.familyName === 'Noto Sans CJK KR'), 'Korean Noto font not used')

  // Path 1: latest KEEP survives the explicit history-backed move to CHANGE and KEEP re-entry.
  await chooseCurrent(cdp)
  await clickContains(cdp, '특별히 바꾸고 싶은 점 없음')
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP step')
  await clickExact(cdp, '현재브랜드 유지')
  await clickExact(cdp, '실내묘')
  report.states.keepSelected = await session(cdp)
  assert.equal(report.states.keepSelected.keepBrand, true)
  assert.deepEqual(report.states.keepSelected.keep.officialTargets, ['indoor'])
  report.screenshots.push(await cdp.shot(`pr22-${SOURCE_SHA.slice(0,8)}-01-keep-selected.png`))

  await clickExact(cdp, '← 바꿀 것 수정')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'explicit back to CHANGE')
  report.states.afterBackToChange = await session(cdp)
  assert.equal(report.states.afterBackToChange.keepBrand, true)
  assert.deepEqual(report.states.afterBackToChange.keep.officialTargets, ['indoor'])
  assert.equal(report.states.afterBackToChange.step, 'change')
  report.screenshots.push(await cdp.shot(`pr22-${SOURCE_SHA.slice(0,8)}-02-back-change-preserved.png`))

  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP re-entry')
  assert.equal(await cdp.eval(`document.querySelector('button[aria-pressed="true"]')?.textContent.includes('현재브랜드 유지')`), true)
  assert.equal(await cdp.eval(`[...document.querySelectorAll('button[aria-pressed="true"]')].some(n=>n.textContent.trim()==='실내묘')`), true)
  report.states.keepReentry = await session(cdp)
  report.screenshots.push(await cdp.shot(`pr22-${SOURCE_SHA.slice(0,8)}-03-keep-reentry.png`))

  // PR21 conflict rule still removes only the matching KEEP axis.
  await clickExact(cdp, '← 바꿀 것 수정')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE for conflict')
  await clickExact(cdp, '다른 브랜드로 보기')
  report.states.afterBrandChange = await session(cdp)
  assert.equal(report.states.afterBrandChange.keepBrand, false)
  assert.deepEqual(report.states.afterBrandChange.keep.officialTargets, ['indoor'])
  assert.ok((await cdp.eval('document.body.innerText')).includes('브랜드 유지 조건을 해제했습니다.'))
  report.screenshots.push(await cdp.shot(`pr22-${SOURCE_SHA.slice(0,8)}-04-brand-conflict.png`))
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP after conflict')
  assert.equal(await cdp.eval(`[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='현재브랜드 유지')`), false)
  assert.equal(await cdp.eval(`[...document.querySelectorAll('button[aria-pressed="true"]')].some(n=>n.textContent.trim()==='실내묘')`), true)
  report.screenshots.push(await cdp.shot(`pr22-${SOURCE_SHA.slice(0,8)}-05-conflict-keep.png`))

  // Reset explicitly and exercise CHANGE + ingredient + real SKU across explicit back to SKU.
  await clickContains(cdp, '현재 사료 다시 선택')
  await cdp.wait(`document.body.innerText.includes('현재 먹이는 사료를 찾으세요')`, 'explicit current reset')
  await chooseCurrent(cdp)
  await clickExact(cdp, '습식')
  const ingredientClicked = await cdp.eval(`(() => { const n=document.querySelector('.switch-current-ingredients button'); if(!n)return false; n.click(); return true })()`)
  assert.equal(ingredientClicked, true, 'current ingredient control missing')
  await sleep(120)
  report.states.changeEdited = await session(cdp)
  assert.equal(report.states.changeEdited.change.feedType, '습식')
  assert.deepEqual(report.states.changeEdited.ingredientAvoidTerms, ['chicken'])
  assert.equal(report.states.changeEdited.variantSelection.variantId, 'variant_qa_current_1')
  report.screenshots.push(await cdp.shot(`pr22-${SOURCE_SHA.slice(0,8)}-06-change-edited.png`))

  await clickExact(cdp, '← 사용 규격')
  await cdp.wait(`document.body.innerText.includes('현재 먹이는 규격을 골라주세요')`, 'explicit back to SKU')
  report.states.afterBackToSku = await session(cdp)
  assert.equal(report.states.afterBackToSku.variantSelection.variantId, 'variant_qa_current_1')
  assert.equal(report.states.afterBackToSku.change.feedType, '습식')
  assert.deepEqual(report.states.afterBackToSku.ingredientAvoidTerms, ['chicken'])
  assert.equal(await cdp.eval(`[...document.querySelectorAll('.switch-sku-option')].find(n=>n.textContent.includes('1 kg'))?.textContent.includes('선택됨')`), true)
  report.screenshots.push(await cdp.shot(`pr22-${SOURCE_SHA.slice(0,8)}-07-back-sku-preserved.png`))

  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE re-entry after SKU')
  report.states.changeReentry = await session(cdp)
  assert.equal(report.states.changeReentry.change.feedType, '습식')
  assert.deepEqual(report.states.changeReentry.ingredientAvoidTerms, ['chicken'])
  assert.equal(report.states.changeReentry.variantSelection.variantId, 'variant_qa_current_1')
  assert.equal(await cdp.eval(`[...document.querySelectorAll('button[aria-pressed="true"]')].some(n=>n.textContent.trim()==='습식')`), true)
  assert.ok((await cdp.eval(`document.querySelector('.switch-ingredient-selected')?.innerText ?? ''`)).includes('닭'))
  report.screenshots.push(await cdp.shot(`pr22-${SOURCE_SHA.slice(0,8)}-08-change-reentry.png`))

  report.writes = writeRequests
  assert.equal(writeRequests, 0)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR22_EXPLICIT_BACK_BROWSER_QA_PASS', JSON.stringify({
    sourceSha: SOURCE_SHA,
    browserVersion: runtime.version,
    keepBrand: report.states.keepReentry.keepBrand,
    indoorKeep: report.states.keepReentry.keep.officialTargets,
    conflictKeepBrand: report.states.afterBrandChange.keepBrand,
    conflictIndoorKeep: report.states.afterBrandChange.keep.officialTargets,
    sku: report.states.changeReentry.variantSelection,
    feedType: report.states.changeReentry.change.feedType,
    avoid: report.states.changeReentry.ingredientAvoidTerms,
    writes: writeRequests,
  }))
} catch (error) {
  report.writes = writeRequests
  report.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
  try {
    if (runtime?.cdp) report.screenshots.push(await runtime.cdp.shot(`pr22-${SOURCE_SHA.slice(0,8)}-failure.png`))
  } catch {}
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  try { runtime?.cdp?.close() } catch {}
  try { runtime?.proc?.kill('SIGTERM') } catch {}
  await new Promise((resolve) => apiServer.close(resolve))
}
