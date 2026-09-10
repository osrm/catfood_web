import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

const BASE = 'https://osrm.github.io/catfood_web/'
const HILLS_ID = 'product_84eb3905fc56f218'
const ROYAL_ID = 'product_5b13354ad9792881'

function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}
function escapeProp(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}
function annotation(level, title, message) {
  console.log(`::${level} title=${escapeProp(title)}::${escapeData(message)}`)
}

class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.consoleErrors = []
    this.networkFailures = []
    this.apiResponses = []
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), 10000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket error')) }, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`))
        else pending.resolve(message.result)
        return
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').filter(Boolean).join(' ')
        this.consoleErrors.push(text || 'console.error')
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'uncaught exception')
      }
      if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params.entry?.level)) {
        const text = message.params.entry?.text ?? ''
        if (text) this.consoleErrors.push(text)
      }
      if (message.method === 'Network.loadingFailed') {
        const p = message.params
        if (p?.errorText && p.errorText !== 'net::ERR_ABORTED') this.networkFailures.push(`${p.errorText}${p.blockedReason ? ` (${p.blockedReason})` : ''}`)
      }
      if (message.method === 'Network.responseReceived') {
        const response = message.params?.response
        if (response?.url?.includes('.supabase.co/rest/v1/')) {
          try {
            const u = new URL(response.url)
            this.apiResponses.push({ path: u.pathname, status: response.status })
          } catch {}
        }
      }
    })
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.send('Log.enable')
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed')
    return result.result?.value
  }

  async waitFor(expression, timeoutMs = 25000, label = expression) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      try {
        if (await this.eval(`Boolean(${expression})`)) return
      } catch (error) {
        lastError = error
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
  }

  async navigate(url) {
    await this.send('Page.navigate', { url })
    await this.waitFor(`document.readyState === 'complete'`, 30000, `document complete: ${url}`)
  }

  async reload() {
    await this.send('Page.reload', { ignoreCache: true })
    await this.waitFor(`document.readyState === 'complete'`, 30000, 'reload complete')
  }

  async viewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  }

  async key(key, code, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
  }

  close() {
    try { this.ws?.close() } catch {}
  }
}

async function startChrome() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  const binary = candidates.find((candidate) => existsSync(candidate))
  if (!binary) throw new Error(`No Chrome/Chromium binary found in ${candidates.join(', ')}`)
  const port = 9400 + (process.pid % 200)
  const userDataDir = `/tmp/catfood-live-browser-${process.pid}`
  rmSync(userDataDir, { recursive: true, force: true })
  const proc = spawn(binary, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,1100',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 4000) stderr = stderr.slice(-4000) })
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (proc.exitCode != null) throw new Error(`Chrome exited early (${proc.exitCode}): ${stderr}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const pages = await response.json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return { proc, cdp: new Cdp(page.webSocketDebuggerUrl), binary, userDataDir }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome remote debugging endpoint did not start: ${stderr}`)
}

function check(failures, ok, title, details) {
  if (ok) annotation('notice', title, details)
  else {
    failures.push(`${title}: ${details}`)
    annotation('error', title, details)
  }
}

async function waitForApp(cdp) {
  await cdp.waitFor(`document.body && document.body.innerText.includes('FELINE ARCHIVE')`, 30000, 'FELINE ARCHIVE app shell')
}

async function clickExactButton(cdp, text) {
  const result = await cdp.eval(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(text)})
    if (!button) return false
    button.click(); return true
  })()`)
  if (!result) throw new Error(`Button not found: ${text}`)
}

async function clickButtonContaining(cdp, text) {
  const result = await cdp.eval(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(${JSON.stringify(text)}))
    if (!button) return false
    button.click(); return true
  })()`)
  if (!result) throw new Error(`Button not found containing: ${text}`)
}

