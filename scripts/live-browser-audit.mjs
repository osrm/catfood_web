import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const HILLS = 'product_84eb3905fc56f218'
const ROYAL = 'product_5b13354ad9792881'
const GROUP = process.argv[2]

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.consoleErrors = []; this.networkFailures = []; this.rest = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 10000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket error')) }, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return
        this.pending.delete(message.id)
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
        return
      }
      if (message.method === 'Runtime.exceptionThrown') this.consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'exception')
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') this.consoleErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '))
      if (message.method === 'Network.loadingFailed' && message.params.errorText !== 'net::ERR_ABORTED') this.networkFailures.push(message.params.errorText)
      if (message.method === 'Network.responseReceived') {
        const response = message.params.response
        if (response?.url?.includes('.supabase.co/rest/v1/')) this.rest.push([new URL(response.url).pathname, response.status])
      }
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await this.send(method)
  }
  send(method, params = {}) { const id = this.id++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression, awaitPromise = false) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  async wait(expression, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await this.eval(`Boolean(${expression})`)) return } catch {} await new Promise((r) => setTimeout(r, 100)) } throw new Error(`timeout: ${label}`) }
  async navigate(url) { await this.send('Page.navigate', { url }); await this.wait(`document.readyState === 'complete'`, `document complete ${url}`) }
  async viewport(width, height, mobile = false) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }) }
  async key(key, code = key) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code }) }
  close() { try { this.ws?.close() } catch {} }
}

