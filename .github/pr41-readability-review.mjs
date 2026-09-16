import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PAGE = process.env.PAGE_URL ?? 'https://osrm.github.io/catfood_web/'
const MERGE_SHA = process.env.MERGE_SHA
const OUT = 'qa-readability-artifacts'
const STORAGE = 'catfood.switch-session.v1'
const q = JSON.stringify
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })
assert.ok(MERGE_SHA)

let launchIndex = 0
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
  async wait(expression, label, timeout = 45000) {
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
    await this.eval('document.fonts?.ready.then(()=>true)')
    await sleep(220)
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const index = launchIndex++
  const port = 17600 + (process.pid % 200) + index * 20
  const dir = `/tmp/pr41-readability-${process.pid}-${index}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const c = new CDP(page.webSocketDebuggerUrl)
      await c.connect()
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      return { c, proc, dir }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}

async function cleanup(handle) {
  handle.c.close(); handle.proc.kill('SIGTERM'); await sleep(80)
  if (handle.proc.exitCode == null) handle.proc.kill('SIGKILL')
  try { rmSync(handle.dir, { recursive: true, force: true }) } catch {}
}

async function trustedPointClick(c, selector, matcher = null) {
  const point = await c.eval(`(()=>{const nodes=[...document.querySelectorAll(${q(selector)})];const node=${matcher ? `nodes.find(x=>x.textContent.includes(${q(matcher)}))` : 'nodes[0]'};if(!node)return null;node.scrollIntoView({block:'center',inline:'nearest'});const r=node.getBoundingClientRect(),x=Math.max(3,Math.min(innerWidth-3,r.left+r.width/2)),y=Math.max(3,Math.min(innerHeight-3,r.top+r.height/2)),hit=document.elementFromPoint(x,y);if(!hit||!(hit===node||node.contains(hit)))return{blocked:true,hit:hit?.className||hit?.tagName};return{x,y}})()`)
  assert.ok(point && !point.blocked, `pointer unavailable ${selector} ${matcher ?? ''}`)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(140)
}

async function typeSearch(c, text) {
  await trustedPointClick(c, '.switch-find-search input')
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
  await c.send('Input.insertText', { text })
  await c.wait(`document.querySelector('.switch-find-search input')?.value===${q(text)}`, 'typed search')
}

async function enterResults(c) {
  await c.nav(`${PAGE}?view=workspace&mode=switch`)
  await c.wait(`document.querySelector('.switch-find-search input')`, 'search')
  await c.wait(`!document.body.innerText.includes('제품 목록을 불러오는 중입니다.')`, 'catalog')
  await typeSearch(c, 'AATU 연어')
  await c.wait(`[...document.querySelectorAll('.switch-find-result')].some(x=>x.textContent.includes('AATU')&&x.textContent.includes('연어'))`, 'AATU result')
  await trustedPointClick(c, '.switch-find-result', '연어')
  await c.wait(`document.querySelector('.switch-current-preview')`, 'preview')
  await trustedPointClick(c, '.switch-current-preview .switch-primary-action')
  await c.wait(`document.querySelectorAll('.switch-sku-option').length>0`, 'SKU options')
  await trustedPointClick(c, '.switch-sku-option', '1 kg')
  await trustedPointClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-no-change')`, 'CHANGE')
  await trustedPointClick(c, '.switch-no-change')
  await trustedPointClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-current-facts-strip')`, 'KEEP')
  await trustedPointClick(c, '.switch-step-actions .switch-primary-action')
  await c.wait(`document.querySelector('.switch-results-stage')`, 'RESULTS')
}

