import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const CANDIDATE_BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/catfood_web/'
const BASELINE_BASE = process.env.BASELINE_BASE ?? 'http://127.0.0.1:4174/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA ?? 'unknown'
const BASELINE_SHA = process.env.BASELINE_SHA ?? 'unknown'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const STORAGE_KEY = 'catfood.switch-session.v1'
const OUT = 'qa-artifacts'
mkdirSync(OUT, { recursive: true })
assert.ok(SUPABASE_URL && SUPABASE_KEY, 'public Supabase read config missing')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)
let launchIndex = 0

async function apiRows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view} read failed: ${response.status}`)
  return response.json()
}

async function makeContext() {
  const products = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,manufacturing_country_codes',
    order: 'brand.asc,canonical_name.asc',
    limit: 1000,
  })
  const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어')
  assert.ok(current, 'AATU 연어 current food not found')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,units_per_sale,display_rank',
    product_id: `eq.${current.product_id}`,
    order: 'display_rank.asc,variant_id.asc',
    limit: 100,
  })
  const sku = variants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? ''))
  assert.ok(sku, 'AATU 연어 1 kg SKU not found')

  const eligible = products.filter((row) => row.product_id !== current.product_id)
  const longest = [...eligible].sort((a, b) => b.canonical_name.length - a.canonical_name.length)[0]
  const unknown = eligible.find((row) => !row.feed_type || !row.life_stage || !(row.manufacturing_country_codes?.length))
  assert.ok(longest && unknown, 'long/unknown candidates not found')
  const five = []
  for (const product of [longest, unknown, ...eligible]) {
    if (!five.some((row) => row.product_id === product.product_id)) five.push(product)
    if (five.length === 5) break
  }
  assert.equal(five.length, 5, 'five fixture candidates required')
  return { current, sku, five, longest, unknown }
}

function emptyCriteria() {
  return { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false }
}

function snapshot(ctx, compareIds) {
  return {
    version: 1,
    state: {
      query: `${ctx.current.brand} ${ctx.current.canonical_name}`,
      currentProductId: ctx.current.product_id,
      variantSelection: { kind: 'variant', variantId: ctx.sku.variant_id },
      change: emptyCriteria(),
      keep: emptyCriteria(),
      changeBrand: false,
      keepBrand: false,
      ingredientAvoidTerms: [],
      noChangeIntent: true,
      step: 'results',
      visibleCandidateCount: 40,
      selectedCandidateId: null,
      compareIds,
      compareOpen: true,
      compareTab: 'overview',
      detailProductId: null,
      detailTab: 'overview',
    },
  }
}

class Browser {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(domain)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await this.eval(`Boolean(${expression})`)) return } catch {} await sleep(120) } throw new Error(`timeout: ${label}`) }
  async navigate(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState === 'complete'`, 'document ready'); await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'app root'); await this.eval('document.fonts?.ready'); await sleep(300) }
  async shot(path) { await this.eval('document.fonts?.ready'); await sleep(100); const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(path, Buffer.from(image.data, 'base64')) }
  close() { try { this.ws?.close() } catch {} }
}

