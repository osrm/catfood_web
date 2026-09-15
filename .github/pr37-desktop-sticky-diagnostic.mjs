import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:4173/catfood_web/'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const OUT = 'qa-artifacts'
mkdirSync(OUT, { recursive: true })
assert.ok(SUPABASE_URL && SUPABASE_KEY)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function rows(view, params = {}) {
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${view}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { apikey: SUPABASE_KEY, 'Accept-Profile': 'api' } })
  assert.equal(response.ok, true)
  return response.json()
}

const products = await rows('effective_product_catalog_summary', {
  select: 'product_id,brand,canonical_name', order: 'brand.asc,canonical_name.asc', limit: 1000,
})
const current = products.find((row) => row.brand === 'AATU' && row.canonical_name === '연어')
assert.ok(current)
const variants = await rows('switch_current_variant_options', {
  select: 'product_id,variant_id,package_size_text,display_rank', product_id: `eq.${current.product_id}`, order: 'display_rank.asc', limit: 100,
})
const sku = variants.find((row) => /1\s*kg/i.test(row.package_size_text ?? ''))
assert.ok(sku)
const five = products.filter((row) => row.product_id !== current.product_id).slice(0, 5)
const empty = { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false }
const snapshot = { version: 1, state: {
  query: 'AATU 연어', currentProductId: current.product_id, variantSelection: { kind: 'variant', variantId: sku.variant_id },
  change: empty, keep: empty, changeBrand: false, keepBrand: false, ingredientAvoidTerms: [], noChangeIntent: true,
  step: 'results', visibleCandidateCount: 40, selectedCandidateId: null, compareIds: five.map((row) => row.product_id), compareOpen: true, compareTab: 'overview', detailProductId: null, detailTab: 'overview',
} }

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map() }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('ws timeout')), 15000); this.ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true }); this.ws.addEventListener('error', reject, { once: true }) })
    this.ws.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (!message.id) return; const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result) })
    await this.send('Page.enable'); await this.send('Runtime.enable')
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label) { for (let i = 0; i < 300; i += 1) { if (await this.eval(`Boolean(${expression})`).catch(() => false)) return; await sleep(100) } throw new Error(`timeout ${label}`) }
}

const chrome = '/usr/bin/google-chrome'; assert.ok(existsSync(chrome))
const port = 9977
const dir = `/tmp/pr37-sticky-${process.pid}`
rmSync(dir, { recursive: true, force: true })
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
let cdp
try {
  for (let i = 0; i < 200; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) { cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect(); break }
    } catch {}
    await sleep(100)
  }
  assert.ok(cdp)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 761, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `sessionStorage.setItem('catfood.switch-session.v1', ${JSON.stringify(JSON.stringify(snapshot))}); const f=window.fetch.bind(window); window.fetch=(input,init={})=>{const u=typeof input==='string'?input:(input&&input.url)||'';const m=String(init.method||(input&&input.method)||'GET').toUpperCase();if(u.includes('/functions/v1/decision-intake')||(u.includes('gnosbstdatkytsyxuapt.supabase.co')&&!['GET','HEAD','OPTIONS'].includes(m)))return Promise.reject(new TypeError('blocked'));return f(input,init)};` })
  await cdp.send('Page.navigate', { url: `${BASE}?view=workspace&mode=switch` })
  await cdp.wait(`document.querySelector('.compare-switch-overview-desktop')`, 'desktop compare')
  const geometry = await cdp.eval(`(() => {
    const wrap=document.querySelector('.compare-table-wrap'); wrap.scrollLeft=wrap.scrollWidth-wrap.clientWidth;
    const table=document.querySelector('.compare-switch-overview-desktop');
    const row=[...document.querySelectorAll('.compare-switch-overview-row')].find((node)=>node.querySelector('.compare-row-label')?.textContent.trim()==='사료 형태');
    const label=row.querySelector('.compare-row-label'); const current=row.querySelector('.compare-cell.is-current'); const last=[...row.querySelectorAll('.compare-cell:not(.is-current)')].at(-1);
    const heads=[...document.querySelectorAll('.compare-switch-overview-desktop .compare-product-head:not(.compare-current-product-head)')]; const lastHead=heads.at(-1); const detail=lastHead.querySelector('.compare-detail-link');
    const rect=(n)=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const style=(n)=>{const s=getComputedStyle(n);return{position:s.position,left:s.left,zIndex:s.zIndex,transform:s.transform,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight,overflowX:s.overflowX}};
    const dr=rect(detail); const hit=document.elementFromPoint(dr.left+dr.width/2,dr.top+dr.height/2);
    return {scroll:{left:wrap.scrollLeft,max:wrap.scrollWidth-wrap.clientWidth,client:wrap.clientWidth,width:wrap.scrollWidth},rects:{wrap:rect(wrap),table:rect(table),row:rect(row),label:rect(label),current:rect(current),last:rect(last),lastHead:rect(lastHead),detail:dr},styles:{wrap:style(wrap),table:style(table),row:style(row),label:style(label),current:style(current)},vars:{label:getComputedStyle(table).getPropertyValue('--switch-overview-label-width'),value:getComputedStyle(table).getPropertyValue('--switch-overview-value-width')},hit:{tag:hit?.tagName,className:hit?.className,text:hit?.textContent?.trim(),isDetail:hit===detail||detail.contains(hit)}};
  })()`)
  writeFileSync(`${OUT}/desktop-sticky-diagnostic.json`, JSON.stringify({ productSha: process.env.PRODUCT_SHA, geometry }, null, 2))
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  writeFileSync(`${OUT}/761x900-desktop-sticky-diagnostic.png`, Buffer.from(image.data, 'base64'))
  console.log('PR37_STICKY_DIAGNOSTIC', JSON.stringify(geometry))
} finally {
  try { cdp?.ws?.close() } catch {}
  proc.kill('SIGTERM'); await sleep(150); if (proc.exitCode == null) proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true })
}