async function chooseAndOpenCompare(c) {
  const rows = await c.eval(`[...document.querySelectorAll('.switch-candidate-row')].map(row=>({brand:row.querySelector('.switch-candidate-identity span')?.textContent.trim()||'',name:row.querySelector('.switch-candidate-identity strong')?.textContent.trim()||''})).filter(x=>x.name)`)
  const groups = new Map()
  for (const row of rows) { const values = groups.get(row.brand) ?? []; values.push(row); groups.set(row.brand, values) }
  const chosen = [...groups.values()].filter((values) => values.length >= 2).sort((a,b)=>(b[0].name.length+b[1].name.length)-(a[0].name.length+a[1].name.length))[0]?.slice(0,2)
  assert.equal(chosen?.length, 2)
  for (let i=0;i<chosen.length;i++) {
    await trustedPointClick(c, '.switch-candidate-row', chosen[i].name)
    await c.wait(`document.querySelector('.switch-candidate-inspector h1')?.textContent.includes(${q(chosen[i].name)})`, `inspector ${i}`)
    await trustedPointClick(c, '.switch-inspector-actions .switch-compare-action', '비교에 추가')
    await c.wait(`(()=>{const raw=sessionStorage.getItem(${q(STORAGE)});const s=raw?JSON.parse(raw).state:null;return s?.compareIds?.length===${i+1}})()`, `compare ${i+1}`)
    await trustedPointClick(c, '.switch-preview-topline button')
  }
  await trustedPointClick(c, '.switch-compare-dock > button', '비교 보기')
  await c.wait(`document.querySelector('.compare-stage.is-switch-overview')`, 'compare')
  return chosen
}

async function typography(c) {
  return c.eval(`(()=>{
    const effBg=(el)=>{for(let n=el;n;n=n.parentElement){const bg=getComputedStyle(n).backgroundColor;if(bg&&bg!=='rgba(0, 0, 0, 0)'&&bg!=='transparent')return bg}return 'rgb(255, 255, 255)'}
    const lines=(el)=>{if(!el)return null;const r=document.createRange();r.selectNodeContents(el);const tops=[...r.getClientRects()].map(x=>Math.round(x.top*10)/10);return new Set(tops).size}
    const snap=(el)=>{if(!el)return null;const s=getComputedStyle(el),r=el.getBoundingClientRect();return{text:el.textContent.replace(/\\s+/g,' ').trim(),fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,color:s.color,background:effBg(el),whiteSpace:s.whiteSpace,overflowWrap:s.overflowWrap,wordBreak:s.wordBreak,width:r.width,height:r.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,lines:lines(el)}}
    const qs=(s)=>document.querySelector(s)
    const valueByText=(text)=>[...document.querySelectorAll('.compare-mobile-pair > div > div')].find(x=>x.textContent.trim()===text)
    const rowByLabel=(label)=>[...document.querySelectorAll('.compare-mobile-overview-row')].find(x=>x.querySelector('.compare-mobile-row-label')?.textContent.trim()===label)
    const sale=rowByLabel('판매 규격')
    return{
      viewport:{innerWidth,innerHeight,dpr:devicePixelRatio,docClientWidth:document.documentElement.clientWidth,docScrollWidth:document.documentElement.scrollWidth},
      pickerMeta:snap(qs('.compare-mobile-candidate-meta')),
      pickerBrand:snap(qs('.compare-mobile-candidate-brand')),
      pickerName:snap(qs('.compare-mobile-candidate-name')),
      currentRole:snap(qs('.compare-mobile-product-head.is-current > span')),
      currentBrand:snap(qs('.compare-mobile-product-head.is-current .compare-mobile-product-brand')),
      currentName:snap(qs('.compare-mobile-product-head.is-current > strong')),
      currentUseSize:snap(qs('.compare-mobile-product-head.is-current > small:nth-of-type(2)')),
      currentSaleSize:snap(qs('.compare-mobile-product-head.is-current > small:nth-of-type(3)')),
      candidateRole:snap(qs('.compare-mobile-product-head.is-candidate > span')),
      candidateBrand:snap(qs('.compare-mobile-product-head.is-candidate .compare-mobile-product-brand')),
      candidateName:snap(qs('.compare-mobile-product-head.is-candidate > strong')),
      candidateSaleSize:snap(qs('.compare-mobile-product-head.is-candidate > small:nth-of-type(2)')),
      detailAction:snap(qs('.compare-mobile-product-head.is-candidate .compare-mobile-head-actions button:first-child')),
      removeAction:snap(qs('.compare-mobile-product-head.is-candidate .compare-mobile-head-actions button:last-child')),
      sectionTitle:snap(qs('.compare-switch-mobile-overview .compare-section-row strong')),
      sectionNote:snap(qs('.compare-switch-mobile-overview .compare-section-row span')),
      rowLabel:snap(qs('.compare-mobile-row-label')),
      pairCurrentLabel:snap(qs('.compare-mobile-pair > div:first-child > span')),
      pairCandidateLabel:snap(qs('.compare-mobile-pair > div:nth-child(2) > span')),
      pairCurrentValue:snap(qs('.compare-mobile-pair > div:first-child > div')),
      pairCandidateValue:snap(qs('.compare-mobile-pair > div:nth-child(2) > div')),
      confirmedNone:snap(valueByText('확인된 값 없음')),
      officialUnknown:snap(valueByText('공식 표기 미확인')),
      saleCurrent:snap(sale?.querySelector('.compare-mobile-pair > div:first-child > div')),
      saleCandidate:snap(sale?.querySelector('.compare-mobile-pair > div:nth-child(2) > div'))
    }
  })()`)
}

