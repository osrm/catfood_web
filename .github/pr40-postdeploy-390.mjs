import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PAGE = 'https://osrm.github.io/catfood_web/'
const OUT = 'qa-artifacts-pr40-postdeploy'
const STORAGE = 'catfood.switch-session.v1'
const q = JSON.stringify
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
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
    for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable']) await this.send(domain)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch=window.fetch.bind(window)
      window.__qaBlocked={analytics:0,writes:0}
      window.fetch=(input,init={})=>{
        const url=typeof input==='string'?input:(input&&input.url)||''
        const method=String(init.method||(input&&input.method)||'GET').toUpperCase()
        if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}
        if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}
        return nativeFetch(input,init)
      }
    })();` })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, timeout = 40000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`).catch(() => false)) return
      await sleep(100)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length`, 'root')
    await this.eval('document.fonts?.ready')
    await sleep(250)
  }
  async shot(name) {
    await this.eval('document.fonts?.ready'); await sleep(80)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch() {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const port = 17127
  const dir = `/tmp/pr40-postdeploy-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const c = new CDP(page.webSocketDebuggerUrl)
      await c.connect()
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 900 })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      return { c, proc, dir }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}

async function cleanup(h) {
  h.c.close(); h.proc.kill('SIGTERM'); await sleep(80)
  if (h.proc.exitCode == null) h.proc.kill('SIGKILL')
  try { rmSync(h.dir, { recursive: true, force: true }) } catch {}
}

async function trustedClick(c, selector, matcher = null, scroll = true) {
  const point = await c.eval(`(()=>{
    const nodes=[...document.querySelectorAll(${q(selector)})]
    const node=${matcher ? `nodes.find(x=>x.textContent.includes(${q(matcher)}))` : 'nodes[0]'}
    if(!node)return null
    if(${scroll ? 'true' : 'false'})node.scrollIntoView({block:'center',inline:'nearest'})
    const r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y)
    if(!hit||!(hit===node||node.contains(hit)))return{blocked:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},hit:hit?.className||hit?.tagName}
    window.__qaTrustedClick=null
    node.addEventListener('click',e=>window.__qaTrustedClick=e.isTrusted,{once:true,capture:true})
    return{x,y,text:node.textContent.trim(),rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}
  })()`)
  assert.ok(point && !point.blocked, `pointer unavailable ${selector} ${matcher ?? ''}: ${JSON.stringify(point)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(140)
  assert.equal(await c.eval('window.__qaTrustedClick'), true)
  return point
}

async function typeSearch(c, text) {
  await trustedClick(c, '.switch-find-search input')
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector('.switch-find-search input')?.value===${q(text)}`, 'typed search')
}

async function state(c) {
  return c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`)
}
function stable(s) { return { currentProductId:s.currentProductId, variantSelection:s.variantSelection, compareIds:s.compareIds } }

async function enterResults(c) {
  await c.nav(`${PAGE}?view=workspace&mode=switch`)
  await c.wait(`document.querySelector('.switch-find-search input')`, 'search')
  await c.wait(`!document.body.innerText.includes('제품 목록을 불러오는 중입니다.')`, 'catalog')
  await typeSearch(c, 'AATU 연어')
  await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(x=>x.textContent.includes('AATU')&&x.textContent.includes('연어'))`, 'AATU result')
  await trustedClick(c, '.switch-find-result', '연어')
  await c.wait(`document.querySelector('.switch-current-preview')`, 'preview')
  await trustedClick(c, '.switch-current-preview .switch-primary-action')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'SKU options')
  await trustedClick(c, '.switch-sku-option', '1 kg')
  await trustedClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-no-change')`, 'CHANGE')
  await trustedClick(c, '.switch-no-change')
  await trustedClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'KEEP')
  await trustedClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-results-stage')`, 'RESULTS')
  assert.ok((await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)) > 0)
}

