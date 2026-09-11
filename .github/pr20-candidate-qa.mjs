import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/'
const SOURCE_SHA = process.env.SOURCE_SHA ?? 'unknown'
const out = 'qa-artifacts'
mkdirSync(out, { recursive: true })
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
      if (!message.id) return
      const pending = this.pending.get(message.id)
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
    await sleep(250)
  }
  async viewport(width, height, mobile = true) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(250)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const bin = '/usr/bin/google-chrome'
  assert.ok(existsSync(bin), 'hosted runner Chrome is unavailable')
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
  const port = 9940 + (process.pid % 40)
  const dir = `/tmp/pr20-qa-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache',
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' })
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

async function waitCatalog(cdp, requireCards = false) {
  await cdp.wait(`document.querySelector('.research-status span:last-child')?.textContent?.includes('데이터 연결됨')`, 'catalog connected')
  if (requireCards) await cdp.wait(`document.querySelectorAll('.research-result-card').length > 0`, 'result cards')
  await cdp.eval('document.fonts?.ready')
  await sleep(400)
}

async function clickNode(cdp, selector, text = null) {
  const target = await cdp.eval(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const node = ${text === null ? 'nodes[0]' : `nodes.find((item) => item.textContent?.includes(${JSON.stringify(text)}))`}
    if (!node) return null
    node.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = node.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: node.textContent?.trim() }
  })()`)
  assert.ok(target, `missing target ${selector} ${text ?? ''}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await sleep(250)
}

async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await sleep(100)
}

async function wheel(cdp, deltaY, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  await sleep(180)
}

async function wheelDocumentToLastRecipe(cdp, width, height) {
  for (let i = 0; i < 60; i += 1) {
    const state = await cdp.eval(`(() => {
      const node = document.querySelector('.recipe-detail-grid .choice:last-child')
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, text: node.textContent?.trim(), scrollY, docHeight: document.documentElement.scrollHeight }
    })()`)
    assert.ok(state, 'missing recipe last choice')
    if (state.top >= 0 && state.bottom <= height - 8) return state
    const before = await cdp.eval('window.scrollY')
    await wheel(cdp, 480, Math.floor(width / 2), Math.floor(height / 2))
    const after = await cdp.eval('window.scrollY')
    if (before === after && state.bottom > height) throw new Error(`document stopped before recipe bottom: ${JSON.stringify(state)}`)
  }
  throw new Error('recipe bottom unreachable with document wheel')
}

async function keyboardToLastRecipe(cdp, height) {
  const lastText = await cdp.eval(`document.querySelector('.recipe-detail-grid .choice:last-child')?.textContent?.trim()`)
  assert.ok(lastText)
  await cdp.eval(`document.querySelector('.recipe-search')?.focus()`)
  for (let i = 0; i < 160; i += 1) {
    await pressTab(cdp)
    const state = await cdp.eval(`(() => {
      const active = document.activeElement
      const last = document.querySelector('.recipe-detail-grid .choice:last-child')
      const rect = active?.getBoundingClientRect?.()
      return { isLast: active === last, text: active?.textContent?.trim(), top: rect?.top, bottom: rect?.bottom, scrollY }
    })()`)
    if (state.isLast) {
      assert.ok(state.top >= 0 && state.bottom <= height, `focused recipe is outside viewport: ${JSON.stringify(state)}`)
      return state
    }
  }
  throw new Error('Tab did not reach last recipe choice')
}

async function setSearchInput(cdp, selector, value) {
  await cdp.eval(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(node, ${JSON.stringify(value)})
    node.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(250)
}

async function waitImages(cdp) {
  const end = Date.now() + 12000
  while (Date.now() < end) {
    const ready = await cdp.eval(`(() => [...document.querySelectorAll('.research-result-image')].filter((node) => {
      const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight
    }).every((node) => node.complete))()`)
    if (ready) break
    await sleep(150)
  }
  await sleep(250)
}

function mobilePath(query = '') { return `${BASE}?view=workspace&applied=1${query}` }

async function mobileScenarios(cdp, width, height) {
  const prefix = `${out}/candidate-${SOURCE_SHA.slice(0, 8)}-${width}x${height}`
  const conditions = '&targets=indoor,sterilized&features=weight_management,digestive,urinary'
  await cdp.viewport(width, height)
  await cdp.nav(mobilePath(conditions))
  await waitCatalog(cdp, true)
  await waitImages(cdp)

  const many = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('.research-result-card')]
    const entries = cards.map((card) => {
      const name = card.querySelector('.research-result-identity strong')
      const pack = card.querySelector('.research-result-packages')
      const relation = card.querySelector('.relation-line strong')
      return { card, name, pack, relation, length: (name?.textContent?.length ?? 0) + (relation?.textContent?.length ?? 0) }
    }).sort((a, b) => b.length - a.length)
    const chosen = entries[0]
    chosen?.card.scrollIntoView({ block: 'center' })
    const rect = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height } }
    const open = chosen?.card.querySelector('.research-result-open')
    return {
      count: cards.length,
      totalText: document.querySelector('.research-results-heading span')?.textContent?.trim(),
      name: chosen?.name?.textContent?.trim(),
      nameRect: rect(chosen?.name), packRect: rect(chosen?.pack), relationRect: rect(chosen?.relation), openRect: rect(open), cardRect: rect(chosen?.card),
      nameScrollHeight: chosen?.name?.scrollHeight, nameClientHeight: chosen?.name?.clientHeight,
      packScrollHeight: chosen?.pack?.scrollHeight, packClientHeight: chosen?.pack?.clientHeight,
      relationScrollHeight: chosen?.relation?.scrollHeight, relationClientHeight: chosen?.relation?.clientHeight,
      openDisplay: open ? getComputedStyle(open).display : null,
    }
  })()`)
  assert.ok(many.count > 1, `${width}: expected many results`)
  assert.equal(many.openDisplay, 'inline-flex', `${width}: quick-view affordance hidden`)
  assert.ok(many.openRect && many.cardRect && many.openRect.left >= many.cardRect.left - 1 && many.openRect.right <= many.cardRect.right + 1, `${width}: quick-view affordance overflows card`)
  assert.ok(many.nameScrollHeight <= many.nameClientHeight + 1, `${width}: long product name clipped`)
  assert.ok(many.packScrollHeight <= many.packClientHeight + 1, `${width}: package text clipped`)
  if (many.relationRect) assert.ok(many.relationScrollHeight <= many.relationClientHeight + 1, `${width}: relation text clipped`)
  await cdp.shot(`${prefix}-many-long-card.png`)

  await cdp.eval(`document.querySelector('.mobile-refine-entry button')?.focus()`)
  await pressTab(cdp)
  const cardFocus = await cdp.eval(`(() => ({ isCard: document.activeElement?.classList?.contains('research-result-card') ?? false, outline: getComputedStyle(document.activeElement).outlineStyle, outlineWidth: getComputedStyle(document.activeElement).outlineWidth }))()`)
  assert.equal(cardFocus.isCard, true, `${width}: Tab did not move focus to result card`)
  assert.notEqual(cardFocus.outline, 'none', `${width}: result-card focus outline missing`)
  await cdp.shot(`${prefix}-card-keyboard-focus.png`)

  await clickNode(cdp, '.research-result-card')
  await cdp.wait(`document.querySelector('.research-quick-view')`, 'quick view open')
  await cdp.shot(`${prefix}-quick-view.png`)

  await cdp.nav(mobilePath('&recipeDetails=sea_bream'))
  await waitCatalog(cdp)
  await cdp.wait(`document.querySelectorAll('.research-result-card').length === 1`, 'one sea-bream result')
  await waitImages(cdp)
  const one = await cdp.eval(`(() => {
    const results = document.querySelector('.research-results')
    const card = document.querySelector('.research-result-card')
    const rr = results.getBoundingClientRect(), cr = card.getBoundingClientRect()
    return { resultsHeight: rr.height, cardBottom: cr.bottom, resultsBottom: rr.bottom, trailingBlank: rr.bottom - cr.bottom, cardText: card.textContent?.trim() }
  })()`)
  assert.ok(one.trailingBlank < 90, `${width}: excessive trailing result space ${one.trailingBlank}`)
  assert.match(one.cardText, /빠른 보기 →/)
  await cdp.shot(`${prefix}-one-result.png`)

  await cdp.nav(`${BASE}?view=workspace&mode=lookup&q=${encodeURIComponent('__catfood_no_match_20260911__')}`)
  await waitCatalog(cdp)
  await cdp.wait(`document.querySelector('.state-message')?.textContent?.includes('검색 결과가 없습니다.')`, 'zero result state')
  const zero = await cdp.eval(`(() => ({ cards: document.querySelectorAll('.research-result-card').length, text: document.querySelector('.state-message')?.textContent?.trim() }))()`)
  assert.equal(zero.cards, 0)
  await cdp.shot(`${prefix}-zero-result.png`)

  return { many, cardFocus, one, zero }
}

