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

const products = [
  product('product_000000000101', '현재 건식 사료', {
    brand: '현재브랜드', feed_type: '건식', life_stage: 'adult', official_targets: ['indoor'],
    features: ['digestive'], recipe_families: ['poultry'],
    confirmed_present_ingredient_terms: ['chicken'], direct_evidence_ingredient_terms: ['chicken'],
  }),
  product('product_000000000102', '전환 습식 생선', {
    brand: '새브랜드', feed_type: '습식', life_stage: 'senior', official_targets: ['indoor'],
    features: ['digestive'], recipe_families: ['fish'], reviewed_not_found_ingredient_terms: ['chicken'],
  }),
  product('product_000000000103', '같은 브랜드 습식', {
    brand: '현재브랜드', feed_type: '습식', life_stage: 'senior', recipe_families: ['fish'],
    reviewed_not_found_ingredient_terms: ['chicken'],
  }),
  product('product_000000000104', '닭 포함 습식', {
    brand: '다른브랜드', feed_type: '습식', life_stage: 'senior', recipe_families: ['fish'],
    confirmed_present_ingredient_terms: ['chicken'], direct_evidence_ingredient_terms: ['chicken'],
  }),
  product('product_000000000105', '다른 건식 후보', {
    brand: '다른브랜드', feed_type: '건식', life_stage: 'senior', recipe_families: ['fish'],
    reviewed_not_found_ingredient_terms: ['chicken'],
  }),
]

