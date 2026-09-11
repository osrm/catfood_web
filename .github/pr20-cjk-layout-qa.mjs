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
  async platformFonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId, `missing node for platform font check: ${selector}`)
    const result = await this.send('CSS.getPlatformFontsForNode', { nodeId })
    return result.fonts ?? []
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const bin = '/usr/bin/google-chrome'
  assert.ok(existsSync(bin), 'hosted runner Chrome unavailable')
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
  const port = 9970 + (process.pid % 20)
  const dir = `/tmp/pr20-cjk-qa-${process.pid}`
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

async function waitImages(cdp) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const ready = await cdp.eval(`[...document.querySelectorAll('.research-result-image')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).every(n=>n.complete)`)
    if (ready) break
    await sleep(120)
  }
  await sleep(200)
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
  await sleep(70)
}

async function wheel(cdp, deltaY, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  await sleep(140)
}

const applied = (extra = '') => `${BASE}?view=workspace&applied=1${extra}`
const manyUrl = applied('&targets=indoor,sterilized&features=weight_management,digestive,urinary')

async function fontPreflight(cdp) {
  await cdp.viewport(390, 900)
  await cdp.nav(manyUrl)
  await waitCatalog(cdp, true)
  await cdp.wait(`document.querySelector('.mobile-refine-entry button')?.textContent?.includes('더 좁혀보기')`, 'Korean refine label')
  const fonts = await cdp.platformFonts('.mobile-refine-entry button')
  const koreanFont = fonts.find((font) => /Noto.*CJK.*KR|Noto Sans KR/i.test(font.familyName) && font.glyphCount > 0)
  assert.ok(koreanFont, `Korean button did not use a Korean Noto font: ${JSON.stringify(fonts)}`)
  const check = await cdp.eval(`({fontCheck:document.fonts.check('16px "Noto Sans KR"','더 좁혀보기'),text:document.querySelector('.mobile-refine-entry button')?.textContent?.trim()})`)
  assert.equal(check.text, '더 좁혀보기')
  await cdp.shot(`${OUT}/candidate-${SOURCE_SHA.slice(0, 8)}-390x900-cjk-preflight.png`)
  return { fonts, fontCheck: check.fontCheck, text: check.text }
}