async function chrome() {
  const binary = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)
  assert.ok(binary, 'Chrome/Chromium binary not found')
  const port = 9300 + (process.pid % 300); const dir = `/tmp/catfood-live-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--window-size=1440,1100', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''; proc.stderr.on('data', (c) => { stderr += c; if (stderr.length > 3000) stderr = stderr.slice(-3000) })
  const end = Date.now() + 20000
  while (Date.now() < end) {
    if (proc.exitCode != null) throw new Error(`Chrome exited ${proc.exitCode}: ${stderr}`)
    try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = pages.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (page) return { proc, cdp: new Cdp(page.webSocketDebuggerUrl), dir, binary } } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }
  proc.kill('SIGKILL'); throw new Error(`Chrome debug endpoint timeout: ${stderr}`)
}

async function app(cdp) { await cdp.wait(`document.body?.innerText.includes('FELINE ARCHIVE')`, 'app shell') }
async function clickText(cdp, text) { assert.equal(await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!b)return false;b.click();return true })()`), true, `missing button ${text}`) }
async function clickContains(cdp, text) { assert.equal(await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!b)return false;b.click();return true })()`), true, `missing button containing ${text}`) }

async function smoke(cdp) {
  await cdp.viewport(1440, 1100); await cdp.navigate(BASE); await app(cdp)
  const state = await cdp.eval(`({ path: location.pathname, width: innerWidth, scroll: document.documentElement.scrollWidth, text: document.body.innerText.slice(0,300) })`)
  assert.equal(state.path, '/catfood_web/'); assert.ok(state.text.includes('FELINE ARCHIVE')); assert.ok(state.scroll <= state.width + 1)
}

async function desktopHistory(cdp) {
  await cdp.viewport(1440, 1100); await cdp.navigate(`${BASE}?view=workspace`); await app(cdp); await cdp.wait(`document.body.innerText.includes('이 조건으로 찾기')`, 'condition editor')
  await clickText(cdp, '건식'); await clickText(cdp, '이 조건으로 찾기'); await cdp.wait(`location.search.includes('applied=1') && document.querySelectorAll('.research-result-card').length`, 'filtered list')
  const initial = await cdp.eval(`document.querySelectorAll('.research-result-card').length`); assert.ok(await cdp.eval(`Boolean(document.querySelector('.load-more'))`)); await clickContains(cdp, '제품 더 보기'); await cdp.wait(`document.querySelectorAll('.research-result-card').length > ${initial}`, 'expanded list')
  const expanded = await cdp.eval(`document.querySelectorAll('.research-result-card').length`)
  const target = await cdp.eval(`(() => { const cards=[...document.querySelectorAll('.research-result-card')]; const c=cards[Math.min(50,cards.length-1)]; c.scrollIntoView({block:'center'}); c.focus(); return {id:c.dataset.productId, scroll:document.querySelector('.research-results-scroll').scrollTop} })()`)
  await cdp.eval(`document.querySelector('[data-product-id="${target.id}"]').click()`); await cdp.wait(`document.querySelector('.research-quick-view')`, 'quick view'); await clickContains(cdp, '상세 보기'); await cdp.wait(`document.querySelector('.detail-stage')`, 'detail')
  assert.ok(locationSafe(await cdp.eval('location.href')).includes(`detail=${target.id}`))
  await cdp.eval('history.back();true'); await cdp.wait(`document.querySelector('.research-results-list') && !document.querySelector('.detail-stage')`, 'back list'); await new Promise((r) => setTimeout(r, 400))
  const restored = await cdp.eval(`({ count:document.querySelectorAll('.research-result-card').length, scroll:document.querySelector('.research-results-scroll')?.scrollTop||0, focus:document.activeElement?.dataset?.productId||null })`)
  assert.ok(restored.count >= expanded, `expanded ${expanded}, restored ${restored.count}`); assert.ok(Math.abs(restored.scroll-target.scroll) <= 180, `scroll before ${target.scroll}, after ${restored.scroll}`); assert.equal(restored.focus, target.id)
  await cdp.eval('history.forward();true'); await cdp.wait(`document.querySelector('.detail-stage')`, 'forward detail'); await cdp.eval('history.back();true'); await cdp.wait(`document.querySelector('.research-results-list')`, 'second back list'); await new Promise((r) => setTimeout(r, 250)); assert.ok(await cdp.eval(`document.querySelectorAll('.research-result-card').length >= ${expanded}`))
}
function locationSafe(v) { return String(v) }

async function historyRace(cdp) {
  await cdp.viewport(1440,1100); await cdp.navigate(`${BASE}?view=workspace&applied=1&feed=%EA%B1%B4%EC%8B%9D&visible=80`); await app(cdp); await cdp.wait(`document.querySelectorAll('.research-result-card').length >= 60`, 'restored 80-ish list')
  const target = await cdp.eval(`document.querySelectorAll('.research-result-card')[55]?.dataset.productId`); assert.ok(target)
  await cdp.eval(`document.querySelector('[data-product-id="${target}"]').click()`); await cdp.wait(`document.querySelector('.research-quick-view')`, 'quick'); await clickContains(cdp,'상세 보기'); await cdp.wait(`document.querySelector('.detail-stage')`,'detail')
  await cdp.eval('history.back();true'); await cdp.wait(`document.querySelector('.research-results-list')`,'list return')
  const race = await cdp.eval(`new Promise((resolve)=>{ const before=document.querySelectorAll('.research-result-card').length; const b=document.querySelector('.load-more'); if(!b)return resolve({before,clicked:false,final:before,min:before}); b.click(); const a=[]; const start=performance.now(); const t=setInterval(()=>{a.push(document.querySelectorAll('.research-result-card').length);if(performance.now()-start>1000){clearInterval(t);resolve({before,clicked:true,min:Math.min(before,...a),final:a.at(-1)})}},25) })`, true)
  assert.equal(race.clicked,true); assert.ok(race.final > race.before, JSON.stringify(race)); assert.ok(race.min >= race.before, JSON.stringify(race))
}

async function hills(cdp) {
  await cdp.viewport(1440,1100); await cdp.navigate(`${BASE}?view=workspace&detail=${HILLS}&detailTab=nutrition`); await app(cdp); await cdp.wait(`document.querySelector('.detail-stage')`,'Hill detail'); await cdp.wait(`!document.querySelector('.detail-body')?.innerText.includes('영양 정보를 불러오는 중입니다.')`,'Hill nutrition')
  const d=await cdp.eval(`(() => { const body=document.querySelector('.detail-body')?.innerText||''; const subs=[...document.querySelectorAll('.detail-nutrition-subheading')]; const general=subs.find(x=>x.textContent.includes('일반 표시 영양정보')); return {h1:document.querySelector('h1')?.innerText||'',body,general:general?.nextElementSibling?.innerText||'',status:document.querySelector('.detail-nutrition-status')?.innerText||'',selected:document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim()||''} })()`)
  assert.ok(d.h1.includes('11+') && d.h1.includes('인도어'),d.h1); assert.equal(d.selected,'영양'); assert.ok(d.body.includes('3,772 kcal/kg')); for(const v of ['34.3%','20.4%','8.6%']) assert.ok(d.body.includes(v),v)
  for(const label of ['조단백질','조지방','조섬유','수분','조회분']) assert.ok(!d.general.includes(label),`general leaked ${label}`)
  assert.ok(d.status.includes('조단백질')&&d.status.includes('건물 기준 자료만 확인')); assert.ok(d.status.includes('수분')&&d.status.includes('미확인')); assert.ok(d.body.includes('건물 기준(Dry Matter) 자료'))
  await cdp.send('Page.reload',{ignoreCache:true}); await cdp.wait(`document.readyState==='complete'`,'reload'); await app(cdp); await cdp.wait(`document.querySelector('.detail-body')?.innerText.includes('3,772 kcal/kg')`,'nutrition after reload'); assert.ok((await cdp.eval('location.search')).includes(`detail=${HILLS}`)); assert.ok((await cdp.eval('location.search')).includes('detailTab=nutrition'))
}

async function royal(cdp) {
  await cdp.viewport(1440,1100); await cdp.navigate(`${BASE}?view=workspace&detail=${ROYAL}&detailTab=nutrition`); await app(cdp); await cdp.wait(`document.querySelector('.detail-stage')`,'Royal detail'); await cdp.wait(`!document.querySelector('.detail-body')?.innerText.includes('영양 정보를 불러오는 중입니다.')`,'Royal nutrition')
  const n=await cdp.eval(`({h1:document.querySelector('h1')?.innerText||'',err:document.querySelector('.detail-body .detail-state.is-error')?.innerText||'',text:document.querySelector('.detail-body')?.innerText||''})`); assert.ok(n.h1.includes('노르웨이')||n.h1.includes('Norwegian'),n.h1); assert.equal(n.err,''); assert.ok(/조단백질|조지방|조섬유/.test(n.text)&&n.text.includes('%'))
  await clickText(cdp,'원재료'); await cdp.wait(`!document.querySelector('.detail-body')?.innerText.includes('원재료 정보를 불러오는 중입니다.')`,'Royal ingredients'); const i=await cdp.eval(`({err:document.querySelector('.detail-body .detail-state.is-error')?.innerText||'',text:document.querySelector('.detail-body')?.innerText||''})`); assert.equal(i.err,''); assert.ok(i.text.includes('출처 원문'))
}

async function invalidUrl(cdp) {
  await cdp.viewport(1440,1100); await cdp.navigate(`${BASE}?view=workspace&mode=garbage&feed=BAD&detail=product_invalid&compare=a,a,b,c,d,e,f&compareOpen=1&detailTab=nope&compareTab=nope`); await app(cdp); await cdp.wait(`!location.search.includes('product_invalid')`,'invalid ID sanitize')
  const s=await cdp.eval(`location.search`); assert.ok(!s.includes('mode=garbage')); assert.ok(!s.includes('feed=BAD')); assert.ok(!s.includes('product_invalid')); assert.ok(!s.includes('detailTab=nope')); assert.ok(!s.includes('compareTab=nope'))
}

async function compareUrl(cdp) {
  await cdp.viewport(1440,1100); await cdp.navigate(`${BASE}?view=workspace&applied=1`); await app(cdp); await cdp.wait(`document.querySelectorAll('.research-result-card').length>=6`,'ids'); const ids=await cdp.eval(`[...document.querySelectorAll('.research-result-card')].slice(0,6).map(x=>x.dataset.productId)`)
  await cdp.navigate(`${BASE}?view=workspace&applied=1&compare=${[ids[0],ids[0],...ids.slice(1,6)].join(',')}&compareOpen=1&compareTab=nutrition`); await app(cdp); await cdp.wait(`document.querySelectorAll('.compare-product-head').length`,'compare'); assert.equal(await cdp.eval(`document.querySelectorAll('.compare-product-head').length`),5); assert.equal(await cdp.eval(`document.querySelector('[role=tab][aria-selected=true]').textContent.trim()`),'영양')
  const removed=await cdp.eval(`document.querySelector('.compare-product-head .compare-remove')?.getAttribute('aria-label')`); assert.ok(removed); await cdp.eval(`document.querySelector('.compare-remove').click()`); await cdp.wait(`document.querySelectorAll('.compare-product-head').length===4`,'remove'); await clickText(cdp,'← 제품 목록으로'); await cdp.wait(`document.querySelector('.research-results-list')`,'back list'); await new Promise((r)=>setTimeout(r,250)); const url=await cdp.eval('location.href'); assert.ok(!url.includes(ids[0]),url)
}

async function detailKeyboard(cdp) {
  await cdp.viewport(1440,1100); await cdp.navigate(`${BASE}?view=workspace&detail=${HILLS}`); await app(cdp); await cdp.wait(`document.querySelector('.detail-stage')`,'detail'); await clickText(cdp,'영양 정보 보기'); await cdp.wait(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim()==='영양'`,'nutrition tab'); await cdp.eval(`document.querySelector('[role=tab][aria-selected=true]').focus()`); await cdp.key('ArrowRight','ArrowRight'); await new Promise((r)=>setTimeout(r,150)); let s=await cdp.eval(`({sel:document.querySelector('[role=tab][aria-selected=true]').textContent.trim(),act:document.activeElement.textContent.trim()})`); assert.deepEqual(s,{sel:'원재료',act:'원재료'}); await cdp.key('End','End'); await new Promise((r)=>setTimeout(r,150)); s=await cdp.eval(`({sel:document.querySelector('[role=tab][aria-selected=true]').textContent.trim(),act:document.activeElement.textContent.trim()})`); assert.deepEqual(s,{sel:'제조 · 유통',act:'제조 · 유통'}); const style=await cdp.eval(`(() => {const b=document.activeElement,s=getComputedStyle(b);return {outline:s.outline,shadow:s.boxShadow}})()`); assert.ok(style.outline!=='none'||style.shadow!=='none',JSON.stringify(style))
}

