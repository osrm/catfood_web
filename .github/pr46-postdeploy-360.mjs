import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE || 'https://osrm.github.io/catfood_web/'
const PRODUCT_SHA = process.env.PRODUCT_SHA
const API_URL = process.env.VITE_SUPABASE_URL
const API_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const OUT = 'qa-artifacts/pr46-postdeploy-360'
const q = JSON.stringify
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

assert.ok(PRODUCT_SHA)
assert.ok(API_URL && API_KEY)
mkdirSync(OUT, { recursive: true })

async function apiRows(view, params) {
  const url = new URL(API_URL.replace(/\/$/, '') + '/rest/v1/' + view)
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: API_KEY, 'Accept-Profile': 'api' } })
  const text = await response.text()
  assert.equal(response.ok, true, 'public API ' + view + ' ' + response.status + ': ' + text.slice(0, 240))
  return JSON.parse(text)
}

function packageLabel(row) {
  const size = row.package_size_text && row.package_size_text.trim()
    ? row.package_size_text.trim()
    : row.package_weight_g != null ? Number(row.package_weight_g).toLocaleString('ko-KR') + ' g' : null
  if (!size) return null
  return row.units_per_sale && row.units_per_sale > 1 ? size + ' × ' + row.units_per_sale : size
}

async function discover() {
  const catalog = await apiRows('effective_product_catalog_summary', {
    select: 'product_id,brand,canonical_name,feed_type,life_stage,display_image_url,representative_package_size_text,representative_package_weight_g,representative_units_per_sale,representative_sale_total_weight_g,manufacturing_country_codes,official_targets,features,recipe_families,recipe_details,official_recipe_traits',
    order: 'brand.asc,canonical_name.asc',
    limit: '1000',
  })
  const aatu = catalog.find((p) => p.brand === 'AATU' && p.canonical_name === '연어')
  const go = catalog.find((p) => p.brand === 'GO! SOLUTIONS' && p.canonical_name === '카니보 치킨&칠면조&오리')
    || catalog.find((p) => String(p.brand).toLowerCase().includes('go') && ['카니보','치킨','칠면조','오리'].every((x) => String(p.canonical_name).includes(x)))
  assert.ok(aatu, 'AATU 연어 missing')
  assert.ok(go, 'GO! SOLUTIONS 카니보 product missing')

  const preferred = [
    '오리지날 울트라 그레인프리 인도어 닭 & 연어 레시피',
    '오리지날 울트라 닭 & 연어 레시피',
  ]
  let longPair = preferred.map((name) => catalog.find((p) => p.canonical_name === name)).filter(Boolean)
  if (longPair.length !== 2 || longPair[0].brand !== longPair[1].brand) {
    const groups = new Map()
    for (const p of catalog) {
      if (String(p.canonical_name || '').length < 24) continue
      const list = groups.get(p.brand) || []
      list.push(p)
      groups.set(p.brand, list)
    }
    const ranked = [...groups.entries()].filter(([, list]) => list.length >= 2).map(([brand, list]) => {
      const sorted = [...list].sort((a, b) => b.canonical_name.length - a.canonical_name.length)
      return { brand, products: sorted.slice(0, 2), score: sorted[0].canonical_name.length + sorted[1].canonical_name.length }
    }).sort((a, b) => b.score - a.score)
    assert.ok(ranked.length, 'same-brand long-name pair missing')
    longPair = ranked[0].products
  }
  assert.equal(longPair[0].brand, longPair[1].brand)

  const targets = [aatu, go, ...longPair]
  const ids = targets.map((p) => p.product_id)
  const variants = await apiRows('switch_current_variant_options', {
    select: 'product_id,variant_id,package_size_text,package_weight_g,units_per_sale,sale_total_weight_g,display_rank',
    product_id: 'in.(' + ids.join(',') + ')',
    order: 'product_id.asc,display_rank.asc,variant_id.asc',
    limit: '200',
  })
  const packages = {}
  for (const p of targets) {
    const labels = []
    for (const row of variants.filter((v) => v.product_id === p.product_id)) {
      const label = packageLabel(row)
      if (label && !labels.includes(label)) labels.push(label)
    }
    packages[p.product_id] = labels.length ? labels.join(' · ') : (p.representative_package_size_text || '판매 규격 미확인')
  }
  return { catalogCount: catalog.length, pair: [aatu, go], longPair, packages }
}

