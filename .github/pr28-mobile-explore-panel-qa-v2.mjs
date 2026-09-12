import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch, sleep, js, info, pointer, network } from './mobile-mode-qa-helpers.mjs'

const BASE = 'http://127.0.0.1:4173/catfood_web/'
const TARGET_SHA = process.env.TARGET_SHA
const OUT = 'qa-artifacts/explore-panel-height'
const MOBILE_VIEWPORTS = [[360, 844], [390, 900]]
const BOUNDARIES = [[760, 900], [761, 900], [1280, 900]]
mkdirSync(OUT, { recursive: true })
assert.ok(TARGET_SHA, 'TARGET_SHA is required')

const exactButton = (label) => `(()=>{const norm=v=>(v||'').replace(/\\s+/g,' ').trim();return [...document.querySelectorAll('button')].find(n=>norm(n.textContent)===${js(label)})||null})()`

async function buttonInfo(c, label) {
  return c.eval(`(()=>{const n=${exactButton(label)};if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=(x>=0&&x<innerWidth&&y>=0&&y<innerHeight)?document.elementFromPoint(x,y):null;return{text:n.textContent.replace(/\\s+/g,' ').trim(),ariaPressed:n.getAttribute('aria-pressed'),disabled:Boolean(n.disabled),rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],rendered:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,inViewport:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,centerHit:Boolean(h&&(h===n||n.contains(h))),hit:h?.className||h?.tagName||null}})()`)
}

async function clickVisibleButton(c, label) {
  const m = await buttonInfo(c, label)
  assert.ok(m?.rendered && m.inViewport && m.centerHit && !m.disabled, `button not clickable: ${label} ${JSON.stringify(m)}`)
  const x = m.rect[0] + m.rect[2] / 2, y = m.rect[1] + m.rect[3] / 2
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(220)
  return { ...m, x, y }
}

async function wheelUntilButton(c, label) {
  for (let i = 0; i < 24; i++) {
    const m = await buttonInfo(c, label)
    if (m?.rendered && m.inViewport && m.centerHit && !m.disabled) return m
    const pos = await c.eval(`({x:Math.max(10,Math.floor(innerWidth/2)),y:Math.max(80,Math.floor(innerHeight*0.72))})`)
    const deltaY = m && m.rect[1] < 0 ? -460 : 460
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pos.x, y: pos.y, deltaX: 0, deltaY })
    await sleep(150)
  }
  throw new Error(`button not reachable by document wheel: ${label}`)
}

async function selectedLabels(c) {
  return c.eval(`(()=>[...document.querySelectorAll('.research-filter-scroll button[aria-pressed="true"]')].map(n=>n.textContent.replace(/\\s+/g,' ').trim()))()`)
}

async function editorMetrics(c) {
  return c.eval(`(()=>{
    const box=n=>{if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect();return{rect:[r.left,r.top,r.width,r.height,r.right,r.bottom],clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,scrollTop:n.scrollTop,overflowY:s.overflowY,maxHeight:s.maxHeight,backgroundColor:s.backgroundColor,borderRadius:s.borderRadius}}
    const panel=document.querySelector('.research-filters'), inner=document.querySelector('.research-filter-scroll'), actions=document.querySelector('.condition-actions'), sections=[...document.querySelectorAll('.filter-section')], last=sections.at(-1)
    const p=box(panel), i=box(inner), a=box(actions), l=box(last)
    const inside=(outer,child)=>Boolean(outer&&child&&child.rect[0]>=outer.rect[0]-1&&child.rect[4]<=outer.rect[4]+1&&child.rect[1]>=outer.rect[1]-1&&child.rect[5]<=outer.rect[5]+1)
    const panelScrollable=Boolean(panel&&panel.scrollHeight>panel.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(panel).overflowY))
    const innerScrollable=Boolean(inner&&inner.scrollHeight>inner.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(inner).overflowY))
    const docScrollable=document.documentElement.scrollHeight>innerHeight+1
    return{viewport:[innerWidth,innerHeight],panel:p,inner:i,actions:a,lastSection:l,actionsInsidePanelRect:inside(p,a),lastInsidePanelRect:inside(p,l),panelScrollable,innerScrollable,doubleVerticalScroll:Boolean(docScrollable&&(panelScrollable||innerScrollable)),document:{scrollY,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight,overflowY:getComputedStyle(document.documentElement).overflowY,bodyOverflowY:getComputedStyle(document.body).overflowY,scrollable:docScrollable},media760:matchMedia('(max-width: 760px)').matches}
  })()`)
}

