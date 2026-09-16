import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASELINE = process.env.BASELINE_URL ?? 'https://osrm.github.io/catfood_web/'
const TARGET = process.env.TARGET_URL ?? 'http://127.0.0.1:4173/'
const PRODUCT_SHA = process.env.PRODUCT_SHA
const OUT = 'qa-artifacts'
const STORAGE = 'catfood.switch-session.v1'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const snapshot = {
  version: 1,
  state: {
    query: 'AATU 연어',
    currentProductId: 'product_d99406c26240b263',
    variantSelection: { kind: 'variant', variantId: 'variant_6e426a0abf2e1a43' },
    change: { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false },
    keep: { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false },
    changeBrand: false,
    keepBrand: false,
    ingredientAvoidTerms: [],
    noChangeIntent: true,
    step: 'results',
    visibleCandidateCount: 40,
    selectedCandidateId: null,
    compareIds: ['product_b47d3ae674773585', 'product_99c5ee4eb9211a75'],
    compareOpen: true,
    compareTab: 'overview',
    detailProductId: null,
    detailTab: 'overview',
  },
}
const EXPECTED = {
  current: 'AATU',
  variant: '1 kg',
  first: '오리지날 울트라 그레인프리 인도어 닭 & 연어 레시피',
  second: '오리지날 울트라 닭 & 연어 레시피',
}
mkdirSync(OUT, { recursive: true })
assert.ok(PRODUCT_SHA)

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
      try{sessionStorage.setItem(${JSON.stringify(STORAGE)},${JSON.stringify(JSON.stringify(snapshot))})}catch{}
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
  async wait(expression, label, timeout = 60000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`).catch(() => false)) return
      await sleep(120)
    }
    const body = await this.eval(`document.body?.innerText?.slice(0,1200)`).catch(() => '')
    throw new Error(`timeout: ${label}; body=${JSON.stringify(body)}`)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait(`document.readyState==='complete'`, 'document ready')
    await this.wait(`document.querySelector('#root')&&document.body.innerText.length`, 'root')
    await this.eval('document.fonts?.ready.then(()=>true)')
    await sleep(200)
  }
  async shot(name) {
    await this.eval('document.fonts?.ready.then(()=>true)'); await sleep(80)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height, mobile = true) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome), 'Chrome required')
  const index = launchIndex++
  const port = 17700 + (process.pid % 150) + index * 20
  const dir = `/tmp/compare-header-seeded-${process.pid}-${index}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const c = new CDP(page.webSocketDebuggerUrl)
      await c.connect()
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
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

async function prepare(c, base) {
  await c.nav(`${base}?view=workspace&mode=switch`)
  await c.wait(`document.querySelector('.compare-stage.is-switch-overview')`, 'seeded compare overview')
  await c.wait(`document.querySelector('.compare-mobile-head-grid')`, 'mobile compare header')
  const texts = await c.eval(`(()=>({current:document.querySelector('.compare-mobile-product-head.is-current')?.textContent||'',candidate:document.querySelector('.compare-mobile-product-head.is-candidate')?.textContent||'',toggle:document.querySelector('.compare-mobile-candidate-toggle')?.textContent||''}))()`)
  assert.match(texts.current, /AATU/)
  assert.match(texts.current, /사용 규격 · 1 kg/)
  assert.match(texts.candidate, new RegExp(${JSON.stringify(EXPECTED.first)}))
  assert.match(texts.toggle, /후보 2개 · 1\/2/)
  return texts
}

async function alignForShot(c) {
  await c.eval(`(()=>{const n=document.querySelector('.compare-mobile-head-grid');n?.scrollIntoView({block:'start',inline:'nearest'});scrollBy(0,-8);return true})()`)
  await sleep(100)
}
async function snapshotMetrics(c) {
  return c.eval(`(()=>{
    const rect=n=>n?(()=>{const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,docTop:r.top+scrollY}})():null
    const style=n=>{if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect(),lh=parseFloat(s.lineHeight);return{text:n.textContent.replace(/\\s+/g,' ').trim(),fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,color:s.color,whiteSpace:s.whiteSpace,overflow:s.overflow,textOverflow:s.textOverflow,height:r.height,width:r.width,approxLines:Number.isFinite(lh)&&lh>0?Math.round(r.height/lh):null}}
    const current=document.querySelector('.compare-mobile-product-head.is-current')
    const candidate=document.querySelector('.compare-mobile-product-head.is-candidate')
    const actions=[...document.querySelectorAll('.compare-mobile-head-actions button')]
    const hit=actions.map((b)=>{const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{text:b.textContent.trim(),height:r.height,width:r.width,hit:Boolean(h&&(h===b||b.contains(h))),minHeight:getComputedStyle(b).minHeight}})
    return{
      viewport:{width:innerWidth,height:innerHeight,scrollY},
      headGrid:rect(document.querySelector('.compare-mobile-head-grid')),
      firstRow:rect(document.querySelector('.compare-mobile-overview-row')),
      current:{role:style(current?.querySelector(':scope > span')),brand:style(current?.querySelector('.compare-mobile-product-brand')),name:style(current?.querySelector(':scope > strong')),usage:style(current?.querySelector(':scope > small:nth-of-type(2)')),sale:style(current?.querySelector(':scope > small:nth-of-type(3)'))},
      candidate:{role:style(candidate?.querySelector(':scope > span')),brand:style(candidate?.querySelector('.compare-mobile-product-brand')),name:style(candidate?.querySelector(':scope > strong')),sale:style(candidate?.querySelector(':scope > small:nth-of-type(2)'))},
      actions:actions.map(style),hit
    }
  })()`)
}
async function pressTab(c) {
  await c.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9, nativeVirtualKeyCode:9 })
  await c.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9, nativeVirtualKeyCode:9 })
  await sleep(70)
}
async function keyboardActions(c) {
  await c.eval(`document.activeElement?.blur()`)
  const found=[]
  for(let i=0;i<30&&found.length<2;i++){
    await pressTab(c)
    const s=await c.eval(`(()=>{const n=document.activeElement,x=n?getComputedStyle(n):null;return{matches:Boolean(n?.matches('.compare-mobile-head-actions button')),text:n?.textContent?.replace(/\\s+/g,' ').trim()??null,focusVisible:Boolean(n?.matches(':focus-visible')),outlineStyle:x?.outlineStyle??null,outlineWidth:x?.outlineWidth??null}})()`)
    if(s.matches) found.push(s)
  }
  assert.equal(found.length,2,`header actions not both tabbable: ${JSON.stringify(found)}`)
  for(const item of found){assert.equal(item.focusVisible,true);assert.notEqual(item.outlineStyle,'none');assert.notEqual(item.outlineWidth,'0px')}
  return found
}
async function network(c) {
  const blocked=await c.eval('window.__qaBlocked')
  const supabase=c.requests.filter(r=>r.url.includes('gnosbstdatkytsyxuapt.supabase.co'))
  const nonRead=supabase.filter(r=>!['GET','HEAD','OPTIONS'].includes(r.method))
  const analytics=c.requests.filter(r=>r.url.includes('/functions/v1/decision-intake'))
  assert.equal(nonRead.length,0);assert.equal(analytics.length,0);assert.equal(blocked.writes,0)
  return{total:c.requests.length,supabaseRead:supabase.length,nonRead:0,analyticsNetwork:0,blocked}
}