let launchIndex = 0
class CDP {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data)
      if (m.method === 'Network.requestWillBeSent') this.requests.push({ url: m.params.request.url, method: m.params.request.method })
      if (!m.id) return
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    })
    for (const domain of ['Page.enable','Runtime.enable','Network.enable','DOM.enable','CSS.enable','Accessibility.enable']) await this.send(domain)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    const blocker = "(()=>{const nativeFetch=window.fetch.bind(window);window.__qaBlocked={analytics:0,writes:0};window.fetch=(input,init={})=>{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(url.includes('/functions/v1/decision-intake')){window.__qaBlocked.analytics++;return Promise.resolve(new Response(null,{status:204}))}if(url.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(method)){window.__qaBlocked.writes++;return Promise.resolve(new Response(null,{status:204}))}return nativeFetch(input,init)}})();"
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: blocker })
  }
  send(method, params) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result && result.result.value
  }
  async wait(expression, label, timeout) {
    const end = Date.now() + (timeout || 45000)
    while (Date.now() < end) {
      if (await this.eval('Boolean(' + expression + ')').catch(() => false)) return
      await sleep(100)
    }
    throw new Error('timeout: ' + label)
  }
  async nav(url) {
    await this.send('Page.navigate', { url })
    await this.wait("document.readyState==='complete'", 'ready')
    await this.wait("document.querySelector('#root')&&document.body.innerText.length", 'root')
    await this.eval("document.fonts&&document.fonts.ready.then(()=>true)")
    await sleep(220)
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(OUT + '/' + name, Buffer.from(result.data, 'base64'))
  }
  close() { try { this.ws && this.ws.close() } catch {} }
}

async function launch(width, height) {
  const chrome = '/usr/bin/google-chrome'
  assert.ok(existsSync(chrome))
  const index = launchIndex++
  const port = 18400 + (process.pid % 80) + index * 10
  const dir = '/tmp/pr46-two-' + process.pid + '-' + index
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-cache','--remote-debugging-port=' + port,'--user-data-dir=' + dir,'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      const page = pages.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (!page) throw new Error('no page')
      const c = new CDP(page.webSocketDebuggerUrl)
      await c.connect()
      const mobile = width <= 760
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height })
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
      return { c, proc, dir, chrome: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
    } catch {}
    await sleep(100)
  }
  throw new Error('chrome launch timeout')
}

async function cleanup(h) {
  h.c.close()
  h.proc.kill('SIGTERM')
  await sleep(100)
  if (h.proc.exitCode == null) h.proc.kill('SIGKILL')
  try { rmSync(h.dir, { recursive: true, force: true }) } catch {}
}

function compareUrl(mode, products) {
  const url = new URL(BASE)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', mode)
  if (mode === 'lookup') url.searchParams.set('q', products[0].brand + ' ' + products[0].canonical_name)
  if (mode === 'explore') { url.searchParams.set('applied', '1'); url.searchParams.set('feed', '건식') }
  url.searchParams.set('compare', products.map((p) => p.product_id).join(','))
  url.searchParams.set('compareOpen', '1')
  url.searchParams.set('compareTab', 'overview')
  return url.toString()
}

async function waitTwo(c) {
  await c.wait("document.querySelector('.compare-stage')", 'compare stage')
  await c.wait("document.querySelectorAll('.compare-mobile-two-product-head').length===2", 'two heads')
  await c.wait("getComputedStyle(document.querySelector('.compare-mobile-two-product-overview')).display!=='none'", 'mobile overview')
  await c.wait("!document.body.innerText.includes('제품 데이터를 불러오는 중입니다.')", 'catalog')
  await c.wait("[...document.querySelectorAll('.compare-mobile-two-product-head img')].length===2&&[...document.querySelectorAll('.compare-mobile-two-product-head img')].every(img=>img.complete&&img.naturalWidth>0)", 'product images decoded', 20000)
  await sleep(120)
}

