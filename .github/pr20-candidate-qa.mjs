import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/'
const SOURCE_SHA = process.env.SOURCE_SHA ?? 'unknown'
const OUT = 'qa-artifacts'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  async wait(expression, label, ms = 60000) {
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
  async viewport(width, height, mobile = true) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(200)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const bin = '/usr/bin/google-chrome'
  assert.ok(existsSync(bin), 'Chrome unavailable')
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
  const port = 9940 + (process.pid % 40)
  const dir = `/tmp/pr20-qa-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 220; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const cdp = new Cdp(page.webSocketDebuggerUrl)
        await cdp.connect()
        return { version, proc, dir, cdp }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function waitCatalog(cdp, cards = false) {
  await cdp.wait(`document.querySelector('.research-status span:last-child')?.textContent?.includes('데이터 연결됨')`, 'catalog connected')
  if (cards) await cdp.wait(`document.querySelectorAll('.research-result-card').length > 0`, 'result cards')
  await sleep(350)
}

async function click(cdp, selector, text = null) {
  const point = await cdp.eval(`(() => {
    const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})]
    const node=${text === null ? 'nodes[0]' : `nodes.find((n)=>n.textContent?.includes(${JSON.stringify(text)}))`}
    if(!node)return null
    node.scrollIntoView({block:'center',inline:'nearest'})
    const r=node.getBoundingClientRect()
    return{x:r.left+r.width/2,y:r.top+r.height/2}
  })()`)
  assert.ok(point, `missing ${selector} ${text ?? ''}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(250)
}

async function tab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await sleep(90)
}

async function wheel(cdp, deltaY, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  await sleep(160)
}

async function setSearch(cdp, selector, value) {
  await cdp.eval(`(() => {
    const node=document.querySelector(${JSON.stringify(selector)})
    if(!node)return false
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)})
    node.dispatchEvent(new Event('input',{bubbles:true}))
    return true
  })()`)
  await sleep(250)
}

async function waitImages(cdp) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const ready = await cdp.eval(`[...document.querySelectorAll('.research-result-image')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).every(n=>n.complete)`)
    if (ready) break
    await sleep(120)
  }
  await sleep(200)
}

const applied = (extra = '') => `${BASE}?view=workspace&applied=1${extra}`

async function mobileResults(cdp, width, height) {
  const prefix = `${OUT}/candidate-${SOURCE_SHA.slice(0, 8)}-${width}x${height}`
  await cdp.viewport(width, height)
  await cdp.nav(applied('&targets=indoor,sterilized&features=weight_management,digestive,urinary'))
  await waitCatalog(cdp, true)
  await waitImages(cdp)

  const many = await cdp.eval(`(() => {
    const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    const cards=[...document.querySelectorAll('.research-result-card')]
    const entries=cards.map(card=>{const name=card.querySelector('.research-result-identity strong'),pack=card.querySelector('.research-result-packages'),relation=card.querySelector('.relation-line strong');return{card,name,pack,relation,len:(name?.textContent?.length??0)+(relation?.textContent?.length??0)}}).sort((a,b)=>b.len-a.len)
    const e=entries[0];e.card.scrollIntoView({block:'center'})
    const open=e.card.querySelector('.research-result-open')
    return{count:cards.length,name:e.name?.textContent?.trim(),card:rect(e.card),open:rect(open),openDisplay:getComputedStyle(open).display,nameScroll:e.name?.scrollHeight,nameClient:e.name?.clientHeight,packScroll:e.pack?.scrollHeight,packClient:e.pack?.clientHeight,relationScroll:e.relation?.scrollHeight??0,relationClient:e.relation?.clientHeight??0}
  })()`)
  assert.ok(many.count > 1, `${width}: expected many results`)
  assert.ok(['flex', 'inline-flex'].includes(many.openDisplay), `${width}: quick-view affordance hidden (${many.openDisplay})`)
  assert.ok(many.open && many.card && many.open.left >= many.card.left - 1 && many.open.right <= many.card.right + 1, `${width}: affordance overflow`)
  assert.ok(many.nameScroll <= many.nameClient + 1, `${width}: name clipped`)
  assert.ok(many.packScroll <= many.packClient + 1, `${width}: package clipped`)
  if (many.relationClient) assert.ok(many.relationScroll <= many.relationClient + 1, `${width}: relation clipped`)
  await cdp.shot(`${prefix}-many-long-card.png`)

  await cdp.eval(`document.querySelector('.mobile-refine-entry button')?.focus()`)
  await tab(cdp)
  const focus = await cdp.eval(`(() => {const a=document.activeElement,s=getComputedStyle(a);return{isCard:a?.classList?.contains('research-result-card')??false,outline:s.outlineStyle,outlineWidth:s.outlineWidth}})()`)
  assert.equal(focus.isCard, true, `${width}: Tab did not reach card`)
  assert.notEqual(focus.outline, 'none', `${width}: card focus outline missing`)
  await cdp.shot(`${prefix}-card-keyboard-focus.png`)

  await click(cdp, '.research-result-card')
  await cdp.wait(`document.querySelector('.research-quick-view')`, 'quick view')
  await cdp.shot(`${prefix}-quick-view.png`)

  await cdp.nav(applied('&recipeDetails=sea_bream'))
  await waitCatalog(cdp)
  await cdp.wait(`document.querySelectorAll('.research-result-card').length === 1`, 'one sea-bream result')
  await waitImages(cdp)
  const one = await cdp.eval(`(() => {const results=document.querySelector('.research-results'),card=document.querySelector('.research-result-card'),rr=results.getBoundingClientRect(),cr=card.getBoundingClientRect();return{resultsHeight:rr.height,trailingBlank:rr.bottom-cr.bottom,text:card.textContent?.trim()}})()`)
  assert.ok(one.trailingBlank < 90, `${width}: excessive trailing blank ${one.trailingBlank}`)
  assert.match(one.text, /빠른 보기 →/)
  await cdp.shot(`${prefix}-one-result.png`)

  await cdp.nav(`${BASE}?view=workspace&mode=lookup&q=${encodeURIComponent('__catfood_no_match_20260911__')}`)
  await waitCatalog(cdp)
  await cdp.wait(`document.querySelector('.state-message')?.textContent?.includes('검색 결과가 없습니다.')`, 'zero result')
  const zero = await cdp.eval(`({cards:document.querySelectorAll('.research-result-card').length,text:document.querySelector('.state-message')?.textContent?.trim()})`)
  assert.equal(zero.cards, 0)
  await cdp.shot(`${prefix}-zero-result.png`)
  return { many, focus, one, zero }
}