async function mobileResults(cdp, width, height) {
  const prefix = `${OUT}/candidate-${SOURCE_SHA.slice(0, 8)}-${width}x${height}`
  await cdp.viewport(width, height)
  await cdp.nav(manyUrl)
  await waitCatalog(cdp, true)
  await waitImages(cdp)

  const many = await cdp.eval(`(() => {
    const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    const rows=[...document.querySelectorAll('.research-result-card')].map(card=>{
      const name=card.querySelector('.research-result-identity strong'),relation=card.querySelector('.relation-line strong'),pack=card.querySelector('.research-result-packages'),open=card.querySelector('.research-result-open')
      const text=[name?.textContent,relation?.textContent].filter(Boolean).join(' ')
      return{card,name,relation,pack,open,text,len:text.length}
    }).filter(x=>/[가-힣]/.test(x.text)).sort((a,b)=>b.len-a.len)
    const e=rows[0]; if(!e)return null; e.card.scrollIntoView({block:'center'})
    const os=getComputedStyle(e.open),or=rect(e.open),cr=rect(e.card)
    return{count:document.querySelectorAll('.research-result-card').length,name:e.name?.textContent?.trim(),relation:e.relation?.textContent?.trim(),card:cr,open:or,openVisible:os.display!=='none'&&os.visibility!=='hidden'&&Number(os.opacity)!==0&&or?.width>0&&or?.height>0,nameClient:e.name?.clientHeight,nameScroll:e.name?.scrollHeight,relationClient:e.relation?.clientHeight??0,relationScroll:e.relation?.scrollHeight??0,packClient:e.pack?.clientHeight??0,packScroll:e.pack?.scrollHeight??0}
  })()`)
  assert.ok(many, `${width}: no Korean result row found`)
  assert.ok(many.count > 1, `${width}: expected many results`)
  assert.equal(many.openVisible, true, `${width}: 빠른 보기 is not visible`)
  assert.ok(many.open.left >= many.card.left - 1 && many.open.right <= many.card.right + 1 && many.open.top >= many.card.top - 1 && many.open.bottom <= many.card.bottom + 1, `${width}: 빠른 보기 outside card`)
  assert.ok(many.nameScroll <= many.nameClient + 1, `${width}: Korean product name clipped`)
  if (many.relationClient) assert.ok(many.relationScroll <= many.relationClient + 1, `${width}: Korean condition text clipped`)
  if (many.packClient) assert.ok(many.packScroll <= many.packClient + 1, `${width}: package text clipped`)
  await cdp.shot(`${prefix}-many-korean-long.png`)

  await cdp.nav(applied('&recipeDetails=sea_bream'))
  await waitCatalog(cdp)
  await cdp.wait(`document.querySelectorAll('.research-result-card').length===1`, 'one result')
  await waitImages(cdp)
  const one = await cdp.eval(`(() => {const results=document.querySelector('.research-results'),scroll=document.querySelector('.research-results-scroll'),list=document.querySelector('.research-results-list'),card=document.querySelector('.research-result-card'),name=card.querySelector('.research-result-identity strong'),open=card.querySelector('.research-result-open');const rr=results.getBoundingClientRect(),sr=scroll.getBoundingClientRect(),lr=list.getBoundingClientRect(),cr=card.getBoundingClientRect(),or=open.getBoundingClientRect();return{minHeight:getComputedStyle(results).minHeight,resultsHeight:rr.height,panelAfterScroll:rr.bottom-sr.bottom,scrollAfterList:sr.bottom-lr.bottom,listAfterCard:lr.bottom-cr.bottom,trailingBlank:rr.bottom-cr.bottom,name:name.textContent?.trim(),nameClient:name.clientHeight,nameScroll:name.scrollHeight,openText:open.textContent?.trim(),openInside:or.left>=cr.left-1&&or.right<=cr.right+1&&or.top>=cr.top-1&&or.bottom<=cr.bottom+1}})()`)
  assert.ok(parseFloat(one.minHeight) <= 1, `${width}: one-result min-height returned`)
  assert.ok(Math.abs(one.panelAfterScroll) <= 2.5 && Math.abs(one.scrollAfterList) <= 2.5 && Math.abs(one.listAfterCard) <= 2.5, `${width}: one-result internal stretch`)
  assert.ok(one.trailingBlank <= 7.5, `${width}: one-result trailing blank ${one.trailingBlank}`)
  assert.ok(one.nameScroll <= one.nameClient + 1, `${width}: one-result Korean name clipped`)
  assert.equal(one.openText, '빠른 보기 →')
  assert.equal(one.openInside, true)
  await cdp.shot(`${prefix}-one-result-korean.png`)

  await cdp.nav(`${BASE}?view=workspace&mode=lookup&q=${encodeURIComponent('__catfood_no_match_cjk__')}`)
  await waitCatalog(cdp)
  await cdp.wait(`document.querySelector('.state-message')?.textContent?.includes('검색 결과가 없습니다.')`, 'zero result')
  const zero = await cdp.eval(`(() => {const results=document.querySelector('.research-results'),scroll=document.querySelector('.research-results-scroll'),state=document.querySelector('.state-message'),rr=results.getBoundingClientRect(),sr=scroll.getBoundingClientRect(),tr=state.getBoundingClientRect();return{minHeight:getComputedStyle(results).minHeight,panelAfterScroll:rr.bottom-sr.bottom,scrollAfterState:sr.bottom-tr.bottom,text:state.textContent?.trim(),stateHeight:tr.height}})()`)
  assert.ok(parseFloat(zero.minHeight) <= 1, `${width}: zero-result min-height returned`)
  assert.ok(Math.abs(zero.panelAfterScroll) <= 2.5 && Math.abs(zero.scrollAfterState) <= 2.5, `${width}: zero-result internal stretch`)
  await cdp.shot(`${prefix}-zero-result-korean.png`)
  return { many, one, zero }
}