async function network(c) {
  const writes = c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET','HEAD','OPTIONS'].includes(r.method))
  const analytics = c.requests.filter((r) => r.url.includes('/functions/v1/decision-intake'))
  const nonRead = c.requests.filter((r) => !['GET','HEAD','OPTIONS'].includes(r.method))
  assert.equal(writes.length, 0, 'write escaped blocker')
  assert.equal(analytics.length, 0, 'analytics escaped blocker')
  assert.equal(nonRead.length, 0, 'non-read request escaped blocker')
  return { publicReads: c.requests.filter((r) => r.url.includes('gnosbstdatkytsyxuapt.supabase.co') && r.method === 'GET').length, blocked: await c.eval('window.__qaBlocked') }
}

async function pointer(c, selector, matcher) {
  const token = 'qa' + Date.now() + Math.random().toString(16).slice(2)
  const expression = "(()=>{const nodes=[...document.querySelectorAll(" + q(selector) + ")];const node=" +
    (matcher ? "nodes.find(n=>n.textContent.includes(" + q(matcher) + ")||n.getAttribute('aria-label')?.includes(" + q(matcher) + "))" : "nodes[0]") +
    ";if(!node)return null;node.scrollIntoView({block:'center',inline:'nearest'});const r=node.getBoundingClientRect(),x=Math.max(3,Math.min(innerWidth-3,r.left+r.width/2)),y=Math.max(3,Math.min(innerHeight-3,r.top+r.height/2)),hit=document.elementFromPoint(x,y);if(!hit||!(hit===node||node.contains(hit)))return{blocked:true,hit:hit?.className||hit?.tagName,rect:[r.left,r.top,r.width,r.height]};window[" + q(token) + "]=null;node.addEventListener('click',e=>window[" + q(token) + "]=e.isTrusted,{once:true,capture:true});return{x,y,text:node.textContent.trim(),aria:node.getAttribute('aria-label'),height:r.height,width:r.width}})()"
  const point = await c.eval(expression)
  assert.ok(point && !point.blocked, 'pointer unavailable ' + selector + ' ' + (matcher || '') + ': ' + JSON.stringify(point))
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await sleep(180)
  assert.equal(await c.eval('window[' + q(token) + ']'), true)
  return point
}

async function tab(c) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await sleep(70)
}

async function tabAudit(c) {
  await c.eval("(()=>{const s=document.querySelector('.compare-stage');if(s)s.scrollTop=0;document.activeElement?.blur();return true})()")
  const found = [], seen = new Set()
  for (let i = 0; i < 70 && found.length < 4; i++) {
    await tab(c)
    const snap = await c.eval("(()=>{const n=document.activeElement;if(!n?.matches('.compare-mobile-two-product-actions button'))return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n),stage=document.querySelector('.compare-stage')?.getBoundingClientRect(),ow=parseFloat(s.outlineWidth)||0,oo=parseFloat(s.outlineOffset)||0;return{aria:n.getAttribute('aria-label'),height:r.height,focusVisible:n.matches(':focus-visible'),outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,clipped:!stage||r.left-ow-oo<stage.left-1||r.right+ow+oo>stage.right+1||r.top-ow-oo<stage.top-1||r.bottom+ow+oo>stage.bottom+1}})()")
    if (snap && !seen.has(snap.aria)) { seen.add(snap.aria); found.push(snap) }
  }
  assert.equal(found.length, 4, 'four actions not reached by Tab: ' + JSON.stringify(found))
  for (const x of found) {
    assert.equal(x.focusVisible, true)
    assert.notEqual(x.outlineStyle, 'none')
    assert.ok(x.height >= 44)
    assert.equal(x.clipped, false)
  }
  return found
}