async function auditDesktopFlow(cdp, failures) {
  await cdp.viewport(1440, 1100, false)
  await cdp.navigate(BASE)
  await waitForApp(cdp)
  const home = await cdp.eval(`({
    pathname: location.pathname,
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    body: document.body.innerText.slice(0, 200),
  })`)
  check(failures, home.pathname === '/catfood_web/', 'Desktop base path', `pathname=${home.pathname}`)
  check(failures, home.scrollWidth <= home.width + 1, 'Desktop home horizontal overflow', `viewport=${home.width}, scrollWidth=${home.scrollWidth}`)

  await cdp.navigate(`${BASE}?view=workspace`)
  await waitForApp(cdp)
  await cdp.waitFor(`document.body.innerText.includes('이 조건으로 찾기')`, 30000, 'condition editor')
  await clickExactButton(cdp, '건식')
  await clickExactButton(cdp, '이 조건으로 찾기')
  await cdp.waitFor(`location.search.includes('applied=1') && document.querySelectorAll('.research-result-card').length > 0`, 30000, 'filtered results')
  const filtered = await cdp.eval(`({
    url: location.href,
    count: document.querySelectorAll('.research-result-card').length,
    loadMore: Boolean(document.querySelector('.load-more')),
    dryPressed: Array.from(document.querySelectorAll('button.choice')).some((b) => b.textContent.trim() === '건식' && b.getAttribute('aria-pressed') === 'true'),
  })`)
  check(failures, filtered.url.includes('feed=%EA%B1%B4%EC%8B%9D') || filtered.url.includes('feed=건식'), 'Filter URL state', `url=${filtered.url}`)
  check(failures, filtered.loadMore, 'Filtered list can expand', `visible cards=${filtered.count}`)

  const initialCount = filtered.count
  if (filtered.loadMore) {
    await clickButtonContaining(cdp, '제품 더 보기')
    await cdp.waitFor(`document.querySelectorAll('.research-result-card').length > ${initialCount}`, 10000, 'expanded list')
  }
  const expanded = await cdp.eval(`document.querySelectorAll('.research-result-card').length`)
  const target = await cdp.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('.research-result-card'))
    const card = cards[Math.min(50, cards.length - 1)]
    if (!card) return null
    card.scrollIntoView({ block: 'center' })
    card.focus()
    const scroller = document.querySelector('.research-results-scroll')
    return { id: card.dataset.productId, scrollTop: scroller?.scrollTop ?? 0, label: card.innerText.slice(0, 90) }
  })()`)
  check(failures, Boolean(target?.id), 'List focus target', target ? `product=${target.id}, scrollTop=${target.scrollTop}` : 'no target card')

  if (target?.id) {
    await cdp.eval(`document.querySelector('[data-product-id="${target.id}"]')?.click()`)
    await cdp.waitFor(`document.querySelector('.research-quick-view')`, 10000, 'quick view')
    await clickButtonContaining(cdp, '상세 보기')
    await cdp.waitFor(`document.querySelector('.detail-stage')`, 20000, 'detail page')
    check(failures, (await cdp.eval(`location.search.includes('detail=${target.id}')`)), 'Detail URL push', `detail=${target.id}`)

    await cdp.eval(`history.back(); true`)
    await cdp.waitFor(`!document.querySelector('.detail-stage') && document.querySelector('.research-results-list')`, 20000, 'return to list')
    await new Promise((resolve) => setTimeout(resolve, 450))
    const restored = await cdp.eval(`({
      count: document.querySelectorAll('.research-result-card').length,
      scrollTop: document.querySelector('.research-results-scroll')?.scrollTop ?? 0,
      focusId: document.activeElement?.dataset?.productId ?? null,
      url: location.href,
    })`)
    check(failures, restored.count >= expanded, 'Back restores expanded list', `before=${expanded}, after=${restored.count}`)
    check(failures, Math.abs(restored.scrollTop - target.scrollTop) <= 180, 'Back restores list scroll', `before=${target.scrollTop}, after=${restored.scrollTop}`)
    check(failures, restored.focusId === target.id, 'Back restores product focus', `expected=${target.id}, actual=${restored.focusId}`)

    await cdp.eval(`history.forward(); true`)
    await cdp.waitFor(`document.querySelector('.detail-stage')`, 20000, 'forward to detail')
    await cdp.eval(`history.back(); true`)
    await cdp.waitFor(`document.querySelector('.research-results-list')`, 20000, 'back to list second time')
    await new Promise((resolve) => setTimeout(resolve, 150))
    check(failures, (await cdp.eval(`document.querySelectorAll('.research-result-card').length >= ${expanded}`)), 'Forward/back repeated navigation', `expanded=${expanded}`)

    const racePrep = await cdp.eval(`(() => {
      const card = document.querySelector('[data-product-id="${target.id}"]')
      if (!card) return false
      card.click(); return true
    })()`)
    if (racePrep) {
      await cdp.waitFor(`document.querySelector('.research-quick-view')`, 10000, 'quick view for race check')
      await clickButtonContaining(cdp, '상세 보기')
      await cdp.waitFor(`document.querySelector('.detail-stage')`, 20000, 'detail for race check')
      await cdp.eval(`history.back(); true`)
      await cdp.waitFor(`document.querySelector('.research-results-list')`, 20000, 'list appears after back')
      const race = await cdp.eval(`new Promise((resolve) => {
        const counts = []
        const before = document.querySelectorAll('.research-result-card').length
        const button = document.querySelector('.load-more')
        if (!button) return resolve({ before, clicked: false, min: before, max: before, final: before })
        button.click()
        const started = performance.now()
        const timer = setInterval(() => {
          counts.push(document.querySelectorAll('.research-result-card').length)
          if (performance.now() - started > 900) {
            clearInterval(timer)
            resolve({ before, clicked: true, min: Math.min(before, ...counts), max: Math.max(before, ...counts), final: counts.at(-1) ?? before })
          }
        }, 30)
      })`, true)
      if (race.clicked) check(failures, race.final > race.before && race.min >= race.before, 'Immediate load-more after back race', `before=${race.before}, min=${race.min}, max=${race.max}, final=${race.final}`)
      else annotation('notice', 'Immediate load-more after back race', `No remaining products after restored count=${race.before}; race path not applicable`)
    }
  }
}

async function auditShareRefreshAndData(cdp, failures) {
  await cdp.viewport(1440, 1100, false)
  const hillsUrl = `${BASE}?view=workspace&detail=${HILLS_ID}&detailTab=nutrition`
  await cdp.navigate(hillsUrl)
  await waitForApp(cdp)
  await cdp.waitFor(`document.querySelector('.detail-stage')`, 30000, 'Hill detail')
  await cdp.waitFor(`!document.querySelector('.detail-body')?.innerText.includes('영양 정보를 불러오는 중입니다.')`, 30000, 'Hill nutrition response')
  const hills = await cdp.eval(`(() => {
    const body = document.querySelector('.detail-body')?.innerText ?? ''
    const subheads = Array.from(document.querySelectorAll('.detail-nutrition-subheading'))
    const general = subheads.find((el) => el.textContent.includes('일반 표시 영양정보'))
    const basis = subheads.find((el) => el.textContent.includes('Dry Matter'))
    const generalGrid = general?.nextElementSibling?.innerText ?? ''
    const status = document.querySelector('.detail-nutrition-status')?.innerText ?? ''
    return { href: location.href, h1: document.querySelector('h1')?.innerText ?? '', body, generalGrid, basis: basis?.innerText ?? '', status }
  })()`)
  check(failures, hills.h1.includes('11+') && hills.h1.includes('인도어'), 'Hill product identity', hills.h1)
  check(failures, hills.body.includes('3,772 kcal/kg'), 'Hill energy', hills.body.includes('3,772 kcal/kg') ? '3,772 kcal/kg rendered' : 'energy missing')
  check(failures, ['34.3%', '20.4%', '8.6%'].every((value) => hills.body.includes(value)), 'Hill Dry Matter values', `34.3=${hills.body.includes('34.3%')}, 20.4=${hills.body.includes('20.4%')}, 8.6=${hills.body.includes('8.6%')}`)
  check(failures, !['조단백질', '조지방', '조섬유', '수분', '조회분'].some((label) => hills.generalGrid.includes(label)), 'Hill general nutrients remain null', `general grid=${hills.generalGrid.replace(/\n/g, ' | ')}`)
  check(failures, hills.status.includes('조단백질') && hills.status.includes('건물 기준 자료만 확인') && hills.status.includes('수분') && hills.status.includes('미확인'), 'Hill null reasons remain separate', hills.status.replace(/\n/g, ' | '))
  check(failures, hills.basis.includes('건물 기준(Dry Matter)'), 'Hill Dry Matter section separate', hills.basis.replace(/\n/g, ' | '))

  await cdp.reload()
  await waitForApp(cdp)
  await cdp.waitFor(`document.querySelector('.detail-stage') && document.querySelector('.detail-body')?.innerText.includes('3,772 kcal/kg')`, 30000, 'Hill detail after refresh')
  check(failures, (await cdp.eval(`location.search.includes('detail=${HILLS_ID}') && location.search.includes('detailTab=nutrition')`)), 'Detail share URL survives refresh', await cdp.eval('location.href'))

  await cdp.navigate(`${BASE}?view=workspace&detail=product_invalid_404&detailTab=nutrition`)
  await waitForApp(cdp)
  await cdp.waitFor(`!location.search.includes('product_invalid_404') && document.querySelector('.research-shell')`, 30000, 'invalid detail sanitized')
  check(failures, !(await cdp.eval(`location.search.includes('product_invalid_404')`)), 'Invalid detail ID is sanitized', await cdp.eval('location.href'))

  await cdp.navigate(`${BASE}?view=workspace&detail=${ROYAL_ID}&detailTab=nutrition`)
  await waitForApp(cdp)
  await cdp.waitFor(`document.querySelector('.detail-stage')`, 30000, 'Royal Canin detail')
  await cdp.waitFor(`!document.querySelector('.detail-body')?.innerText.includes('영양 정보를 불러오는 중입니다.')`, 30000, 'Royal Canin nutrition response')
  const royalNutrition = await cdp.eval(`({
    h1: document.querySelector('h1')?.innerText ?? '',
    error: document.querySelector('.detail-body .detail-state.is-error')?.innerText ?? '',
    text: document.querySelector('.detail-body')?.innerText ?? '',
  })`)
  check(failures, royalNutrition.h1.includes('노르웨이') || royalNutrition.h1.includes('Norwegian'), 'Royal Canin product identity', royalNutrition.h1)
  check(failures, !royalNutrition.error, 'Royal Canin nutrition no timeout/error', royalNutrition.error || 'nutrition loaded without error state')
  check(failures, !royalNutrition.text.includes('건물 기준(Dry Matter) 자료'), 'General nutrition product has no Dry Matter section', 'Royal Canin nutrition does not show a Dry Matter section')
  check(failures, /조단백질|조지방|조섬유/.test(royalNutrition.text) && /%/.test(royalNutrition.text), 'General nutrition values render', royalNutrition.text.slice(0, 500).replace(/\n/g, ' | '))

  await clickExactButton(cdp, '원재료')
  await cdp.waitFor(`document.querySelector('.detail-body') && !document.querySelector('.detail-body').innerText.includes('원재료 정보를 불러오는 중입니다.')`, 30000, 'Royal Canin ingredients response')
  const royalIngredients = await cdp.eval(`({
    error: document.querySelector('.detail-body .detail-state.is-error')?.innerText ?? '',
    text: document.querySelector('.detail-body')?.innerText ?? '',
  })`)
  check(failures, !royalIngredients.error, 'Royal Canin ingredients no timeout/error', royalIngredients.error || 'ingredients loaded without error state')
  check(failures, royalIngredients.text.includes('출처 원문'), 'Ingredients raw source wording retained', royalIngredients.text.slice(0, 350).replace(/\n/g, ' | '))

  const perf = await cdp.eval(`performance.getEntriesByType('resource').filter((entry) => entry.name.includes('.supabase.co/rest/v1/')).map((entry) => {
    const u = new URL(entry.name)
    return { path: u.pathname, duration: Math.round(entry.duration) }
  })`)
  const relevant = perf.filter((item) => item.path.includes('compare_product_nutrition') || item.path.includes('compare_product_ingredients'))
  annotation('notice', 'Royal Canin REST timings', relevant.map((item) => `${item.path}=${item.duration}ms`).join(', ') || 'No PerformanceResourceTiming entry exposed')
}

async function auditCompareAndKeyboard(cdp, failures) {
  await cdp.viewport(1440, 1100, false)
  await cdp.navigate(`${BASE}?view=workspace&applied=1`)
  await waitForApp(cdp)
  await cdp.waitFor(`document.querySelectorAll('.research-result-card').length >= 6`, 30000, 'catalog product ids for compare')
  const ids = await cdp.eval(`Array.from(document.querySelectorAll('.research-result-card')).slice(0, 6).map((el) => el.dataset.productId)`)
  const compareParam = [ids[0], ids[0], ...ids.slice(1, 6)].join(',')
  await cdp.navigate(`${BASE}?view=workspace&applied=1&compare=${compareParam}&compareOpen=1&compareTab=nutrition`)
  await waitForApp(cdp)
  await cdp.waitFor(`document.querySelector('[role="tablist"]') && document.querySelectorAll('.compare-product-head').length > 0`, 30000, 'direct compare view')
  const compareState = await cdp.eval(`({
    heads: document.querySelectorAll('.compare-product-head').length,
    selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
    bodyWidth: document.documentElement.scrollWidth,
    innerWidth,
  })`)
  check(failures, compareState.heads === 5, 'Duplicate/over-5 compare safely capped', `rendered products=${compareState.heads}, requested entries=7`)
  check(failures, compareState.selected === '영양', 'Compare tab restored from URL', `selected=${compareState.selected}`)

  const tabFocus = await cdp.eval(`(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]')
    tab?.focus()
    const style = tab ? getComputedStyle(tab) : null
    return { text: tab?.textContent.trim() ?? '', outline: style?.outline ?? '', boxShadow: style?.boxShadow ?? '' }
  })()`)
  await cdp.key('End', 'End')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const afterEnd = await cdp.eval(`({ selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '', active: document.activeElement?.textContent?.trim() ?? '' })`)
  check(failures, afterEnd.selected === '원재료' && afterEnd.active === '원재료', 'Compare End keyboard navigation', `selected=${afterEnd.selected}, active=${afterEnd.active}`)
  await cdp.key('Home', 'Home')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const afterHome = await cdp.eval(`({ selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '', active: document.activeElement?.textContent?.trim() ?? '' })`)
  check(failures, afterHome.selected === '개요' && afterHome.active === '개요', 'Compare Home keyboard navigation', `selected=${afterHome.selected}, active=${afterHome.active}`)
  check(failures, tabFocus.outline !== 'none' || (tabFocus.boxShadow && tabFocus.boxShadow !== 'none'), 'Compare focus indicator style', `outline=${tabFocus.outline}, boxShadow=${tabFocus.boxShadow}`)

  const beforeRemove = await cdp.eval(`document.querySelectorAll('.compare-product-head').length`)
  await cdp.eval(`document.querySelector('.compare-remove')?.click()`)
  await cdp.waitFor(`document.querySelectorAll('.compare-product-head').length === ${beforeRemove - 1}`, 10000, 'compare removal')
  await clickButtonContaining(cdp, '비교 닫기').catch(async () => {
    const closed = await cdp.eval(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('돌아가기')); if (!b) return false; b.click(); return true })()`)
    if (!closed) throw new Error('Compare close button not found')
  })
  await cdp.waitFor(`!document.querySelector('.compare-product-head') && document.querySelector('.research-results-list')`, 20000, 'return from compare')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const afterRemoveUrl = await cdp.eval('location.href')
  const removedId = ids[0]
  check(failures, !afterRemoveUrl.includes(removedId), 'Removed compare product stays removed on return', `removed=${removedId}, url=${afterRemoveUrl}`)

  await cdp.navigate(`${BASE}?view=workspace&detail=${HILLS_ID}`)
  await waitForApp(cdp)
  await cdp.waitFor(`document.querySelector('.detail-stage')`, 30000, 'detail keyboard view')
  await clickButtonContaining(cdp, '영양 정보 보기')
  await cdp.waitFor(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() === '영양'`, 5000, 'top navigation to nutrition')
  check(failures, (await cdp.eval(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() === '영양'`)), 'Detail top action moves to nutrition tab', await cdp.eval(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim()`))
  await cdp.eval(`document.querySelector('[role="tab"][aria-selected="true"]')?.focus()`)
  await cdp.key('ArrowRight', 'ArrowRight')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const detailArrow = await cdp.eval(`({ selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '', active: document.activeElement?.textContent?.trim() ?? '' })`)
  check(failures, detailArrow.selected === '원재료' && detailArrow.active === '원재료', 'Detail ArrowRight keyboard navigation', `selected=${detailArrow.selected}, active=${detailArrow.active}`)
  await cdp.key('End', 'End')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const detailEnd = await cdp.eval(`({ selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? '', active: document.activeElement?.textContent?.trim() ?? '' })`)
  check(failures, detailEnd.selected === '제조 · 유통' && detailEnd.active === '제조 · 유통', 'Detail End keyboard navigation', `selected=${detailEnd.selected}, active=${detailEnd.active}`)
}

async function auditMobile(cdp, failures, width) {
  await cdp.viewport(width, 844, true)
  await cdp.navigate(`${BASE}?view=workspace&applied=1`)
  await waitForApp(cdp)
  await cdp.waitFor(`document.querySelectorAll('.research-result-card').length >= 5`, 30000, `mobile ${width} catalog`)
  const ids = await cdp.eval(`Array.from(document.querySelectorAll('.research-result-card')).slice(0, 5).map((el) => el.dataset.productId)`)
  await cdp.navigate(`${BASE}?view=workspace&applied=1&compare=${ids.join(',')}&compareOpen=1&compareTab=ingredients`)
  await waitForApp(cdp)
  await cdp.waitFor(`document.querySelectorAll('.compare-product-head').length === 5`, 30000, `mobile ${width} compare`) 
  const layout = await cdp.eval(`(() => {
    const scroller = document.querySelector('.compare-scroll') || document.querySelector('.compare-table-scroll') || document.querySelector('.compare-body')
    const labels = Array.from(document.querySelectorAll('.compare-row-label'))
    const sticky = labels[0]
    const style = sticky ? getComputedStyle(sticky) : null
    const smallTexts = Array.from(document.querySelectorAll('button, .compare-product-copy, .compare-cell, .compare-row-label')).map((el) => ({
      text: el.textContent.trim().slice(0, 60),
      size: parseFloat(getComputedStyle(el).fontSize),
      rect: el.getBoundingClientRect(),
    })).filter((item) => item.text)
    const buttons = Array.from(document.querySelectorAll('button')).map((el) => ({ text: el.textContent.trim().slice(0, 40), rect: el.getBoundingClientRect() })).filter((item) => item.rect.width && item.rect.height)
    const minButton = buttons.reduce((best, item) => !best || item.rect.height < best.rect.height ? item : best, null)
    const productHeads = Array.from(document.querySelectorAll('.compare-product-head')).map((el) => ({ text: el.innerText.slice(0, 90), rect: el.getBoundingClientRect() }))
    const firstLabel = sticky?.getBoundingClientRect() ?? null
    return {
      innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      scroller: scroller ? { clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth, overflowX: getComputedStyle(scroller).overflowX } : null,
      sticky: style ? { position: style.position, left: style.left, width: firstLabel?.width ?? 0 } : null,
      minFont: smallTexts.reduce((min, item) => Math.min(min, item.size), 99),
      minButton: minButton ? { text: minButton.text, width: Math.round(minButton.rect.width), height: Math.round(minButton.rect.height) } : null,
      heads: productHeads.length,
      headWidths: productHeads.map((item) => Math.round(item.rect.width)),
    }
  })()`)
  check(failures, layout.heads === 5, `Mobile ${width}: 5-product identity`, `heads=${layout.heads}, widths=${layout.headWidths.join('/')}`)
  check(failures, layout.scroller && layout.scroller.scrollWidth > layout.scroller.clientWidth && ['auto', 'scroll'].includes(layout.scroller.overflowX), `Mobile ${width}: compare horizontal scroll`, JSON.stringify(layout.scroller))
  check(failures, layout.sticky && layout.sticky.position === 'sticky' && parseFloat(layout.sticky.left || '0') === 0, `Mobile ${width}: row label sticky`, JSON.stringify(layout.sticky))
  check(failures, layout.docScrollWidth <= layout.innerWidth + 2, `Mobile ${width}: no page-level horizontal overflow`, `viewport=${layout.innerWidth}, document=${layout.docScrollWidth}`)
  check(failures, layout.minFont >= 12, `Mobile ${width}: minimum inspected text size`, `minFont=${layout.minFont}px`)
  if (layout.minButton) check(failures, layout.minButton.height >= 32, `Mobile ${width}: minimum button height`, JSON.stringify(layout.minButton))

  const longText = await cdp.eval(`(() => {
    const copies = Array.from(document.querySelectorAll('.compare-cell, .detail-ingredient-copy'))
    const longest = copies.sort((a, b) => b.textContent.length - a.textContent.length)[0]
    if (!longest) return null
    const s = getComputedStyle(longest)
    return { length: longest.textContent.length, whiteSpace: s.whiteSpace, overflowWrap: s.overflowWrap, wordBreak: s.wordBreak, scrollWidth: longest.scrollWidth, clientWidth: longest.clientWidth }
  })()`)
  if (longText) check(failures, longText.scrollWidth <= longText.clientWidth + 2 || ['anywhere', 'break-word'].includes(longText.overflowWrap) || ['break-all', 'break-word'].includes(longText.wordBreak), `Mobile ${width}: long text wrapping`, JSON.stringify(longText))
}

test('live deployed CATFOOD browser audit', { timeout: 180000 }, async () => {
  const failures = []
  const { proc, cdp, binary, userDataDir } = await startChrome()
  annotation('notice', 'Live browser environment', `binary=${binary}; target=${BASE}; desktop=1440x1100; mobile viewport emulation=390x844,360x844; not a physical device`)
  try {
    await cdp.connect()
    await auditDesktopFlow(cdp, failures)
    await auditShareRefreshAndData(cdp, failures)
    await auditCompareAndKeyboard(cdp, failures)
    await auditMobile(cdp, failures, 390)
    await auditMobile(cdp, failures, 360)

    const apiSummary = [...new Map(cdp.apiResponses.map((item) => [`${item.path}:${item.status}`, item])).values()]
    annotation('notice', 'Observed public REST responses', apiSummary.map((item) => `${item.path}=${item.status}`).join(', ') || 'No Supabase REST responses observed')
    const meaningfulConsole = [...new Set(cdp.consoleErrors)].filter((value) => !value.includes('favicon'))
    check(failures, meaningfulConsole.length === 0, 'Browser console errors', meaningfulConsole.length ? meaningfulConsole.slice(0, 8).join(' | ') : 'none observed')
    check(failures, cdp.networkFailures.length === 0, 'Browser network failures', cdp.networkFailures.length ? [...new Set(cdp.networkFailures)].slice(0, 8).join(' | ') : 'none observed')
  } finally {
    cdp.close()
    proc.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (proc.exitCode == null) proc.kill('SIGKILL')
    rmSync(userDataDir, { recursive: true, force: true })
  }

  if (failures.length) {
    annotation('error', 'Live browser audit summary', `${failures.length} issue(s): ${failures.join(' || ')}`)
  } else {
    annotation('notice', 'Live browser audit summary', 'All automated live-browser checks passed')
  }
  assert.deepEqual(failures, [])
})
