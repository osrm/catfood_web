import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.MERGE_SHA
const EXPECTED_ASSET = process.env.EXPECTED_ASSET
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const OUT = 'qa-artifacts'
const STORAGE_KEY = 'catfood.switch-session.v1'
const STEP_LABELS = ['현재 제품', '사용 규격', '바꿀 것', '유지할 것', '후보']
const LONG_NAME = '울트라 프로틴+ 스킨 & 코트 & 다이제스티브 캣 레시피'
mkdirSync(OUT, { recursive: true })
assert.ok(MERGE_SHA && EXPECTED_ASSET && SUPABASE_URL && SUPABASE_KEY)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)

async function apiRows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `${view} read failed: ${response.status}`)
  return response.json()
}

async function catalogContext() {
  const rows = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,variant_count',
    order: 'brand.asc,canonical_name.asc', limit: 1000,
  })
  const current = rows.find((row) => row.brand === 'AATU' && row.canonical_name === '연어' && Number(row.variant_count) >= 2)
  assert.ok(current, 'AATU 연어 multi-SKU product missing')
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,display_rank',
    product_id: `eq.${current.product_id}`, order: 'display_rank.asc,variant_id.asc', limit: 50,
  })
  const sku = variants.find((row) => /(^|\s)1\s*kg/i.test(row.package_size_text ?? '')) ?? variants[0]
  assert.ok(sku, 'actual SKU missing')
  const counts = new Map()
  for (const row of rows) if (row.brand) counts.set(row.brand, (counts.get(row.brand) ?? 0) + 1)
  const manyBrand = [...counts.entries()].sort((a, b) => b[1] - a[1]).find(([, count]) => count >= 8)?.[0]
  assert.ok(manyBrand, 'multi-result brand missing')
  return { current, sku, manyBrand }
}

