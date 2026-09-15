import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/catfood_web/'
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const q = JSON.stringify
let launchNo = 0

class CDP {
  constructor(ws) { this.wsUrl = ws; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
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
  async wait(expression, label, timeout = 30000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`).catch(() => false)) return
      await sleep(80)
    }
    throw new Error(`timeout: ${label}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length`, 'root content')
    await this.eval('document.fonts?.ready')
    await sleep(200)
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile, snapshot = null) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome))
  const port = 10300 + (process.pid % 100) + launchNo++ * 50
  const dir = `/tmp/pr38-final-${process.pid}-${launchNo}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const c = new CDP(page.webSocketDebuggerUrl)
      await c.connect()
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const original=window.fetch.bind(window);window.__qaBlocked={analytics:0,writes:0};window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.reject(new TypeError('blocked analytics'))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.reject(new TypeError('blocked write'))}return original(input,init)};${snapshot ? `sessionStorage.setItem(${q(STORAGE)},${q(snapshot)});` : ''}})();` })
      return { c, proc, dir }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}
async function cleanup(h) { h.c.close(); h.proc.kill('SIGTERM'); await sleep(80); if (h.proc.exitCode == null) h.proc.kill('SIGKILL'); rmSync(h.dir, { recursive: true, force: true }) }

async function click(c, selector, index = 0, contains = []) {
  const point = await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${q(selector)})].filter(n=>${q(contains)}.every(t=>n.textContent?.includes(t)));const n=nodes[${index}];if(!n)return null;const r=n.getBoundingClientRect();if(r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth)return{offscreen:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},text:n.textContent.trim()};window.__qaTrusted=null;n.addEventListener('click',e=>window.__qaTrusted=e.isTrusted,{once:true,capture:true});return{x:Math.max(2,Math.min(innerWidth-2,r.left+r.width/2)),y:Math.max(2,Math.min(innerHeight-2,r.top+r.height/2)),text:n.textContent.trim()}})()`)
  assert.ok(point, `missing ${selector} ${contains.join('+')} [${index}]`)
  assert.ok(!point.offscreen, `offscreen ${selector}: ${JSON.stringify(point)}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(120)
  assert.equal(await c.eval('window.__qaTrusted'), true)
}
async function typeText(c, selector, text) {
  await click(c, selector)
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector(${q(selector)})?.value===${q(text)}`, 'typed input')
}
async function scrollInfo(c, anchor) {
  return c.eval(`(()=>{let n=document.querySelector(${q(anchor)});while(n){const s=getComputedStyle(n);if((s.overflowY==='auto'||s.overflowY==='scroll')&&n.scrollHeight>n.clientHeight+1)return{owner:'.'+[...n.classList].join('.'),top:n.scrollTop,max:n.scrollHeight-n.clientHeight,documentTop:document.scrollingElement?.scrollTop||0};n=n.parentElement}const d=document.scrollingElement;return{owner:'document',top:d?.scrollTop||0,max:d?d.scrollHeight-d.clientHeight:0,documentTop:d?.scrollTop||0}})()`)
}
async function wheelOwner(c, anchor, deltaY) {
  const point = await c.eval(`(()=>{let n=document.querySelector(${q(anchor)});while(n){const s=getComputedStyle(n);if((s.overflowY==='auto'||s.overflowY==='scroll')&&n.scrollHeight>n.clientHeight+1){const r=n.getBoundingClientRect();return{x:Math.max(8,Math.min(innerWidth-8,r.left+Math.min(r.width,innerWidth)/2)),y:Math.max(8,Math.min(innerHeight-8,r.top+Math.min(r.height,innerHeight)/2))}}n=n.parentElement}return{x:innerWidth/2,y:innerHeight/2}})()`)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, pointerType: 'mouse' })
  await sleep(90)
}
async function visible(c, selector, index = 0, anchor = selector, minTop = 6) {
  for (let i = 0; i < 40; i++) {
    const r = await c.eval(`(()=>{const n=document.querySelectorAll(${q(selector)})[${index}];if(!n)return null;const r=n.getBoundingClientRect();return{ok:r.top>=${minTop}&&r.bottom<=innerHeight-6,top:r.top,bottom:r.bottom}})()`)
    assert.ok(r, `missing ${selector} [${index}]`)
    if (r.ok) return
    await wheelOwner(c, anchor, r.top < minTop ? -480 : 560)
  }
  throw new Error(`could not make visible ${selector}`)
}
async function rect(c, selector) { return c.eval(`(()=>{const n=document.querySelector(${q(selector)});if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,text:n.textContent.trim()}})()`) }
async function state(c) { return c.eval(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});return raw?JSON.parse(raw).state:null})()`) }
async function historyMove(c, offset) { const h = await c.send('Page.getNavigationHistory'); const e = h.entries[h.currentIndex + offset]; assert.ok(e, `missing history offset ${offset}`); await c.send('Page.navigateToHistoryEntry', { entryId: e.id }) }
function net(c) { return { writes: c.requests.filter(r=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(r.method)), analytics:c.requests.filter(r=>r.url.includes('/functions/v1/decision-intake')), nonRead:c.requests.filter(r=>!['GET','HEAD','OPTIONS'].includes(r.method)), gets:c.requests.filter(r=>r.method==='GET').length } }

async function mobile() {
  const h = await launch(360, 844, true)
  const c = h.c
  const report = { viewport:'360x844', transitions:{}, restores:{}, loading:{} }
  try {
    await c.nav(BASE)
    await c.wait(`document.querySelector('.home-start-path button')`, 'home switch')
    await visible(c, '.home-start-path button', 0, '.home-start-path')
    await click(c, '.home-start-path button', 0, ['현재 사료로 시작하기'])
    await c.wait(`document.querySelector('.switch-find-search input')`, 'current search')
    await typeText(c, '.switch-find-search input', 'AATU 연어')
    await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(n=>n.textContent.includes('AATU')&&n.textContent.includes('연어'))`, 'AATU result')
    const pi = await c.eval(`[...document.querySelectorAll('.switch-find-result')].findIndex(n=>n.textContent.includes('AATU')&&n.textContent.includes('연어'))`)
    await visible(c, '.switch-find-result', pi, '.switch-find-results-list'); await click(c, '.switch-find-result', pi, ['AATU','연어'])
    await c.wait(`document.querySelector('.switch-current-preview')`, 'preview')
    await visible(c, '.switch-current-preview .switch-primary-action', 0, '.switch-current-preview')
    await c.send('Network.emulateNetworkConditions',{offline:false,latency:700,downloadThroughput:10000000,uploadThroughput:10000000,connectionType:'wifi'})
    await click(c, '.switch-current-preview .switch-primary-action')
    await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'sku', 20000)
    await c.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:'wifi'})
    await visible(c, '.switch-sku-option', 0, '.switch-step-main'); await click(c, '.switch-sku-option', 0)
    await visible(c, '.switch-step-actions .switch-primary-action', 0, '.switch-step-main'); await click(c, '.switch-step-actions .switch-primary-action')
    await c.wait(`document.querySelector('.switch-no-change')`, 'change')
    await visible(c, '.switch-no-change', 0, '.switch-step-main'); await click(c, '.switch-no-change')

    await visible(c, '.switch-step-actions .switch-primary-action', 0, '.switch-step-main')
    const changeBefore = await scrollInfo(c, '.switch-step-main'); assert.ok(changeBefore.top>0, JSON.stringify(changeBefore))
    await click(c, '.switch-step-actions .switch-primary-action'); await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'keep')
    const keepAfter = await scrollInfo(c, '.switch-step-main'); assert.ok(keepAfter.top<=1, JSON.stringify(keepAfter))
    const keepHeading = await rect(c,'.switch-step-header h1'); assert.ok(keepHeading?.top>=0&&keepHeading.top<844)
    await c.shot('360-keep-immediate.png')
    report.transitions.changeToKeep={screen:'keep',owner:keepAfter.owner,before:changeBefore,after:keepAfter,heading:keepHeading,screenshot:'360-keep-immediate.png'}

    assert.ok(await c.eval(`document.querySelectorAll('.switch-criteria-columns button').length>0`))
    await visible(c,'.switch-criteria-columns button',0,'.switch-step-main'); await click(c,'.switch-criteria-columns button',0)
    const edited=await state(c); const keepSig=JSON.stringify([edited.keep,edited.keepBrand])
    await visible(c,'.switch-step-actions .switch-secondary-action',0,'.switch-step-main')
    const keepBeforeBack=await scrollInfo(c,'.switch-step-main'); assert.ok(keepBeforeBack.top>0)
    await click(c,'.switch-step-actions .switch-secondary-action'); await c.wait(`document.querySelector('.switch-no-change')`,'explicit previous')
    const changeAfterBack=await scrollInfo(c,'.switch-step-main'); const backState=await state(c)
    assert.ok(changeAfterBack.top<=1); assert.equal(backState.noChangeIntent,true); assert.equal(JSON.stringify([backState.keep,backState.keepBrand]),keepSig); assert.equal(await c.eval('history.scrollRestoration'),'auto')
    await c.shot('360-change-explicit-back-immediate.png')
    report.transitions.keepToChangePrevious={screen:'change',owner:changeAfterBack.owner,before:keepBeforeBack,after:changeAfterBack,keepPreserved:true,changePreserved:true,screenshot:'360-change-explicit-back-immediate.png'}

    await wheelOwner(c,'.switch-step-main',320); const changeRead=await scrollInfo(c,'.switch-step-main'); assert.ok(changeRead.top>0)
    await historyMove(c,1); await c.wait(`document.querySelector('.switch-current-facts-strip')`,'forward keep'); await sleep(180); const keepForward=await scrollInfo(c,'.switch-step-main'); assert.ok(Math.abs(keepForward.top-keepBeforeBack.top)<=3,JSON.stringify({keepForward,keepBeforeBack}))
    await historyMove(c,-1); await c.wait(`document.querySelector('.switch-no-change')`,'back change'); await sleep(180); const changeBack=await scrollInfo(c,'.switch-step-main'); assert.ok(Math.abs(changeBack.top-changeRead.top)<=3,JSON.stringify({changeBack,changeRead}))
    await historyMove(c,1); await c.wait(`document.querySelector('.switch-current-facts-strip')`,'forward keep 2'); await sleep(180); const keepForward2=await scrollInfo(c,'.switch-step-main'); assert.ok(Math.abs(keepForward2.top-keepBeforeBack.top)<=3)
    report.restores.stepHistory={keepBeforeBack,keepForward,changeRead,changeBack,keepForward2}

    await visible(c,'.switch-step-actions .switch-primary-action',0,'.switch-step-main'); const keepBeforeResults=await scrollInfo(c,'.switch-step-main'); await click(c,'.switch-step-actions .switch-primary-action')
    await c.wait(`document.querySelector('.switch-results-stage')&&document.querySelectorAll('.switch-candidate-row').length>=2`,'results')
    const resultsAfter=await scrollInfo(c,'.switch-candidate-list'); assert.ok(resultsAfter.top<=1); const sessionBar=await rect(c,'.switch-session-bar'); const candidateHeading=await rect(c,'.switch-candidate-heading'); assert.ok(sessionBar?.top>=0&&sessionBar.top<844); assert.ok(candidateHeading?.top>=0&&candidateHeading.top<844)
    await c.shot('360-results-immediate.png'); report.transitions.keepToResults={screen:'results',owner:resultsAfter.owner,before:keepBeforeResults,after:resultsAfter,sessionBar,candidateHeading,screenshot:'360-results-immediate.png'}

    await visible(c,'.switch-candidate-row',0,'.switch-candidate-list'); await click(c,'.switch-candidate-row',0); await c.wait(`document.querySelector('.switch-candidate-inspector')`,'inspector')
    const first=await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`)
    await visible(c,'.switch-candidate-inspector .switch-compare-action',0,'.switch-candidate-inspector'); await click(c,'.switch-candidate-inspector .switch-compare-action',0,['비교에 추가'])
    await visible(c,'.switch-candidate-inspector .switch-compare-action',1,'.switch-candidate-inspector'); const parentBeforeDetail=await scrollInfo(c,'.switch-candidate-inspector')
    await c.send('Network.emulateNetworkConditions',{offline:false,latency:650,downloadThroughput:10000000,uploadThroughput:10000000,connectionType:'wifi'})
    await click(c,'.switch-candidate-inspector .switch-compare-action',0,['상세 보기']); await c.wait(`document.querySelector('.detail-stage')`,'detail')
    const detailOwner=await scrollInfo(c,'.detail-stage'); if(detailOwner.max>0)await wheelOwner(c,'.detail-stage',320); const detailScrolled=await scrollInfo(c,'.detail-stage'); await c.wait(`!document.body.innerText.includes('불러오는 중')`,'detail settled',20000); const detailAfter=await scrollInfo(c,'.detail-stage'); if(detailScrolled.top>1)assert.ok(Math.abs(detailAfter.top-detailScrolled.top)<=3,JSON.stringify({detailScrolled,detailAfter}))
    const backButton=await rect(c,'.detail-topbar > button'); assert.ok(backButton&&backButton.bottom>0&&backButton.top<844,JSON.stringify(backButton)); report.loading.detail={owner:detailOwner,scrolled:detailScrolled,after:detailAfter,backButton}
    await c.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:'wifi'}); await click(c,'.detail-topbar > button'); await c.wait(`document.querySelector('.switch-candidate-inspector')`,'detail return'); await sleep(180)
    const detailReturn=await scrollInfo(c,'.switch-candidate-inspector'); assert.ok(Math.abs(detailReturn.top-parentBeforeDetail.top)<=3,JSON.stringify({parentBeforeDetail,detailReturn})); assert.equal(await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`),first)
    await c.shot('360-detail-return-preserved.png'); report.restores.detailReturn={screen:'results-inspector',owner:detailReturn.owner,before:parentBeforeDetail,after:detailReturn,selected:first,screenshot:'360-detail-return-preserved.png'}

    await visible(c,'.switch-preview-topline button',0,'.switch-candidate-inspector'); await click(c,'.switch-preview-topline button'); await c.wait(`!document.querySelector('.switch-candidate-inspector')`,'inspector close')
    await visible(c,'.switch-candidate-row',1,'.switch-candidate-list'); await click(c,'.switch-candidate-row',1); await c.wait(`document.querySelector('.switch-candidate-inspector')`,'inspector2'); const second=await c.eval(`document.querySelector('.switch-candidate-inspector h1')?.textContent.trim()`); await visible(c,'.switch-candidate-inspector .switch-compare-action',0,'.switch-candidate-inspector'); await click(c,'.switch-candidate-inspector .switch-compare-action',0,['비교에 추가']); await visible(c,'.switch-preview-topline button',0,'.switch-candidate-inspector'); await click(c,'.switch-preview-topline button'); await c.wait(`!document.querySelector('.switch-candidate-inspector')`,'inspector2 close')
    await wheelOwner(c,'.switch-candidate-list',420); const resultsBeforeCompare=await scrollInfo(c,'.switch-candidate-list'); assert.ok(resultsBeforeCompare.top>0); await click(c,'.switch-compare-dock > button',0,['비교 보기']); await c.wait(`document.querySelector('.compare-stage')`,'compare')
    const compareAfter=await scrollInfo(c,'.compare-stage'); const compareTitle=await rect(c,'.compare-header h1'); assert.ok(compareAfter.top<=1); assert.ok(compareTitle?.top>=0&&compareTitle.top<844); await c.shot('360-compare-immediate.png'); report.transitions.resultsToCompare={screen:'compare',owner:compareAfter.owner,before:resultsBeforeCompare,after:compareAfter,title:compareTitle,screenshot:'360-compare-immediate.png'}
    await click(c,'.compare-header > button'); await c.wait(`document.querySelector('.switch-results-stage')&&!document.querySelector('.compare-stage')`,'compare return'); await sleep(180); const resultsReturn=await scrollInfo(c,'.switch-candidate-list'); assert.ok(Math.abs(resultsReturn.top-resultsBeforeCompare.top)<=3,JSON.stringify({resultsReturn,resultsBeforeCompare})); const returnState=await state(c); assert.equal(returnState.compareIds.length,2); await c.shot('360-results-compare-return-preserved.png'); report.restores.compareReturn={screen:'results',owner:resultsReturn.owner,before:resultsBeforeCompare,after:resultsReturn,compareIds:returnState.compareIds,screenshot:'360-results-compare-return-preserved.png'}

    await historyMove(c,1); await c.wait(`document.querySelector('.compare-stage')`,'history forward compare'); await sleep(180); await wheelOwner(c,'.compare-stage',300); const compareRead=await scrollInfo(c,'.compare-stage'); assert.ok(compareRead.top>0); await historyMove(c,-1); await c.wait(`document.querySelector('.switch-results-stage')&&!document.querySelector('.compare-stage')`,'history back results'); await sleep(180); const backResults=await scrollInfo(c,'.switch-candidate-list'); assert.ok(Math.abs(backResults.top-resultsBeforeCompare.top)<=3); await historyMove(c,1); await c.wait(`document.querySelector('.compare-stage')`,'history forward compare2'); await sleep(180); const forwardCompare=await scrollInfo(c,'.compare-stage'); assert.ok(Math.abs(forwardCompare.top-compareRead.top)<=3,JSON.stringify({forwardCompare,compareRead})); await c.shot('360-compare-browser-forward-preserved.png'); report.restores.browserHistory={resultsBeforeCompare,backResults,compareRead,forwardCompare,screenshot:'360-compare-browser-forward-preserved.png'}

    const network=net(c); const blocked=await c.eval('window.__qaBlocked'); assert.equal(network.writes.length,0); assert.equal(network.analytics.length,0); assert.equal(network.nonRead.length,0); assert.deepEqual(blocked,{analytics:0,writes:0}); report.network={writes:0,analytics:0,nonRead:0,gets:network.gets,blocked}; report.candidates=[first,second]
    const desktopState={...(await state(c)),step:'change',compareOpen:false,detailProductId:null,detailTab:'overview'}; report.desktopSnapshot=JSON.stringify({version:1,state:desktopState}); return report
  } finally { await cleanup(h) }
}

