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

async function context() {
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
  const sku = variants.find((row) => /1\s*kg/i.test(row.package_size_text ?? ''))
  assert.ok(sku, 'AATU 연어 1 kg SKU not found')
  const eligible = products.filter((row) => row.product_id !== current.product_id)
  const longest = [...eligible].sort((a, b) => b.canonical_name.length - a.canonical_name.length)[0]
  const unknown = eligible.find((row) => !row.feed_type || !row.life_stage || !(row.manufacturing_country_codes?.length))
  const five = []
  for (const row of [longest, unknown, ...eligible]) {
    if (row && !five.some((item) => item.product_id === row.product_id)) five.push(row)
    if (five.length === 5) break
  }
  assert.equal(five.length, 5)
  return { current, sku, longest, unknown, five }
}

const emptyCriteria = () => ({ feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false })
function snapshot(ctx, ids) {
  return { version: 1, state: {
    query: 'AATU 연어', currentProductId: ctx.current.product_id, variantSelection: { kind: 'variant', variantId: ctx.sku.variant_id },
    change: emptyCriteria(), keep: emptyCriteria(), changeBrand: false, keepBrand: false, ingredientAvoidTerms: [], noChangeIntent: true,
    step: 'results', visibleCandidateCount: 40, selectedCandidateId: null, compareIds: ids, compareOpen: true, compareTab: 'overview', detailProductId: null, detailTab: 'overview',
  } }
}

class Browser {
  constructor(ws) { this.wsUrl = ws; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await this.eval(`Boolean(${expression})`)) return } catch {} await sleep(100) } throw new Error(`timeout: ${label}`) }
  async navigate(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState==='complete'`, 'ready'); await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'app'); await this.eval('document.fonts?.ready'); await sleep(250) }
  async shot(path) { const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(path, Buffer.from(image.data, 'base64')) }
  close() { try { this.ws?.close() } catch {} }
}

async function launch({ width, height, mobile, fixture = null }) {
  const chrome = '/usr/bin/google-chrome'; assert.ok(existsSync(chrome))
  const port = 9900 + (process.pid % 50) + launchIndex++ * 80
  const dir = `/tmp/pr37-final2-${process.pid}-${launchIndex}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) {
        const browser = new Browser(page.webSocketDebuggerUrl); await browser.connect()
        await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
        await browser.send('Emulation.setUserAgentOverride', { userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 Chrome/152.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: mobile ? 'Android' : 'Linux' })
        await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
          ${fixture ? `sessionStorage.setItem(${js(STORAGE_KEY)}, ${js(JSON.stringify(fixture))});` : ''}
          const nativeFetch=window.fetch.bind(window); window.__qaBlockedAnalytics=0; window.__qaBlockedWrites=0;
          window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||''; const method=String(init.method||(input&&input.method)||'GET').toUpperCase(); if(url.includes('/functions/v1/decision-intake')){window.__qaBlockedAnalytics+=1; return Promise.reject(new TypeError('blocked analytics'))} if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlockedWrites+=1; return Promise.reject(new TypeError('blocked write'))} return nativeFetch(input,init)};
        })();` })
        return { browser, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}
async function cleanup(handle) { handle.browser.close(); handle.proc.kill('SIGTERM'); await sleep(150); if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL'); try { rmSync(handle.dir, { recursive: true, force: true }) } catch {} }

async function pointer(browser, selector, { texts = [], index = 0 } = {}) {
  const target = await browser.eval(`(() => { const nodes=[...document.querySelectorAll(${js(selector)})].filter((node)=>${js(texts)}.every((text)=>node.textContent?.includes(text))); const node=nodes[${index}]; if(!node)return null; node.scrollIntoView({block:'center',inline:'center'}); const r=node.getBoundingClientRect(); window.__qaClick=null; node.addEventListener('click',(e)=>window.__qaClick={trusted:e.isTrusted,text:node.textContent.trim()},{once:true,capture:true}); return {x:r.left+r.width/2,y:r.top+r.height/2,text:node.textContent.trim()}; })()`)
  assert.ok(target, `pointer target missing: ${selector} ${texts.join('+')} [${index}]`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(160)
  assert.equal((await browser.eval('window.__qaClick'))?.trusted, true, `click not trusted: ${selector}`)
  return target
}
async function type(browser, selector, text) {
  await pointer(browser, selector)
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
  await browser.send('Input.insertText', { text })
  await browser.wait(`document.querySelector(${js(selector)})?.value===${js(text)}`, `typed ${text}`)
  await sleep(180)
}
async function session(browser) { return browser.eval(`(()=>{const raw=sessionStorage.getItem(${js(STORAGE_KEY)});return raw?JSON.parse(raw).state:null})()`) }
async function network(browser, currentId) {
  const compare = browser.requests.filter((r) => r.url.includes('/compare_product_nutrition') || r.url.includes('/compare_product_ingredients'))
  for (const request of compare) assert.equal((new URL(request.url).searchParams.get('product_id') ?? '').includes(currentId), false)
  const writes = browser.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(r.method))
  const analytics = browser.requests.filter((r) => r.url.includes('/functions/v1/decision-intake'))
  assert.equal(writes.length, 0); assert.equal(analytics.length, 0)
  return { compareFilters: compare.map((r) => new URL(r.url).searchParams.get('product_id')), blocked: await browser.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`) }
}