function unknownExpectations(p) {
  const rows = []
  if (!p.feed_type) rows.push(['feed-type','미확인'])
  if (!p.life_stage) rows.push(['life-stage','미확인'])
  if (!(p.official_targets || []).length) rows.push(['targets','확인된 값 없음'])
  if (!(p.features || []).length) rows.push(['features','확인된 값 없음'])
  if (!(p.recipe_families || []).length) rows.push(['recipe-families','확인된 값 없음'])
  if (!(p.recipe_details || []).length) rows.push(['recipe-details','확인된 값 없음'])
  if (!(p.official_recipe_traits || []).includes('grain_free')) rows.push(['grain-free','공식 표기 미확인'])
  if (!(p.manufacturing_country_codes || []).length) rows.push(['country','미확인'])
  return rows
}

async function axReport(c, products) {
  const full = await c.send('Accessibility.getFullAXTree')
  const nodes = full.nodes || []
  const role = (n) => n.role?.value || ''
  const name = (n) => n.name?.value || ''
  const tables = nodes.filter((n) => role(n) === 'table').map(name)
  const columns = nodes.filter((n) => role(n) === 'columnheader').map(name).filter(Boolean)
  const rows = nodes.filter((n) => role(n) === 'rowheader').map(name).filter(Boolean)
  const cells = nodes.filter((n) => role(n) === 'cell')
  assert.ok(tables.some((x) => x.includes('2개 제품 개요 비교')), 'named AX table missing')
  for (const p of products) assert.ok(columns.some((x) => x.includes(p.canonical_name)), 'AX column missing ' + p.canonical_name)
  assert.ok(rows.includes('사료 형태'))
  assert.ok(rows.includes('판매 규격'))
  assert.ok(cells.length >= 4)
  const dom = await c.eval("(()=>({columns:[...document.querySelectorAll('.compare-mobile-two-product-key th[scope=\"col\"]')].map(n=>({id:n.id,text:n.textContent.replace(/\\s+/g,' ').trim()})),rows:[...document.querySelectorAll('.compare-mobile-two-product-row-label[scope=\"rowgroup\"]')].map(n=>({id:n.id,text:n.textContent.trim()})),cells:[...document.querySelectorAll('.compare-mobile-two-product-value')].slice(0,6).map(n=>({headers:n.getAttribute('headers'),text:n.textContent.replace(/\\s+/g,' ').trim()}))}))()")
  assert.equal(dom.columns.length, 2)
  assert.ok(dom.cells.every((x) => x.headers && x.headers.trim().split(/\s+/).length === 2))
  return { note: 'Chromium AX tree + native table DOM; not a screen-reader run', tables, columns: columns.filter((x) => products.some((p) => x.includes(p.canonical_name))), rowheaders: rows, cellCount: cells.length, dom }
}

