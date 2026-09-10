import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const HILLS = 'product_84eb3905fc56f218'
const ROYAL = 'product_5b13354ad9792881'
const OUT = 'qa-artifacts'

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.seq = 1
    this.pending = new Map()
    this.consoleErrors = []
    this.networkFailures = []
    this.restResponses = []
  }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data)
      if (m.id) {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
        return
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'uncaught exception')
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').filter(Boolean).join(' ') || 'console.error')
      }
      if (m.method === 'Network.loadingFailed' && m.params.errorText !== 'net::ERR_ABORTED') {
        this.networkFailures.push(m.params.errorText)
      }
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response
        if (r?.url?.includes('.supabase.co/rest/v1/')) {
          const u = new URL(r.url)
          this.restResponses.push({ path: u.pathname, status: r.status })
        }
      }
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await this.send(method)
  }
  send(method, params = {}) {
    const id = this.seq++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Runtime evaluation failed')
    return result.result?.value
  }
  async wait(expression, label, timeout = 45000) {
    const end = Date.now() + timeout
    let last = null
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch (error) { last = error }
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`)
  }
  async navigate(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, `document ready: ${url}`)
  }
  async viewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  }
  async key(key, code = key) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
  }
  async screenshot(name, quality = 72) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'))
  }
  resetErrors() { this.consoleErrors.length = 0; this.networkFailures.length = 0 }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const binary = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)
  assert.ok(binary, 'Chrome/Chromium binary not found')
  const port = 9800 + (process.pid % 100)
  const dir = `/tmp/catfood-focus-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`, '--window-size=1440,1100', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 5000) stderr = stderr.slice(-5000) })
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (proc.exitCode != null) throw new Error(`Chrome exited early (${proc.exitCode}): ${stderr}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return { proc, cdp: new Cdp(page.webSocketDebuggerUrl), binary, dir }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome remote debugging endpoint timeout: ${stderr}`)
}

async function shell(cdp) {
  await cdp.wait(`document.body && (document.body.innerText.includes('CATFOOD') || document.body.innerText.includes('FELINE ARCHIVE') || document.body.innerText.includes('PRODUCT DETAIL') || document.body.innerText.includes('COMPARE'))`, 'app shell')
}
async function clickExact(cdp, text) {
  assert.equal(await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!b)return false; b.click(); return true })()`), true, `Missing button: ${text}`)
}
async function clickHas(cdp, text) {
  assert.equal(await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!b)return false; b.click(); return true })()`), true, `Missing button containing: ${text}`)
}
function section(name, data = '') { console.log(`AUDIT ${name}${data ? ` :: ${typeof data === 'string' ? data : JSON.stringify(data)}` : ''}`) }

async function directHillAndReload(cdp) {
  await cdp.viewport(1440, 1100, false)
  const url = `${BASE}?view=workspace&detail=${HILLS}&detailTab=nutrition`
  await cdp.navigate(url); await shell(cdp)
  await cdp.wait(`document.querySelector('.detail-stage')`, 'Hill detail')
  await cdp.wait(`!document.querySelector('.detail-body')?.innerText.includes('영양 정보를 불러오는 중입니다.')`, 'Hill nutrition')
  const first = await cdp.eval(`(() => { const body=document.querySelector('.detail-body')?.innerText||''; const subs=[...document.querySelectorAll('.detail-nutrition-subheading')]; const g=subs.find(x=>x.textContent.includes('일반 표시 영양정보')); return {h1:document.querySelector('h1')?.innerText||'', body, general:g?.nextElementSibling?.innerText||'', status:document.querySelector('.detail-nutrition-status')?.innerText||'', error:document.querySelector('.detail-state.is-error')?.innerText||'', href:location.href} })()`)
  assert.equal(first.error, '')
  assert.ok(first.h1.includes('11+') && first.h1.includes('인도어'), first.h1)
  assert.ok(first.body.includes('3,772 kcal/kg'), 'Hill 3772 kcal/kg missing')
  for (const value of ['34.3%', '20.4%', '8.6%']) assert.ok(first.body.includes(value), `Hill Dry Matter ${value} missing`)
  for (const label of ['조단백질', '조지방', '조섬유', '수분', '조회분']) assert.ok(!first.general.includes(label), `General nutrient section unexpectedly contains ${label}: ${first.general}`)
  assert.ok(first.status.includes('조단백질') && first.status.includes('건물 기준 자료만 확인'), first.status)
  assert.ok(first.status.includes('수분') && first.status.includes('미확인'), first.status)
  assert.ok(first.body.includes('건물 기준(Dry Matter) 자료'))
  section('hill-initial', { h1:first.h1, energy:first.body.includes('3,772 kcal/kg'), dm:['34.3%','20.4%','8.6%'].map(v=>first.body.includes(v)), url:first.href })
  await cdp.screenshot('detail-hills-1440.jpg')

  await cdp.eval(`location.reload(); true`)
  await cdp.wait(`document.readyState === 'complete'`, 'Hill hard reload document')
  await shell(cdp)
  await cdp.wait(`document.querySelector('.detail-stage')`, 'Hill detail after hard reload')
  await cdp.wait(`!document.querySelector('.detail-body')?.innerText.includes('영양 정보를 불러오는 중입니다.')`, 'Hill nutrition after hard reload')
  const after = await cdp.eval(`({href:location.href, text:document.querySelector('.detail-body')?.innerText||'', error:document.querySelector('.detail-state.is-error')?.innerText||'', selected:document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim()||''})`)
  section('hill-after-hard-reload', { href:after.href, selected:after.selected, energy:after.text.includes('3,772 kcal/kg'), error:after.error })
  assert.equal(after.error, '')
  assert.equal(after.selected, '영양')
  assert.ok(after.href.includes(`detail=${HILLS}`) && after.href.includes('detailTab=nutrition'))
  assert.ok(after.text.includes('3,772 kcal/kg'), 'Hill energy missing after hard reload')
}

async function royalAndManufacturing(cdp) {
  await cdp.navigate(`${BASE}?view=workspace&detail=${ROYAL}&detailTab=nutrition`); await shell(cdp)
  await cdp.wait(`document.querySelector('.detail-stage')`, 'Royal detail')
  await cdp.wait(`!document.querySelector('.detail-body')?.innerText.includes('영양 정보를 불러오는 중입니다.')`, 'Royal nutrition')
  const n = await cdp.eval(`({h1:document.querySelector('h1')?.innerText||'', text:document.querySelector('.detail-body')?.innerText||'', error:document.querySelector('.detail-state.is-error')?.innerText||''})`)
  assert.equal(n.error, '')
  assert.ok(n.h1.includes('노르웨이') || n.h1.includes('Norwegian'), n.h1)
  assert.ok(/조단백질|조지방|조섬유/.test(n.text) && n.text.includes('%'), n.text.slice(0,400))
  assert.ok(!n.text.includes('건물 기준(Dry Matter) 자료'), 'Unexpected Dry Matter section on Royal Canin comparison product')
  await clickExact(cdp, '원재료')
  await cdp.wait(`!document.querySelector('.detail-body')?.innerText.includes('원재료 정보를 불러오는 중입니다.')`, 'Royal ingredients')
  const i = await cdp.eval(`({text:document.querySelector('.detail-body')?.innerText||'', error:document.querySelector('.detail-state.is-error')?.innerText||''})`)
  assert.equal(i.error, '')
  assert.ok(i.text.includes('출처 원문'), i.text.slice(0,400))
  await clickExact(cdp, '제조 · 유통')
  const m = await cdp.eval(`document.querySelector('.detail-body')?.innerText||''`)
  section('royal', { h1:n.h1, nutritionLoaded:true, ingredientsLoaded:true, manufacturing:m.slice(0,700).replace(/\n/g,' | ') })
  assert.ok(m.includes('제조국'), m)
  assert.ok(m.includes('제조사') || m.includes('제조 공장') || m.includes('공장'), m)
}

async function invalidQuery(cdp) {
  await cdp.navigate(`${BASE}?view=workspace&mode=garbage&feed=BAD&detail=product_invalid&compare=a,a,b,c,d,e,f&compareOpen=1&detailTab=nope&compareTab=nope`); await shell(cdp)
  await cdp.wait(`!location.search.includes('product_invalid')`, 'invalid query sanitation')
  const search = await cdp.eval('location.search')
  for (const bad of ['mode=garbage','feed=BAD','product_invalid','detailTab=nope','compareTab=nope','compare=a']) assert.ok(!search.includes(bad), search)
  section('invalid-query-sanitized', search)
}

async function lookupHistory(cdp) {
  await cdp.navigate(`${BASE}?view=workspace&mode=lookup`); await shell(cdp)
  await cdp.wait(`document.querySelector('.lookup-input')`, 'lookup input')
  const before = await cdp.eval('history.length')
  await cdp.eval(`document.querySelector('.lookup-input').focus(); true`)
  await cdp.send('Input.insertText', { text: '로얄캐닌' })
  await cdp.wait(`document.querySelector('.lookup-input')?.value === '로얄캐닌'`, 'lookup typed value')
  await cdp.wait(`location.search.includes('q=')`, 'lookup query URL')
  await cdp.wait(`document.querySelectorAll('.research-result-card').length > 0`, 'lookup results')
  const afterType = await cdp.eval(`({history:history.length, q:location.search, count:document.querySelectorAll('.research-result-card').length, value:document.querySelector('.lookup-input').value})`)
  assert.equal(afterType.history, before, 'Lookup typing should replaceState rather than add history entries')
  const id = await cdp.eval(`document.querySelector('.research-result-card').dataset.productId`)
  await cdp.eval(`document.querySelector('.research-result-card').click(); true`)
  await cdp.wait(`document.querySelector('.research-quick-view')`, 'lookup quick view')
  await clickHas(cdp, '상세 보기')
  await cdp.wait(`document.querySelector('.detail-stage')`, 'lookup detail')
  const detailHistory = await cdp.eval('history.length')
  assert.ok(detailHistory > before, 'Entering detail should push history')
  await cdp.eval(`history.back(); true`)
  await cdp.wait(`document.querySelector('.lookup-input') && document.querySelector('.research-results-list') && !document.querySelector('.detail-stage')`, 'lookup back')
  await new Promise((resolve) => setTimeout(resolve, 350))
  const restored = await cdp.eval(`({value:document.querySelector('.lookup-input').value, q:location.search, focus:document.activeElement?.dataset?.productId||null, quick:Boolean(document.querySelector('.research-quick-view')), exists:Boolean(document.querySelector('[data-product-id="${id}"]'))})`)
  assert.equal(restored.value, '로얄캐닌')
  assert.ok(restored.q.includes('q='), restored.q)
  assert.equal(restored.focus, id)
  assert.equal(restored.quick, true)
  assert.equal(restored.exists, true)
  section('lookup-history', { before, afterType:afterType.history, detailHistory, resultCount:afterType.count, restored })
}

async function keyboardAndTopNavigation(cdp) {
  await cdp.navigate(`${BASE}?view=workspace&detail=${HILLS}`); await shell(cdp)
  await cdp.wait(`document.querySelector('.detail-stage')`, 'detail for keyboard')
  await clickExact(cdp, '영양 정보 보기')
  await cdp.wait(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() === '영양'`, 'top navigation to nutrition')
  assert.ok((await cdp.eval('location.search')).includes('detailTab=nutrition'))
  await cdp.eval(`document.querySelector('[role="tab"][aria-selected="true"]').focus(); true`)
  await cdp.key('ArrowRight', 'ArrowRight'); await new Promise((r) => setTimeout(r, 180))
  let s = await cdp.eval(`({selected:document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(), active:document.activeElement.textContent.trim()})`)
  assert.deepEqual(s, { selected:'원재료', active:'원재료' })
  await cdp.key('Home', 'Home'); await new Promise((r) => setTimeout(r, 180))
  s = await cdp.eval(`({selected:document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(), active:document.activeElement.textContent.trim()})`)
  assert.deepEqual(s, { selected:'개요', active:'개요' })
  await cdp.key('End', 'End'); await new Promise((r) => setTimeout(r, 180))
  s = await cdp.eval(`(() => {const a=document.activeElement,g=getComputedStyle(a);return{selected:document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(), active:a.textContent.trim(), outline:g.outline, shadow:g.boxShadow}})()`)
  assert.equal(s.selected, '제조 · 유통'); assert.equal(s.active, '제조 · 유통')
  assert.ok(s.outline !== 'none' || (s.shadow && s.shadow !== 'none'), JSON.stringify(s))
  section('detail-keyboard', s)
}