async function recipeFlow(cdp) {
  const width = 390, height = 900
  const prefix = `${OUT}/candidate-${SOURCE_SHA.slice(0, 8)}-390x900-recipe`
  await cdp.viewport(width, height)
  await cdp.nav(applied())
  await waitCatalog(cdp, true)
  await click(cdp, '.mobile-refine-entry button', '더 좁혀보기')
  await cdp.wait(`document.querySelector('.mobile-refine-entry button')?.getAttribute('aria-expanded')==='true'`, 'refine open')
  await setSearch(cdp, '.recipe-search', '')
  await cdp.eval('window.scrollTo(0,0)')

  const list = await cdp.eval(`(() => {const choices=[...document.querySelectorAll('.recipe-detail-grid .choice')],panel=document.querySelector('#mobile-recipe-refine-panel'),inner=panel.querySelector('.research-filter-scroll');return{count:choices.length,labels:choices.map(n=>n.textContent?.trim()),panelOverflow:getComputedStyle(panel).overflowY,innerOverflow:getComputedStyle(inner).overflowY}})()`)
  assert.ok(list.count > 0)
  assert.deepEqual(list.labels, [...list.labels].sort((a,b)=>a.localeCompare(b,'ko-KR')), 'display-label order')
  assert.equal(list.panelOverflow, 'visible')
  assert.equal(list.innerOverflow, 'visible')
  await cdp.shot(`${prefix}-top.png`)

  let bottom = null
  for (let i = 0; i < 60; i += 1) {
    bottom = await cdp.eval(`(() => {const n=document.querySelector('.recipe-detail-grid .choice:last-child'),r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,text:n.textContent?.trim(),scrollY,docHeight:document.documentElement.scrollHeight}})()`)
    if (bottom.top >= 0 && bottom.bottom <= height - 8) break
    const before = await cdp.eval('window.scrollY')
    await wheel(cdp, 480, width / 2, height / 2)
    const after = await cdp.eval('window.scrollY')
    if (after === before && bottom.bottom > height) throw new Error(`recipe bottom clipped ${JSON.stringify(bottom)}`)
  }
  assert.ok(bottom && bottom.top >= 0 && bottom.bottom <= height - 8 && bottom.scrollY > 0, 'recipe bottom unreachable')
  await cdp.shot(`${prefix}-bottom.png`)

  await cdp.eval('window.scrollTo(0,0);document.querySelector(".recipe-search")?.focus()')
  let keyboard = null
  for (let i = 0; i < 160; i += 1) {
    await tab(cdp)
    keyboard = await cdp.eval(`(() => {const a=document.activeElement,last=document.querySelector('.recipe-detail-grid .choice:last-child'),r=a?.getBoundingClientRect?.();return{isLast:a===last,text:a?.textContent?.trim(),top:r?.top,bottom:r?.bottom,scrollY}})()`)
    if (keyboard.isLast) break
  }
  assert.ok(keyboard?.isLast && keyboard.top >= 0 && keyboard.bottom <= height, 'keyboard did not reach visible last recipe')
  await cdp.shot(`${prefix}-last-keyboard-focus.png`)

  await cdp.eval('window.scrollTo(0,0)')
  await setSearch(cdp, '.recipe-search', 'sea_bream')
  await cdp.wait(`document.querySelectorAll('.recipe-detail-grid .choice').length===1`, 'raw-key recipe search')
  const searched = await cdp.eval(`document.querySelector('.recipe-detail-grid .choice')?.textContent?.trim()`)
  assert.equal(searched, '도미류(Sea bream)')
  await click(cdp, '.recipe-detail-grid .choice')
  await cdp.wait(`document.querySelector('.recipe-detail-grid .choice')?.getAttribute('aria-pressed')==='true'`, 'select recipe')
  assert.equal(await cdp.eval(`new URL(location.href).searchParams.get('recipeDetails')`), 'sea_bream')
  await cdp.eval('window.scrollTo(0,0)')
  await click(cdp, '.mobile-refine-entry button', '목록으로 돌아가기')
  await cdp.wait(`document.querySelectorAll('.research-result-card').length===1`, 'selected result')

  await click(cdp, '.mobile-refine-entry button', '더 좁혀보기')
  await cdp.wait(`document.querySelector('.recipe-detail-grid .choice')?.getAttribute('aria-pressed')==='true'`, 'selection retained')
  await click(cdp, '.recipe-detail-grid .choice')
  await cdp.wait(`document.querySelector('.recipe-detail-grid .choice')?.getAttribute('aria-pressed')==='false'`, 'deselect recipe')
  assert.equal(await cdp.eval(`new URL(location.href).searchParams.has('recipeDetails')`), false)
  await cdp.eval('window.scrollTo(0,0)')
  await click(cdp, '.mobile-refine-entry button', '목록으로 돌아가기')
  await sleep(300)
  const restoredFocus = await cdp.eval(`document.activeElement===document.querySelector('.mobile-refine-entry button')`)
  assert.equal(restoredFocus, true, 'close focus not restored')
  return { count: list.count, first: list.labels[0], last: list.labels.at(-1), bottom, keyboard, searched, restoredFocus }
}

