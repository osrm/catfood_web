import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'

const LIVE = 'https://osrm.github.io/catfood_web/'
const TARGET_SHA = process.env.TARGET_SHA
const OUT = 'qa-artifacts/explore-condition-editor'
const VIEWPORTS = [[360, 844], [390, 900]]
mkdirSync(OUT, { recursive: true })
assert.ok(TARGET_SHA, 'TARGET_SHA is required')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (value) => JSON.stringify(value)

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 1; this.pending = new Map(); this.requests = [] }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket timeout')), 15000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Network.requestWillBeSent') this.requests.push({ url: message.params.request.url, method: message.params.request.method })
      const pending = message.id ? this.pending.get(message.id) : null
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
    for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'CSS.enable', 'Network.enable']) await this.send(method)
    await this.send('Emulation.setLocaleOverride', { locale: 'ko-KR' })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const nativeFetch = window.fetch.bind(window)
      const nativeBeacon = navigator.sendBeacon?.bind(navigator)
      window.__qaBlockedAnalytics = 0
      window.__qaBlockedWrites = 0
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
        if (url.includes('/functions/v1/decision-intake')) {
          window.__qaBlockedAnalytics += 1
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        if (url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          window.__qaBlockedWrites += 1
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        return nativeFetch(input, init)
      }
      if (nativeBeacon) navigator.sendBeacon = (url, data) => {
        const value = String(url || '')
        if (value.includes('/functions/v1/decision-intake')) { window.__qaBlockedAnalytics += 1; return true }
        return nativeBeacon(url, data)
      }
    })();` })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  async wait(expression, label, ms = 45000) {
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
    await this.wait(`document.querySelector('#root') && document.body.innerText.length > 0`, 'app root')
    await this.eval('document.fonts?.ready')
    await sleep(250)
  }
  async shot(path) {
    await this.eval('document.fonts?.ready')
    await sleep(100)
    const image = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(image.data, 'base64'))
  }
  async fonts(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId, `font node missing: ${selector}`)
    return (await this.send('CSS.getPlatformFontsForNode', { nodeId })).fonts ?? []
  }
  close() { try { this.ws?.close() } catch {} }
}

async function launch(width, height) {
  const chrome = '/usr/bin/google-chrome'
  const port = 9900 + (process.pid % 70) + (width % 19)
  const dir = `/tmp/explore-editor-${width}-${height}-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) {
        const c = new Cdp(page.webSocketDebuggerUrl)
        await c.connect()
        await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height })
        await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Android' })
        return { c, proc, dir, version: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('Chrome launch timeout')
}

const exactButtonExpr = (label) => `(()=>{const norm=v=>(v||'').replace(/\\s+/g,' ').trim();return [...document.querySelectorAll('button')].find(n=>norm(n.textContent)===${js(label)})||null})()`

async function buttonInfo(c, label) {
  return c.eval(`(()=>{const n=${exactButtonExpr(label)};if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=(x>=0&&x<innerWidth&&y>=0&&y<innerHeight)?document.elementFromPoint(x,y):null;return{text:n.textContent.replace(/\\s+/g,' ').trim(),ariaPressed:n.getAttribute('aria-pressed'),disabled:Boolean(n.disabled),rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],rendered:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,inViewport:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,centerHit:Boolean(h&&(h===n||n.contains(h))),hit:h?.className||h?.tagName||null}})()`)
}

async function wheel(c, x, y, deltaY) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  await sleep(140)
}

async function ensureButtonReach(c, label) {
  for (let i = 0; i < 32; i++) {
    const info = await buttonInfo(c, label)
    assert.ok(info, `missing button: ${label}`)
    if (info.rendered && info.inViewport && info.centerHit && !info.disabled) return info
    const geometry = await c.eval(`(()=>{const p=document.querySelector('.research-filters'),s=document.querySelector('.research-filter-scroll');const box=n=>{if(!n)return null;const r=n.getBoundingClientRect();return[r.left,r.top,r.width,r.height,r.right,r.bottom]};return{innerHeight,innerWidth,panel:box(p),scroll:box(s)}})()`)
    const area = geometry.scroll ?? geometry.panel ?? [0, 0, geometry.innerWidth, geometry.innerHeight, geometry.innerWidth, geometry.innerHeight]
    const x = Math.max(10, Math.min(geometry.innerWidth - 10, area[0] + area[2] / 2))
    const y = Math.max(80, Math.min(geometry.innerHeight - 40, Math.max(area[1] + 10, Math.min(area[5] - 10, area[1] + area[3] / 2))))
    const top = info.rect[1], bottom = info.rect[5]
    const delta = top >= geometry.innerHeight || top > area[5] ? 520 : bottom <= 0 || bottom < area[1] ? -520 : top < 100 ? -280 : 280
    await wheel(c, x, y, delta)
  }
  throw new Error(`button not reachable with wheel: ${label}`)
}