class Cdp {
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
    for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'CSS.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const nativeFetch = window.fetch.bind(window)
      window.__qaBlockedAnalytics = 0
      window.__qaBlockedWrites = 0
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
        if (url.includes('/functions/v1/decision-intake')) {
          window.__qaBlockedAnalytics += 1
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(method)) {
          window.__qaBlockedWrites += 1
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        return nativeFetch(input, init)
      }
    })();` })
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await this.eval(`Boolean(${expression})`)) return } catch {} await sleep(120) } throw new Error(`timeout: ${label}`) }
  async navigate(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState==='complete'`, 'document ready'); await this.wait(`document.querySelector('#root')&&document.body.innerText.length>0`, 'app root'); await this.eval('document.fonts?.ready'); await sleep(250) }
  async screenshot(path) { await this.eval('document.fonts?.ready'); await sleep(100); const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(path, Buffer.from(image.data, 'base64')) }
  async platformFonts(selector) { const { root } = await this.send('DOM.getDocument', { depth: 1 }); const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector }); assert.ok(nodeId, `font node missing: ${selector}`); return (await this.send('CSS.getPlatformFontsForNode', { nodeId })).fonts ?? [] }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome unavailable')
  const port = 9700 + (process.pid % 100) + (width % 31)
  const dir = `/tmp/pr23-post-v2-${width}-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect()
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height })
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' })
        return { cdp, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function setQuery(cdp, value) {
  const ok = await cdp.eval(`(() => { const input=document.querySelector('.switch-find-search input'); if(!input)return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${js(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(ok, true, 'search input missing'); await cdp.wait(`document.querySelector('.switch-find-search input')?.value===${js(value)}`, 'query render'); await sleep(220)
}
async function clickExact(cdp, scope, text) {
  await cdp.wait(`(() => { const root=document.querySelector(${js(scope)}); if(!root)return false; return [...root.querySelectorAll('button')].some((button)=>button.textContent.trim()===${js(text)}&&!button.disabled) })()`, `enabled ${text}`)
  const ok = await cdp.eval(`(() => { const root=document.querySelector(${js(scope)}); const button=[...root.querySelectorAll('button')].find((item)=>item.textContent.trim()===${js(text)}&&!item.disabled); if(!button)return false; button.click(); return true })()`)
  assert.equal(ok, true, `cannot click ${text}`); await sleep(160)
}
async function clickContains(cdp, selector, text) { const ok = await cdp.eval(`(() => { const item=[...document.querySelectorAll(${js(selector)})].find((node)=>node.textContent.includes(${js(text)})); if(!item)return false; item.click(); return true })()`); assert.equal(ok, true, `${selector} missing ${text}`); await sleep(160) }
async function waitState(cdp, expression, label) { await cdp.wait(`(() => { const raw=sessionStorage.getItem(${js(STORAGE_KEY)}); if(!raw)return false; const s=JSON.parse(raw).state; return ${expression} })()`, label) }
async function capture(cdp, prefix, name) { const file = `${prefix}-${name}.png`; await cdp.screenshot(`${OUT}/${file}`); return file }

async function runViewport(width, height, ctx, result) {
  const prefix = `pr23-postdeploy-${MERGE_SHA.slice(0, 8)}-${width}x${height}`
  const { cdp, proc, dir, version } = await launch(width, height)
  result.browserVersion = version; result.captures = []
  try {
    await cdp.navigate(`${BASE}?view=workspace&mode=switch`)
    await cdp.wait(`document.querySelector('.switch-find-search input')`, 'SWITCH search')
    await cdp.wait(`!document.body.innerText.includes('제품 목록을 불러오는 중입니다.')`, 'catalog load')

    await setQuery(cdp, ctx.manyBrand)
    await cdp.wait(`document.querySelectorAll('.switch-find-result').length>1`, 'multi-result search')
    const count = await cdp.eval(`document.querySelectorAll('.switch-find-result').length`)
    const list = await cdp.eval(`(() => { const e=document.querySelector('.switch-find-results-list'),s=getComputedStyle(e); return {count:e.querySelectorAll('.switch-find-result').length,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,overflowY:s.overflowY,maxHeight:s.maxHeight} })()`)
    assert.equal(list.overflowY, 'visible'); assert.equal(list.maxHeight, 'none'); assert.ok(list.scrollHeight <= list.clientHeight + 1, 'mobile results list has internal scroll')
    result.search = { query: ctx.manyBrand, count, list }

    const lastSelector = `.switch-find-result:nth-child(${count})`
    await cdp.eval(`document.querySelector(${js(lastSelector)}).scrollIntoView({block:'center'})`); await sleep(160)
    const beforeY = await cdp.eval('scrollY')
    const lastName = await cdp.eval(`document.querySelector(${js(lastSelector)}).querySelector('.switch-find-result-copy strong').textContent.trim()`)
    result.captures.push(await capture(cdp, prefix, '01-last-result'))
    await cdp.eval(`document.querySelector(${js(lastSelector)}).click()`)
    await cdp.wait(`document.querySelector('.switch-current-preview h2')?.textContent.trim()===${js(lastName)}`, 'preview identity')
    result.captures.push(await capture(cdp, prefix, '02-preview'))
    await clickExact(cdp, '.switch-current-preview', '닫기 ×'); await cdp.wait(`!document.querySelector('.switch-current-preview')`, 'preview closed')
    const returned = await cdp.eval(`(() => { const query=document.querySelector('.switch-find-search input')?.value??null,row=[...document.querySelectorAll('.switch-find-result')].find((item)=>item.querySelector('.switch-find-result-copy strong')?.textContent.trim()===${js(lastName)}); if(!row)return{query,row:null,scrollY}; const r=row.getBoundingClientRect(); return{query,scrollY,row:{name:row.querySelector('.switch-find-result-copy strong')?.textContent.trim(),visible:r.bottom>0&&r.top<innerHeight,fullyVisible:r.top>=0&&r.bottom<=innerHeight,rect:[r.left,r.top,r.width,r.height]}} })()`)
    result.return = { beforeY, afterY: returned.scrollY, deltaY: Math.round(returned.scrollY - beforeY), ...returned }
    assert.equal(returned.query, ctx.manyBrand, 'search query changed after preview close'); assert.equal(returned.row?.name, lastName, 'same result row missing after preview close'); assert.equal(returned.row?.visible, true, 'returned result row not visible'); assert.ok(Math.abs(result.return.deltaY) <= 1, `return position changed ${result.return.deltaY}px`)
    result.captures.push(await capture(cdp, prefix, '03-preview-return'))

    await setQuery(cdp, `${ctx.current.brand} ${ctx.current.canonical_name}`)
    await cdp.wait(`document.querySelectorAll('.switch-find-result').length>0`, 'current food result')
    await clickContains(cdp, '.switch-find-result', ctx.current.canonical_name); await cdp.wait(`document.querySelector('.switch-current-preview')`, 'current preview')
    await clickExact(cdp, '.switch-current-preview', '이 제품을 현재 사료로 선택 →'); await waitState(cdp, `s.step==='sku'`, 'SKU step')
    await cdp.wait(`document.querySelector('.switch-sku-option')&&!document.body.innerText.includes('판매 규격을 불러오는 중입니다.')`, 'SKU load')
    await clickContains(cdp, '.switch-sku-option', ctx.sku.package_size_text); await waitState(cdp, `s.variantSelection?.kind==='variant'&&s.variantSelection.variantId===${js(ctx.sku.variant_id)}`, 'SKU selected')
    result.progress = await cdp.eval(`(() => { const p=document.querySelector('.switch-progress'),items=[...p.querySelectorAll('li')]; return {clientWidth:p.clientWidth,scrollWidth:p.scrollWidth,items:items.map((item)=>({text:item.querySelector('strong')?.textContent.trim(),current:item.getAttribute('aria-current'),classes:item.className}))} })()`)
    assert.deepEqual(result.progress.items.map((item)=>item.text), STEP_LABELS); assert.equal(result.progress.items.filter((item)=>item.current==='step').length, 1, 'exactly one current step expected'); assert.equal(result.progress.clientWidth, result.progress.scrollWidth, 'step labels horizontally scroll')
    result.fonts = await cdp.platformFonts('.switch-progress li[aria-current="step"] strong')
    assert.ok(result.fonts.some((font)=>font.familyName.includes('Noto Sans CJK KR')), `Korean browser font mismatch ${JSON.stringify(result.fonts)}`)
    result.captures.push(await capture(cdp, prefix, '04-progress'))

    await clickExact(cdp, '.switch-step-actions', '다음 →'); await waitState(cdp, `s.step==='change'`, 'CHANGE step')
    await clickExact(cdp, '.switch-step-main', '다른 브랜드로 보기'); await waitState(cdp, `s.changeBrand===true`, 'change brand stored')
    await clickExact(cdp, '.switch-step-actions', '다음 →'); await waitState(cdp, `s.step==='keep'`, 'KEEP step')
    await clickExact(cdp, '.switch-step-main', `${ctx.current.feed_type} 유지`); await waitState(cdp, `s.keep?.feedType===${js(ctx.current.feed_type)}`, 'keep feed type stored')
    await clickExact(cdp, '.switch-step-actions', '후보 제품 보기 →'); await waitState(cdp, `s.step==='results'`, 'results step'); await cdp.wait(`document.querySelector('.switch-results-stage')`, 'results render')
    await cdp.wait(`[...document.querySelectorAll('.switch-candidate-row')].some((item)=>item.textContent.includes(${js(LONG_NAME)}))`, 'long candidate present')
    await clickContains(cdp, '.switch-candidate-row', LONG_NAME)
    await cdp.wait(`document.querySelector('.switch-candidate-inspector .switch-inspector-identity h1')?.textContent.trim()===${js(LONG_NAME)}`, 'long candidate inspector')
    result.candidate = await cdp.eval(`(() => { const box=document.querySelector('.switch-inspector-identity'),image=box.querySelector('.switch-inspector-image'),title=box.querySelector('h1'),br=box.getBoundingClientRect(),ir=image.getBoundingClientRect(),tr=title.getBoundingClientRect(),s=getComputedStyle(title); return {name:title.textContent.trim(),box:[br.left,br.top,br.width,br.height],image:[ir.left,ir.top,ir.width,ir.height],title:[tr.left,tr.top,tr.width,tr.height],titleBelowImage:tr.top>=ir.bottom-1,titleWidthRatio:tr.width/br.width,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,lineClamp:s.webkitLineClamp||null,overflow:s.overflow} })()`)
    assert.equal(result.candidate.name, LONG_NAME); assert.equal(result.candidate.titleBelowImage, true, 'candidate title is not below image'); assert.ok(result.candidate.titleWidthRatio > 0.85, 'candidate title does not use full mobile width'); assert.equal(result.candidate.textOverflow, 'clip'); assert.ok(!result.candidate.lineClamp || result.candidate.lineClamp === 'none', 'candidate title is line-clamped'); assert.equal(result.candidate.overflow, 'visible')
    result.captures.push(await capture(cdp, prefix, '05-long-candidate'))

    result.network = {
      blocked: await cdp.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`),
      sentAnalytics: cdp.requests.filter((request)=>request.url.includes('/functions/v1/decision-intake')),
      sentWrites: cdp.requests.filter((request)=>request.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(request.method)),
      publicReads: cdp.requests.filter((request)=>request.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&request.method==='GET').length,
    }
    assert.equal(result.network.sentAnalytics.length, 0, 'analytics request escaped block'); assert.equal(result.network.sentWrites.length, 0, 'production write request escaped block'); assert.equal(result.network.blocked.writes, 0, 'application attempted a production write')
    result.status = 'pass'
  } catch (error) { result.status = 'fail'; result.error = String(error?.stack || error); throw error } finally { cdp.close(); proc.kill('SIGTERM'); await sleep(80); try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}

const liveHtml = await (await fetch(BASE, { cache: 'no-store' })).text()
assert.ok(liveHtml.includes(`./assets/${EXPECTED_ASSET}`), `live Pages missing merge asset ${EXPECTED_ASSET}`)
const ctx = await catalogContext()
const report = { status: 'running', mergeSha: MERGE_SHA, expectedAsset: EXPECTED_ASSET, pages: BASE, chrome: execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim(), koreanFont: execFileSync('fc-match', [':lang=ko'], { encoding: 'utf8' }).trim(), context: ctx, viewports: [], error: null }
const save = () => writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
try {
  for (const [width, height] of [[360,844],[390,900]]) { const item = { viewport: [width,height], status: 'running', captures: [] }; report.viewports.push(item); save(); await runViewport(width,height,ctx,item); save() }
  report.status = 'pass'
} catch (error) { report.status = 'fail'; report.error = String(error?.stack || error); throw error } finally { save() }
console.log('PR23_POSTDEPLOY_MOBILE_QA_PASS', JSON.stringify({ mergeSha: MERGE_SHA, asset: EXPECTED_ASSET, chrome: report.chrome, viewports: report.viewports.map((item)=>({viewport:item.viewport,returnDeltaY:item.return?.deltaY,steps:item.progress?.items.map((step)=>[step.text,step.current]),candidate:item.candidate?.name,blocked:item.network?.blocked,sentAnalytics:item.network?.sentAnalytics?.length,sentWrites:item.network?.sentWrites?.length,publicReads:item.network?.publicReads})) }))