async function resultState(c) {
  return c.eval(`(()=>{const p=new URL(location.href).searchParams;return{url:location.href,params:Object.fromEntries(p.entries()),chips:[...document.querySelectorAll('.criteria-chips span')].map(n=>n.textContent.trim()),cards:[...document.querySelectorAll('.research-result-card')].slice(0,5).map(n=>({name:n.querySelector('.research-result-identity strong')?.textContent.trim()||null,meta:n.querySelector('.research-result-meta')?.textContent.trim()||null,relation:n.querySelector('.result-relations')?.textContent.replace(/\\s+/g,' ').trim()||null}))}})()`)
}

function assertEditorContained(m, label) {
  assert.ok(m.panel && m.inner && m.actions && m.lastSection, `${label}: editor geometry missing`)
  assert.equal(m.panel.maxHeight, 'none', `${label}: panel max-height should be none`)
  assert.equal(m.actionsInsidePanelRect, true, `${label}: actions outside panel rect`)
  assert.equal(m.lastInsidePanelRect, true, `${label}: last condition outside panel rect`)
  assert.equal(m.panelScrollable, false, `${label}: panel became an internal scroller`)
  assert.equal(m.innerScrollable, false, `${label}: filter content became an internal scroller`)
  assert.equal(m.doubleVerticalScroll, false, `${label}: double vertical scroll`)
  assert.equal(m.document.scrollable, true, `${label}: document should carry vertical scrolling`)
}

async function openEditor(c) {
  await c.nav(BASE)
  await c.wait(`/\\d/.test(document.querySelector('.home-search-console-copy small')?.textContent||'')`, 'catalog loaded')
  await pointer(c, 'button', '조건 고르기 →')
  await c.wait(`document.querySelector('.condition-actions')&&document.querySelector('.research-filter-scroll')`, 'condition editor')
}

