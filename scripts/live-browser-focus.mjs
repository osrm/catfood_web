import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const HILLS = 'product_84eb3905fc56f218'
const ROYAL = 'product_5b13354ad9792881'
const OUT = 'qa-artifacts-final'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.seq = 1
    this.pending = new Map()
    this.requests = new Map()
    this.restResponses = []
    this.networkFailures = []
    this.consoleErrors = []
  }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
        return
      }
      if (message.method === 'Network.requestWillBeSent') this.requests.set(message.params.requestId, message.params.request?.url ?? '')
      if (message.method === 'Network.responseReceived') {
        const response = message.params.response
        if (response?.url?.includes('.supabase.co/rest/v1/')) {
          const parsed = new URL(response.url)
          this.restResponses.push({ path: parsed.pathname, status: response.status })
        }
      }
      if (message.method === 'Network.loadingFailed' && message.params.errorText !== 'net::ERR_ABORTED') {
        this.networkFailures.push({
          url: this.requests.get(message.params.requestId) ?? '',
          error: message.params.errorText,
          blockedReason: message.params.blockedReason ?? null,
        })
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'uncaught exception')
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').filter(Boolean).join(' ') || 'console.error')
      }
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(method)
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
  async wait(expression, label, timeout = 60000) {
    const end = Date.now() + timeout
    let last = null
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch (error) { last = error }
      await sleep(150)
    }
    const diag = await this.diagnostics()
    throw new Error(`timeout ${label}${last ? ` (${last.message})` : ''}; diagnostics=${JSON.stringify(diag)}`)
  }
  async navigate(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, `document ready ${url}`)
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, `app root ${url}`)
  }
  async viewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  }
  async screenshot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  async key(key, code = key) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
  }
  async diagnostics() {
    let page = {}
    try {
      page = await this.eval(`({href:location.href, ready:document.readyState, title:document.title, body:(document.body?.innerText||'').slice(0,500)})`)
    } catch {}
    return {
      page,
      recentRest: this.restResponses.slice(-12),
      recentFailures: this.networkFailures.slice(-8),
      consoleErrors: this.consoleErrors.slice(-8),
    }
  }
  resetNetworkLog() { this.restResponses.length = 0; this.networkFailures.length = 0 }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const binary = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)
  assert.ok(binary, 'Chrome/Chromium binary not found')
  const port = 9900 + (process.pid % 80)
  const profile = `/tmp/catfood-final-${process.pid}`
  rmSync(profile, { recursive: true, force: true })
  const proc = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,1100', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 6000) stderr = stderr.slice(-6000) })
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (proc.exitCode != null) throw new Error(`Chrome exited early (${proc.exitCode}): ${stderr}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return { proc, profile, binary, cdp: new Cdp(page.webSocketDebuggerUrl) }
    } catch {}
    await sleep(150)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome debugging endpoint timeout: ${stderr}`)
}

function log(name, value) { console.log(`FINAL_QA ${name} :: ${typeof value === 'string' ? value : JSON.stringify(value)}`) }

async function waitWorkspace(cdp) {
  await cdp.wait(`document.querySelector('.workspace, .research-shell, .research-stage, .detail-stage, .compare-stage, .home-shell')`, 'workspace shell')
}

async function getCompareIds(cdp) {
  await cdp.viewport(1440, 1100, false)
  await cdp.navigate(`${BASE}?view=workspace&applied=1`)
  await waitWorkspace(cdp)
  await cdp.wait(`document.querySelectorAll('.research-result-card').length >= 5`, 'five catalog result cards')
  const ids = await cdp.eval(`[...document.querySelectorAll('.research-result-card')].slice(0,5).map((node)=>node.dataset.productId).filter(Boolean)`)
  assert.equal(ids.length, 5)
  return ids
}