async function actualJourney(ctx) {
  const handle = await launch({ width: 360, height: 844, mobile: true }); const { browser } = handle
  try {
    await browser.navigate(`${CANDIDATE_BASE}?view=workspace&mode=switch`)
    await browser.wait(`document.querySelector('.switch-find-search input')`, 'current search')
    await type(browser, '.switch-find-search input', 'AATU 연어')
    await browser.wait(`[...document.querySelectorAll('.switch-find-result')].some((node)=>node.textContent.includes('AATU')&&node.textContent.includes('연어'))`, 'exact current result')
    await pointer(browser, '.switch-find-result', { texts: ['AATU', '연어'] })
    await browser.wait(`document.querySelector('.switch-current-preview')`, 'current preview')
    const previewName = await browser.eval(`document.querySelector('.switch-current-preview h2')?.textContent.trim()`)
    assert.equal(previewName, '연어', 'wrong AATU product selected')
    await pointer(browser, '.switch-current-preview .switch-primary-action')
    await browser.wait(`document.querySelector('.switch-sku-list')`, 'sku step')
    await browser.wait(`[...document.querySelectorAll('.switch-sku-option')].some((node)=>node.textContent.replaceAll(' ','').includes('1kg'))`, '1 kg sku')
    await pointer(browser, '.switch-sku-option', { texts: ['1', 'kg'] })
    await pointer(browser, '.switch-step-actions .switch-primary-action')
    await browser.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'change')
    await pointer(browser, '.switch-no-change')
    await pointer(browser, '.switch-step-actions .switch-primary-action')
    await browser.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'keep')
    await pointer(browser, '.switch-step-actions .switch-primary-action')
    await browser.wait(`document.querySelectorAll('.switch-candidate-row').length>=2`, 'results')
    const firstTwo = await browser.eval(`[...document.querySelectorAll('.switch-candidate-row')].slice(0,2).map((row)=>({brand:row.querySelector('.switch-candidate-identity>span')?.textContent.trim(),name:row.querySelector('.switch-candidate-identity>strong')?.textContent.trim()}))`)
    for (const index of [0, 1]) {
      await pointer(browser, '.switch-candidate-row', { index })
      await browser.wait(`document.querySelector('.switch-candidate-inspector')`, `inspector ${index}`)
      await pointer(browser, '.switch-candidate-inspector .switch-compare-action', { texts: ['비교에 추가'] })
      await pointer(browser, '.switch-candidate-inspector .switch-preview-topline button')
      await browser.wait(`!document.querySelector('.switch-candidate-inspector')`, `close ${index}`)
    }
    await browser.wait(`document.querySelector('.switch-compare-dock')`, 'compare dock')
    const before = await session(browser); assert.equal(before.compareIds.length, 2)
    await pointer(browser, '.switch-compare-dock > button', { texts: ['비교 보기'] })
    await browser.wait(`document.querySelectorAll('.compare-mobile-candidate-picker button').length===2`, 'compare')
    const picker = await browser.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].map((button)=>button.textContent.trim())`)
    assert.equal(picker[0].includes(firstTwo[0].brand) && picker[0].includes(firstTwo[0].name), true)
    assert.equal(picker[1].includes(firstTwo[1].brand) && picker[1].includes(firstTwo[1].name), true)
    await pointer(browser, '.compare-mobile-candidate-picker button', { index: 1 })
    const selectedName = await browser.eval(`document.querySelector('.compare-mobile-product-head.is-candidate > strong')?.textContent.trim()`)
    const firstFactTop = await browser.eval(`document.querySelector('.compare-mobile-overview-row')?.getBoundingClientRect().top`)
    await browser.shot(`${OUT}/360x844-app-journey-compare.png`)
    await pointer(browser, '.compare-mobile-head-actions button', { texts: ['상세 보기'] })
    await browser.wait(`document.querySelector('.detail-stage')`, 'detail')
    await pointer(browser, '.detail-topbar button')
    await browser.wait(`document.querySelector('.compare-switch-mobile-overview')`, 'detail return')
    assert.equal(await browser.eval(`document.querySelector('.compare-mobile-product-head.is-candidate > strong')?.textContent.trim()`), selectedName)
    await pointer(browser, '.compare-mobile-head-actions button', { texts: ['비교에서 제거'] })
    await browser.wait(`!document.querySelector('.compare-mobile-candidate-picker')`, 'single candidate')
    const afterRemoval = await session(browser); assert.equal(afterRemoval.compareIds.length, 1); assert.equal(afterRemoval.compareIds.includes(before.compareIds[1]), false)
    const history = await browser.send('Page.getNavigationHistory'); assert.ok(history.currentIndex > 0)
    const compareEntry = history.entries[history.currentIndex]; const parentEntry = history.entries[history.currentIndex - 1]
    await browser.send('Page.navigateToHistoryEntry', { entryId: parentEntry.id })
    await browser.wait(`document.querySelector('.switch-results-stage')&&!document.querySelector('.compare-stage')`, 'back to results')
    const afterBack = await session(browser); assert.deepEqual(afterBack.compareIds, afterRemoval.compareIds)
    const dock = await browser.eval(`document.querySelector('.switch-compare-dock')?.textContent||''`); assert.equal(dock.includes(selectedName), false)
    await browser.shot(`${OUT}/360x844-app-journey-after-back.png`)
    return { firstTwo, picker, selectedName, firstFactTop, compareIdsBefore: before.compareIds, compareIdsAfterRemoval: afterRemoval.compareIds, appHistoryEntries: { compare: { id: compareEntry.id, url: compareEntry.url }, parent: { id: parentEntry.id, url: parentEntry.url } }, network: await network(browser, ctx.current.product_id) }
  } finally { await cleanup(handle) }
}

async function firstFactFixture(ctx, base, name) {
  const handle = await launch({ width: 360, height: 844, mobile: true, fixture: snapshot(ctx, ctx.five.slice(0, 2).map((row) => row.product_id)) }); const { browser } = handle
  try {
    await browser.navigate(`${base}?view=workspace&mode=switch`)
    await browser.wait(`document.querySelector('.compare-switch-mobile-overview')`, name)
    const row = await browser.eval(`(()=>{const node=[...document.querySelectorAll('.compare-mobile-overview-row')].find((row)=>row.querySelector('.compare-mobile-row-label')?.textContent.trim()==='사료 형태');if(!node)return null;const r=node.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height}})()`)
    assert.ok(row)
    if (name === 'candidate') await browser.shot(`${OUT}/360x844-candidate-first-fact.png`)
    return row
  } finally { await cleanup(handle) }
}

async function mobile390(ctx) {
  const handle = await launch({ width: 390, height: 900, mobile: true, fixture: snapshot(ctx, ctx.five.map((row) => row.product_id)) }); const { browser } = handle
  try {
    await browser.navigate(`${CANDIDATE_BASE}?view=workspace&mode=switch`)
    await browser.wait(`document.querySelectorAll('.compare-mobile-candidate-picker button').length===5`, 'five picker')
    const labels = await browser.eval(`[...document.querySelectorAll('.compare-mobile-candidate-picker button')].map((button)=>button.textContent.trim())`)
    const selected = []
    for (let index = 0; index < 5; index += 1) { await pointer(browser, '.compare-mobile-candidate-picker button', { index }); selected.push(await browser.eval(`document.querySelector('.compare-mobile-product-head.is-candidate > strong')?.textContent.trim()`)) }
    assert.equal(new Set(selected).size, 5)
    const longIndex = ctx.five.findIndex((row) => row.product_id === ctx.longest.product_id); await pointer(browser, '.compare-mobile-candidate-picker button', { index: longIndex })
    const long = await browser.eval(`(()=>{const n=document.querySelector('.compare-mobile-product-head.is-candidate > strong');const s=getComputedStyle(n);return{text:n.textContent.trim(),clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,textOverflow:s.textOverflow}})()`)
    assert.equal(long.text, ctx.longest.canonical_name); assert.equal(long.clientWidth, long.scrollWidth); assert.equal(long.clientHeight, long.scrollHeight); assert.notEqual(long.textOverflow, 'ellipsis')
    const unknownIndex = ctx.five.findIndex((row) => row.product_id === ctx.unknown.product_id); await pointer(browser, '.compare-mobile-candidate-picker button', { index: unknownIndex })
    assert.match(await browser.eval(`document.querySelector('.compare-switch-mobile-overview')?.textContent||''`), /미확인|확인된 값 없음|공식 표기 미확인/)
    await browser.shot(`${OUT}/390x900-five-candidates.png`)
    return { labels, selected, long, unknown: `${ctx.unknown.brand} · ${ctx.unknown.canonical_name}`, network: await network(browser, ctx.current.product_id) }
  } finally { await cleanup(handle) }
}

async function boundary760(ctx) {
  const handle = await launch({ width: 760, height: 900, mobile: true, fixture: snapshot(ctx, ctx.five.map((row) => row.product_id)) }); const { browser } = handle
  try { await browser.navigate(`${CANDIDATE_BASE}?view=workspace&mode=switch`); await browser.wait(`document.querySelector('.compare-switch-mobile-overview')`, '760'); const display = await browser.eval(`({mobile:getComputedStyle(document.querySelector('.compare-switch-mobile-overview')).display,desktop:getComputedStyle(document.querySelector('.compare-switch-overview-desktop')).display})`); assert.notEqual(display.mobile, 'none'); assert.equal(display.desktop, 'none'); await browser.shot(`${OUT}/760x900-mobile-boundary.png`); return display } finally { await cleanup(handle) }
}

async function desktop(ctx, width) {
  const handle = await launch({ width, height: 900, mobile: false, fixture: snapshot(ctx, ctx.five.map((row) => row.product_id)) }); const { browser } = handle
  try {
    await browser.navigate(`${CANDIDATE_BASE}?view=workspace&mode=switch`)
    await browser.wait(`document.querySelector('.compare-switch-overview-desktop')&&getComputedStyle(document.querySelector('.compare-switch-overview-desktop')).display!=='none'`, `${width} desktop`)
    const g = await browser.eval(`(()=>{const wrap=document.querySelector('.compare-table-wrap');wrap.scrollLeft=wrap.scrollWidth-wrap.clientWidth;const row=[...document.querySelectorAll('.compare-switch-overview-row')].find((node)=>node.querySelector('.compare-row-label')?.textContent.trim()==='사료 형태');const label=row.querySelector('.compare-row-label');const current=row.querySelector('.compare-cell.is-current');const last=[...row.querySelectorAll('.compare-cell:not(.is-current)')].at(-1);const heads=[...document.querySelectorAll('.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head)')];const lastHead=heads.at(-1);const detail=lastHead.querySelector('.compare-detail-link');const rect=(n)=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};const wr=rect(wrap),lr=rect(label),cr=rect(current),vr=rect(last),hr=rect(lastHead),dr=rect(detail);const hit=document.elementFromPoint(dr.left+dr.width/2,dr.top+dr.height/2);return{scrollLeft:wrap.scrollLeft,maxScroll:wrap.scrollWidth-wrap.clientWidth,wrap:wr,label:lr,current:cr,last:vr,lastHead:hr,detail:dr,hit:hit===detail||detail.contains(hit),texts:{label:label.textContent.trim(),current:current.textContent.trim(),last:last.textContent.trim()}}})()`)
    assert.ok(g.maxScroll > 0); assert.equal(Math.round(g.scrollLeft), Math.round(g.maxScroll)); assert.equal(g.texts.label, '사료 형태'); assert.ok(g.texts.current && g.texts.last); assert.ok(g.label.left >= g.wrap.left - 1 && g.label.right <= g.wrap.right + 1); assert.ok(g.current.left >= g.label.right - 1 && g.current.right <= g.wrap.right + 1); assert.ok(g.last.left >= g.current.right - 1 && g.last.right <= g.wrap.right + 1); assert.equal(g.hit, true)
    if (width === 761) { await pointer(browser, '.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head)', { index: 4 }); const lastHeadName = await browser.eval(`[...document.querySelectorAll('.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head)')].at(-1)?.querySelector('.compare-product-copy strong')?.textContent.trim()`); assert.ok(lastHeadName); await pointer(browser, '.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head) .compare-detail-link', { index: 4 }); await browser.wait(`document.querySelector('.detail-stage')`, 'last detail pointer'); await pointer(browser, '.detail-topbar button'); await browser.wait(`document.querySelector('.compare-switch-overview-desktop')`, 'return last detail') }
    await browser.shot(`${OUT}/${width}x900-desktop-right-edge.png`)
    return { geometry: g, network: await network(browser, ctx.current.product_id) }
  } finally { await cleanup(handle) }
}

const ctx = await context()
const report = { productSha: PRODUCT_SHA, baselineSha: BASELINE_SHA, browserVersion: execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim(), koreanFont: execFileSync('fc-match', [':lang=ko'], { encoding: 'utf8' }).trim().split('\n')[0], actualJourney: null, fixtures: {}, status: 'running' }
try {
  report.actualJourney = await actualJourney(ctx)
  report.fixtures.baselineFirstFact = await firstFactFixture(ctx, BASELINE_BASE, 'baseline')
  report.fixtures.candidateFirstFact = await firstFactFixture(ctx, CANDIDATE_BASE, 'candidate')
  report.fixtures.firstFactDelta = report.fixtures.candidateFirstFact.top - report.fixtures.baselineFirstFact.top
  report.fixtures.mobile390 = await mobile390(ctx)
  report.fixtures.boundary760 = await boundary760(ctx)
  report.fixtures.desktop761 = await desktop(ctx, 761)
  report.fixtures.desktop1280 = await desktop(ctx, 1280)
  report.status = 'pass'
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR37_REVIEW_FIXES_FINAL2_QA PASS', JSON.stringify({ firstFactDelta: report.fixtures.firstFactDelta, actualCandidate: report.actualJourney.selectedName, d761: report.fixtures.desktop761.geometry, d1280: report.fixtures.desktop1280.geometry }))
} catch (error) {
  report.status = 'fail'; report.error = String(error?.stack ?? error); writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2)); throw error
}