async function compareDesktop(cdp) {
  await cdp.navigate(`${BASE}?view=workspace&applied=1`); await shell(cdp)
  await cdp.wait(`document.querySelectorAll('.research-result-card').length >= 6`, 'catalog IDs for compare')
  const ids = await cdp.eval(`[...document.querySelectorAll('.research-result-card')].slice(0,6).map(x=>x.dataset.productId)`)
  const requested = [ids[0], ids[0], ...ids.slice(1,6)]
  await cdp.navigate(`${BASE}?view=workspace&applied=1&compare=${requested.join(',')}&compareOpen=1&compareTab=nutrition`); await shell(cdp)
  await cdp.wait(`document.querySelectorAll('.compare-product-head').length === 5`, '5-product compare')
  assert.equal(await cdp.eval(`document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim()`), '영양')
  await cdp.eval(`document.querySelector('[role="tab"][aria-selected="true"]').focus(); true`)
  await cdp.key('End','End'); await new Promise((r)=>setTimeout(r,180))
  let key = await cdp.eval(`({selected:document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(),active:document.activeElement.textContent.trim()})`)
  assert.deepEqual(key,{selected:'원재료',active:'원재료'})
  await cdp.key('Home','Home'); await new Promise((r)=>setTimeout(r,180))
  key = await cdp.eval(`({selected:document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(),active:document.activeElement.textContent.trim()})`)
  assert.deepEqual(key,{selected:'개요',active:'개요'})
  await cdp.screenshot('compare-5-desktop-1440.jpg')
  const before = await cdp.eval(`document.querySelectorAll('.compare-product-head').length`)
  await cdp.eval(`document.querySelector('.compare-remove').click(); true`)
  await cdp.wait(`document.querySelectorAll('.compare-product-head').length === ${before-1}`, 'compare removal')
  await clickExact(cdp, '← 제품 목록으로')
  await cdp.wait(`document.querySelector('.research-results-list')`, 'return from compare')
  const href = await cdp.eval('location.href')
  assert.ok(!href.includes(ids[0]), `Removed compare product returned in URL: ${href}`)
  section('compare-desktop', { requested:requested.length, uniqueRendered:5, keyboard:true, removedPersists:true })
  return ids.slice(0,5)
}