async function compareKeyboard(cdp) {
  await cdp.viewport(1440,1100); await cdp.navigate(`${BASE}?view=workspace&applied=1`); await app(cdp); await cdp.wait(`document.querySelectorAll('.research-result-card').length>=3`,'ids'); const ids=await cdp.eval(`[...document.querySelectorAll('.research-result-card')].slice(0,3).map(x=>x.dataset.productId)`); await cdp.navigate(`${BASE}?view=workspace&applied=1&compare=${ids.join(',')}&compareOpen=1&compareTab=nutrition`); await app(cdp); await cdp.wait(`document.querySelector('[role=tab][aria-selected=true]')`,'tabs'); await cdp.eval(`document.querySelector('[role=tab][aria-selected=true]').focus()`); await cdp.key('End','End'); await new Promise((r)=>setTimeout(r,150)); let s=await cdp.eval(`({sel:document.querySelector('[role=tab][aria-selected=true]').textContent.trim(),act:document.activeElement.textContent.trim()})`); assert.deepEqual(s,{sel:'원재료',act:'원재료'}); await cdp.key('Home','Home'); await new Promise((r)=>setTimeout(r,150)); s=await cdp.eval(`({sel:document.querySelector('[role=tab][aria-selected=true]').textContent.trim(),act:document.activeElement.textContent.trim()})`); assert.deepEqual(s,{sel:'개요',act:'개요'})
}