async function launch({ width, height, mobile, fixture = null }) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9800 + (process.pid % 80) + launchIndex++ * 100
  const dir = `/tmp/pr37-review-${process.pid}-${launchIndex}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const browser = new Browser(page.webSocketDebuggerUrl)
        await browser.connect()
        await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await browser.send('Emulation.setUserAgentOverride', { userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: mobile ? 'Android' : 'Linux' })
        await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
          ${fixture ? `sessionStorage.setItem(${js(STORAGE_KEY)}, ${js(JSON.stringify(fixture))});` : ''}
          const nativeFetch = window.fetch.bind(window)
          window.__qaBlockedAnalytics = 0
          window.__qaBlockedWrites = 0
          window.fetch = (input, init = {}) => {
            const url = typeof input === 'string' ? input : (input && input.url) || ''
            const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
            if (url.includes('/functions/v1/decision-intake')) { window.__qaBlockedAnalytics += 1; return Promise.reject(new TypeError('QA blocked analytics before send')) }
            if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) { window.__qaBlockedWrites += 1; return Promise.reject(new TypeError('QA blocked production write before send')) }
            return nativeFetch(input, init)
          }
        })();` })
        return { browser, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function cleanup({ browser, proc, dir }) {
  browser.close(); proc.kill('SIGTERM'); await sleep(150); if (proc.exitCode == null) proc.kill('SIGKILL'); try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

async function pointerClick(browser, selector, { text = null, index = 0 } = {}) {
  const target = await browser.eval(`(() => {
    const nodes=[...document.querySelectorAll(${js(selector)})]
    const filtered=${text ? `nodes.filter((node)=>node.textContent?.includes(${js(text)}))` : 'nodes'}
    const node=filtered[${index}]
    if(!node)return null
    node.scrollIntoView({block:'center',inline:'center'})
    const rect=node.getBoundingClientRect()
    window.__qaTrustedClick=null
    node.addEventListener('click',(event)=>{window.__qaTrustedClick={trusted:event.isTrusted,text:node.textContent.trim()}},{once:true,capture:true})
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,text:node.textContent.trim()}
  })()`)
  assert.ok(target, `pointer target missing: ${selector} ${text ?? ''} [${index}]`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none', buttons: 0, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(180)
  const event = await browser.eval('window.__qaTrustedClick')
  assert.equal(event?.trusted, true, `untrusted click: ${selector} ${text ?? ''}`)
  return { target, event }
}

async function typeInto(browser, selector, text) {
  await pointerClick(browser, selector)
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
  await browser.send('Input.insertText', { text })
  await browser.wait(`document.querySelector(${js(selector)})?.value.includes(${js(text)})`, `typed ${text}`)
  await sleep(200)
}

async function sessionState(browser) {
  return browser.eval(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); return raw ? JSON.parse(raw).state : null })()`)
}

async function networkReport(browser, currentId) {
  const compareRequests = browser.requests.filter((request) => request.url.includes('/compare_product_nutrition') || request.url.includes('/compare_product_ingredients'))
  for (const request of compareRequests) {
    const filter = new URL(request.url).searchParams.get('product_id') ?? ''
    assert.equal(filter.includes(currentId), false, `current food leaked into compare request: ${filter}`)
  }
  const sentAnalytics = browser.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const sentWrites = browser.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  const blocked = await browser.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`)
  assert.equal(sentAnalytics.length, 0, 'analytics request was sent')
  assert.equal(sentWrites.length, 0, 'Supabase write request was sent')
  return { compareRequests: compareRequests.map((request) => new URL(request.url).searchParams.get('product_id')), blocked, sentAnalytics: sentAnalytics.length, sentWrites: sentWrites.length }
}