async function snapshot(c, products, packages, mode) {
  const data = await c.eval("(()=>{const heads=[...document.querySelectorAll('.compare-mobile-two-product-head')],overview=document.querySelector('.compare-mobile-two-product-overview'),table=document.querySelector('.compare-mobile-two-product-table'),stage=document.querySelector('.compare-stage'),first=document.querySelector('.compare-mobile-two-product-label-row'),key=document.querySelector('.compare-mobile-two-product-key th');const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};const style=n=>{if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect();return{fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight,minHeight:s.minHeight,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace,overflow:s.overflow,height:r.height,width:r.width,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight}};const ownerOf=n=>{for(let p=n?.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(/auto|scroll/.test(s.overflowY)&&p.scrollHeight>p.clientHeight+1)return p}return document.scrollingElement};const owner=ownerOf(key),or=owner?.getBoundingClientRect();return{viewport:{width:innerWidth,height:innerHeight},document:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth},overview:{clientWidth:overview?.clientWidth,scrollWidth:overview?.scrollWidth,scrollHeight:overview?.scrollHeight},table:{clientWidth:table?.clientWidth,scrollWidth:table?.scrollWidth},owner:owner?{tag:owner.tagName,className:owner.className,clientHeight:owner.clientHeight,scrollHeight:owner.scrollHeight,scrollTop:owner.scrollTop,rect:or?{top:or.top,bottom:or.bottom,left:or.left,right:or.right}:null}:null,layout:{productHeaderHeight:rect(document.querySelector('.compare-mobile-two-product-heads'))?.height,firstFactOwnerTop:first&&or?(first.getBoundingClientRect().top-or.top+(owner?.scrollTop||0)):null,totalOverviewHeight:overview?.scrollHeight,compareScrollHeight:stage?.scrollHeight,stickyHeight:rect(key)?.height},typography:{value:style(document.querySelector('.compare-mobile-two-product-value')),label:style(document.querySelector('.compare-mobile-two-product-row-label')),productName:style(document.querySelector('.compare-mobile-two-product-name')),brand:style(document.querySelector('.compare-mobile-two-product-brand')),action:style(document.querySelector('.compare-mobile-two-product-actions button')),stickyName:style(document.querySelector('.compare-mobile-two-product-key th strong'))},identities:heads.map(h=>({name:h.querySelector('.compare-mobile-two-product-name')?.textContent.trim(),brand:h.querySelector('.compare-mobile-two-product-brand')?.textContent.trim(),image:h.querySelector('img')?{src:h.querySelector('img').src,complete:h.querySelector('img').complete,naturalWidth:h.querySelector('img').naturalWidth,naturalHeight:h.querySelector('img').naturalHeight}:null,nameStyle:style(h.querySelector('.compare-mobile-two-product-name')),brandStyle:style(h.querySelector('.compare-mobile-two-product-brand')),actions:[...h.querySelectorAll('.compare-mobile-two-product-actions button')].map(n=>({text:n.textContent.trim(),style:style(n)}))})),sections:[...document.querySelectorAll('.compare-mobile-two-product-section th')].map(n=>n.textContent.trim()),relation:[...document.querySelectorAll('#compare-mobile-two-row-relation')].map(n=>[...n.closest('tbody').querySelectorAll('td')].map(td=>td.textContent.replace(/\\s+/g,' ').trim())),package:[...document.querySelectorAll('#compare-mobile-two-row-packages')].flatMap(n=>[...n.closest('tbody').querySelectorAll('td')].map(td=>td.textContent.replace(/\\s+/g,' ').trim()))}})()")
  const positions = await c.eval("(()=>{const key=document.querySelector('.compare-mobile-two-product-key th');const owner=(()=>{for(let p=key?.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(/auto|scroll/.test(s.overflowY)&&p.scrollHeight>p.clientHeight+1)return p}return document.scrollingElement})();const or=owner?.getBoundingClientRect();const pos=id=>{const h=document.querySelector(id);if(!h||!or)return null;const row=h.closest('tbody')?.querySelector('.compare-mobile-two-product-label-row');if(!row)return null;return row.getBoundingClientRect().top-or.top+(owner?.scrollTop||0)};return{firstConditionRelationOwnerTop:pos('#compare-mobile-two-row-relation'),firstProductBasicFactOwnerTop:pos('#compare-mobile-two-row-feed-type')}})()")
  data.layout.firstConditionRelationOwnerTop = positions.firstConditionRelationOwnerTop
  data.layout.firstProductBasicFactOwnerTop = positions.firstProductBasicFactOwnerTop
  delete data.layout.firstFactOwnerTop
  assert.ok(data.document.scrollWidth <= data.document.clientWidth + 1, 'page overflow')
  assert.ok(data.overview.scrollWidth <= data.overview.clientWidth + 1, 'overview overflow')
  assert.ok(data.table.scrollWidth <= data.table.clientWidth + 1, 'table overflow')
  assert.equal(data.identities.length, 2)
  for (let i = 0; i < 2; i++) {
    assert.equal(data.identities[i].name, products[i].canonical_name)
    assert.equal(data.identities[i].brand, products[i].brand)
    assert.ok(products[i].display_image_url)
    assert.ok(data.identities[i].image?.complete && data.identities[i].image.naturalWidth > 0)
    assert.equal(data.identities[i].image.src, products[i].display_image_url)
    assert.notEqual(data.identities[i].nameStyle.textOverflow, 'ellipsis')
    assert.ok(data.identities[i].nameStyle.scrollWidth <= data.identities[i].nameStyle.clientWidth + 1)
    const brandLineHeight = parseFloat(data.identities[i].brandStyle.lineHeight)
    assert.ok(data.identities[i].brandStyle.height <= brandLineHeight * 1.25, 'brand wrapped awkwardly: ' + JSON.stringify(data.identities[i]))
    const detail = data.identities[i].actions.find((x) => x.text === '상세 보기')
    const remove = data.identities[i].actions.find((x) => x.text === '제거')
    assert.ok(detail && remove, 'header actions missing')
    assert.ok(detail.style.scrollWidth <= detail.style.clientWidth + 1, '상세 보기 overflow/wrap: ' + JSON.stringify(detail))
    assert.ok(remove.style.scrollWidth <= remove.style.clientWidth + 1, '제거 overflow/wrap: ' + JSON.stringify(remove))
    assert.equal(detail.style.whiteSpace, 'nowrap')
    assert.equal(remove.style.whiteSpace, 'nowrap')
  }
  assert.deepEqual(data.package, products.map((p) => packages[p.product_id]))
  assert.equal(data.typography.value.fontSize, '14px')
  assert.equal(data.typography.label.fontSize, '13px')
  assert.equal(data.typography.productName.fontSize, '15px')
  assert.equal(data.typography.brand.fontSize, '12px')
  assert.equal(data.typography.action.fontSize, '13px')
  assert.ok(data.typography.action.height >= 44)
  assert.ok(data.owner && data.owner.scrollHeight > data.owner.clientHeight, 'no active vertical scroll owner: ' + JSON.stringify(data.owner))
  if (mode === 'lookup') assert.equal(data.sections.includes('선택한 조건과 비교'), false)
  if (mode === 'explore') {
    assert.equal(data.sections.includes('선택한 조건과 비교'), true)
    assert.equal(data.relation.length, 1)
    for (const text of data.relation[0]) { assert.match(text, /확인됨/); assert.match(text, /건식/) }
  }

  const unknownChecks = []
  for (let index = 0; index < products.length; index++) {
    for (const [field, expected] of unknownExpectations(products[index])) {
      const expression = "(()=>{const h=document.querySelector('#compare-mobile-two-row-" + field + "');return h?[...h.closest('tbody').querySelectorAll('td')][" + index + "]?.textContent.replace(/\\s+/g,' ').trim():null})()"
      const text = await c.eval(expression)
      assert.equal(text, expected, 'unknown mismatch ' + field + ' product ' + index)
      unknownChecks.push({ index, field, expected, text })
    }
  }
  assert.ok(unknownChecks.length > 0, 'no source-derived unknown state to verify')
  data.unknownChecks = unknownChecks
  return data
}