async function clickButton(c, label) {
  const info = await ensureButtonReach(c, label)
  const x = info.rect[0] + info.rect[2] / 2, y = info.rect[1] + info.rect[3] / 2
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(220)
  return { ...info, x, y }
}

async function editorMetrics(c) {
  return c.eval(`(()=>{
    const norm=v=>(v||'').replace(/\\s+/g,' ').trim()
    const box=n=>{if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect();return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,scrollTop:n.scrollTop,overflowY:s.overflowY,backgroundColor:s.backgroundColor,borderTop:[s.borderTopWidth,s.borderTopStyle,s.borderTopColor],borderBottom:[s.borderBottomWidth,s.borderBottomStyle,s.borderBottomColor],borderLeft:[s.borderLeftWidth,s.borderLeftStyle,s.borderLeftColor],borderRight:[s.borderRightWidth,s.borderRightStyle,s.borderRightColor],position:s.position}}
    const panel=document.querySelector('.research-filters'), scroll=document.querySelector('.research-filter-scroll'), actions=document.querySelector('.condition-actions'), sections=[...document.querySelectorAll('.filter-section')], last=sections.at(-1)
    const button=label=>[...document.querySelectorAll('button')].find(n=>norm(n.textContent)===label)||null
    const hit=n=>{if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=(x>=0&&x<innerWidth&&y>=0&&y<innerHeight)?document.elementFromPoint(x,y):null;return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],inViewport:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,centerHit:Boolean(h&&(h===n||n.contains(h))),hit:h?.className||h?.tagName||null}}
    const p=box(panel), sc=box(scroll), ac=box(actions), ls=box(last), apply=hit(button('이 조건으로 찾기')), reset=hit(button('초기화'))
    return{
      viewport:[innerWidth,innerHeight],
      panel:p,
      scroll:sc,
      actions:ac,
      lastSection:ls,
      apply,
      reset,
      document:{scrollY,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight,overflowY:getComputedStyle(document.documentElement).overflowY,scrollable:document.documentElement.scrollHeight>innerHeight+1},
      innerScrollable:Boolean(scroll&&scroll.scrollHeight>scroll.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(scroll).overflowY)),
      doubleVerticalScroll:Boolean(document.documentElement.scrollHeight>innerHeight+1&&scroll&&scroll.scrollHeight>scroll.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(scroll).overflowY)),
      actionsInsidePanel:panel&&actions?panel.contains(actions):false,
      actionsCenterInsidePanelRect:Boolean(p&&apply&&apply.rect[0]+apply.rect[2]/2>=p.rect[0]&&apply.rect[4]-apply.rect[2]/2<=p.rect[4]&&apply.rect[1]+apply.rect[3]/2>=p.rect[1]&&apply.rect[5]-apply.rect[3]/2<=p.rect[5]),
      selected:[...document.querySelectorAll('.research-filter-scroll button[aria-pressed="true"]')].map(n=>norm(n.textContent)),
      stateMessage:document.querySelector('.state-message')?.textContent.replace(/\\s+/g,' ').trim()||null,
      feedHeading:[...document.querySelectorAll('.filter-heading')].find(n=>norm(n.textContent).startsWith('사료 형태'))?.textContent.replace(/\\s+/g,' ').trim()||null,
      editorText:document.querySelector('.research-filter-scroll')?.textContent.replace(/\\s+/g,' ').trim().slice(0,1200)||null,
    }
  })()`)
}

async function resultState(c) {
  return c.eval(`(()=>{
    const params=Object.fromEntries(new URL(location.href).searchParams.entries())
    const cards=[...document.querySelectorAll('.research-result-card')].slice(0,8).map(n=>({name:n.querySelector('strong')?.textContent.trim()||null,meta:n.querySelector('.research-result-meta')?.textContent.trim()||null,relation:n.querySelector('.result-relations')?.textContent.replace(/\\s+/g,' ').trim()||null}))
    return{url:location.href,params,chips:[...document.querySelectorAll('.criteria-chips span')].map(n=>n.textContent.trim()),resultHeading:document.querySelector('.research-results-heading')?.textContent.replace(/\\s+/g,' ').trim()||null,cards,documentScrollY:scrollY}
  })()`)
}