async function actualMobileJourney(ctx) {
  const handle = await launch({ width: 360, height: 844, mobile: true })
  const { browser } = handle
  try {
    await browser.navigate(`${CANDIDATE_BASE}?view=workspace&mode=switch`)
    await browser.wait(`document.querySelector('.switch-find-search input')`, 'SWITCH current search')
    await typeInto(browser, '.switch-find-search input', 'AATU 연어')
    await browser.wait(`[...document.querySelectorAll('.switch-find-result')].some((node)=>node.textContent.includes('AATU')&&node.textContent.includes('연어'))`, 'AATU result')
    await pointerClick(browser, '.switch-find-result', { text: 'AATU' })
    await browser.wait(`document.querySelector('.switch-current-preview')`, 'current preview')
    await pointerClick(browser, '.switch-current-preview .switch-primary-action')
    await browser.wait(`document.querySelector('.switch-sku-list')`, 'SKU step')
    await pointerClick(browser, '.switch-sku-option', { text: '1 kg' })
    await pointerClick(browser, '.switch-step-actions .switch-primary-action')
    await browser.wait(`[...document.querySelectorAll('h1')].some((node)=>node.textContent.includes('무엇을 바꾸고 싶나요'))`, 'CHANGE step')
    await pointerClick(browser, '.switch-no-change')
    await pointerClick(browser, '.switch-step-actions .switch-primary-action')
    await browser.wait(`[...document.querySelectorAll('h1')].some((node)=>node.textContent.includes('무엇을 그대로 유지할까요'))`, 'KEEP step')
    await pointerClick(browser, '.switch-step-actions .switch-primary-action')
    await browser.wait(`document.querySelectorAll('.switch-candidate-row').length>=2`, 'candidate results')

    const firstTwo = await browser.eval(`[...document.querySelectorAll('.switch-candidate-row')].slice(0,2).map((row)=>({brand:row.querySelector('.switch-candidate-identity>span')?.textContent.trim(),name:row.querySelector('.switch-candidate-identity>strong')?.textContent.trim()}))`)
    assert.equal(firstTwo.length, 2)
    assert.notEqual(firstTwo[0].name, firstTwo[1].name)

    await pointerClick(browser, '.switch-candidate-row', { index: 0 })
    await browser.wait(`document.querySelector('.switch-candidate-inspector')`, 'first inspector')
    await pointerClick(browser, '.switch-candidate-inspector .switch-compare-action', { text: '비교에 추가' })
    await pointerClick(browser, '.switch-candidate-inspector .switch-preview-topline button')
    await browser.wait(`!document.querySelector('.switch-candidate-inspector')`, 'first inspector close')

    await pointerClick(browser, '.switch-candidate-row', { index: 1 })
    await browser.wait(`document.querySelector('.switch-candidate-inspector')`, 'second inspector')
    await pointerClick(browser, '.switch-candidate-inspector .switch-compare-action', { text: '비교에 추가' })
    await pointerClick(browser, '.switch-candidate-inspector .switch-preview-topline button')
    await browser.wait(`document.querySelector('.switch-compare-dock')`, 'compare dock')
    const beforeCompare = await sessionState(browser)
    assert.deepEqual(beforeCompare.compareIds.length, 2)
    await pointerClick(browser, '.switch-compare-dock > button', { text: '비교 보기' })
    await browser.wait(`document.querySelector('.compare-switch-mobile-overview') && document.querySelectorAll('.compare-mobile-candidate-picker button').length===2`, 'mobile compare')

    const pickerLabels = await browser.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].map((button)=>button.textContent.trim())`)
    assert.equal(pickerLabels.every((label)=>label.includes(' · ')), true, `picker lacks brand/product separator: ${pickerLabels.join(' | ')}`)
    assert.equal(pickerLabels[0].includes(firstTwo[0].brand) && pickerLabels[0].includes(firstTwo[0].name), true)
    assert.equal(pickerLabels[1].includes(firstTwo[1].brand) && pickerLabels[1].includes(firstTwo[1].name), true)

    await pointerClick(browser, '.compare-mobile-candidate-picker button', { index: 1 })
    const selectedName = await browser.eval(`document.querySelector('.compare-mobile-product-head.is-candidate > strong')?.textContent.trim()`)
    assert.equal(selectedName, firstTwo[1].name)
    const firstFactTop = await browser.eval(`document.querySelector('.compare-mobile-overview-row')?.getBoundingClientRect().top`)
    await browser.shot(`${OUT}/360x844-app-journey-compare.png`)

    await pointerClick(browser, '.compare-mobile-head-actions button', { text: '상세 보기' })
    await browser.wait(`document.querySelector('.detail-stage')`, 'detail from compare')
    await pointerClick(browser, '.detail-topbar button')
    await browser.wait(`document.querySelector('.compare-switch-mobile-overview')`, 'return from detail')
    const returnedName = await browser.eval(`document.querySelector('.compare-mobile-product-head.is-candidate > strong')?.textContent.trim()`)
    assert.equal(returnedName, selectedName, 'local displayed candidate changed after detail roundtrip')

    await pointerClick(browser, '.compare-mobile-head-actions button', { text: '비교에서 제거' })
    await browser.wait(`document.querySelectorAll('.compare-mobile-candidate-picker button').length===0`, 'single candidate after removal')
    const afterRemoval = await sessionState(browser)
    assert.equal(afterRemoval.compareIds.length, 1)
    assert.equal(afterRemoval.compareIds.includes(beforeCompare.compareIds[1]), false, 'removed candidate still in compareIds')

    const history = await browser.send('Page.getNavigationHistory')
    assert.ok(history.currentIndex > 0, 'app did not create a compare history parent')
    const currentEntry = history.entries[history.currentIndex]
    const previousEntry = history.entries[history.currentIndex - 1]
    await browser.send('Page.navigateToHistoryEntry', { entryId: previousEntry.id })
    await browser.wait(`document.querySelector('.switch-results-stage') && !document.querySelector('.compare-stage')`, 'browser back to results')
    const afterBack = await sessionState(browser)
    assert.deepEqual(afterBack.compareIds, afterRemoval.compareIds, 'browser back restored removed candidate')
    const dockText = await browser.eval(`document.querySelector('.switch-compare-dock')?.textContent || ''`)
    assert.equal(dockText.includes(selectedName), false, 'removed candidate reappeared in compare dock')
    await browser.shot(`${OUT}/360x844-app-journey-after-back.png`)

    return {
      firstTwo,
      pickerLabels,
      selectedName,
      firstFactTop,
      compareIdsBefore: beforeCompare.compareIds,
      compareIdsAfterRemoval: afterRemoval.compareIds,
      compareHistory: { currentEntry: { id: currentEntry.id, url: currentEntry.url }, previousEntry: { id: previousEntry.id, url: previousEntry.url } },
      network: await networkReport(browser, ctx.current.product_id),
    }
  } finally {
    await cleanup(handle)
  }
}

async function fixtureMobile(ctx, base, label, width, height, compareIds) {
  const handle = await launch({ width, height, mobile: true, fixture: snapshot(ctx, compareIds) })
  const { browser } = handle
  try {
    await browser.navigate(`${base}?view=workspace&mode=switch`)
    await browser.wait(`document.querySelector('.compare-switch-mobile-overview')`, `${label} mobile fixture`)
    const firstFact = await browser.eval(`(() => { const rows=[...document.querySelectorAll('.compare-mobile-overview-row')]; const row=rows.find((node)=>node.querySelector('.compare-mobile-row-label')?.textContent.trim()==='사료 형태'); if(!row)return null; const r=row.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; })()`)
    assert.ok(firstFact, `${label}: first product fact missing`)
    if (label.includes('candidate')) await browser.shot(`${OUT}/${width}x${height}-${label}.png`)
    return { firstFact }
  } finally { await cleanup(handle) }
}

async function fixture390(ctx) {
  const handle = await launch({ width: 390, height: 900, mobile: true, fixture: snapshot(ctx, ctx.five.map((row) => row.product_id)) })
  const { browser } = handle
  try {
    await browser.navigate(`${CANDIDATE_BASE}?view=workspace&mode=switch`)
    await browser.wait(`document.querySelectorAll('.compare-mobile-candidate-picker button').length===5`, 'five picker choices')
    const labels = await browser.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].map((button)=>button.textContent.trim())`)
    assert.equal(labels.length, 5)
    const selectedNames = []
    for (let index = 0; index < 5; index += 1) {
      await pointerClick(browser, '.compare-mobile-candidate-picker button', { index })
      selectedNames.push(await browser.eval(`document.querySelector('.compare-mobile-product-head.is-candidate > strong')?.textContent.trim()`))
    }
    assert.equal(new Set(selectedNames).size, 5, 'five fixture candidates were not individually selectable')

    const longButtonIndex = ctx.five.findIndex((row) => row.product_id === ctx.longest.product_id)
    await pointerClick(browser, '.compare-mobile-candidate-picker button', { index: longButtonIndex })
    const longName = await browser.eval(`(() => { const n=document.querySelector('.compare-mobile-product-head.is-candidate > strong'); const s=getComputedStyle(n); return {text:n.textContent.trim(),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,overflow:s.overflow,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace}; })()`)
    assert.equal(longName.text, ctx.longest.canonical_name)
    assert.equal(longName.clientWidth, longName.scrollWidth, 'long candidate name clipped horizontally')
    assert.equal(longName.clientHeight, longName.scrollHeight, 'long candidate name clipped vertically')
    assert.notEqual(longName.textOverflow, 'ellipsis')

    const unknownIndex = ctx.five.findIndex((row) => row.product_id === ctx.unknown.product_id)
    await pointerClick(browser, '.compare-mobile-candidate-picker button', { index: unknownIndex })
    const unknownText = await browser.eval(`document.querySelector('.compare-switch-mobile-overview')?.textContent || ''`)
    assert.match(unknownText, /미확인|확인된 값 없음|공식 표기 미확인/)
    await browser.shot(`${OUT}/390x900-five-candidates.png`)
    return { labels, selectedNames, longName, unknown: { product: `${ctx.unknown.brand} · ${ctx.unknown.canonical_name}`, hasUnknownCopy: true }, network: await networkReport(browser, ctx.current.product_id) }
  } finally { await cleanup(handle) }
}