async function runMobile(width, height) {
  const tag = `${width}x${height}`
  const browser = await launch(width, height), c = browser.c
  const result = { viewport: [width, height], targetSha: TARGET_SHA, captures: [], status: 'running' }
  const shot = async (name) => { const file = `${tag}-${name}.png`; await c.shot(`${OUT}/${file}`); result.captures.push(file) }
  try {
    result.chrome = browser.version
    await openEditor(c)
    result.fonts = await c.fonts('.research-pane-heading strong')
    assert.ok(result.fonts.some(f=>f.familyName.includes('Noto Sans CJK KR')), `${tag}: Korean font mismatch`)

    await c.eval('scrollTo(0,0)')
    await sleep(100)
    result.initialTop = await editorMetrics(c)
    assertEditorContained(result.initialTop, `${tag} initial`)
    result.initialApply = await buttonInfo(c, '이 조건으로 찾기')
    assert.equal(result.initialApply?.disabled, false, `${tag}: existing apply-with-empty-draft semantics changed`)
    await shot('01-editor-top')

    await pointer(c, 'button', '건식')
    await pointer(c, 'button', '실내묘')
    await pointer(c, 'button', '체중 관리')
    result.initialSelected = await selectedLabels(c)
    assert.deepEqual([...result.initialSelected].sort(), ['건식','실내묘','체중 관리'].sort(), `${tag}: initial selected values`)

    result.lastReach = await wheelUntilButton(c, 'Grain-Free 표기')
    result.applyReach = await wheelUntilButton(c, '이 조건으로 찾기')
    result.bottomBeforeApply = await editorMetrics(c)
    assertEditorContained(result.bottomBeforeApply, `${tag} bottom before apply`)
    result.applyHit = await buttonInfo(c, '이 조건으로 찾기')
    result.resetHit = await buttonInfo(c, '초기화')
    assert.equal(result.applyHit?.centerHit, true, `${tag}: apply hit-test`)
    assert.equal(result.applyHit?.inViewport, true, `${tag}: apply viewport`)
    await shot('02-editor-bottom-actions')
    await clickVisibleButton(c, '이 조건으로 찾기')

    await c.wait(`document.querySelector('.criteria-bar')&&document.querySelectorAll('.research-result-card').length>0`, 'first applied results')
    result.firstApplied = await resultState(c)
    assert.equal(result.firstApplied.params.applied, '1')
    assert.equal(result.firstApplied.params.feed, '건식')
    assert.equal(result.firstApplied.params.targets, 'indoor')
    assert.equal(result.firstApplied.params.features, 'weight_management')
    for (const label of ['건식','실내묘','체중 관리']) assert.ok(result.firstApplied.chips.includes(label), `${tag}: missing first chip ${label}`)
    assert.ok(result.firstApplied.cards.length > 0 && result.firstApplied.cards.every(x=>x.meta?.includes('건식')), `${tag}: hard feed result mismatch`)
    assert.ok(result.firstApplied.cards[0]?.relation?.includes('실내묘') && result.firstApplied.cards[0]?.relation?.includes('체중 관리'), `${tag}: relation summary mismatch`)
    await c.eval('scrollTo(0,0)')
    await sleep(120)
    await shot('03-first-results')

    result.refineEntry = await info(c, '.mobile-refine-entry button', '더 좁혀보기')
    assert.ok(result.refineEntry?.rendered && result.refineEntry.inViewport && result.refineEntry.centerHit, `${tag}: refine entry affected`)
    await pointer(c, '.mobile-refine-entry button', '더 좁혀보기')
    await c.wait(`document.querySelector('.research-shell.is-mobile-refining')`, 'mobile refine open')
    result.refinePanel = await c.eval(`(()=>{const n=document.querySelector('.research-filters');const s=n?getComputedStyle(n):null;const r=n?.getBoundingClientRect();return n?{display:s.display,maxHeight:s.maxHeight,overflowY:s.overflowY,rect:r?[r.left,r.top,r.width,r.height]:null}:null})()`)
    assert.equal(result.refinePanel?.maxHeight, 'none', `${tag}: existing refine panel max-height changed`)
    await pointer(c, '.mobile-refine-entry button', '목록으로 돌아가기')
    await c.wait(`!document.querySelector('.research-shell.is-mobile-refining')`, 'mobile refine close')

    await pointer(c, '.criteria-bar button', '조건 수정')
    await c.wait(`document.querySelector('.condition-actions')`, 're-edit')
    await c.eval('scrollTo(0,0)')
    await sleep(100)
    result.reeditTop = await editorMetrics(c)
    assertEditorContained(result.reeditTop, `${tag} re-edit`)
    result.reeditSelected = await selectedLabels(c)
    assert.deepEqual([...result.reeditSelected].sort(), ['건식','실내묘','체중 관리'].sort(), `${tag}: selections not restored`)
    await shot('04-reedit-top')

    await pointer(c, 'button', '실내묘')
    await pointer(c, 'button', '중성화묘')
    await pointer(c, 'button', '체중 관리')
    await pointer(c, 'button', '헤어볼')
    result.changedSelected = await selectedLabels(c)
    assert.deepEqual([...result.changedSelected].sort(), ['건식','중성화묘','헤어볼'].sort(), `${tag}: changed draft mismatch`)
    await wheelUntilButton(c, '이 조건으로 찾기')
    result.reeditBottom = await editorMetrics(c)
    assertEditorContained(result.reeditBottom, `${tag} re-edit bottom`)
    await shot('05-reedit-bottom-actions')
    await clickVisibleButton(c, '이 조건으로 찾기')

    await c.wait(`document.querySelector('.criteria-bar')&&document.querySelectorAll('.research-result-card').length>0`, 'reapplied results')
    result.reapplied = await resultState(c)
    assert.equal(result.reapplied.params.feed, '건식')
    assert.equal(result.reapplied.params.targets, 'sterilized')
    assert.equal(result.reapplied.params.features, 'hairball')
    for (const label of ['건식','중성화묘','헤어볼']) assert.ok(result.reapplied.chips.includes(label), `${tag}: missing reapplied chip ${label}`)
    assert.ok(result.reapplied.cards.length > 0 && result.reapplied.cards.every(x=>x.meta?.includes('건식')), `${tag}: reapplied hard feed mismatch`)
    assert.ok(result.reapplied.cards[0]?.relation?.includes('중성화묘') && result.reapplied.cards[0]?.relation?.includes('헤어볼'), `${tag}: reapplied relation mismatch`)
    await c.eval('scrollTo(0,0)')
    await sleep(120)
    await shot('06-reapplied-results')

    await pointer(c, '.criteria-bar button', '조건 수정')
    await c.wait(`document.querySelector('.condition-actions')`, 'edit before reset')
    result.urlBeforeReset = await c.eval('location.href')
    await wheelUntilButton(c, '초기화')
    result.resetHitBefore = await buttonInfo(c, '초기화')
    assert.equal(result.resetHitBefore?.centerHit, true, `${tag}: reset hit-test`)
    await clickVisibleButton(c, '초기화')
    result.resetSelected = await selectedLabels(c)
    result.urlAfterReset = await c.eval('location.href')
    assert.deepEqual(result.resetSelected, [], `${tag}: reset did not clear only draft selections`)
    assert.equal(result.urlAfterReset, result.urlBeforeReset, `${tag}: reset changed applied URL before apply`)
    result.resetMetrics = await editorMetrics(c)
    assertEditorContained(result.resetMetrics, `${tag} after reset`)
    await shot('07-reset-draft-bottom')

    await pointer(c, '.mode-nav .mode-button', '제품 찾기')
    await c.wait(`document.querySelector('.lookup-input')`, 'lookup impact')
    result.lookupPanel = await c.eval(`(()=>{const n=document.querySelector('.research-filters');const s=n?getComputedStyle(n):null;return n?{maxHeight:s.maxHeight,overflowY:s.overflowY,hasConditionActions:Boolean(document.querySelector('.condition-actions'))}:null})()`)
    assert.equal(result.lookupPanel?.hasConditionActions, false, `${tag}: lookup unexpectedly matches editor selector`)
    assert.notEqual(result.lookupPanel?.maxHeight, 'none', `${tag}: scoped override leaked into lookup`)

    result.network = await network(c)
    assert.deepEqual(result.network.sentAnalytics, [], `${tag}: analytics escaped blocker`)
    assert.deepEqual(result.network.sentWrites, [], `${tag}: production write escaped blocker`)
    result.status = 'pass'
    return result
  } catch (error) {
    result.status = 'failed'; result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    try { await shot('99-failure') } catch {}
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { qaResult: result })
  } finally {
    c.close(); browser.proc.kill('SIGTERM'); await sleep(180)
  }
}