async function mobileCompare(cdp, ids, width) {
  await cdp.viewport(width, 844, true)
  await cdp.navigate(`${BASE}?view=workspace&applied=1&compare=${ids.join(',')}&compareOpen=1&compareTab=ingredients`); await shell(cdp)
  await cdp.wait(`document.querySelectorAll('.compare-product-head').length === 5`, `${width}px compare heads`)
  await cdp.wait(`!document.querySelector('.compare-state')?.innerText.includes('원재료 정보를 불러오는 중입니다.')`, `${width}px ingredients`)
  const layout = await cdp.eval(`(() => {
    const wrap=document.querySelector('.compare-table-wrap'), label=document.querySelector('.compare-row-label'), ls=getComputedStyle(label)
    const controls=[...document.querySelectorAll('.compare-remove,.compare-detail-link,.compare-header>button,.compare-tabs button')].map(x=>({text:x.textContent.trim(),h:x.getBoundingClientRect().height,w:x.getBoundingClientRect().width,font:parseFloat(getComputedStyle(x).fontSize)})).filter(x=>x.h>0)
    const names=[...document.querySelectorAll('.compare-product-copy>strong')].map(x=>({text:x.textContent.trim(),font:parseFloat(getComputedStyle(x).fontSize),height:x.getBoundingClientRect().height,scrollWidth:x.scrollWidth,clientWidth:x.clientWidth}))
    const longest=[...document.querySelectorAll('.compare-ingredient-text')].sort((a,b)=>b.textContent.length-a.textContent.length)[0]
    const lg=longest?getComputedStyle(longest):null
    return {innerWidth,docWidth:document.documentElement.scrollWidth,wrap:{client:wrap.clientWidth,scroll:wrap.scrollWidth,overflow:getComputedStyle(wrap).overflowX},sticky:{position:ls.position,left:ls.left,width:label.getBoundingClientRect().width},controls,names,longest:longest?{length:longest.textContent.length,scroll:longest.scrollWidth,client:longest.clientWidth,overflowWrap:lg.overflowWrap,wordBreak:lg.wordBreak,font:parseFloat(lg.fontSize)}:null}
  })()`)
  assert.ok(layout.wrap.scroll > layout.wrap.client, JSON.stringify(layout.wrap))
  assert.ok(['auto','scroll'].includes(layout.wrap.overflow), JSON.stringify(layout.wrap))
  assert.equal(layout.sticky.position, 'sticky'); assert.equal(parseFloat(layout.sticky.left), 0)
  assert.ok(layout.sticky.width <= 112, JSON.stringify(layout.sticky))
  assert.ok(layout.docWidth <= layout.innerWidth + 2, JSON.stringify({doc:layout.docWidth,inner:layout.innerWidth}))
  for (const c of layout.controls) assert.ok(c.h >= 44, `Small touch target at ${width}px: ${JSON.stringify(c)}`)
  for (const n of layout.names) assert.ok(n.font >= 13, `Small product name at ${width}px: ${JSON.stringify(n)}`)
  if (layout.longest) assert.ok(layout.longest.scroll <= layout.longest.client + 2 || ['anywhere','break-word'].includes(layout.longest.overflowWrap) || ['break-all','break-word'].includes(layout.longest.wordBreak), JSON.stringify(layout.longest))
  await cdp.screenshot(`compare-5-mobile-${width}.jpg`, 78)
  section(`mobile-${width}`, layout)
}