async function addFirstCandidate(c) {
  const candidate = await c.eval(`(()=>{const row=document.querySelector('.switch-candidate-row');return{name:row?.querySelector('.switch-candidate-identity strong')?.textContent.trim()}})()`)
  assert.ok(candidate.name)
  await trustedClick(c, '.switch-candidate-row')
  await c.wait(`document.querySelector('.switch-candidate-inspector')`, 'inspector')
  await trustedClick(c, '.switch-inspector-actions .switch-compare-action', '비교에 추가')
  await c.wait(`document.querySelector('.switch-compare-dock')`, 'dock')
  const selected = stable(await state(c))
  assert.equal(selected.compareIds.length, 1)
  await trustedClick(c, '.switch-preview-topline button')
  await c.wait(`!document.querySelector('.switch-candidate-inspector')`, 'inspector closed')
  return { candidate, selected }
}

function ownerExpression(selector) {
  return `(()=>{const n=document.querySelector(${q(selector)});if(!n)return null;for(let p=n.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(/auto|scroll/.test(s.overflowY)&&p.scrollHeight>p.clientHeight+1)return p}return document.scrollingElement})()`
}
async function ownerSnapshot(c, selector) {
  return c.eval(`(()=>{const o=${ownerExpression(selector)};if(!o)return null;const r=o===document.scrollingElement?{left:0,right:innerWidth,top:0,bottom:innerHeight}:o.getBoundingClientRect();return{tag:o.tagName,className:o.className,scrollTop:o.scrollTop,maxScroll:o.scrollHeight-o.clientHeight,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}}})()`)
}
async function wheel(c, owner, deltaY) {
  const x=Math.max(4,Math.min(386,(owner.rect.left+owner.rect.right)/2)), y=Math.max(4,Math.min(896,(owner.rect.top+owner.rect.bottom)/2))
  await c.send('Input.dispatchMouseEvent', { type:'mouseWheel', x, y, deltaX:0, deltaY, modifiers:0, pointerType:'mouse' })
  await sleep(80)
}
async function wheelToEnd(c, selector) {
  for (let i=0;i<40;i++) { const o=await ownerSnapshot(c,selector); assert.ok(o); if(o.maxScroll-o.scrollTop<=1)return o; await wheel(c,o,4000) }
  const o=await ownerSnapshot(c,selector); assert.ok(o.maxScroll-o.scrollTop<=1); return o
}
async function wheelToStart(c, selector) {
  for (let i=0;i<40;i++) { const o=await ownerSnapshot(c,selector); assert.ok(o); if(o.scrollTop<=1)return o; await wheel(c,o,-4000) }
  const o=await ownerSnapshot(c,selector); assert.ok(o.scrollTop<=1); return o
}

async function loadMoreEvidence(c) {
  return c.eval(`(()=>{const b=document.querySelector('.load-more'),d=document.querySelector('.switch-compare-dock');if(!b||!d)return null;const br=b.getBoundingClientRect(),dr=d.getBoundingClientRect(),x=br.left+br.width/2,y=br.top+br.height/2,hit=document.elementFromPoint(x,y);return{button:{top:br.top,bottom:br.bottom,left:br.left,right:br.right},dock:{top:dr.top,bottom:dr.bottom,left:dr.left,right:dr.right},fullyAbove:br.bottom<=dr.top,hit:{tag:hit?.tagName,className:hit?.className,text:hit?.textContent?.trim().slice(0,80)},pointerAccessible:Boolean(hit&&(hit===b||b.contains(hit))),stagePaddingBottom:getComputedStyle(document.querySelector('.switch-results-stage')).paddingBottom}})()`)
}

async function elementEvidence(c, selector, matcher=null) {
  return c.eval(`(()=>{const nodes=[...document.querySelectorAll(${q(selector)})],n=${matcher ? `nodes.find(x=>x.textContent.includes(${q(matcher)}))`:'nodes[0]'};if(!n)return null;const r=n.getBoundingClientRect(),d=document.querySelector('.switch-compare-dock'),limit=d?d.getBoundingClientRect().top:innerHeight,x=r.left+r.width/2,y=r.top+r.height/2,hit=(x>=0&&x<=innerWidth&&y>=0&&y<=innerHeight)?document.elementFromPoint(x,y):null;return{rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},safeBottom:limit,pointerAccessible:Boolean(hit&&(hit===n||n.contains(hit)))}})()`)
}
async function wheelUntilVisible(c, selector, matcher=null) {
  for (let i=0;i<40;i++) {
    const e=await elementEvidence(c,selector,matcher); assert.ok(e)
    const safeTop=16,safeBottom=e.safeBottom-16
    if(e.rect.top>=safeTop&&e.rect.bottom<=safeBottom&&e.pointerAccessible)return e
    const o=await ownerSnapshot(c,selector); assert.ok(o)
    const delta=e.rect.top<safeTop?-Math.min(320,Math.max(64,safeTop-e.rect.top+24)):Math.min(320,Math.max(64,e.rect.bottom-safeBottom+24))
    await wheel(c,o,delta)
  }
  throw new Error(`could not reach ${selector}`)
}