async function runBoundary(width, height) {
  const tag = `${width}x${height}`
  const browser = await launch(width, height), c = browser.c
  const result = { viewport: [width, height], targetSha: TARGET_SHA, captures: [], status: 'running' }
  const shot = async (name) => { const file = `${tag}-${name}.png`; await c.shot(`${OUT}/${file}`); result.captures.push(file) }
  try {
    result.chrome = browser.version
    if (width > 760) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height })
      await c.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8', platform: 'Linux x86_64' })
    }
    await openEditor(c)
    await c.eval('scrollTo(0,0)')
    await sleep(100)
    result.metrics = await editorMetrics(c)
    if (width <= 760) assertEditorContained(result.metrics, `${tag} boundary`)
    if (width === 761) {
      assert.equal(result.metrics.media760, false, '761 should be outside mobile cap breakpoint')
      assert.equal(result.metrics.actionsInsidePanelRect, true, '761 editor containment changed')
      assert.equal(result.metrics.innerScrollable, false, '761 unexpectedly became nested scroll')
    }
    if (width === 1280) {
      assert.equal(result.metrics.media760, false, '1280 mobile rule leaked')
      assert.ok(result.metrics.panel && result.metrics.inner, '1280 filter rail missing')
    }
    await shot('boundary-editor-top')
    result.network = await network(c)
    assert.deepEqual(result.network.sentAnalytics, [], `${tag}: analytics escaped blocker`)
    assert.deepEqual(result.network.sentWrites, [], `${tag}: production write escaped blocker`)
    result.status = 'pass'
    return result
  } catch (error) {
    result.status = 'failed'; result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    try { await shot('99-failure') } catch {}
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { qaResult: result })
  } finally {
    c.close(); browser.proc.kill('SIGTERM'); await sleep(180)
  }
}

const report = {
  targetSha: TARGET_SHA,
  candidateUrl: BASE,
  baselineEvidence: { run: 34671410086, artifact: 10290479839, finding: '360/390 panel max-height 50vh ended before the full condition form while content remained overflow-visible' },
  environment: 'GitHub-hosted headless Chrome, ko-KR locale, Noto Sans CJK KR; viewport emulation only',
  mobile: [], boundaries: [], status: 'running'
}

try {
  for (const [w,h] of MOBILE_VIEWPORTS) report.mobile.push(await runMobile(w,h))
  for (const [w,h] of BOUNDARIES) report.boundaries.push(await runBoundary(w,h))
  report.status = 'pass'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (error?.qaResult) report.failure = error.qaResult
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  throw error
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ status: report.status, targetSha: TARGET_SHA, mobile: report.mobile.map(x=>({viewport:x.viewport,status:x.status})), boundaries: report.boundaries.map(x=>({viewport:x.viewport,status:x.status})) }, null, 2))