async function pressZoomIn(c, times) {
  for (let i=0;i<times;i++) {
    await c.send('Input.dispatchKeyEvent', { type:'keyDown', key:'=', code:'Equal', windowsVirtualKeyCode:187, nativeVirtualKeyCode:187, modifiers:2 })
    await c.send('Input.dispatchKeyEvent', { type:'keyUp', key:'=', code:'Equal', windowsVirtualKeyCode:187, nativeVirtualKeyCode:187, modifiers:2 })
    await sleep(120)
  }
}

async function zoomSnapshot(c) {
  return c.eval(`(()=>{
    const pick=(s)=>document.querySelector(s)
    const metric=(el)=>el?(()=>{const r=el.getBoundingClientRect();return{text:el.textContent.replace(/\\s+/g,' ').trim(),width:r.width,height:r.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,visible:r.width>0&&r.height>0}})():null
    return{innerWidth,innerHeight,dpr:devicePixelRatio,visualScale:visualViewport?.scale??null,docClientWidth:document.documentElement.clientWidth,docScrollWidth:document.documentElement.scrollWidth,currentName:metric(pick('.compare-mobile-product-head.is-current > strong')),candidateName:metric(pick('.compare-mobile-product-head.is-candidate > strong')),useSize:metric(pick('.compare-mobile-product-head.is-current > small:nth-of-type(2)')),detail:metric(pick('.compare-mobile-head-actions button:first-child')),remove:metric(pick('.compare-mobile-head-actions button:last-child')),rowLabel:metric(pick('.compare-mobile-row-label')),pair:metric(pick('.compare-mobile-pair'))}
  })()`)
}

async function network(c) {
  const blocked = await c.eval('window.__qaBlocked')
  const supabase = c.requests.filter((r)=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co'))
  return{total:c.requests.length,supabaseRead:supabase.filter((r)=>['GET','HEAD','OPTIONS'].includes(r.method)).length,nonRead:supabase.filter((r)=>!['GET','HEAD','OPTIONS'].includes(r.method)).length,analyticsNetwork:c.requests.filter((r)=>r.url.includes('/functions/v1/decision-intake')).length,blocked}
}

async function run(width,height,zoom=false) {
  const h=await launch(width,height)
  try {
    await enterResults(h.c)
    const chosen=await chooseAndOpenCompare(h.c)
    const styles=await typography(h.c)
    await h.c.shot(`readability-${width}.png`)
    let zoomCheck=null
    if(zoom){
      const before=await zoomSnapshot(h.c)
      await pressZoomIn(h.c,5)
      const after=await zoomSnapshot(h.c)
      await h.c.shot(`readability-${width}-zoom.png`)
      zoomCheck={before,after,layoutChanged:before.innerWidth!==after.innerWidth||before.dpr!==after.dpr}
    }
    return{chosen,styles,zoomCheck,network:await network(h.c)}
  } finally { await cleanup(h) }
}

const report={mergeSha:MERGE_SHA,page:PAGE,at360:await run(360,844,true),at390:await run(390,900,false)}
for(const entry of [report.at360,report.at390]){assert.equal(entry.network.nonRead,0);assert.equal(entry.network.analyticsNetwork,0);assert.equal(entry.network.blocked.writes,0)}
writeFileSync(`${OUT}/readability-report.json`,JSON.stringify(report,null,2))
console.log('PR41_READABILITY_REVIEW_PASS')
console.log(JSON.stringify(report,null,2))