async function desktopRightEdge(ctx, width, height) {
  const handle = await launch({ width, height, mobile: false, fixture: snapshot(ctx, ctx.five.map((row) => row.product_id)) })
  const { browser } = handle
  try {
    await browser.navigate(`${CANDIDATE_BASE}?view=workspace&mode=switch`)
    await browser.wait(`document.querySelector('.compare-switch-overview-desktop') && getComputedStyle(document.querySelector('.compare-switch-overview-desktop')).display !== 'none'`, `${width} desktop fixture`)
    const geometry = await browser.eval(`(() => {
      const wrap=document.querySelector('.compare-table-wrap')
      wrap.scrollLeft=wrap.scrollWidth-wrap.clientWidth
      const row=[...document.querySelectorAll('.compare-switch-overview-row')].find((node)=>node.querySelector('.compare-row-label')?.textContent.trim()==='사료 형태')
      const label=row?.querySelector('.compare-row-label')
      const current=row?.querySelector('.compare-cell.is-current')
      const candidates=row ? [...row.querySelectorAll('.compare-cell:not(.is-current)')] : []
      const last=candidates.at(-1)
      const heads=[...document.querySelectorAll('.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head)')]
      const lastHead=heads.at(-1)
      const detail=lastHead?.querySelector('.compare-detail-link')
      const rect=(node)=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
      const wr=rect(wrap), lr=rect(label), cr=rect(current), vr=rect(last), hr=rect(lastHead), dr=rect(detail)
      const point=document.elementFromPoint(dr.left+dr.width/2,dr.top+dr.height/2)
      return {scrollLeft:wrap.scrollLeft,maxScroll:wrap.scrollWidth-wrap.clientWidth,wrap:wr,label:lr,current:cr,last:vr,lastHead:hr,detail:dr,hit:point===detail||detail.contains(point),labelText:label.textContent.trim(),currentText:current.textContent.trim(),lastText:last.textContent.trim()}
    })()`)
    assert.ok(geometry.maxScroll > 0, `${width}: expected horizontal overflow`)
    assert.equal(Math.round(geometry.scrollLeft), Math.round(geometry.maxScroll), `${width}: did not reach right edge`)
    assert.equal(geometry.labelText, '사료 형태')
    assert.ok(geometry.currentText.length > 0 && geometry.lastText.length > 0)
    assert.ok(geometry.label.left >= geometry.wrap.left - 1 && geometry.label.right <= geometry.wrap.right + 1, `${width}: row label not visible`)
    assert.ok(geometry.current.left >= geometry.label.right - 1 && geometry.current.right <= geometry.wrap.right + 1, `${width}: current value not visible`)
    assert.ok(geometry.last.left >= geometry.current.right - 1 && geometry.last.right <= geometry.wrap.right + 1, `${width}: last candidate value not simultaneously visible`)
    assert.equal(geometry.hit, true, `${width}: last candidate detail button is covered at right edge`)
    if (width === 761) {
      await pointerClick(browser, '.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head):last-child .compare-detail-link')
      await browser.wait(`document.querySelector('.detail-stage')`, 'last candidate detail hit-test')
      await pointerClick(browser, '.detail-topbar button')
      await browser.wait(`document.querySelector('.compare-switch-overview-desktop')`, 'return after last detail hit-test')
    }
    await browser.shot(`${OUT}/${width}x${height}-desktop-right-edge.png`)
    return { geometry, network: await networkReport(browser, ctx.current.product_id) }
  } finally { await cleanup(handle) }
}