async function mobile(cdp,width) {
  await cdp.viewport(width,844,true); await cdp.navigate(`${BASE}?view=workspace&applied=1`); await app(cdp); await cdp.wait(`document.querySelectorAll('.research-result-card').length>=5`,'mobile ids'); const ids=await cdp.eval(`[...document.querySelectorAll('.research-result-card')].slice(0,5).map(x=>x.dataset.productId)`); await cdp.navigate(`${BASE}?view=workspace&applied=1&compare=${ids.join(',')}&compareOpen=1&compareTab=ingredients`); await app(cdp); await cdp.wait(`document.querySelectorAll('.compare-product-head').length===5`,'mobile compare'); const l=await cdp.eval(`(() => {const wrap=document.querySelector('.compare-table-wrap'),label=document.querySelector('.compare-row-label'),ls=getComputedStyle(label); const long=[...document.querySelectorAll('.compare-ingredient-text')].sort((a,b)=>b.textContent.length-a.textContent.length)[0]; const buttons=[...document.querySelectorAll('button')].map(b=>({t:b.textContent.trim(),h:b.getBoundingClientRect().height})).filter(x=>x.h>0);return {iw:innerWidth,doc:document.documentElement.scrollWidth,cw:wrap.clientWidth,sw:wrap.scrollWidth,overflow:getComputedStyle(wrap).overflowX,pos:ls.position,left:ls.left,labelw:label.getBoundingClientRect().width,minButton:Math.min(...buttons.map(x=>x.h)),long:long?{sw:long.scrollWidth,cw:long.clientWidth,wrap:getComputedStyle(long).overflowWrap,break:getComputedStyle(long).wordBreak}:null}})()`); assert.ok(l.sw>l.cw,JSON.stringify(l)); assert.ok(['auto','scroll'].includes(l.overflow),JSON.stringify(l)); assert.equal(l.pos,'sticky'); assert.equal(parseFloat(l.left),0); assert.ok(l.doc<=l.iw+2,JSON.stringify(l)); assert.ok(l.labelw<=112,JSON.stringify(l)); assert.ok(l.minButton>=32,JSON.stringify(l)); if(l.long) assert.ok(l.long.sw<=l.long.cw+2||['anywhere','break-word'].includes(l.long.wrap)||['break-all','break-word'].includes(l.long.break),JSON.stringify(l.long))
}