async function recipeFlow(cdp, width, height) {
  const prefix = `${OUT}/candidate-${SOURCE_SHA.slice(0, 8)}-${width}x${height}-recipe`
  await cdp.viewport(width, height)
  await cdp.nav(applied())
  await waitCatalog(cdp, true)
  await click(cdp, '.mobile-refine-entry button', '더 좁혀보기')
  await cdp.wait(`document.querySelector('.mobile-refine-entry button')?.getAttribute('aria-expanded')==='true'`, 'refine open')
  const list = await cdp.eval(`(() => {const choices=[...document.querySelectorAll('.recipe-detail-grid .choice')],panel=document.querySelector('#mobile-recipe-refine-panel'),inner=panel.querySelector('.research-filter-scroll');return{count:choices.length,labels:choices.map(n=>n.textContent?.trim()),clipped:choices.filter(n=>n.scrollHeight>n.clientHeight+1||n.scrollWidth>n.clientWidth+1).map(n=>n.textContent?.trim()),panelOverflow:getComputedStyle(panel).overflowY,innerOverflow:getComputedStyle(inner).overflowY,docHeight:document.documentElement.scrollHeight}})()`)
  assert.equal(list.count, 48, `${width}: expected 48 recipe choices`)
  assert.deepEqual(list.clipped, [], `${width}: recipe label clipping`)
  assert.equal(list.panelOverflow, 'visible')
  assert.equal(list.innerOverflow, 'visible')

  let bottom = null
  for (let i=0;i<60;i+=1) {
    bottom = await cdp.eval(`(() => {const n=document.querySelector('.recipe-detail-grid .choice:last-child'),r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,text:n.textContent?.trim(),scrollY,docHeight:document.documentElement.scrollHeight}})()`)
    if (bottom.top >= 0 && bottom.bottom <= innerHeight - 8) break
    const before = await cdp.eval('window.scrollY')
    await wheel(cdp, 480, width/2, height/2)
    const after = await cdp.eval('window.scrollY')
    if (after === before && bottom.bottom > height) throw new Error(`${width}: recipe bottom unreachable ${JSON.stringify(bottom)}`)
  }
  assert.ok(bottom && bottom.top >= 0 && bottom.bottom <= height - 8 && bottom.scrollY > 0, `${width}: recipe bottom not visible`)
  await cdp.shot(`${prefix}-bottom.png`)

  await cdp.eval(`window.scrollTo(0,0);document.querySelector('.recipe-search')?.focus()`)
  let keyboard = null
  for (let i=0;i<180;i+=1) {
    await tab(cdp)
    keyboard = await cdp.eval(`(() => {const a=document.activeElement,last=document.querySelector('.recipe-detail-grid .choice:last-child'),r=a?.getBoundingClientRect?.();return{isLast:a===last,text:a?.textContent?.trim(),top:r?.top,bottom:r?.bottom,scrollY,outline:getComputedStyle(a).outlineStyle}})()`)
    if (keyboard.isLast) break
  }
  assert.ok(keyboard?.isLast && keyboard.top >= 0 && keyboard.bottom <= height, `${width}: keyboard did not reach visible last recipe`)
  assert.notEqual(keyboard.outline, 'none', `${width}: last recipe focus outline missing`)
  await cdp.shot(`${prefix}-last-keyboard-focus.png`)
  return { list, bottom, keyboard }
}

async function desktopFlow(cdp) {
  await cdp.viewport(1280, 900, false)
  await cdp.nav(manyUrl)
  await waitCatalog(cdp, true)
  await waitImages(cdp)
  const state = await cdp.eval(`(() => {const rail=document.querySelector('.research-filter-scroll'),cards=[...document.querySelectorAll('.research-result-card')],row=cards.map(card=>{const name=card.querySelector('.research-result-identity strong'),relation=card.querySelector('.relation-line strong');return{card,name,relation,text:[name?.textContent,relation?.textContent].filter(Boolean).join(' ')}}).filter(x=>/[가-힣]/.test(x.text)).sort((a,b)=>b.text.length-a.text.length)[0];return{railOverflow:getComputedStyle(rail).overflowY,railClient:rail.clientHeight,railScroll:rail.scrollHeight,name:row?.name?.textContent?.trim(),nameClient:row?.name?.clientHeight,nameScroll:row?.name?.scrollHeight,relation:row?.relation?.textContent?.trim(),relationClient:row?.relation?.clientHeight??0,relationScroll:row?.relation?.scrollHeight??0,cardHeight:row?.card?.getBoundingClientRect().height}})()`)
  assert.equal(state.railOverflow, 'auto', 'desktop filter rail overflow changed')
  assert.ok(state.railScroll > state.railClient, 'desktop filter rail no longer scrollable')
  assert.ok(state.nameScroll <= state.nameClient + 1, 'desktop Korean product name clipped')
  if (state.relationClient) assert.ok(state.relationScroll <= state.relationClient + 1, 'desktop Korean condition text clipped')
  await cdp.shot(`${OUT}/candidate-${SOURCE_SHA.slice(0, 8)}-1280x900-desktop-cjk.png`)
  return state
}

const { version, proc, dir, cdp } = await launch()
const report = { sourceSha: SOURCE_SHA, base: BASE, browserVersion: version, cssInjection: false, productFontChanged: false, checks: {} }
try {
  report.checks.fontPreflight = await fontPreflight(cdp)
  report.checks.mobile360 = await mobileResults(cdp, 360, 844)
  report.checks.mobile390 = await mobileResults(cdp, 390, 900)
  report.checks.recipe360 = await recipeFlow(cdp, 360, 844)
  report.checks.recipe390 = await recipeFlow(cdp, 390, 900)
  report.checks.desktop = await desktopFlow(cdp)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log('PR20_CJK_LAYOUT_QA_PASS ' + JSON.stringify({sourceSha:SOURCE_SHA,browserVersion:version,platformFonts:report.checks.fontPreflight.fonts,oneBlank360:report.checks.mobile360.one.trailingBlank,oneBlank390:report.checks.mobile390.one.trailingBlank,recipeCount360:report.checks.recipe360.list.count,recipeCount390:report.checks.recipe390.list.count}))
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