async function searchHistory(cdp) {
  await cdp.viewport(1440, 1100, false)
  await cdp.navigate(`${BASE}?view=workspace&mode=lookup`)
  await waitWorkspace(cdp)
  await cdp.wait(`document.querySelector('.lookup-input')`, 'lookup input')
  const initialLength = await cdp.eval('history.length')
  await cdp.eval(`document.querySelector('.lookup-input').focus(); true`)
  let prefix = ''
  const samples = []
  for (const char of ['1', '1', '+']) {
    prefix += char
    await cdp.send('Input.insertText', { text: char })
    await cdp.wait(`document.querySelector('.lookup-input')?.value === ${JSON.stringify(prefix)}`, `lookup value ${prefix}`)
    await sleep(120)
    samples.push({ value: prefix, history: await cdp.eval('history.length'), search: await cdp.eval('location.search') })
  }
  assert.ok(samples.every((sample) => sample.history === initialLength), JSON.stringify(samples))
  await cdp.wait(`document.querySelectorAll('.research-result-card').length > 0`, 'lookup result after typed query')
  const selectedId = await cdp.eval(`document.querySelector('.research-result-card')?.dataset.productId`)
  assert.ok(selectedId)
  await cdp.eval(`document.querySelector('.research-result-card').click(); true`)
  await cdp.wait(`document.querySelector('.research-quick-view')`, 'lookup quick view')
  const clicked = await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find((node)=>node.textContent.includes('상세 보기')); if(!b)return false; b.click(); return true })()`)
  assert.equal(clicked, true)
  await cdp.wait(`document.querySelector('.detail-stage')`, 'detail from lookup')
  const detailHistory = await cdp.eval('history.length')
  assert.ok(detailHistory > initialLength)
  await cdp.eval('history.back(); true')
  await cdp.wait(`document.querySelector('.lookup-input')?.value === '11+' && !document.querySelector('.detail-stage')`, 'lookup state after back')
  await cdp.wait(`document.querySelectorAll('.research-result-card').length > 0`, 'lookup results after back')
  const restored = await cdp.eval(`({value:document.querySelector('.lookup-input').value, search:location.search, quick:Boolean(document.querySelector('.research-quick-view')), activeId:document.activeElement?.dataset?.productId||null})`)
  assert.equal(restored.value, '11+')
  assert.ok(restored.search.includes('q=11%2B') || restored.search.includes('q=11+'), restored.search)
  log('search-history', { initialLength, samples, detailHistory, restored })
}

async function detailKeyboard(cdp) {
  await cdp.navigate(`${BASE}?view=workspace&detail=${HILLS}&detailTab=overview`)
  await waitWorkspace(cdp)
  await cdp.wait(`document.querySelector('.detail-stage') && document.querySelector('.detail-tabs [role="tab"]')`, 'detail tabs')
  await cdp.eval(`document.querySelector('.detail-tabs [role="tab"][aria-selected="true"]').focus(); true`)
  const read = () => cdp.eval(`(() => { const a=document.activeElement; const s=document.querySelector('.detail-tabs [role="tab"][aria-selected="true"]'); const g=getComputedStyle(a); return {selected:s?.textContent.trim()||'', active:a?.textContent.trim()||'', search:location.search, outlineWidth:g.outlineWidth, outlineStyle:g.outlineStyle} })()`)
  await cdp.key('ArrowRight', 'ArrowRight'); await sleep(180); let state = await read(); assert.equal(state.selected, '영양'); assert.equal(state.active, '영양')
  await cdp.key('ArrowRight', 'ArrowRight'); await sleep(180); state = await read(); assert.equal(state.selected, '원재료'); assert.equal(state.active, '원재료')
  await cdp.key('Home', 'Home'); await sleep(180); state = await read(); assert.equal(state.selected, '개요'); assert.equal(state.active, '개요')
  await cdp.key('End', 'End'); await sleep(180); state = await read(); assert.equal(state.selected, '제조 · 유통'); assert.equal(state.active, '제조 · 유통'); assert.ok(state.search.includes('detailTab=context'))
  assert.notEqual(state.outlineStyle, 'none', JSON.stringify(state)); assert.notEqual(state.outlineWidth, '0px', JSON.stringify(state))
  await cdp.wait(`!document.querySelector('.detail-body')?.innerText.includes('제조 정보를 불러오는 중입니다.')`, 'manufacturing content')
  const manufacturing = await cdp.eval(`document.querySelector('.detail-body')?.innerText||''`)
  assert.ok(manufacturing.includes('제조국') && manufacturing.includes('제조 업체'), manufacturing.slice(0,800))
  await cdp.screenshot('manufacturing-1440.png')
  log('detail-keyboard', { state, manufacturing: manufacturing.slice(0,900).replaceAll('\n', ' | ') })
}

async function compareKeyboardAndMobile(cdp, ids) {
  const compare = ids.join(',')
  await cdp.viewport(1440, 1100, false)
  await cdp.navigate(`${BASE}?view=workspace&applied=1&compare=${compare}&compareOpen=1&compareTab=overview`)
  await waitWorkspace(cdp)
  await cdp.wait(`document.querySelector('.compare-stage') && document.querySelectorAll('.compare-product-head').length === 5`, 'five product compare')
  await cdp.eval(`document.querySelector('.compare-tabs [role="tab"][aria-selected="true"]').focus(); true`)
  const read = () => cdp.eval(`(() => { const a=document.activeElement; const s=document.querySelector('.compare-tabs [role="tab"][aria-selected="true"]'); const g=getComputedStyle(a); return {selected:s?.textContent.trim()||'', active:a?.textContent.trim()||'', search:location.search, outlineWidth:g.outlineWidth, outlineStyle:g.outlineStyle} })()`)
  await cdp.key('ArrowRight', 'ArrowRight'); await sleep(180); let state = await read(); assert.equal(state.selected, '영양'); assert.equal(state.active, '영양')
  await cdp.key('End', 'End'); await sleep(180); state = await read(); assert.equal(state.selected, '원재료'); assert.equal(state.active, '원재료')
  await cdp.key('Home', 'Home'); await sleep(180); state = await read(); assert.equal(state.selected, '개요'); assert.equal(state.active, '개요'); assert.ok(state.search.includes('compareTab=overview') || !state.search.includes('compareTab='))
  assert.notEqual(state.outlineStyle, 'none', JSON.stringify(state)); assert.notEqual(state.outlineWidth, '0px', JSON.stringify(state))
  log('compare-keyboard', state)

  for (const width of [390, 360]) {
    await cdp.viewport(width, 844, true)
    await sleep(250)
    const geometry = await cdp.eval(`(() => {
      const rect = (node) => { if(!node)return null; const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom} }
      const wrap=document.querySelector('.compare-table-wrap')
      const label=document.querySelector('.compare-row-label')
      const heads=[...document.querySelectorAll('.compare-product-head')]
      const names=[...document.querySelectorAll('.compare-product-copy > strong')].map((node)=>({text:node.textContent.trim(), clientWidth:node.clientWidth, scrollWidth:node.scrollWidth, height:node.getBoundingClientRect().height}))
      const remove=document.querySelector('.compare-remove')
      const detail=document.querySelector('.compare-detail-link')
      const back=document.querySelector('.compare-header > button')
      const tabs=[...document.querySelectorAll('.compare-tabs [role="tab"]')].map(rect)
      return {width:innerWidth, wrap:{clientWidth:wrap.clientWidth,scrollWidth:wrap.scrollWidth,scrollLeft:wrap.scrollLeft,rect:rect(wrap)}, label:{position:getComputedStyle(label).position,left:getComputedStyle(label).left,rect:rect(label)}, heads:heads.map(rect), names, remove:rect(remove), detail:rect(detail), back:rect(back), tabs}
    })()`)
    assert.ok(geometry.wrap.scrollWidth > geometry.wrap.clientWidth, JSON.stringify(geometry.wrap))
    assert.equal(geometry.label.position, 'sticky')
    assert.ok(geometry.names.every((name) => name.text && name.scrollWidth <= name.clientWidth + 1), JSON.stringify(geometry.names))
    assert.ok(geometry.back.height >= 44, JSON.stringify(geometry.back))
    assert.ok(geometry.detail.height >= 44, JSON.stringify(geometry.detail))
    assert.ok(geometry.tabs.every((tab) => tab.height >= 44), JSON.stringify(geometry.tabs))
    assert.ok(geometry.remove.width >= 44 && geometry.remove.height >= 44, `compare remove touch target ${width}px: ${JSON.stringify(geometry.remove)}`)
    await cdp.screenshot(`compare-${width}-start.png`)

    const beforeLeft = geometry.label.rect.x
    await cdp.eval(`(() => { const w=document.querySelector('.compare-table-wrap'); w.scrollLeft=Math.min(320,w.scrollWidth-w.clientWidth); w.dispatchEvent(new Event('scroll')); return w.scrollLeft })()`)
    await sleep(250)
    const after = await cdp.eval(`(() => { const rect=(n)=>{const r=n.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width}}; const w=document.querySelector('.compare-table-wrap'), label=document.querySelector('.compare-row-label'); const heads=[...document.querySelectorAll('.compare-product-head')].map((node)=>({text:node.querySelector('strong')?.textContent.trim()||'',...rect(node)})); return {scrollLeft:w.scrollLeft,label:rect(label),wrap:rect(w),visible:heads.filter((h)=>h.right>Math.max(label.getBoundingClientRect().right,w.getBoundingClientRect().left)&&h.x<w.getBoundingClientRect().right)} })()`)
    assert.ok(after.scrollLeft > 0, JSON.stringify(after))
    assert.ok(Math.abs(after.label.x - beforeLeft) <= 2, JSON.stringify(after))
    assert.ok(after.visible.length >= 1 && after.visible.every((head) => head.text), JSON.stringify(after.visible))
    await cdp.screenshot(`compare-${width}-scrolled.png`)
    log(`mobile-${width}`, { geometry, after })
  }
}

async function blockedRequestRetry(cdp) {
  await cdp.viewport(1440, 1100, false)
  cdp.resetNetworkLog()
  await cdp.send('Network.setBlockedURLs', { urls: ['*compare_product_nutrition*'] })
  try {
    await cdp.navigate(`${BASE}?view=workspace&detail=${HILLS}&detailTab=nutrition`)
    await waitWorkspace(cdp)
    await cdp.wait(`document.querySelector('.detail-state.is-error[role="alert"]')`, 'blocked nutrition error')
    const error = await cdp.eval(`document.querySelector('.detail-state.is-error[role="alert"]')?.innerText||''`)
    assert.ok(error.includes('영양 정보를 불러오지 못했습니다') && error.includes('다시 시도'), error)
    const blocked = cdp.networkFailures.filter((item) => item.url.includes('compare_product_nutrition'))
    assert.ok(blocked.length > 0, JSON.stringify(cdp.networkFailures))
    await cdp.screenshot('nutrition-blocked-error.png')
    await cdp.send('Network.setBlockedURLs', { urls: [] })
    const clicked = await cdp.eval(`(() => { const b=document.querySelector('.detail-state.is-error[role="alert"] button'); if(!b)return false; b.click(); return true })()`)
    assert.equal(clicked, true)
    await cdp.wait(`!document.querySelector('.detail-state.is-error[role="alert"]') && document.querySelector('.detail-body')?.innerText.includes('3,772 kcal/kg')`, 'nutrition retry recovery')
    const successful = cdp.restResponses.filter((item) => item.path.includes('compare_product_nutrition') && item.status >= 200 && item.status < 300)
    assert.ok(successful.length > 0, JSON.stringify(cdp.restResponses))
    await cdp.screenshot('nutrition-retry-recovered.png')
    log('blocked-retry', { error, blocked, successful, recentRest: cdp.restResponses.slice(-10) })
  } finally {
    await cdp.send('Network.setBlockedURLs', { urls: [] }).catch(() => {})
  }
}

async function fontScreens(cdp, ids) {
  await cdp.viewport(1440, 1100, false)
  await cdp.navigate(BASE)
  await waitWorkspace(cdp)
  await cdp.screenshot('home-1440-korean-font.png')
  await cdp.viewport(390, 844, true)
  await cdp.navigate(`${BASE}?view=workspace&detail=${HILLS}&detailTab=nutrition`)
  await waitWorkspace(cdp)
  await cdp.wait(`document.querySelector('.detail-body')?.innerText.includes('3,772 kcal/kg')`, 'Hill mobile nutrition')
  await cdp.screenshot('hills-detail-390-korean-font.png')
  log('font-screens', { ids, koreanFont: await cdp.eval(`getComputedStyle(document.body).fontFamily`) })
}

mkdirSync(OUT, { recursive: true })
const failures = []
const { proc, profile, binary, cdp } = await launch()
try {
  await cdp.connect()
  log('environment', { binary, physicalDevice: false, viewports: ['1440x1100', '390x844 emulation', '360x844 emulation'] })
  let ids = null
  const steps = [
    ['search-history', () => searchHistory(cdp)],
    ['detail-keyboard-manufacturing', () => detailKeyboard(cdp)],
    ['compare-setup', async () => { ids = await getCompareIds(cdp); log('compare-ids', ids) }],
    ['compare-keyboard-mobile', () => compareKeyboardAndMobile(cdp, ids)],
    ['blocked-request-retry', () => blockedRequestRetry(cdp)],
    ['font-screens', () => fontScreens(cdp, ids)],
  ]
  for (const [name, run] of steps) {
    try {
      await run()
      console.log(`FINAL_QA PASS ${name}`)
    } catch (error) {
      const diagnostics = await cdp.diagnostics()
      failures.push({ name, error: error.stack ?? String(error), diagnostics })
      console.error(`FINAL_QA FAIL ${name} :: ${error.stack ?? error}`)
      console.error(`FINAL_QA DIAGNOSTICS ${name} :: ${JSON.stringify(diagnostics)}`)
    }
  }
  if (failures.length) {
    console.error(`FINAL_QA FAILURES :: ${JSON.stringify(failures)}`)
    process.exitCode = 1
  } else {
    console.log('FINAL_QA ALL_REMAINING_CHECKS_PASS')
  }
} finally {
  cdp.close()
  proc.kill('SIGTERM')
  await sleep(250)
  if (proc.exitCode == null) proc.kill('SIGKILL')
  rmSync(profile, { recursive: true, force: true })
}