async function boundary760(ctx) {
  const handle = await launch({ width: 760, height: 900, mobile: true, fixture: snapshot(ctx, ctx.five.map((row) => row.product_id)) })
  const { browser } = handle
  try {
    await browser.navigate(`${CANDIDATE_BASE}?view=workspace&mode=switch`)
    await browser.wait(`getComputedStyle(document.querySelector('.compare-switch-mobile-overview')).display !== 'none'`, '760 mobile boundary')
    const displays = await browser.eval(`({mobile:getComputedStyle(document.querySelector('.compare-switch-mobile-overview')).display,desktop:getComputedStyle(document.querySelector('.compare-switch-overview-desktop')).display})`)
    assert.notEqual(displays.mobile, 'none')
    assert.equal(displays.desktop, 'none')
    await browser.shot(`${OUT}/760x900-mobile-boundary.png`)
    return displays
  } finally { await cleanup(handle) }
}

const browserVersion = execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim()
const koreanFont = execFileSync('fc-match', [':lang=ko'], { encoding: 'utf8' }).trim().split('\n')[0]
const ctx = await makeContext()
const report = { productSha: PRODUCT_SHA, baselineSha: BASELINE_SHA, browserVersion, koreanFont, actualJourney: null, fixture: {}, status: 'running' }
try {
  report.actualJourney = await actualMobileJourney(ctx)
  report.fixture.baseline360 = await fixtureMobile(ctx, BASELINE_BASE, 'baseline', 360, 844, ctx.five.slice(0, 2).map((row) => row.product_id))
  report.fixture.candidate360 = await fixtureMobile(ctx, CANDIDATE_BASE, 'candidate-first-fact', 360, 844, ctx.five.slice(0, 2).map((row) => row.product_id))
  report.fixture.firstFactDelta = report.fixture.candidate360.firstFact.top - report.fixture.baseline360.firstFact.top
  report.fixture.mobile390 = await fixture390(ctx)
  report.fixture.boundary760 = await boundary760(ctx)
  report.fixture.desktop761 = await desktopRightEdge(ctx, 761, 900)
  report.fixture.desktop1280 = await desktopRightEdge(ctx, 1280, 900)
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR37_REVIEW_FIXES_QA PASS', JSON.stringify({ firstFactDelta: report.fixture.firstFactDelta, actualCandidate: report.actualJourney.selectedName, desktop761: report.fixture.desktop761.geometry, desktop1280: report.fixture.desktop1280.geometry }))
} catch (error) {
  report.status = 'fail'
  report.error = String(error?.stack ?? error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}