async function sticky(c, prefix) {
  const result = {}
  for (const item of [['mid',0.5],['lower',0.92]]) {
    const label = item[0], fraction = item[1]
    await c.eval("(()=>{const key=document.querySelector('.compare-mobile-two-product-key th');const owner=(()=>{for(let p=key?.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(/auto|scroll/.test(s.overflowY)&&p.scrollHeight>p.clientHeight+1)return p}return document.scrollingElement})();owner.scrollTop=Math.max(0,owner.scrollHeight-owner.clientHeight)*" + fraction + ";return true})()")
    await sleep(180)
    const m = await c.eval("(()=>{const key=document.querySelector('.compare-mobile-two-product-key th');const owner=(()=>{for(let p=key?.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(/auto|scroll/.test(s.overflowY)&&p.scrollHeight>p.clientHeight+1)return p}return document.scrollingElement})();const kr=key.getBoundingClientRect(),or=owner.getBoundingClientRect(),x=Math.max(4,Math.min(innerWidth-4,kr.left+kr.width/2)),y=Math.min(or.bottom-4,kr.bottom+4),hit=document.elementFromPoint(x,y);return{owner:{className:owner.className,scrollTop:owner.scrollTop,maxScroll:owner.scrollHeight-owner.clientHeight,top:or.top,bottom:or.bottom},sticky:{top:kr.top,bottom:kr.bottom,height:kr.height},below:{tag:hit?.tagName,className:typeof hit?.className==='string'?hit.className:'',text:hit?.textContent?.replace(/\\s+/g,' ').trim().slice(0,100)||''}}})()")
    assert.ok(m.owner.maxScroll > 0, 'scroll owner has no range: ' + JSON.stringify(m.owner))
    assert.ok(m.sticky.bottom < m.owner.bottom - 4, 'sticky consumes viewport: ' + JSON.stringify(m))
    result[label] = m
    await c.shot(prefix + '-' + label + '.png')
  }
  await c.eval("document.querySelector('.compare-stage').scrollTop=0")
  return result
}