async function run(label,base,width,height,candidate=false){
  const h=await launch(width,height,true)
  try{
    const texts=await prepare(h.c,base)
    await alignForShot(h.c)
    const metrics=await snapshotMetrics(h.c)
    await h.c.shot(`${label}-${width}.png`)
    let keyboard=null
    if(candidate){
      assert.ok(metrics.hit.every(x=>x.hit),`hit test failed: ${JSON.stringify(metrics.hit)}`)
      assert.ok(metrics.hit.every(x=>x.height>=44),`target below 44px: ${JSON.stringify(metrics.hit)}`)
      keyboard=await keyboardActions(h.c)
    }
    return{texts,metrics,keyboard,network:await network(h.c)}
  }finally{await cleanup(h)}
}

const baseline360=await run('baseline',BASELINE,360,844)
const candidate360=await run('candidate',TARGET,360,844,true)
const baseline390=await run('baseline',BASELINE,390,900)
const candidate390=await run('candidate',TARGET,390,900,true)

const bh=await launch(390,900,true)
let boundaries
try{
  await prepare(bh.c,TARGET)
  async function at(width,mobile){
    await bh.c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile,screenWidth:width,screenHeight:900})
    await bh.c.send('Emulation.setTouchEmulationEnabled',{enabled:mobile,maxTouchPoints:mobile?5:1})
    await sleep(180)
    return bh.c.eval(`(()=>{const m=document.querySelector('.compare-switch-mobile-overview'),d=document.querySelector('.compare-switch-overview-desktop'),n=document.querySelector('.compare-mobile-product-head.is-candidate > strong'),a=document.querySelector('.compare-mobile-head-actions button');return{width:innerWidth,mobileDisplay:m?getComputedStyle(m).display:null,desktopDisplay:d?getComputedStyle(d).display:null,nameFont:n?getComputedStyle(n).fontSize:null,actionFont:a?getComputedStyle(a).fontSize:null,actionMinHeight:a?getComputedStyle(a).minHeight:null}})()`)
  }
  boundaries={at760:await at(760,true),at761:await at(761,false)}
  assert.notEqual(boundaries.at760.mobileDisplay,'none');assert.equal(boundaries.at760.desktopDisplay,'none');assert.equal(boundaries.at760.nameFont,'14px');assert.equal(boundaries.at760.actionFont,'12px');assert.equal(boundaries.at760.actionMinHeight,'44px')
  assert.equal(boundaries.at761.mobileDisplay,'none');assert.notEqual(boundaries.at761.desktopDisplay,'none')
}finally{await cleanup(bh)}

const delta=(b,c)=>({headerHeight:c.metrics.headGrid.height-b.metrics.headGrid.height,firstRowDocTop:c.metrics.firstRow.docTop-b.metrics.firstRow.docTop})
const report={productSha:PRODUCT_SHA,baselineUrl:BASELINE,targetUrl:TARGET,seededSession:snapshot.state,baseline360,candidate360,baseline390,candidate390,boundaries,deltas:{w360:delta(baseline360,candidate360),w390:delta(baseline390,candidate390)}}
writeFileSync(`${OUT}/report.json`,JSON.stringify(report,null,2))
console.log('MOBILE_SWITCH_COMPARE_HEADER_SEEDED_QA_PASS')
console.log(JSON.stringify({deltas:report.deltas,boundaries,candidate360:{current:candidate360.metrics.current,candidate:candidate360.metrics.candidate,actions:candidate360.metrics.actions,hit:candidate360.metrics.hit},candidate390:{headGrid:candidate390.metrics.headGrid,firstRow:candidate390.metrics.firstRow}},null,2))