async function desktop(snapshot) {
  const h=await launch(1280,900,false,snapshot); const c=h.c
  try {
    await c.nav(`${BASE}?view=workspace&mode=switch`); await c.wait(`document.querySelector('.switch-no-change')`,'desktop change'); const initial=await scrollInfo(c,'.switch-step-main'); assert.ok(initial.owner.includes('switch-step-main'),JSON.stringify(initial)); assert.equal(initial.documentTop,0); await visible(c,'.switch-step-actions .switch-primary-action',0,'.switch-step-main'); const before=await scrollInfo(c,'.switch-step-main'); assert.ok(before.top>0); await click(c,'.switch-step-actions .switch-primary-action'); await c.wait(`document.querySelector('.switch-current-facts-strip')`,'desktop keep'); const after=await scrollInfo(c,'.switch-step-main'); assert.ok(after.owner.includes('switch-step-main')); assert.ok(after.top<=1); assert.equal(after.documentTop,0); await c.shot('1280-keep-internal-owner-immediate.png'); const network=net(c); const blocked=await c.eval('window.__qaBlocked'); assert.equal(network.writes.length,0); assert.equal(network.analytics.length,0); assert.equal(network.nonRead.length,0); assert.deepEqual(blocked,{analytics:0,writes:0}); return{viewport:'1280x900',screen:'keep',owner:after.owner,initial,before,after,screenshot:'1280-keep-internal-owner-immediate.png',network:{writes:0,analytics:0,nonRead:0,gets:network.gets,blocked}}
  } finally { await cleanup(h) }
}

const report={productSha:process.env.PRODUCT_SHA,status:'running'}
try{report.mobile=await mobile();report.desktop=await desktop(report.mobile.desktopSnapshot);delete report.mobile.desktopSnapshot;report.status='pass';writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2));console.log('PR38_SCROLL PASS',JSON.stringify({transitions:report.mobile.transitions,restores:report.mobile.restores,desktop:report.desktop}))}catch(error){report.status='fail';report.error=String(error?.stack??error);writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2));throw error}