async function networkState(c) {
  const sentAnalytics = c.requests.filter((request) => request.url.includes('/functions/v1/decision-intake'))
  const sentWrites = c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  return { blocked: await c.eval(`({analytics:window.__qaBlockedAnalytics||0,writes:window.__qaBlockedWrites||0})`), sentAnalytics, sentWrites, publicReads: c.requests.filter((request) => request.url.includes('gnosbstdatkytsyxuapt.supabase.co') && request.method === 'GET').length }
}

async function pressed(c, label) { return (await buttonInfo(c, label))?.ariaPressed === 'true' }

async function runViewport(width, height) {
  const tag = `${width}x${height}`
  const result = { viewport: [width, height], targetSha: TARGET_SHA, liveUrl: LIVE, captures: [], status: 'running' }
  const browser = await launch(width, height), c = browser.c
  const shot = async (name) => { const file = `${tag}-${name}.png`; await c.shot(`${OUT}/${file}`); result.captures.push(file) }
  try {
    result.chrome = browser.version
    await c.nav(LIVE)
    await c.wait(`/\\d/.test(document.querySelector('.home-search-console-copy small')?.textContent||'')`, 'catalog count')
    result.homeFonts = await c.fonts('.home-start h1')
    assert.ok(result.homeFonts.some((font) => font.familyName.includes('Noto Sans CJK KR')), 'Korean font mismatch')

    await clickButton(c, '조건 고르기 →')
    await c.wait(`document.querySelector('.condition-actions') && document.querySelector('.research-filter-scroll')`, 'condition editor')
    result.initial = await editorMetrics(c)
    result.initialGuidance = {
      feedHeading: result.initial.feedHeading,
      stateMessage: result.initial.stateMessage,
      applyButton: await buttonInfo(c, '이 조건으로 찾기'),
      noFeedSelected: !(await pressed(c, '건식')) && !(await pressed(c, '습식')) && !(await pressed(c, '동결건조')),
    }
    await shot('01-editor-top')

    result.firstSelection = []
    result.firstSelection.push(await clickButton(c, '건식'))
    result.firstSelection.push(await clickButton(c, '실내묘'))
    result.firstSelection.push(await clickButton(c, '체중 관리'))
    assert.equal(await pressed(c, '건식'), true)
    assert.equal(await pressed(c, '실내묘'), true)
    assert.equal(await pressed(c, '체중 관리'), true)

    result.lastConditionReach = await ensureButtonReach(c, 'Grain-Free 표기')
    result.lastConditionMetrics = await editorMetrics(c)
    await shot('02-last-condition-and-panel-boundary')

    result.firstApplyReach = await ensureButtonReach(c, '이 조건으로 찾기')
    result.firstApplyMetrics = await editorMetrics(c)
    assert.equal(result.firstApplyReach.centerHit, true, 'apply button not hit-testable')
    await shot('03-apply-button-reached')
    await clickButton(c, '이 조건으로 찾기')
    await c.wait(`document.querySelector('.criteria-bar') && document.querySelector('.research-result-card')`, 'first applied results')
    result.firstResult = await resultState(c)
    assert.equal(result.firstResult.params.applied, '1')
    assert.equal(result.firstResult.params.feed, '건식')
    assert.equal(result.firstResult.params.targets, 'indoor')
    assert.equal(result.firstResult.params.features, 'weight_management')
    for (const label of ['건식', '실내묘', '체중 관리']) assert.ok(result.firstResult.chips.includes(label), `missing first summary chip: ${label}`)
    assert.ok(result.firstResult.cards.length > 0, 'no result cards after first apply')
    assert.ok(result.firstResult.cards.every((card) => !card.meta || card.meta.includes('건식') || card.meta.includes('형태 미확인')), 'hard feed constraint result mismatch')
    await shot('04-first-results')

    await clickButton(c, '조건 수정')
    await c.wait(`document.querySelector('.condition-actions')`, 'reopened editor')
    await ensureButtonReach(c, '건식')
    result.reopened = await editorMetrics(c)
    result.reopenedSelections = { dry: await pressed(c, '건식'), indoor: await pressed(c, '실내묘'), weight: await pressed(c, '체중 관리') }
    assert.deepEqual(result.reopenedSelections, { dry: true, indoor: true, weight: true }, 'editor did not preserve selected values')
    await shot('05-reopened-editor')

    await clickButton(c, '실내묘')
    await clickButton(c, '중성화묘')
    await clickButton(c, '체중 관리')
    await clickButton(c, '헤어볼')
    result.modifiedSelections = { dry: await pressed(c, '건식'), indoor: await pressed(c, '실내묘'), sterilized: await pressed(c, '중성화묘'), weight: await pressed(c, '체중 관리'), hairball: await pressed(c, '헤어볼') }
    assert.deepEqual(result.modifiedSelections, { dry: true, indoor: false, sterilized: true, weight: false, hairball: true })
    result.secondApplyReach = await ensureButtonReach(c, '이 조건으로 찾기')
    result.secondApplyMetrics = await editorMetrics(c)
    await shot('06-modified-editor-apply-reached')
    await clickButton(c, '이 조건으로 찾기')
    await c.wait(`document.querySelector('.criteria-bar') && document.querySelector('.research-result-card')`, 'second applied results')
    result.secondResult = await resultState(c)
    assert.equal(result.secondResult.params.applied, '1')
    assert.equal(result.secondResult.params.feed, '건식')
    assert.equal(result.secondResult.params.targets, 'sterilized')
    assert.equal(result.secondResult.params.features, 'hairball')
    for (const label of ['건식', '중성화묘', '헤어볼']) assert.ok(result.secondResult.chips.includes(label), `missing second summary chip: ${label}`)
    assert.ok(!result.secondResult.chips.includes('실내묘') && !result.secondResult.chips.includes('체중 관리'), 'removed criteria still summarized')
    await shot('07-second-results')

    await clickButton(c, '조건 수정')
    await c.wait(`document.querySelector('.condition-actions')`, 'editor for reset')
    result.beforeReset = await editorMetrics(c)
    result.resetReach = await ensureButtonReach(c, '초기화')
    result.resetButtonBefore = await buttonInfo(c, '초기화')
    await clickButton(c, '초기화')
    result.afterResetBottom = await editorMetrics(c)
    result.resetUrl = await c.eval('location.href')
    result.resetPressed = await c.eval(`(()=>[...document.querySelectorAll('.research-filter-scroll button[aria-pressed="true"]')].map(n=>n.textContent.replace(/\\s+/g,' ').trim()))()`)
    assert.deepEqual(result.resetPressed, [], 'reset did not clear draft selections')
    await ensureButtonReach(c, '건식')
    result.afterResetTop = await editorMetrics(c)
    await shot('08-reset-editor-top')

    result.network = await networkState(c)
    assert.deepEqual(result.network.sentAnalytics, [], 'analytics request escaped blocker')
    assert.deepEqual(result.network.sentWrites, [], 'production write escaped blocker')
    result.flags = {
      initialDoubleVerticalScroll: result.initial.doubleVerticalScroll,
      firstApplyDoubleVerticalScroll: result.firstApplyMetrics.doubleVerticalScroll,
      reopenedDoubleVerticalScroll: result.reopened.doubleVerticalScroll,
      secondApplyDoubleVerticalScroll: result.secondApplyMetrics.doubleVerticalScroll,
      resetDoubleVerticalScroll: result.afterResetTop.doubleVerticalScroll,
      initialDocumentScrollable: result.initial.document.scrollable,
      initialInnerScrollable: result.initial.innerScrollable,
      firstApplyDocumentScrollY: result.firstApplyMetrics.document.scrollY,
      firstApplyInnerScrollTop: result.firstApplyMetrics.scroll?.scrollTop ?? null,
    }
    result.status = 'pass'
    return result
  } catch (error) {
    result.status = 'failed'
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    try { await shot('99-failure') } catch {}
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { qaResult: result })
  } finally {
    c.close(); browser.proc.kill('SIGTERM')
  }
}

const report = {
  task: 'mobile EXPLORE initial condition editor and condition-edit review',
  targetSha: TARGET_SHA,
  liveUrl: LIVE,
  environment: 'GitHub-hosted headless Chrome with ko-KR locale and Noto Sans CJK KR; viewport emulation only, not a physical device or screen reader',
  results: [],
  status: 'running',
}

try {
  for (const [width, height] of VIEWPORTS) report.results.push(await runViewport(width, height))
  report.status = 'pass'
} catch (error) {
  if (error?.qaResult) report.results.push(error.qaResult)
  report.status = 'failed'
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ status: report.status, targetSha: report.targetSha, viewports: report.results.map((result) => ({ viewport: result.viewport, flags: result.flags, network: result.network })) }, null, 2))
