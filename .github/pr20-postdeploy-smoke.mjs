import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'https://osrm.github.io/catfood_web/'
const DEPLOY_SHA = process.env.DEPLOY_SHA ?? 'unknown'
const PRODUCT_HEAD = process.env.PRODUCT_HEAD ?? 'unknown'
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
    await sleep(350)
  }
  async viewport(width, height, mobile = true) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  }
  async shot(name) {
    await this.eval('document.fonts?.ready')
    await sleep(180)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  async platformFonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId, `missing node for font check ${selector}`)
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
  const dir = `/tmp/pr20-postdeploy-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 220; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) {
        const cdp = new Cdp(page.webSocketDebuggerUrl)
        await cdp.connect()
        return { cdp, proc, dir, version }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

async function waitCatalog(cdp, cards = false) {
  await cdp.wait(`document.querySelector('.research-status span:last-child')?.textContent?.includes('데이터 연결됨')`, 'catalog connected')
  if (cards) await cdp.wait(`document.querySelectorAll('.research-result-card').length > 0`, 'result cards')
  await sleep(300)
}

async function clickPoint(cdp, selector, text = null) {
  const point = await cdp.eval(`(() => {const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const node=${text === null ? 'nodes[0]' : `nodes.find(n=>n.textContent?.trim()===${JSON.stringify(text)})`};if(!node)return null;node.scrollIntoView({block:'center',inline:'nearest'});const r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  assert.ok(point, `missing ${selector} ${text ?? ''}`)
  await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1 })
  await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1 })
  await sleep(250)
}

async function tab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 })
  await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 })
  await sleep(70)
}

async function wheel(cdp, deltaY, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type:'mouseWheel', x, y, deltaX:0, deltaY })
  await sleep(140)
}

const applied = (extra = '') => `${BASE}?view=workspace&applied=1${extra}`
const manyUrl = applied('&targets=indoor,sterilized&features=weight_management,digestive,urinary')

async function quickViewSmoke(cdp) {
  await cdp.viewport(360, 844)
  await cdp.nav(manyUrl)
  await waitCatalog(cdp, true)
  await cdp.wait(`document.querySelector('.research-result-open')?.textContent?.includes('빠른 보기')`, 'quick view affordance')
  const fonts = await cdp.platformFonts('.research-result-open')
  assert.ok(fonts.some(f => /Noto.*CJK.*KR/i.test(f.familyName) && f.glyphCount > 0), `Korean glyph font missing: ${JSON.stringify(fonts)}`)
  const entry = await cdp.eval(`(() => {const card=document.querySelector('.research-result-card'),open=card.querySelector('.research-result-open'),cr=card.getBoundingClientRect(),r=open.getBoundingClientRect(),s=getComputedStyle(open);return{text:open.textContent?.trim(),visible:s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0,inside:r.left>=cr.left-1&&r.right<=cr.right+1&&r.top>=cr.top-1&&r.bottom<=cr.bottom+1}})()`)
  assert.equal(entry.text, '빠른 보기 →')
  assert.equal(entry.visible, true)
  assert.equal(entry.inside, true)
  await cdp.shot(`postdeploy-${DEPLOY_SHA.slice(0,8)}-360-quick-view-entry.png`)
  await clickPoint(cdp, '.research-result-card')
  await cdp.wait(`document.querySelector('.research-quick-view')`, 'quick view open')
  const opened = await cdp.eval(`({title:document.querySelector('.research-quick-view')?.textContent?.trim().slice(0,120),minHeight:getComputedStyle(document.querySelector('.research-quick-view')).minHeight})`)
  await cdp.shot(`postdeploy-${DEPLOY_SHA.slice(0,8)}-360-quick-view-open.png`)
  return { entry, opened, fonts }
}

async function oneResultSmoke(cdp) {
  await cdp.viewport(360, 844)
  await cdp.nav(applied('&recipeDetails=sea_bream'))
  await waitCatalog(cdp)
  await cdp.wait(`document.querySelectorAll('.research-result-card').length===1`, 'one result')
  const one = await cdp.eval(`(() => {const results=document.querySelector('.research-results'),scroll=document.querySelector('.research-results-scroll'),list=document.querySelector('.research-results-list'),card=document.querySelector('.research-result-card');const rr=results.getBoundingClientRect(),sr=scroll.getBoundingClientRect(),lr=list.getBoundingClientRect(),cr=card.getBoundingClientRect();return{count:document.querySelectorAll('.research-result-card').length,minHeight:getComputedStyle(results).minHeight,panelAfterScroll:rr.bottom-sr.bottom,scrollAfterList:sr.bottom-lr.bottom,listAfterCard:lr.bottom-cr.bottom,trailingBlank:rr.bottom-cr.bottom}})()`)
  assert.equal(one.count, 1)
  assert.ok(parseFloat(one.minHeight) <= 1, `one result min-height ${one.minHeight}`)
  assert.ok(Math.abs(one.panelAfterScroll) <= 2.5 && Math.abs(one.scrollAfterList) <= 2.5 && Math.abs(one.listAfterCard) <= 2.5, `one result internal stretch ${JSON.stringify(one)}`)
  assert.ok(one.trailingBlank <= 7.5, `one result trailing blank ${one.trailingBlank}`)
  await cdp.shot(`postdeploy-${DEPLOY_SHA.slice(0,8)}-360-one-result.png`)
  return one
}