async function failureRetry(cdp) {
  await cdp.viewport(1440,1100); await cdp.navigate(`${BASE}?view=workspace&applied=1`); await app(cdp); await cdp.wait(`document.querySelector('.research-result-card')`,'catalog'); const id=await cdp.eval(`document.querySelector('.research-result-card').dataset.productId`); await cdp.send('Network.setBlockedURLs',{urls:['*compare_product_nutrition*']}); await cdp.eval(`document.querySelector('[data-product-id="${id}"]').click()`); await cdp.wait(`document.querySelector('.research-quick-view')`,'quick'); await clickContains(cdp,'상세 보기'); await cdp.wait(`document.querySelector('.detail-stage')`,'detail'); await clickText(cdp,'영양 정보 보기'); await cdp.wait(`document.querySelector('.detail-body .detail-state.is-error')`,'blocked nutrition error'); const e=await cdp.eval(`({role:document.querySelector('.detail-body .detail-state.is-error')?.getAttribute('role'),retry:[...document.querySelectorAll('.detail-body button')].some(b=>b.textContent.trim()==='다시 시도')})`); assert.deepEqual(e,{role:'alert',retry:true}); await cdp.send('Network.setBlockedURLs',{urls:[]}); await clickText(cdp,'다시 시도'); await cdp.wait(`!document.querySelector('.detail-body .detail-state.is-error') && !document.querySelector('.detail-body')?.innerText.includes('영양 정보를 불러오는 중입니다.')`,'retry recovered')
}

async function lookupHistory(cdp) {
  await cdp.viewport(1440,1100); await cdp.navigate(`${BASE}?view=workspace&mode=lookup`); await app(cdp); await cdp.wait(`document.querySelector('.lookup-input')`,'lookup input'); const before=await cdp.eval('history.length'); const ok=await cdp.eval(`(() => {const i=document.querySelector('.lookup-input'); const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'로얄캐닌');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`); assert.ok(ok); await cdp.wait(`location.search.includes('q=') && document.querySelectorAll('.research-result-card').length>0`,'lookup results'); const after=await cdp.eval('history.length'); assert.equal(after,before); const q=await cdp.eval('location.search'); assert.ok(q.includes('q=')); const id=await cdp.eval(`document.querySelector('.research-result-card').dataset.productId`); await cdp.eval(`document.querySelector('.research-result-card').click()`); await cdp.wait(`document.querySelector('.research-quick-view')`,'lookup quick'); await clickContains(cdp,'상세 보기'); await cdp.wait(`document.querySelector('.detail-stage')`,'lookup detail'); assert.ok((await cdp.eval('history.length'))>after); await cdp.eval('history.back();true'); await cdp.wait(`document.querySelector('.lookup-input') && document.querySelector('.research-results-list')`,'lookup back'); assert.equal(await cdp.eval(`document.querySelector('.lookup-input').value`),'로얄캐닌'); assert.ok((await cdp.eval('location.search')).includes('q=')); assert.equal(await cdp.eval(`document.activeElement?.dataset?.productId||null`),id)
}

const groups={smoke,desktopHistory,historyRace,hills,royal,invalidUrl,compareUrl,detailKeyboard,compareKeyboard,'mobile390':(c)=>mobile(c,390),'mobile360':(c)=>mobile(c,360),failureRetry,lookupHistory}
if(!groups[GROUP]) throw new Error(`unknown group ${GROUP}`)
const {proc,cdp,dir,binary}=await chrome(); console.log(`browser=${binary} group=${GROUP}`)
try { await cdp.connect(); await groups[GROUP](cdp); const consoleErrors=[...new Set(cdp.consoleErrors)].filter(Boolean); if(!['failureRetry'].includes(GROUP)){ assert.deepEqual(consoleErrors,[],`console errors: ${consoleErrors.join(' | ')}`); assert.deepEqual([...new Set(cdp.networkFailures)],[],`network failures: ${[...new Set(cdp.networkFailures)].join(' | ')}`) } console.log(`PASS ${GROUP}; REST ${[...new Map(cdp.rest.map(x=>[x.join(':'),x])).values()].map(x=>x.join('=')).join(', ')}`) }
finally { cdp.close(); proc.kill('SIGTERM'); await new Promise((r)=>setTimeout(r,200)); if(proc.exitCode==null)proc.kill('SIGKILL'); rmSync(dir,{recursive:true,force:true}) }