async function recipeScenario(cdp) {
  const width = 390, height = 900
  const prefix = `${out}/candidate-${SOURCE_SHA.slice(0, 8)}-390x900-recipe`
  await cdp.viewport(width, height)
  await cdp.nav(mobilePath())
  await waitCatalog(cdp, true)
  await clickNode(cdp, '.mobile-refine-entry button', '더 좁혀보기')
  await cdp.wait(`document.querySelector('.mobile-refine-entry button')?.getAttribute('aria-expanded') === 'true'`, 'mobile refine open')
  await setSearchInput(cdp, '.recipe-search', '')
  await cdp.eval('window.scrollTo(0, 0)')

  const list = await cdp.eval(`(() => {
    const choices = [...document.querySelectorAll('.recipe-detail-grid .choice')]
    return { count: choices.length, labels: choices.map((node) => node.textContent?.trim()), panelOverflow: getComputedStyle(document.querySelector('#mobile-recipe-refine-panel')).overflowY, innerOverflow: getComputedStyle(document.querySelector('#mobile-recipe-refine-panel .research-filter-scroll')).overflowY }
  })()`)
  assert.ok(list.count > 0, 'recipe catalog is empty')
  assert.deepEqual(list.labels, [...list.labels].sort((a, b) => a.localeCompare(b, 'ko-KR')), 'recipe labels are not Korean-display sorted')
  assert.equal(list.panelOverflow, 'visible', 'mobile panel reverted to nested clipping')
  assert.equal(list.innerOverflow, 'visible', 'mobile inner scroll reverted')
  await cdp.shot(`${prefix}-top.png`)

  const bottom = await wheelDocumentToLastRecipe(cdp, width, height)
  assert.ok(bottom.scrollY > 0, 'recipe list did not use document scroll')
  await cdp.shot(`${prefix}-bottom.png`)

  await cdp.eval('window.scrollTo(0,0)')
  const keyboard = await keyboardToLastRecipe(cdp, height)
  await cdp.shot(`${prefix}-last-keyboard-focus.png`)

  await cdp.eval('window.scrollTo(0,0)')
  await setSearchInput(cdp, '.recipe-search', 'sea_bream')
  await cdp.wait(`document.querySelectorAll('.recipe-detail-grid .choice').length === 1`, 'raw recipe key search')
  const searched = await cdp.eval(`document.querySelector('.recipe-detail-grid .choice')?.textContent?.trim()`)
  assert.equal(searched, '도미류(Sea bream)')
  await clickNode(cdp, '.recipe-detail-grid .choice')
  await cdp.wait(`document.querySelector('.recipe-detail-grid .choice')?.getAttribute('aria-pressed') === 'true'`, 'recipe selected')
  assert.equal(await cdp.eval(`new URL(location.href).searchParams.get('recipeDetails')`), 'sea_bream')

  await cdp.eval('window.scrollTo(0,0)')
  await clickNode(cdp, '.mobile-refine-entry button', '목록으로 돌아가기')
  await cdp.wait(`document.querySelectorAll('.research-result-card').length === 1`, 'selected recipe result')

  await clickNode(cdp, '.mobile-refine-entry button', '더 좁혀보기')
  await cdp.wait(`document.querySelector('.recipe-detail-grid .choice')?.getAttribute('aria-pressed') === 'true'`, 'selection retained')
  await clickNode(cdp, '.recipe-detail-grid .choice')
  await cdp.wait(`document.querySelector('.recipe-detail-grid .choice')?.getAttribute('aria-pressed') === 'false'`, 'recipe deselected')
  assert.equal(await cdp.eval(`new URL(location.href).searchParams.has('recipeDetails')`), false)
  await cdp.eval('window.scrollTo(0,0)')
  await clickNode(cdp, '.mobile-refine-entry button', '목록으로 돌아가기')
  const restoredFocus = await cdp.eval(`document.activeElement === document.querySelector('.mobile-refine-entry button')`)
  assert.equal(restoredFocus, true, 'mobile refine close did not restore focus')

  return { count: list.count, first: list.labels[0], last: list.labels.at(-1), bottom, keyboard, searched, restoredFocus }
}