async function visualCase(mode, width, height, products, packages, options) {
  const h = await launch(width, height)
  const prefix = options.name
  try {
    await h.c.nav(compareUrl(mode, products))
    await waitTwo(h.c)
    const metrics = await snapshot(h.c, products, packages, mode)
    await h.c.shot(prefix + '-top.png')
    const stickyResult = options.sticky ? await sticky(h.c, prefix) : null
    const accessibility = options.ax ? await axReport(h.c, products) : null
    return { mode, width, height, chrome: h.chrome, url: compareUrl(mode, products), metrics, sticky: stickyResult, accessibility, network: await network(h.c), captures: [prefix + '-top.png'].concat(options.sticky ? [prefix + '-mid.png',prefix + '-lower.png'] : []) }
  } finally { await cleanup(h) }
}

async function actionAudit(products) {
  const h = await launch(360, 844)
  try {
    await h.c.nav(compareUrl('lookup', products))
    await waitTwo(h.c)
    const tabActions = await tabAudit(h.c)
    const hitTests = await h.c.eval("(()=>[...document.querySelectorAll('.compare-mobile-two-product-actions button')].map(n=>{n.scrollIntoView({block:'center',inline:'nearest'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y),s=getComputedStyle(n);return{text:n.textContent.trim(),aria:n.getAttribute('aria-label'),rect:[r.left,r.top,r.width,r.height],centerHit:hit===n||n.contains(hit),hit:hit?.className||hit?.tagName,whiteSpace:s.whiteSpace,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth}}))()")
    assert.equal(hitTests.length, 4)
    for (const item of hitTests) {
      assert.equal(item.centerHit, true, 'action center occluded: ' + JSON.stringify(item))
      assert.equal(item.whiteSpace, 'nowrap')
      assert.ok(item.scrollWidth <= item.clientWidth + 1, 'action text overflow: ' + JSON.stringify(item))
      assert.ok(item.rect[3] >= 44, 'action height below 44px: ' + JSON.stringify(item))
    }
    await h.c.shot('actions-360.png')
    return { chrome:h.chrome, tabActions, hitTests, network:await network(h.c), captures:['actions-360.png'] }
  } finally { await cleanup(h) }
}