async function recipeSmoke(cdp) {
  const width=390, height=900
  await cdp.viewport(width, height)
  await cdp.nav(applied())
  await waitCatalog(cdp, true)
  const beforeUrl = await cdp.eval('location.href')
  await clickPoint(cdp, '.mobile-refine-entry button', '더 좁혀보기')
  await cdp.wait(`document.querySelector('.mobile-refine-entry button')?.getAttribute('aria-expanded')==='true'`, 'refine open')
  const list = await cdp.eval(`(() => {const choices=[...document.querySelectorAll('.recipe-detail-grid .choice')];return{count:choices.length,last:choices.at(-1)?.textContent?.trim(),clipped:choices.filter(n=>n.scrollHeight>n.clientHeight+1||n.scrollWidth>n.clientWidth+1).map(n=>n.textContent?.trim())}})()`)
  assert.equal(list.count, 48)
  assert.deepEqual(list.clipped, [])

  let bottom=null
  for(let i=0;i<60;i+=1){
    bottom=await cdp.eval(`(() => {const n=document.querySelector('.recipe-detail-grid .choice:last-child'),r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,text:n.textContent?.trim(),scrollY}})()`)
    if(bottom.top>=0&&bottom.bottom<=height-8)break
    await wheel(cdp,480,width/2,height/2)
  }
  assert.ok(bottom?.scrollY>0 && bottom.top>=0 && bottom.bottom<=height-8, `recipe bottom unreachable ${JSON.stringify(bottom)}`)
  await cdp.shot(`postdeploy-${DEPLOY_SHA.slice(0,8)}-390-recipe-bottom.png`)

  await cdp.eval(`window.scrollTo(0,0);document.querySelector('.recipe-search')?.focus()`)
  let focus=null
  for(let i=0;i<180;i+=1){
    await tab(cdp)
    focus=await cdp.eval(`(() => {const a=document.activeElement,last=document.querySelector('.recipe-detail-grid .choice:last-child'),r=a?.getBoundingClientRect?.();return{isLast:a===last,text:a?.textContent?.trim(),top:r?.top,bottom:r?.bottom,outline:getComputedStyle(a).outlineStyle}})()`)
    if(focus.isLast)break
  }
  assert.equal(focus?.isLast,true,'keyboard did not reach last recipe')
  assert.notEqual(focus.outline,'none','last recipe focus outline missing')

  const label=list.last
  await clickPoint(cdp,'.recipe-detail-grid .choice',label)
  await cdp.wait(`new URL(location.href).searchParams.has('recipeDetails')`, 'recipe selected')
  const selected = await cdp.eval(`({url:location.href,value:new URL(location.href).searchParams.get('recipeDetails'),selected:[...document.querySelectorAll('.recipe-detail-grid .choice')].find(n=>n.textContent?.trim()===${JSON.stringify(label)})?.className})`)
  assert.ok(selected.value, 'recipeDetails not selected')
  await cdp.shot(`postdeploy-${DEPLOY_SHA.slice(0,8)}-390-recipe-selected.png`)

  await clickPoint(cdp,'.recipe-detail-grid .choice',label)
  await cdp.wait(`!new URL(location.href).searchParams.has('recipeDetails')`, 'recipe deselected')
  const deselectedUrl = await cdp.eval('location.href')
  assert.equal(new URL(deselectedUrl).searchParams.has('recipeDetails'), false)
  assert.equal(new URL(beforeUrl).searchParams.has('recipeDetails'), false)
  await cdp.shot(`postdeploy-${DEPLOY_SHA.slice(0,8)}-390-recipe-deselected.png`)
  return { list, bottom, focus, selected, deselectedUrl }
}

const { cdp, proc, dir, version } = await launch()
const report = { base:BASE, deploySha:DEPLOY_SHA, productHead:PRODUCT_HEAD, browserVersion:version, cssInjection:false, productFontChanged:false, checks:{} }
try {
  report.checks.quickView = await quickViewSmoke(cdp)
  report.checks.oneResult = await oneResultSmoke(cdp)
  report.checks.recipe = await recipeSmoke(cdp)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report,null,2))
  console.log('PR20_POSTDEPLOY_SMOKE_PASS '+JSON.stringify({deploySha:DEPLOY_SHA,quickView:report.checks.quickView.entry.text,oneBlank:report.checks.oneResult.trailingBlank,recipeCount:report.checks.recipe.list.count,recipeLast:report.checks.recipe.list.last}))
} catch(error) {
  report.error=String(error?.stack??error)
  try{await cdp.shot('failure.png')}catch{}
  writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))
  throw error
} finally {
  cdp.close();proc.kill('SIGTERM');try{rmSync(dir,{recursive:true,force:true})}catch{}
}