async function boundaryFlow(cdp) {
  const report = {}
  for (const width of [980, 981]) {
    await cdp.viewport(width, 900, false)
    await cdp.nav(applied())
    await waitCatalog(cdp, true)
    const state = await cdp.eval(`(() => {const entry=document.querySelector('.mobile-refine-entry'),filters=document.querySelector('.research-filters'),scroll=document.querySelector('.research-filter-scroll'),er=entry?.getBoundingClientRect(),fr=filters?.getBoundingClientRect();return{entryDisplay:entry?getComputedStyle(entry).display:null,entryWidth:er?.width??0,filtersDisplay:filters?getComputedStyle(filters).display:null,filtersWidth:fr?.width??0,filterOverflowY:scroll?getComputedStyle(scroll).overflowY:null}})()`)
    if (width === 980) { assert.notEqual(state.entryDisplay, 'none'); assert.equal(state.filtersDisplay, 'none') }
    else { assert.equal(state.entryDisplay, 'none'); assert.notEqual(state.filtersDisplay, 'none'); assert.equal(state.filterOverflowY, 'auto') }
    await cdp.shot(`${OUT}/candidate-${SOURCE_SHA.slice(0, 8)}-${width}x900-boundary.png`)
    report[width] = state
  }

  await cdp.viewport(1280, 900, false)
  await cdp.nav(applied())
  await waitCatalog(cdp, true)
  const before = await cdp.eval(`(() => {const n=document.querySelector('.research-filter-scroll'),r=n.getBoundingClientRect();return{top:n.scrollTop,client:n.clientHeight,scroll:n.scrollHeight,win:scrollY,x:r.left+r.width/2,y:r.top+Math.min(r.height/2,300)}})()`)
  assert.ok(before.scroll > before.client, 'desktop filter rail not scrollable')
  await wheel(cdp, 500, before.x, before.y)
  const after = await cdp.eval(`(() => {const n=document.querySelector('.research-filter-scroll');return{top:n.scrollTop,win:scrollY}})()`)
  assert.ok(after.top > before.top, 'desktop rail wheel failed')
  assert.equal(after.win, 0, 'desktop wheel moved document')
  await cdp.shot(`${OUT}/candidate-${SOURCE_SHA.slice(0, 8)}-1280x900-desktop.png`)
  report.desktop = { before, after }
  return report
}

const { version, proc, dir, cdp } = await launch()
const report = { sourceSha: SOURCE_SHA, base: BASE, browserVersion: version, cssInjection: false, analyticsEnabled: false, checks: {} }
try {
  report.checks.mobile360 = await mobileResults(cdp, 360, 844)
  report.checks.mobile390 = await mobileResults(cdp, 390, 900)
  report.checks.recipe = await recipeFlow(cdp)
  report.checks.boundaryDesktop = await boundaryFlow(cdp)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR20_CANDIDATE_QA_PASS ' + JSON.stringify({ sourceSha: SOURCE_SHA, browserVersion: version, recipeCount: report.checks.recipe.count, recipeLast: report.checks.recipe.last, oneBlank360: report.checks.mobile360.one.trailingBlank, oneBlank390: report.checks.mobile390.one.trailingBlank }))
} catch (error) {
  report.error = String(error?.stack ?? error)
  try { await cdp.shot(`${OUT}/failure.png`) } catch {}
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  cdp.close()
  proc.kill('SIGTERM')
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
