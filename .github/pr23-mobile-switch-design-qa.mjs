import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA ?? 'unknown'
const QA_SHA = process.env.GITHUB_SHA ?? 'unknown'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const OUT = 'qa-artifacts'
const STORAGE_KEY = 'catfood.switch-session.v1'
const LONG_CANDIDATE = '울트라 프로틴+ 스킨 & 코트 & 다이제스티브 캣 레시피'
const STEP_LABELS = ['현재 제품', '사용 규격', '바꿀 것', '유지할 것', '후보']

mkdirSync(OUT, { recursive: true })
assert.ok(SUPABASE_URL && SUPABASE_KEY, 'public Supabase config missing')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const j = (value) => JSON.stringify(value)

async function apiRows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view} read failed ${response.status}`)
  return response.json()
}

async function catalogContext() {
  const rows = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,variant_count,has_variants',
    order: 'brand.asc,canonical_name.asc', limit: 1000,
  })
  const current = rows.find((row) => row.brand === 'AATU' && row.canonical_name === '연어' && Number(row.variant_count) >= 2)
    ?? rows.find((row) => Number(row.variant_count) >= 2 && row.brand && row.canonical_name && row.feed_type)
  assert.ok(current, 'no multi-SKU current product')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,display_rank',
    product_id: `eq.${current.product_id}`, order: 'display_rank.asc,variant_id.asc', limit: 100,
  })
  assert.ok(variants.length >= 2, 'current product needs multiple real variants')
  const sku = variants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? '')) ?? variants[0]
  const counts = new Map()
  for (const row of rows) if (row.brand) counts.set(row.brand, (counts.get(row.brand) ?? 0) + 1)
  const multiBrand = [...counts.entries()].sort((a, b) => b[1] - a[1]).find(([, count]) => count >= 8)?.[0]
  assert.ok(multiBrand, 'no brand with enough search rows')
  return { rows, current, variants, sku, multiBrand }
}

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('DOM.enable'); await this.send('CSS.enable'); await this.send('Network.enable')
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const originalFetch = window.fetch.bind(window)
      window.__qaBlockedAnalytics = 0
      window.__qaBlockedWrites = 0
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
        if (url.includes('/functions/v1/decision-intake')) { window.__qaBlockedAnalytics += 1; return Promise.reject(new TypeError('QA blocked analytics before network send')) }
        if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) { window.__qaBlockedWrites += 1; return Promise.reject(new TypeError('QA blocked production write before network send')) }
        return originalFetch(input, init)
      }
    })();` })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await this.eval(`Boolean(${expression})`)) return } catch {} await sleep(120) } throw new Error(`timeout: ${label}`) }
  async nav(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState === 'complete'`, 'document ready'); await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'root content'); await this.eval('document.fonts?.ready'); await sleep(250) }
  async shot(path) { await this.eval('document.fonts?.ready'); await sleep(100); const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(path, Buffer.from(result.data, 'base64')) }
  async platformFonts(selector) { const { root } = await this.send('DOM.getDocument', { depth: 1 }); const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector }); assert.ok(nodeId, `font node missing ${selector}`); return (await this.send('CSS.getPlatformFontsForNode', { nodeId })).fonts ?? [] }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile = true) {
  const bin = '/usr/bin/google-chrome'; assert.ok(existsSync(bin), 'Chrome unavailable'); const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
  const port = 9300 + (process.pid % 200) + (width % 37); const dir = `/tmp/pr23-${width}-${process.pid}`; rmSync(dir, { recursive: true, force: true })
  const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect()
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: mobile ? 'Android' : 'Linux' })
        return { cdp, proc, dir, version }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function sessionState(cdp) { return cdp.eval(`(() => { const raw = sessionStorage.getItem(${j(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`) }
async function waitSession(cdp, expression, label) { await cdp.wait(`(() => { const raw = sessionStorage.getItem(${j(STORAGE_KEY)}); if (!raw) return false; const s = JSON.parse(raw).state; return ${expression} })()`, label) }

async function setSearchInput(cdp, value) {
  const ok = await cdp.eval(`(() => { const input = document.querySelector('.switch-find-search input'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${j(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  assert.equal(ok, true, 'search input missing'); await cdp.wait(`document.querySelector('.switch-find-search input')?.value === ${j(value)}`, 'search input value'); await sleep(220)
}
async function clickExact(cdp, text, scope = 'body') {
  await cdp.wait(`(() => { const root = document.querySelector(${j(scope)}); if (!root) return false; return [...root.querySelectorAll('button')].some((button) => button.textContent.trim() === ${j(text)} && !button.disabled) })()`, `enabled button ${text}`)
  const ok = await cdp.eval(`(() => { const root = document.querySelector(${j(scope)}); if (!root) return false; const button = [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === ${j(text)} && !item.disabled); if (!button) return false; button.click(); return true })()`)
  assert.equal(ok, true, `button missing or disabled: ${text}`); await sleep(160)
}
async function clickContaining(cdp, selector, text) { const ok = await cdp.eval(`(() => { const item = [...document.querySelectorAll(${j(selector)})].find((node) => node.textContent.includes(${j(text)})); if (!item) return false; item.click(); return true })()`); assert.equal(ok, true, `${selector} missing ${text}`); await sleep(160) }

async function measure(cdp, selectors = []) {
  return cdp.eval(`(() => {
    const visible = (element) => { if (!element) return false; const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 }
    const info = (selector) => { const element = document.querySelector(selector); if (!element) return { selector, missing: true }; const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return { selector, text: (element.textContent || '').trim(), rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)], client: [element.clientWidth, element.clientHeight], scroll: [element.scrollWidth, element.scrollHeight], overflow: [style.overflowX, style.overflowY], maxHeight: style.maxHeight, minHeight: style.minHeight, display: style.display, gridTemplateColumns: style.gridTemplateColumns, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, wordBreak: style.wordBreak, lineClamp: style.webkitLineClamp || null } }
    const all = [...document.querySelectorAll('body *')].filter(visible)
    return { viewport: [innerWidth, innerHeight], windowScrollY: Math.round(scrollY), document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], horizontal: all.filter((element) => { const rect = element.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1 }).slice(0, 16).map((element) => { const rect = element.getBoundingClientRect(); return { tag: element.tagName, class: element.className, rect: [Math.round(rect.left), Math.round(rect.right)], text: (element.textContent || '').trim().slice(0, 100) } }), nested: all.filter((element) => { const style = getComputedStyle(element); return element.scrollHeight > element.clientHeight + 2 && ['auto', 'scroll'].includes(style.overflowY) && element.clientHeight > 60 }).slice(0, 20).map((element) => ({ class: element.className, client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY })), targets: ${j(selectors)}.map(info) }
  })()`)
}
async function capture(cdp, prefix, name, selectors = []) { const metrics = await measure(cdp, selectors); const file = `${prefix}-${name}.png`; await cdp.shot(`${OUT}/${file}`); return { file, metrics } }
async function reachSelector(cdp, selector) {
  const before = await cdp.eval(`(() => { const element = document.querySelector(${j(selector)}); if (!element) return null; const rect = element.getBoundingClientRect(); return { scrollY, rect: [rect.left, rect.top, rect.width, rect.height], visible: rect.top >= 0 && rect.bottom <= innerHeight } })()`); assert.ok(before, `reach missing ${selector}`)
  await cdp.eval(`document.querySelector(${j(selector)}).scrollIntoView({ block: 'center', inline: 'nearest' })`); await sleep(180)
  const after = await cdp.eval(`(() => { const element = document.querySelector(${j(selector)}), rect = element.getBoundingClientRect(), x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)), top = document.elementFromPoint(x, y); return { scrollY, rect: [rect.left, rect.top, rect.width, rect.height], visible: rect.top >= 0 && rect.bottom <= innerHeight, centerHit: Boolean(top && (top === element || element.contains(top))) } })()`)
  assert.equal(after.visible, true, `${selector} not reachable`); assert.equal(after.centerHit, true, `${selector} covered`); return { before, after }
}
async function reachExactButton(cdp, scope, text) {
  await cdp.wait(`(() => { const root = document.querySelector(${j(scope)}); if (!root) return false; const button = [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === ${j(text)}); if (!button || button.disabled) return false; const style = getComputedStyle(button), rect = button.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 })()`, `rendered enabled button ${text}`)
  const before = await cdp.eval(`(() => { const root = document.querySelector(${j(scope)}), button = [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === ${j(text)}), rect = button.getBoundingClientRect(); return { text: button.textContent.trim(), className: button.className, disabled: button.disabled, scrollY, rect: [rect.left, rect.top, rect.width, rect.height], visible: rect.top >= 0 && rect.bottom <= innerHeight } })()`)
  assert.equal(before.className.includes('switch-compare-action'), true, 'detail action class mismatch'); assert.equal(before.disabled, false, 'detail action disabled')
  await cdp.eval(`(() => { const root = document.querySelector(${j(scope)}), button = [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === ${j(text)}); button.scrollIntoView({ block: 'center', inline: 'nearest' }) })()`); await sleep(180)
  const after = await cdp.eval(`(() => { const root = document.querySelector(${j(scope)}), button = [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === ${j(text)}), rect = button.getBoundingClientRect(), x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)), top = document.elementFromPoint(x, y); return { text: button.textContent.trim(), className: button.className, disabled: button.disabled, scrollY, rect: [rect.left, rect.top, rect.width, rect.height], visible: rect.top >= 0 && rect.bottom <= innerHeight, centerHit: Boolean(top && (top === button || button.contains(top))) } })()`)
  assert.equal(after.text, text); assert.equal(after.visible, true, `${text} not fully reachable`); assert.equal(after.centerHit, true, `${text} center is covered`); return { before, after }
}

async function waitCatalog(cdp) { await cdp.wait(`document.querySelector('.switch-find-search input')`, 'SWITCH search') }
async function searchCount(cdp, query) { await setSearchInput(cdp, query); await cdp.wait(`document.querySelector('.switch-find-results-heading span')?.textContent.includes('개 표시')`, 'search result count'); const first = await cdp.eval(`document.querySelectorAll('.switch-find-result').length`); await sleep(180); const second = await cdp.eval(`document.querySelectorAll('.switch-find-result').length`); assert.equal(second, first, `search count not stable for ${query}`); return second }
async function findUniqueQuery(cdp, rows) { const options = []; for (const row of rows.slice(0, 160)) options.push(`${row.brand} ${row.canonical_name}`, row.canonical_name); for (const query of options) { if (!query?.trim()) continue; if (await searchCount(cdp, query) === 1) return query } throw new Error('unable to find one-result query') }

async function selectCurrent(cdp, ctx) {
  const query = `${ctx.current.brand} ${ctx.current.canonical_name}`; await setSearchInput(cdp, query); await cdp.wait(`document.querySelectorAll('.switch-find-result').length > 0`, 'current result'); await clickContaining(cdp, '.switch-find-result', ctx.current.canonical_name); await cdp.wait(`document.querySelector('.switch-current-preview')`, 'current preview'); await clickExact(cdp, '이 제품을 현재 사료로 선택 →', '.switch-current-preview'); await waitSession(cdp, `s.step === 'sku' && s.currentProductId === ${j(ctx.current.product_id)}`, 'SKU step session'); await cdp.wait(`document.querySelector('.switch-sku-option')`, 'SKU options'); await cdp.wait(`!document.body.innerText.includes('판매 규격을 불러오는 중입니다.')`, 'SKU load')
}
async function chooseSku(cdp, ctx) { const label = ctx.sku.package_size_text || '1 kg'; await clickContaining(cdp, '.switch-sku-option', label); await waitSession(cdp, `s.variantSelection?.kind === 'variant' && s.variantSelection.variantId === ${j(ctx.sku.variant_id)}`, 'selected SKU stored'); await cdp.wait(`document.querySelector('.switch-sku-option.is-selected')`, 'selected SKU rendered'); return label }
async function advanceSkuToChange(cdp) { await clickExact(cdp, '다음 →', '.switch-step-actions'); await waitSession(cdp, `s.step === 'change'`, 'CHANGE step'); await cdp.wait(`document.querySelector('.switch-no-change')`, 'CHANGE rendered') }

async function progressAudit(cdp) {
  return cdp.eval(`(() => { const progress = document.querySelector('.switch-progress'), items = [...progress.querySelectorAll('li')]; return { scroll: [progress.clientWidth, progress.scrollWidth], items: items.map((item) => { const number = item.querySelector(':scope > span'), label = item.querySelector('strong'), numberRect = number.getBoundingClientRect(), labelRect = label.getBoundingClientRect(), style = getComputedStyle(label); return { text: label.textContent.trim(), current: item.getAttribute('aria-current'), classes: item.className, numRect: [numberRect.left, numberRect.top, numberRect.width, numberRect.height], labelRect: [labelRect.left, labelRect.top, labelRect.width, labelRect.height], numberAbove: numberRect.bottom <= labelRect.top + 1, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflowX: style.overflowX, client: [label.clientWidth, label.clientHeight], scrollSize: [label.scrollWidth, label.scrollHeight], fontSize: style.fontSize } }) } })()`)
}
function assertMobileProgress(progress) { assert.equal(progress.scroll[0], progress.scroll[1], 'mobile progress horizontally scrolls'); assert.deepEqual(progress.items.map((item) => item.text), STEP_LABELS); assert.equal(progress.items.filter((item) => item.current === 'step').length, 1, 'exactly one current step expected'); for (const item of progress.items) { assert.equal(item.numberAbove, true, `number is not above label: ${item.text}`); assert.notEqual(item.whiteSpace, 'nowrap', `label forced to one line: ${item.text}`); assert.notEqual(item.textOverflow, 'ellipsis', `label ellipsized: ${item.text}`); assert.ok(item.scrollSize[0] <= item.client[0] + 1, `label horizontally clipped: ${item.text}`); assert.ok(item.scrollSize[1] <= item.client[1] + 1, `label vertically clipped: ${item.text}`) } }

async function mobileSearchEvidence(cdp, prefix, ctx, result) {
  await setSearchInput(cdp, '__qa_no_match_9f31c__'); await cdp.wait(`document.querySelectorAll('.switch-find-result').length === 0 && document.body.innerText.includes('검색 결과가 없습니다.')`, 'zero results'); result.zero = await capture(cdp, prefix, '01-zero-results', ['.switch-find-body', '.switch-find-results-list']); assert.equal(result.zero.metrics.targets[0].minHeight, '0px', 'zero-result body retains min-height'); assert.ok(result.zero.metrics.targets[0].rect[3] < 320, 'zero-result body retained large visual height')
  const uniqueQuery = await findUniqueQuery(cdp, ctx.rows); result.uniqueQuery = uniqueQuery; result.oneCount = await searchCount(cdp, uniqueQuery); assert.equal(result.oneCount, 1); result.one = await capture(cdp, prefix, '02-one-result', ['.switch-find-body', '.switch-find-results-list']); assert.equal(result.one.metrics.targets[0].minHeight, '0px', 'one-result body retains min-height'); assert.ok(result.one.metrics.targets[0].rect[3] < 330, 'one-result body retained large visual height')
  const many = await searchCount(cdp, ctx.multiBrand); assert.ok(many >= 2, 'many-result query too small'); result.manyQuery = ctx.multiBrand; result.manyCount = many
  const list = await cdp.eval(`(() => { const element = document.querySelector('.switch-find-results-list'), style = getComputedStyle(element); return { count: element.querySelectorAll('.switch-find-result').length, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: style.overflowY, maxHeight: style.maxHeight } })()`); result.searchList = list; assert.equal(list.overflowY, 'visible'); assert.equal(list.maxHeight, 'none'); assert.ok(list.scrollHeight <= list.clientHeight + 1, 'mobile results list is still an internal scroller')
  const lastIndex = many - 1, lastSelector = `.switch-find-result:nth-child(${lastIndex + 1})`; result.lastReach = await reachSelector(cdp, lastSelector); result.lastBefore = await capture(cdp, prefix, '03-last-result-reached', [lastSelector, '.switch-find-results-list']); const beforeY = await cdp.eval('scrollY'); const lastName = await cdp.eval(`document.querySelector(${j(lastSelector)}).querySelector('.switch-find-result-copy strong').textContent.trim()`); result.lastName = lastName
  await cdp.eval(`document.querySelector(${j(lastSelector)}).click()`); await cdp.wait(`document.querySelector('.switch-current-preview')`, 'last result preview'); await cdp.wait(`document.querySelector('.switch-current-preview h2')?.textContent.trim() === ${j(lastName)}`, 'last result preview identity'); result.preview = await capture(cdp, prefix, '04-last-result-preview', ['.switch-current-preview']); await clickExact(cdp, '닫기 ×', '.switch-current-preview'); await cdp.wait(`!document.querySelector('.switch-current-preview')`, 'preview close')
  const returned = await cdp.eval(`(() => { const query = document.querySelector('.switch-find-search input')?.value ?? null, row = [...document.querySelectorAll('.switch-find-result')].find((item) => item.querySelector('.switch-find-result-copy strong')?.textContent.trim() === ${j(lastName)}); if (!row) return { query, row: null, scrollY }; const rect = row.getBoundingClientRect(); return { query, scrollY, row: { text: row.textContent.trim(), rect: [rect.left, rect.top, rect.width, rect.height], visible: rect.bottom > 0 && rect.top < innerHeight, fullyVisible: rect.top >= 0 && rect.bottom <= innerHeight } } })()`)
  result.returnState = { beforeY, afterY: returned.scrollY, deltaY: Math.round(returned.scrollY - beforeY), query: returned.query, row: returned.row }; assert.equal(returned.query, ctx.multiBrand, 'search query changed after preview close'); assert.ok(returned.row?.text.includes(lastName), 'same result row missing after preview close'); assert.equal(returned.row.visible, true, 'same result row is not visible after preview close'); result.returnCapture = await capture(cdp, prefix, '05-preview-return-position', [lastSelector, '.switch-find-results-list'])
}

async function networkEvidence(cdp) { const blocked = await cdp.eval(`({ analytics: window.__qaBlockedAnalytics || 0, writes: window.__qaBlockedWrites || 0 })`); const sentAnalytics = cdp.requests.filter((request) => request.url.includes('/functions/v1/decision-intake')); const sentWrites = cdp.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)); const publicReads = cdp.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && request.method === 'GET').length; return { blocked, sentAnalytics, sentWrites, publicReads } }

async function mobileFlow(width, height, ctx, result) {
  const prefix = `pr23-${PRODUCT_SHA.slice(0, 8)}-${width}x${height}`, { cdp, proc, dir, version } = await launch(width, height, true); result.viewport = [width, height]; result.browserVersion = version; result.captures = []; const cap = async (name, selectors = []) => { const item = await capture(cdp, prefix, name, selectors); result.captures.push(item); return item }
  try {
    await cdp.nav(`${BASE}?view=workspace&mode=switch`); await waitCatalog(cdp); await mobileSearchEvidence(cdp, prefix, ctx, result.search = {})
    await selectCurrent(cdp, ctx); const skuLabel = await chooseSku(cdp, ctx); result.sku = { label: skuLabel, id: ctx.sku.variant_id }; result.progress = await progressAudit(cdp); assertMobileProgress(result.progress); result.font = await cdp.platformFonts('.switch-progress li[aria-current="step"] strong'); assert.ok(result.font.some((item) => item.familyName.includes('Noto Sans CJK KR')), `Korean font mismatch ${JSON.stringify(result.font)}`); await cap('06-sku-progress', ['.switch-progress', '.switch-sku-option.is-selected'])
    result.roundtrip = {}; await advanceSkuToChange(cdp); await clickExact(cdp, '다른 브랜드로 보기', '.switch-step-main'); await waitSession(cdp, `s.changeBrand === true`, 'change brand stored'); await clickExact(cdp, '다음 →', '.switch-step-actions'); await waitSession(cdp, `s.step === 'keep'`, 'KEEP step')
    const keepFeedLabel = `${ctx.current.feed_type} 유지`; await clickExact(cdp, keepFeedLabel, '.switch-step-main'); await waitSession(cdp, `s.keep?.feedType === ${j(ctx.current.feed_type)}`, 'KEEP feed type stored'); result.roundtrip.beforeKeepBack = await sessionState(cdp); await cap('07-keep-before-explicit-back', ['.switch-progress', '.switch-step-actions'])
    await clickExact(cdp, '← 바꿀 것 수정', '.switch-step-actions'); await waitSession(cdp, `s.step === 'change'`, 'explicit KEEP to CHANGE back'); result.roundtrip.afterKeepBack = await sessionState(cdp); assert.equal(result.roundtrip.afterKeepBack.variantSelection.variantId, ctx.sku.variant_id); assert.equal(result.roundtrip.afterKeepBack.changeBrand, true); assert.equal(result.roundtrip.afterKeepBack.keep.feedType, ctx.current.feed_type); await cap('08-change-after-keep-back', ['.switch-progress', '.switch-choice.is-active'])
    await clickExact(cdp, '다음 →', '.switch-step-actions'); await waitSession(cdp, `s.step === 'keep'`, 'KEEP re-entry'); await cdp.wait(`(() => { const button = [...document.querySelectorAll('.switch-step-main button')].find((item) => item.textContent.trim() === ${j(keepFeedLabel)}); return button?.getAttribute('aria-pressed') === 'true' })()`, 'KEEP feed selection rendered'); result.roundtrip.afterKeepReentry = await sessionState(cdp); assert.equal(result.roundtrip.afterKeepReentry.variantSelection.variantId, ctx.sku.variant_id); assert.equal(result.roundtrip.afterKeepReentry.changeBrand, true); assert.equal(result.roundtrip.afterKeepReentry.keep.feedType, ctx.current.feed_type); await cap('09-keep-reentry', ['.switch-progress', '.switch-choice.is-active'])
    await clickExact(cdp, '후보 제품 보기 →', '.switch-step-actions'); await waitSession(cdp, `s.step === 'results'`, 'results session'); await cdp.wait(`document.querySelector('.switch-results-stage')`, 'results rendered'); await cap('10-results', ['.switch-session-bar', '.switch-candidate-list'])
    const longExists = await cdp.eval(`[...document.querySelectorAll('.switch-candidate-row')].some((item) => item.textContent.includes(${j(LONG_CANDIDATE)}))`); assert.equal(longExists, true, 'long candidate not visible in current candidate window'); await clickContaining(cdp, '.switch-candidate-row', LONG_CANDIDATE); await cdp.wait(`document.querySelector('.switch-candidate-inspector')`, 'candidate inspector'); await cdp.wait(`document.querySelector('.switch-candidate-inspector .switch-inspector-identity h1')?.textContent.trim() === ${j(LONG_CANDIDATE)}`, 'long candidate inspector identity')
    result.candidate = await cdp.eval(`(() => { const box = document.querySelector('.switch-inspector-identity'), image = box.querySelector('.switch-inspector-image'), title = box.querySelector('h1'), boxRect = box.getBoundingClientRect(), imageRect = image.getBoundingClientRect(), titleRect = title.getBoundingClientRect(), style = getComputedStyle(title), range = document.createRange(); range.selectNodeContents(title); const rangeRect = range.getBoundingClientRect(); return { name: title.textContent.trim(), box: [boxRect.left, boxRect.top, boxRect.width, boxRect.height], image: [imageRect.left, imageRect.top, imageRect.width, imageRect.height], title: [titleRect.left, titleRect.top, titleRect.width, titleRect.height], range: [rangeRect.left, rangeRect.top, rangeRect.width, rangeRect.height], titleBelowImage: titleRect.top >= imageRect.bottom - 1, titleWidthRatio: titleRect.width / boxRect.width, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflowX: style.overflowX, overflowY: style.overflowY, lineClamp: style.webkitLineClamp || null, scroll: [title.clientWidth, title.scrollWidth, title.clientHeight, title.scrollHeight], imageFit: getComputedStyle(image).objectFit, imageNatural: image.tagName === 'IMG' ? [image.naturalWidth, image.naturalHeight] : null } })()`)
    await cap('11-long-candidate-inspector', ['.switch-inspector-identity', '.switch-inspector-actions'])
    assert.equal(result.candidate.name, LONG_CANDIDATE); assert.equal(result.candidate.titleBelowImage, true); assert.ok(result.candidate.titleWidthRatio > 0.85, 'candidate title does not use full mobile width'); assert.notEqual(result.candidate.whiteSpace, 'nowrap'); assert.notEqual(result.candidate.textOverflow, 'ellipsis'); assert.ok(!result.candidate.lineClamp || result.candidate.lineClamp === 'none', 'candidate title line-clamped'); assert.notEqual(result.candidate.overflowY, 'hidden', 'candidate title hides vertical overflow'); assert.ok(result.candidate.scroll[1] <= result.candidate.scroll[0] + 1, 'candidate title horizontally clipped'); assert.ok(result.candidate.scroll[3] <= result.candidate.scroll[2] + 3, `candidate title vertical metric exceeds rounding tolerance: ${result.candidate.scroll[2]} -> ${result.candidate.scroll[3]}`); const titleBottom = result.candidate.title[1] + result.candidate.title[3], rangeBottom = result.candidate.range[1] + result.candidate.range[3]; assert.ok(rangeBottom <= titleBottom + 2, `candidate text range exceeds title box: ${rangeBottom} > ${titleBottom}`); assert.ok(result.candidate.image[2] <= 180 && result.candidate.image[3] <= 180, 'candidate image is oversized on mobile')
    result.detailReach = await reachExactButton(cdp, '.switch-candidate-inspector', '상세 보기 →')
    await clickExact(cdp, '닫기 ×', '.switch-candidate-inspector'); await cdp.wait(`!document.querySelector('.switch-candidate-inspector')`, 'candidate inspector close'); await clickExact(cdp, '조건 수정', '.switch-session-bar'); await waitSession(cdp, `s.step === 'change'`, 'results to CHANGE edit'); await cdp.wait(`document.querySelector('.switch-step-layout')`, 'CHANGE edit rendered'); result.roundtrip.beforeSkuBack = await sessionState(cdp)
    await clickExact(cdp, '← 사용 규격', '.switch-step-actions'); await waitSession(cdp, `s.step === 'sku'`, 'explicit CHANGE to SKU back'); await cdp.wait(`document.querySelector('.switch-sku-list')`, 'SKU back rendered'); result.roundtrip.afterSkuBack = await sessionState(cdp); assert.equal(result.roundtrip.afterSkuBack.variantSelection.variantId, ctx.sku.variant_id); assert.equal(result.roundtrip.afterSkuBack.changeBrand, true); assert.equal(result.roundtrip.afterSkuBack.keep.feedType, ctx.current.feed_type); await cdp.wait(`document.querySelector('.switch-sku-option.is-selected')`, 'SKU selection rendered after back'); await cap('12-explicit-back-sku', ['.switch-progress', '.switch-sku-option.is-selected'])
    await advanceSkuToChange(cdp); result.roundtrip.afterChangeReentry = await sessionState(cdp); assert.equal(result.roundtrip.afterChangeReentry.variantSelection.variantId, ctx.sku.variant_id); assert.equal(result.roundtrip.afterChangeReentry.changeBrand, true); assert.equal(result.roundtrip.afterChangeReentry.keep.feedType, ctx.current.feed_type); await cap('13-change-reentry', ['.switch-progress', '.switch-choice.is-active'])
    result.network = await networkEvidence(cdp); assert.equal(result.network.sentAnalytics.length, 0, 'analytics request escaped block'); assert.equal(result.network.sentWrites.length, 0, 'production write escaped block'); result.status = 'pass'
  } catch (error) { result.status = 'fail'; result.error = String(error?.stack || error); throw error } finally { cdp.close(); proc.kill('SIGTERM'); await sleep(100); try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}

async function boundaryFlow(width, height, ctx, result) {
  const prefix = `pr23-${PRODUCT_SHA.slice(0, 8)}-${width}x${height}`, mobile = width <= 761, { cdp, proc, dir, version } = await launch(width, height, mobile); result.viewport = [width, height]; result.browserVersion = version; result.captures = []
  try {
    await cdp.nav(`${BASE}?view=workspace&mode=switch`); await waitCatalog(cdp); await searchCount(cdp, ctx.multiBrand)
    result.search = await cdp.eval(`(() => { const element = document.querySelector('.switch-find-results-list'), style = getComputedStyle(element); return { count: element.querySelectorAll('.switch-find-result').length, overflowY: style.overflowY, maxHeight: style.maxHeight, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight } })()`)
    if (width <= 760) { assert.equal(result.search.overflowY, 'visible'); assert.equal(result.search.maxHeight, 'none'); assert.ok(result.search.scrollHeight <= result.search.clientHeight + 1, '760 search has nested vertical scroll') } else { assert.equal(result.search.overflowY, 'auto'); assert.notEqual(result.search.maxHeight, 'none'); assert.ok(result.search.scrollHeight > result.search.clientHeight, `${width} search did not preserve internal desktop scroll`) }
    result.captures.push(await capture(cdp, prefix, 'boundary-search', ['.switch-find-results-list'])); await selectCurrent(cdp, ctx); await chooseSku(cdp, ctx); result.progress = await progressAudit(cdp); if (width <= 760) assertMobileProgress(result.progress); else assert.ok(result.progress.items.some((item) => !item.numberAbove), `${width} unexpectedly uses mobile progress stacking`); result.captures.push(await capture(cdp, prefix, 'boundary-progress', ['.switch-progress']))
    result.network = await networkEvidence(cdp); assert.equal(result.network.sentAnalytics.length, 0); assert.equal(result.network.sentWrites.length, 0); result.status = 'pass'
  } catch (error) { result.status = 'fail'; result.error = String(error?.stack || error); throw error } finally { cdp.close(); proc.kill('SIGTERM'); await sleep(80); try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}

const ctx = await catalogContext(); const browserVersion = execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim()
const report = { productSha: PRODUCT_SHA, qaSha: QA_SHA, status: 'running', browserVersion, koreanFont: execFileSync('fc-match', [':lang=ko'], { encoding: 'utf8' }).trim(), context: { current: ctx.current, sku: ctx.sku, multiBrand: ctx.multiBrand, longCandidate: LONG_CANDIDATE }, expected: { mobileSteps: 'number above full label; exactly one aria-current=step; no horizontal progress scroll', mobileSearch: 'document scroll only; zero/one content-sized; query + same last row + measured return position retained with no corrective scroll', mobileCandidate: 'image then full-width full product name; exact enabled 상세 보기 → button reachable', boundary: '760 mobile behavior; 761 and 1280 preserve non-mobile nested search scroll and progress layout', state: 'real SKU plus CHANGE/KEEP survive explicit KEEP→CHANGE and CHANGE→SKU roundtrips' }, mobile: [], boundary: [], error: null }
function saveReport() { writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2)) }
try {
  for (const [width, height] of [[360, 844], [390, 900]]) { const item = { viewport: [width, height], status: 'running', search: {}, roundtrip: {}, captures: [] }; report.mobile.push(item); saveReport(); await mobileFlow(width, height, ctx, item); saveReport() }
  for (const [width, height] of [[760, 900], [761, 900], [1280, 900]]) { const item = { viewport: [width, height], status: 'running', captures: [] }; report.boundary.push(item); saveReport(); await boundaryFlow(width, height, ctx, item); saveReport() }
  report.status = 'pass'
} catch (error) { report.status = 'fail'; report.error = String(error?.stack || error); throw error } finally { saveReport() }
console.log('PR23_MOBILE_SWITCH_DESIGN_QA_PASS', JSON.stringify({ productSha: PRODUCT_SHA, qaSha: QA_SHA, browserVersion, current: [ctx.current.brand, ctx.current.canonical_name], sku: ctx.sku.package_size_text, mobile: report.mobile.map((item) => ({ viewport: item.viewport, returnDeltaY: item.search?.returnState?.deltaY, returnVisible: item.search?.returnState?.row?.visible, progress: item.progress?.items.map((step) => ({ text: step.text, current: step.current, numberAbove: step.numberAbove })), candidate: item.candidate?.name, titleVertical: item.candidate?.scroll?.slice(2), detailButton: item.detailReach?.after?.text, writes: item.network?.sentWrites?.length, analytics: item.network?.sentAnalytics?.length })), boundary: report.boundary.map((item) => ({ viewport: item.viewport, search: item.search, progress: item.progress?.items.map((step) => ({ text: step.text, numberAbove: step.numberAbove })) })) }))