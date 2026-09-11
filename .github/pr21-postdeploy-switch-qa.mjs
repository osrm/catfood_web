import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'https://osrm.github.io/catfood_web/'
const DEPLOY_SHA = process.env.DEPLOY_SHA ?? 'unknown'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const OUT = 'qa-artifacts'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)

assert.ok(SUPABASE_URL && SUPABASE_KEY, 'public Supabase read config missing')

async function chooseDryProduct() {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/effective_product_catalog_summary`)
  url.searchParams.set('select', 'product_id,brand,canonical_name,feed_type')
  url.searchParams.set('feed_type', 'eq.건식')
  url.searchParams.set('order', 'canonical_name.asc')
  url.searchParams.set('limit', '200')
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true, `catalog read failed: ${response.status}`)
  const rows = await response.json()
  const row = rows.find((item) => item?.feed_type === '건식' && typeof item.canonical_name === 'string' && item.canonical_name.trim())
  assert.ok(row, 'no dry product available for postdeploy path')
  return row
}

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
  async wait(expression, label, ms = 30000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try { if (await this.eval(`Boolean(${expression})`)) return } catch {}
      await sleep(120)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState === 'complete'`, 'document ready')
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'root content')
    await this.eval('document.fonts?.ready')
    await sleep(300)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(150)
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
  const port = 9960 + (process.pid % 20)
  const dir = `/tmp/pr21-postdeploy-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
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
        return { cdp, version, proc, dir }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function clickExact(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${js(text)}); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing exact button: ${text}`)
  await sleep(180)
}

async function clickContains(cdp, text) {
  const ok = await cdp.eval(`(() => { const n=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${js(text)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(ok, true, `missing button containing: ${text}`)
  await sleep(180)
}

async function setSearch(cdp, selector, value) {
  const ok = await cdp.eval(`(() => { const n=document.querySelector(${js(selector)}); if(!n)return false; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(n,${js(value)}); n.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  assert.equal(ok, true, `missing input: ${selector}`)
  await sleep(250)
}

const current = await chooseDryProduct()
const { cdp, version, proc, dir } = await launch()
const report = {
  deploySha: DEPLOY_SHA,
  pageUrl: BASE,
  browserVersion: version,
  koreanFontEnvironment: true,
  cssInjection: false,
  productionWrites: false,
  currentProduct: { product_id: current.product_id, brand: current.brand, canonical_name: current.canonical_name, feed_type: current.feed_type },
  checks: {},
}

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  const url = new URL(BASE)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', 'switch')
  await cdp.nav(url.toString())
  await cdp.wait(`document.body.innerText.includes('데이터 연결됨')`, 'catalog connected')

  await setSearch(cdp, '.switch-find-search input', current.canonical_name)
  await cdp.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes(${js(current.canonical_name)}))`, 'current dry product result')
  const selected = await cdp.eval(`(() => { const n=[...document.querySelectorAll('.switch-find-result')].find(x=>x.textContent.includes(${js(current.canonical_name)})); if(!n)return false; n.click(); return true })()`)
  assert.equal(selected, true, 'could not select current dry product')
  await sleep(200)
  await clickContains(cdp, '이 제품을 현재 사료로 선택')

  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?') || [...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='사용 규격을 모르겠어요')`, 'variant or change step')
  const hasUnknownVariant = await cdp.eval(`[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='사용 규격을 모르겠어요')`)
  if (hasUnknownVariant) await clickExact(cdp, '사용 규격을 모르겠어요')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE step')

  await clickContains(cdp, '특별히 바꾸고 싶은 점 없음')
  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP step')
  await clickExact(cdp, '건식 유지')
  await cdp.shot(`${OUT}/pr21-postdeploy-${DEPLOY_SHA.slice(0,8)}-01-dry-keep.png`)

  await clickContains(cdp, '후보 제품 보기')
  await cdp.wait(`document.querySelector('.switch-results-stage')`, 'initial results')
  await clickExact(cdp, '조건 수정')
  await cdp.wait(`document.body.innerText.includes('무엇을 바꾸고 싶나요?')`, 'CHANGE edit step')

  await clickExact(cdp, '습식')
  const expectedNotice = '사료 형태 유지 조건을 해제했습니다.'
  await cdp.wait(`document.querySelector('[role="status"]')?.textContent.includes(${js(expectedNotice)})`, 'KEEP-clear notice')
  const notice = await cdp.eval(`document.querySelector('[role="status"]')?.textContent.trim()`)
  assert.equal(notice, expectedNotice)
  const fonts = await cdp.platformFonts('[role="status"]')
  assert.ok(fonts.some((font) => /Noto Sans CJK KR/i.test(font.familyName) && font.glyphCount > 0), `Korean status did not use Noto CJK KR: ${JSON.stringify(fonts)}`)
  await cdp.shot(`${OUT}/pr21-postdeploy-${DEPLOY_SHA.slice(0,8)}-02-wet-change-notice.png`)

  await clickExact(cdp, '다음 →')
  await cdp.wait(`document.body.innerText.includes('무엇을 그대로 유지할까요?')`, 'KEEP after wet change')
  const hiddenDryKeep = await cdp.eval(`![...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='건식 유지')`)
  assert.equal(hiddenDryKeep, true, 'stale 건식 KEEP control remained visible')
  await cdp.shot(`${OUT}/pr21-postdeploy-${DEPLOY_SHA.slice(0,8)}-03-dry-keep-cleared.png`)

  await clickContains(cdp, '후보 제품 보기')
  await cdp.wait(`document.querySelector('.switch-results-stage')`, 'final results')
  const final = await cdp.eval(`(() => ({ summary:document.querySelector('.switch-session-bar')?.textContent ?? '', candidateCards:document.querySelectorAll('.switch-candidate-list > *').length }))()`)
  assert.match(final.summary, /CHANGE[^]*습식/)
  const keepPart = final.summary.includes('KEEP') ? final.summary.split('KEEP').slice(1).join('KEEP') : ''
  assert.doesNotMatch(keepPart, /건식/)
  const decisionIntakeRequests = await cdp.eval(`performance.getEntriesByType('resource').map(e=>e.name).filter(name=>name.includes('/functions/v1/decision-intake'))`)
  assert.deepEqual(decisionIntakeRequests, [])
  await cdp.shot(`${OUT}/pr21-postdeploy-${DEPLOY_SHA.slice(0,8)}-04-final-summary.png`)

  report.checks = {
    notice,
    hiddenDryKeep,
    finalSummary: final.summary,
    observedCandidateCards: final.candidateCards,
    decisionIntakeRequests,
    platformFonts: fonts,
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR21_POSTDEPLOY_SWITCH_QA_PASS', JSON.stringify({
    deploySha: DEPLOY_SHA,
    currentProduct: report.currentProduct,
    notice,
    hiddenDryKeep,
    finalSummary: final.summary,
    observedCandidateCards: final.candidateCards,
    platformFonts: fonts,
  }))
} finally {
  cdp.close()
  try { proc.kill('SIGTERM') } catch {}
  rmSync(dir, { recursive: true, force: true })
}