async function failureAndRetry(cdp) {
  await cdp.viewport(1440,1100,false)
  await cdp.navigate(`${BASE}?view=workspace&applied=1`); await shell(cdp)
  await cdp.wait(`document.querySelector('.research-result-card')`, 'catalog before blocked request')
  const id = await cdp.eval(`document.querySelector('.research-result-card').dataset.productId`)
  cdp.resetErrors()
  await cdp.send('Network.setBlockedURLs', { urls:['*compare_product_nutrition*'] })
  await cdp.eval(`document.querySelector('[data-product-id="${id}"]').click(); true`)
  await cdp.wait(`document.querySelector('.research-quick-view')`, 'quick view before blocked detail')
  await clickHas(cdp, '상세 보기')
  await cdp.wait(`document.querySelector('.detail-stage')`, 'blocked detail')
  await clickExact(cdp, '영양 정보 보기')
  await cdp.wait(`document.querySelector('.detail-body .detail-state.is-error')`, 'blocked nutrition error', 20000)
  const error = await cdp.eval(`({role:document.querySelector('.detail-body .detail-state.is-error').getAttribute('role'), text:document.querySelector('.detail-body .detail-state.is-error').innerText, retry:[...document.querySelectorAll('.detail-body button')].some(x=>x.textContent.trim()==='다시 시도')})`)
  assert.equal(error.role,'alert'); assert.equal(error.retry,true); assert.ok(error.text.includes('다시 시도'))
  await cdp.send('Network.setBlockedURLs', { urls:[] })
  cdp.resetErrors()
  await clickExact(cdp, '다시 시도')
  await cdp.wait(`!document.querySelector('.detail-body .detail-state.is-error') && !document.querySelector('.detail-body')?.innerText.includes('영양 정보를 불러오는 중입니다.')`, 'nutrition retry recovery')
  section('failure-retry', { accessibleAlert:true, retry:true, recovered:true })
}