let writeRequests = 0
const apiServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'apikey,accept-profile,content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
  if (req.method !== 'GET') { writeRequests += 1; res.statusCode = 405; res.end('writes disabled'); return }
  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (url.pathname.endsWith('/effective_product_catalog_summary')) {
    res.end(JSON.stringify(products)); return
  }
  if (url.pathname.endsWith('/switch_current_variant_options')) {
    res.end('[]'); return
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
      await sleep(100)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, 'document ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'root content')
    await this.eval('document.fonts?.ready'); await sleep(250)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready'); await sleep(120)
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
  const port = 9980 + (process.pid % 10)
  const dir = `/tmp/pr21-switch-qa-${process.pid}`
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
  assert.equal(ok, true, `missing exact button: ${text}`); await sleep(140)
}
async function clickContains(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing button containing: ${text}`); await sleep(140)
}
async function setSearch(cdp, selector, value) {
  const ok = await cdp.eval(`(() => { const n=document.querySelector(${js(selector)}); if(!n)return false; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(n,${js(value)}); n.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(ok, true, `missing input ${selector}`); await sleep(180)
}
async function pressed(cdp, text) {
  return cdp.eval(`(() => [...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${js(text)})?.getAttribute('aria-pressed') ?? null)()`)
}

const { cdp, version, proc, dir } = await launch()
const report = { sourceSha: SOURCE_SHA, browserVersion: version, mockedCatalog: true, analyticsDisabled: true, cssInjection: false, productFontChanged: false, checks: {} }
try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.nav(`${BASE}?view=workspace&mode=switch`)
  await cdp.wait(`document.body.innerText.includes('데이터 연결됨')`, 'catalog connected')
  await setSearch(cdp, '.switch-find-search input', '현재 건식')
  await cdp.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes('현재 건식 사료'))`, 'current result')
  await cdp.eval(`([...document.querySelectorAll('.switch-find-result')].find(n=>n.textContent.includes('현재 건식 사료'))).click()`); await sleep(120)
  await clickContains(cdp, '이 제품을 현재 사료로 선택')
  await cdp.wait(`document.body.innerText.includes('선택할 수 있는 판매 규격을 확인하지 못했습니다')`, 'empty SKU')
  await clickExact(cdp, '사용 규격을 모르겠어요')
  await clickContains(cdp, '특별히 바꾸고 싶은 점 없음')
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP step')
  for (const text of ['현재브랜드 유지', '건식 유지', '성묘 유지', '가금류', '실내묘']) await clickExact(cdp, text)

  await clickContains(cdp, '← 바꿀 것 수정')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE step')
  await cdp.eval(`document.querySelector('.switch-current-ingredients button').click()`); await sleep(120)

  const notices = []
  for (const [text, notice] of [
    ['다른 브랜드로 보기', '브랜드 유지 조건을 해제했습니다.'],
    ['습식', '사료 형태 유지 조건을 해제했습니다.'],
    ['시니어', '생애주기 유지 조건을 해제했습니다.'],
    ['생선', '레시피 계열 유지 조건을 해제했습니다.'],
  ]) {
    await clickExact(cdp, text)
    await cdp.wait(`document.querySelector('[role="status"]')?.textContent.includes(${js(notice)})`, notice)
    notices.push((await cdp.eval(`document.querySelector('[role="status"]')?.textContent.trim()`)))
  }
  const fonts = await cdp.platformFonts('[role="status"]')
  assert.ok(fonts.some((font) => /Noto Sans CJK KR/i.test(font.familyName) && font.glyphCount > 0), `Korean status did not use Noto CJK KR: ${JSON.stringify(fonts)}`)
  await cdp.shot(`${OUT}/pr21-${SOURCE_SHA.slice(0,8)}-change-conflicts-cleared.png`)

  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP after changes')
  const keepState = await cdp.eval(`(() => { const text=t=>[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===t); return { brand:!!text('현재브랜드 유지'), dry:!!text('건식 유지'), adult:!!text('성묘 유지'), poultry:!!text('가금류'), indoor:text('실내묘')?.getAttribute('aria-pressed') } })()`)
  assert.deepEqual(keepState, { brand: false, dry: false, adult: false, poultry: false, indoor: 'true' })
  await cdp.shot(`${OUT}/pr21-${SOURCE_SHA.slice(0,8)}-keep-after-change.png`)

  await clickContains(cdp, '후보 제품 보기')
  await cdp.wait(`document.querySelector('.switch-results-stage')`, 'results')
  const results = await cdp.eval(`(() => ({ summary:document.querySelector('.switch-session-bar').textContent, candidates:document.querySelector('.switch-candidate-list').textContent }))()`)
  assert.match(results.summary, /CHANGE.*다른 브랜드.*습식.*시니어.*생선.*피함 · 닭/s)
  assert.match(results.summary, /KEEP.*실내묘/s)
  for (const stale of ['현재브랜드','건식','성묘','가금류']) assert.doesNotMatch(results.summary, new RegExp('KEEP[^]*'+stale))
  assert.match(results.candidates, /전환 습식 생선/)
  for (const blocked of ['같은 브랜드 습식','닭 포함 습식','다른 건식 후보']) assert.doesNotMatch(results.candidates, new RegExp(blocked))
  await cdp.shot(`${OUT}/pr21-${SOURCE_SHA.slice(0,8)}-results-final-conditions.png`)

  await clickExact(cdp, '조건 수정')
  for (const text of ['다른 브랜드로 보기','습식','시니어','생선']) await clickExact(cdp, text)
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP after CHANGE off')
  const noRestore = {
    brand: await pressed(cdp, '현재브랜드 유지'),
    dry: await pressed(cdp, '건식 유지'),
    adult: await pressed(cdp, '성묘 유지'),
    poultry: await pressed(cdp, '가금류'),
    indoor: await pressed(cdp, '실내묘'),
  }
  assert.deepEqual(noRestore, { brand: 'false', dry: 'false', adult: 'false', poultry: 'false', indoor: 'true' })
  await cdp.shot(`${OUT}/pr21-${SOURCE_SHA.slice(0,8)}-keep-no-restore.png`)

  assert.equal(writeRequests, 0, 'QA attempted an API write')
  report.checks = { notices, fonts, keepState, results, noRestore, writeRequests }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR21_SWITCH_KEEP_QA_PASS ' + JSON.stringify({ sourceSha: SOURCE_SHA, notices, keepState, noRestore, candidates: results.candidates }))
} catch (error) {
  report.error = String(error?.stack ?? error)
  try { await cdp.shot(`${OUT}/failure.png`) } catch {}
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  cdp.close(); proc.kill('SIGTERM'); apiServer.close(); try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