async function boundaryAndDesktop(cdp) {
  const report = {}
  for (const width of [980, 981]) {
    const height = 900
    await cdp.viewport(width, height, false)
    await cdp.nav(mobilePath())
    await waitCatalog(cdp, true)
    const state = await cdp.eval(`(() => {
      const entry = document.querySelector('.mobile-refine-entry')
      const filters = document.querySelector('.research-filters')
      const scroll = document.querySelector('.research-filter-scroll')
      const er = entry?.getBoundingClientRect(), fr = filters?.getBoundingClientRect()
      return { width: innerWidth, entryDisplay: entry ? getComputedStyle(entry).display : null, entryWidth: er?.width ?? 0, filtersDisplay: filters ? getComputedStyle(filters).display : null, filtersWidth: fr?.width ?? 0, filterOverflowY: scroll ? getComputedStyle(scroll).overflowY : null, windowScrollY: scrollY }
    })()`)
    if (width === 980) {
      assert.notEqual(state.entryDisplay, 'none', '980px mobile refine entry hidden')
      assert.equal(state.filtersDisplay, 'none', '980px desktop filter rail visible')
    } else {
      assert.equal(state.entryDisplay, 'none', '981px mobile refine entry visible')
      assert.notEqual(state.filtersDisplay, 'none', '981px desktop filter rail hidden')
      assert.equal(state.filterOverflowY, 'auto', '981px desktop filter rail lost internal scroll')
    }
    await cdp.shot(`${out}/candidate-${SOURCE_SHA.slice(0, 8)}-${width}x${height}-boundary.png`)
    report[width] = state
  }

  await cdp.viewport(1280, 900, false)
  await cdp.nav(mobilePath())
  await waitCatalog(cdp, true)
  const before = await cdp.eval(`(() => { const n=document.querySelector('.research-filter-scroll'); return { top:n.scrollTop, client:n.clientHeight, scroll:n.scrollHeight, win:scrollY, rect:n.getBoundingClientRect() } })()`)
  assert.ok(before.scroll > before.client, 'desktop filter rail is not scrollable')
  await wheel(cdp, 500, Math.max(40, before.rect.left + before.rect.width / 2), Math.max(100, before.rect.top + Math.min(before.rect.height / 2, 300)))
  const after = await cdp.eval(`(() => { const n=document.querySelector('.research-filter-scroll'); return { top:n.scrollTop, win:scrollY } })()`)
  assert.ok(after.top > before.top, 'desktop wheel did not scroll filter rail')
  assert.equal(after.win, 0, 'desktop filter wheel scrolled document')
  await cdp.shot(`${out}/candidate-${SOURCE_SHA.slice(0, 8)}-1280x900-desktop.png`)
  report.desktop = { before, after }
  return report
}

const { version, proc, dir, cdp } = await launch()
const report = { sourceSha: SOURCE_SHA, base: BASE, browserVersion: version, cssInjection: false, analyticsEnabled: false, checks: {} }
try {
  report.checks.mobile360 = await mobileScenarios(cdp, 360, 844)
  report.checks.mobile390 = await mobileScenarios(cdp, 390, 900)
  report.checks.recipe = await recipeScenario(cdp)
  report.checks.boundaryDesktop = await boundaryAndDesktop(cdp)
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR20_CANDIDATE_QA_PASS ' + JSON.stringify({ sourceSha: SOURCE_SHA, browserVersion: version, recipeCount: report.checks.recipe.count, recipeLast: report.checks.recipe.last, oneBlank360: report.checks.mobile360.one.trailingBlank, oneBlank390: report.checks.mobile390.one.trailingBlank }))
} catch (error) {
  report.error = String(error?.stack ?? error)
  try { await cdp.shot(`${out}/failure.png`) } catch {}
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  cdp.close()
  proc.kill('SIGTERM')
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