async function networkReport(c) {
  const blocked=await c.eval('window.__qaBlocked')
  const bad=c.requests.filter(r=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(r.method))
  const analytics=c.requests.filter(r=>r.url.includes('/functions/v1/decision-intake'))
  assert.equal(bad.length,0); assert.equal(analytics.length,0); assert.deepEqual(blocked,{analytics:0,writes:0})
  return { requests:c.requests.length, supabaseNonRead:bad.length, analytics:analytics.length, blocked }
}

const report={page:PAGE,viewport:{width:390,height:900},status:'running'}
const h=await launch(),c=h.c
try {
  await enterResults(c)
  const {candidate,selected}=await addFirstCandidate(c)
  const beforeCount=await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)
  const paddingWithDock=Number.parseFloat(await c.eval(`getComputedStyle(document.querySelector('.switch-results-stage')).paddingBottom`))
  const owner=await wheelToEnd(c,'.load-more')
  const maxEvidence=await loadMoreEvidence(c)
  assert.ok(maxEvidence?.fullyAbove&&maxEvidence.pointerAccessible,JSON.stringify(maxEvidence))
  await c.shot('390-max-scroll.png')
  await trustedClick(c,'.load-more',null,false)
  await c.wait(`document.querySelectorAll('.switch-candidate-row').length>${beforeCount}`,'list increased')
  const afterCount=await c.eval(`document.querySelectorAll('.switch-candidate-row').length`)
  const afterLoad=stable(await state(c))
  assert.ok(afterCount>beforeCount)
  assert.deepEqual(afterLoad,selected)
  await c.shot('390-after-load-more.png')

  await wheelToStart(c,'.switch-candidate-row')
  await trustedClick(c,'.switch-candidate-row',candidate.name,false)
  await c.wait(`document.querySelector('.switch-candidate-inspector')`,'inspector reopen')
  await wheelUntilVisible(c,'.switch-inspector-actions .switch-compare-action','비교에서 제거')
  await trustedClick(c,'.switch-inspector-actions .switch-compare-action','비교에서 제거',false)
  await c.wait(`!document.querySelector('.switch-compare-dock')`,'dock removed')
  const removed=stable(await state(c))
  assert.equal(removed.compareIds.length,0)
  assert.equal(removed.currentProductId,selected.currentProductId)
  assert.deepEqual(removed.variantSelection,selected.variantSelection)
  const paddingWithoutDock=Number.parseFloat(await c.eval(`getComputedStyle(document.querySelector('.switch-results-stage')).paddingBottom`))
  assert.ok(paddingWithoutDock < paddingWithDock, `${paddingWithoutDock} !< ${paddingWithDock}`)

  report.status='pass'
  report.currentProductId=selected.currentProductId
  report.variantSelection=selected.variantSelection
  report.candidate=candidate
  report.owner=owner
  report.maxEvidence=maxEvidence
  report.listCounts={before:beforeCount,after:afterCount,increased:afterCount>beforeCount}
  report.statePreserved=afterLoad
  report.removedState=removed
  report.padding={withDock:paddingWithDock,withoutDock:paddingWithoutDock,released:paddingWithoutDock<paddingWithDock}
  report.network=await networkReport(c)
  writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))
  console.log('PR40_POSTDEPLOY_390_PASS',JSON.stringify({maxEvidence,listCounts:report.listCounts,padding:report.padding,network:report.network}))
} catch(error) {
  report.status='fail'; report.error=String(error?.stack||error); writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2)); throw error
} finally { await cleanup(h) }