mkdirSync(OUT, { recursive:true })
const { proc, cdp, binary, dir } = await launch()
console.log(`AUDIT browser :: ${binary}; target=${BASE}; desktop=1440x1100; mobile=390x844/360x844 emulation; physical-device=false`)
try {
  await cdp.connect()
  await directHillAndReload(cdp)
  await royalAndManufacturing(cdp)
  await invalidQuery(cdp)
  await lookupHistory(cdp)
  await keyboardAndTopNavigation(cdp)
  const ids = await compareDesktop(cdp)
  await mobileCompare(cdp, ids, 390)
  await mobileCompare(cdp, ids, 360)
  await failureAndRetry(cdp)
  const rest = [...new Map(cdp.restResponses.map((x)=>[`${x.path}:${x.status}`,x])).values()]
  section('public-rest', rest)
  section('console-errors-after-normal-flows', [...new Set(cdp.consoleErrors)].filter(Boolean))
  section('network-failures-after-normal-flows', [...new Set(cdp.networkFailures)].filter(Boolean))
  assert.deepEqual([...new Set(cdp.consoleErrors)].filter(Boolean), [], 'Unexpected console errors after retry recovery')
  assert.deepEqual([...new Set(cdp.networkFailures)].filter(Boolean), [], 'Unexpected network failures after retry recovery')
  console.log('AUDIT PASS :: focused live-browser audit complete')
} finally {
  cdp.close()
  proc.kill('SIGTERM')
  await new Promise((r)=>setTimeout(r,250))
  if (proc.exitCode == null) proc.kill('SIGKILL')
  rmSync(dir, { recursive:true, force:true })
}