async function detailRoundTrip(products) {
  const h = await launch(360, 844)
  try {
    await h.c.nav(compareUrl('lookup', products))
    await waitTwo(h.c)
    const before = await h.c.eval("[...document.querySelectorAll('.compare-mobile-two-product-name')].map(n=>n.textContent.trim())")
    assert.deepEqual(before, products.map((p)=>p.canonical_name))
    const open = await pointer(h.c, '.compare-mobile-two-product-actions button', '상세 보기')
    await h.c.wait("document.querySelector('.detail-stage')", 'detail open')
    const detailName = await h.c.eval("document.querySelector('.detail-identity-copy h1')?.textContent.trim()")
    assert.equal(detailName, products[0].canonical_name)
    const back = await pointer(h.c, '.detail-topbar button', '돌아가기')
    await waitTwo(h.c)
    const after = await h.c.eval("[...document.querySelectorAll('.compare-mobile-two-product-name')].map(n=>n.textContent.trim())")
    assert.deepEqual(after, products.map((p)=>p.canonical_name))
    return { chrome:h.chrome, before, detailName, after, open, back, network:await network(h.c) }
  } finally { await cleanup(h) }
}
async function boundary(products) {
  const h = await launch(760, 900)
  try {
    await h.c.nav(compareUrl('lookup', products))
    await waitTwo(h.c)
    async function at(width, mobile) {
      await h.c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: 900 })
      await h.c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
      await sleep(180)
      const state = await h.c.eval("(()=>{const m=document.querySelector('.compare-mobile-two-product-overview'),d=document.querySelector('.compare-two-product-overview-desktop'),t=document.querySelector('.compare-mobile-two-product-table');return{width:innerWidth,mobileDisplay:m?getComputedStyle(m).display:null,desktopDisplay:d?getComputedStyle(d).display:null,documentWidth:document.documentElement.scrollWidth,tableClient:t?.clientWidth??null,tableScroll:t?.scrollWidth??null}})()")
      await h.c.shot('boundary-' + width + '.png')
      return state
    }
    const at760 = await at(760, true)
    const at761 = await at(761, false)
    assert.notEqual(at760.mobileDisplay, 'none')
    assert.equal(at760.desktopDisplay, 'none')
    assert.ok(at760.documentWidth <= 761)
    assert.ok(at760.tableScroll <= at760.tableClient + 1)
    assert.equal(at761.mobileDisplay, 'none')
    assert.notEqual(at761.desktopDisplay, 'none')
    return { at760, at761, network: await network(h.c), captures: ['boundary-760.png','boundary-761.png'] }
  } finally { await cleanup(h) }
}

const discovery = await discover()
const report = {
  productSha: PRODUCT_SHA,
  status: 'running',
  environment: {
    method: 'exact candidate build served on runner localhost /catfood_web/ with real public API reads and Chrome/CDP',
    screenReader: 'not run',
    font: execFileSync('fc-match', [':lang=ko'], { encoding: 'utf8' }).trim(),
  },
  discovery: {
    catalogCount: discovery.catalogCount,
    pair: discovery.pair.map((p) => ({ product_id: p.product_id, brand: p.brand, canonical_name: p.canonical_name, display_image_url: p.display_image_url, package: discovery.packages[p.product_id] })),
    longPair: discovery.longPair.map((p) => ({ product_id: p.product_id, brand: p.brand, canonical_name: p.canonical_name, display_image_url: p.display_image_url, package: discovery.packages[p.product_id] })),
  },
  visual: [], actionAudit: null, error: null,
}
const save = () => writeFileSync(OUT + '/report.json', JSON.stringify(report, null, 2))

try {
  report.visual.push(await visualCase('lookup', 360, 844, discovery.pair, discovery.packages, { ax:false, sticky:true, name:'lookup-360' })); save()
  report.visual.push(await visualCase('explore', 360, 844, discovery.pair, discovery.packages, { ax:false, sticky:false, name:'explore-360' })); save()
  report.detailRoundTrip = await detailRoundTrip(discovery.pair); save()
  report.status = 'pass'; save()
  console.log('PR46_POSTDEPLOY_360_PASS')
  console.log(JSON.stringify({
    mergeSha: report.productSha,
    lookup: { layout:report.visual[0].metrics.layout, document:report.visual[0].metrics.document, overview:report.visual[0].metrics.overview, table:report.visual[0].metrics.table, headers:report.visual[0].metrics.identities.map((x)=>({brand:x.brand,brandHeight:x.brandStyle.height,brandLineHeight:x.brandStyle.lineHeight,actions:x.actions})), packages:report.visual[0].metrics.package, unknownChecks:report.visual[0].metrics.unknownChecks, sticky:report.visual[0].sticky, network:report.visual[0].network },
    detailRoundTrip: report.detailRoundTrip,
    explore: { sections:report.visual[1].metrics.sections, relation:report.visual[1].metrics.relation, network:report.visual[1].network },
  }, null, 2))
} catch (error) {
  report.status = 'fail'
  report.error = String(error?.stack || error)
  save()
  throw error
}
