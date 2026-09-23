import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'

const BASE = 'https://osrm.github.io/catfood_web/'
const OUT = process.env.OUT_DIR || 'qa-output'
const MERGE_SHA = process.env.EXPECTED_MERGE_SHA
const PRODUCT_ID = 'product_31bc515d78d43d5d'
const EXPECTED_NAME = '카니보 치킨&칠면조&오리'
const EXPECTED_BRAND = 'GO! SOLUTIONS'

await mkdir(OUT, { recursive: true })

const report = {
  generatedAt: new Date().toISOString(),
  deployedMergeSha: MERGE_SHA,
  target: { productId: PRODUCT_ID, brand: EXPECTED_BRAND, name: EXPECTED_NAME },
  blockedNonGet: [],
  blockedAnalytics: [],
  apiReads: [],
  storageReads: [],
  mobile360: null,
  desktop1440: null,
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
})

function lookupUrl() {
  const u = new URL(BASE)
  u.searchParams.set('view', 'workspace')
  u.searchParams.set('mode', 'lookup')
  u.searchParams.set('q', 'GO! SOLUTIONS')
  return u.toString()
}

async function newGuardedPage(width, height) {
  const page = await browser.newPage({ viewport: { width, height } })

  await page.route('**/*', async route => {
    const req = route.request()
    const method = req.method()
    const url = req.url()
    let parsed
    try { parsed = new URL(url) } catch { parsed = null }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      report.blockedNonGet.push({
        method,
        url: parsed ? parsed.origin + parsed.pathname : url,
      })
      await route.abort('blockedbyclient')
      return
    }

    if (/\/functions\/v1\/|analytics|telemetry|event_log/i.test(url)) {
      report.blockedAnalytics.push({
        method,
        url: parsed ? parsed.origin + parsed.pathname : url,
      })
      await route.abort('blockedbyclient')
      return
    }

    await route.continue()
  })

  page.on('response', response => {
    try {
      const u = new URL(response.url())
      if (u.host === 'gnosbstdatkytsyxuapt.supabase.co' && u.pathname.startsWith('/rest/v1/')) {
        report.apiReads.push({
          method: response.request().method(),
          path: u.pathname,
          status: response.status(),
        })
      }
      if (u.host === 'gnosbstdatkytsyxuapt.supabase.co' && u.pathname.startsWith('/storage/v1/object/public/')) {
        report.storageReads.push({
          method: response.request().method(),
          path: u.pathname,
          status: response.status(),
        })
      }
    } catch {}
  })

  return page
}

async function pointerClick(page, locator, label) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  assert.ok(box, label + ': pointer target has a box')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

async function waitImage(page, selector, label) {
  await page.waitForFunction((sel) => {
    const image = document.querySelector(sel)
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
  }, selector, { timeout: 30000 })
  const info = await page.locator(selector).evaluate((image) => ({
    src: image.currentSrc || image.src,
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  }))
  assert.equal(info.complete, true, label + ': image complete')
  assert.ok(info.naturalWidth > 0 && info.naturalHeight > 0, label + ': image natural size')
  assert.match(info.src, /\/storage\/v1\/object\/public\//, label + ': image is live public Storage asset')
  return info
}

async function openQuickView(page) {
  await page.goto(lookupUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 })
  const card = page.locator('.research-result-card[data-product-id="' + PRODUCT_ID + '"]')
  await card.waitFor({ state: 'visible', timeout: 30000 })

  const cardText = (await card.innerText()).replace(/\s+/g, ' ').trim()
  assert.match(cardText, /GO! SOLUTIONS/, 'lookup card brand')
  assert.match(cardText, /카니보 치킨&칠면조&오리/, 'lookup card product name')

  await pointerClick(page, card, 'lookup result card')

  const quick = page.locator('.research-quick-view.is-editorial')
  await quick.waitFor({ state: 'visible', timeout: 20000 })
  await page.locator('.quick-view-identity h1').waitFor({ state: 'visible' })
  const image = await waitImage(page, '.quick-view-image', 'quick view')

  return { cardText, quick, image }
}

async function quickViewSnapshot(page) {
  return page.evaluate(() => {
    const quick = document.querySelector('.research-quick-view.is-editorial')
    const identity = document.querySelector('.quick-view-identity')
    const title = document.querySelector('.quick-view-identity h1')
    const brand = document.querySelector('.quick-view-identity span')
    const actions = [...document.querySelectorAll('.quick-view-actions button')]
    const rows = [...document.querySelectorAll('.quick-view-section .definition')]
    const packageRow = rows.find(row => row.querySelector('dt')?.textContent?.trim() === '판매 규격')
    const q = quick?.getBoundingClientRect()
    const i = identity?.getBoundingClientRect()
    return {
      title: title?.textContent?.trim() || null,
      brand: brand?.textContent?.trim() || null,
      packageValue: packageRow?.querySelector('dd')?.textContent?.replace(/\s+/g, ' ').trim() || null,
      actionButtons: actions.map(button => {
        const r = button.getBoundingClientRect()
        return {
          text: button.textContent?.replace(/\s+/g, ' ').trim() || '',
          width: r.width,
          height: r.height,
          top: r.top,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
        }
      }),
      quickRect: q ? { left:q.left, right:q.right, top:q.top, bottom:q.bottom, width:q.width, height:q.height } : null,
      identityRect: i ? { left:i.left, right:i.right, top:i.top, bottom:i.bottom, width:i.width, height:i.height } : null,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      quickScrollWidth: quick instanceof HTMLElement ? quick.scrollWidth : null,
      quickClientWidth: quick instanceof HTMLElement ? quick.clientWidth : null,
      coreRows: rows.map(row => ({
        label: row.querySelector('dt')?.textContent?.trim() || '',
        value: row.querySelector('dd')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      })),
    }
  })
}

{
  const page = await newGuardedPage(360, 844)
  const opened = await openQuickView(page)
  const initial = await quickViewSnapshot(page)

  assert.equal(initial.title, EXPECTED_NAME, 'mobile full product name')
  assert.equal(initial.brand, EXPECTED_BRAND, 'mobile brand')
  assert.ok(initial.packageValue && initial.packageValue !== '판매 규격 미확인', 'mobile sales package is shown')
  assert.equal(initial.actionButtons.length, 2, 'mobile has two actions')
  for (const action of initial.actionButtons) {
    assert.ok(action.height >= 44, 'mobile action >=44px: ' + action.text)
  }
  assert.ok(initial.documentScrollWidth <= 360, 'mobile document has no horizontal overflow')
  assert.ok(initial.bodyScrollWidth <= 360, 'mobile body has no horizontal overflow')
  assert.ok((initial.quickScrollWidth ?? 361) <= (initial.quickClientWidth ?? 360) + 1, 'mobile quick view has no horizontal overflow')

  await page.screenshot({ path: OUT + '/pr50-quick-view-360.png', fullPage: false })

  const compare = page.locator('.quick-view-actions button').filter({ hasText: '비교에 추가' })
  await pointerClick(page, compare, 'mobile compare add')
  const remove = page.locator('.quick-view-actions button').filter({ hasText: '비교에서 제거' })
  await remove.waitFor({ state: 'visible', timeout: 10000 })
  assert.match(await remove.innerText(), /비교에서 제거/, 'compare add changes action to remove')
  assert.equal(await page.locator('.switch-compare-dock').count(), 1, 'compare dock appears after add')

  await pointerClick(page, remove, 'mobile compare remove')
  const addAgain = page.locator('.quick-view-actions button').filter({ hasText: '비교에 추가' })
  await addAgain.waitFor({ state: 'visible', timeout: 10000 })
  assert.equal(await page.locator('.switch-compare-dock').count(), 0, 'compare dock clears after remove')

  const detailButton = page.locator('.quick-view-actions button').filter({ hasText: '상세 보기' })
  await pointerClick(page, detailButton, 'mobile detail open')
  await page.locator('.detail-stage').waitFor({ state: 'visible', timeout: 20000 })
  await waitImage(page, '.detail-product-image', 'mobile detail')
  assert.equal((await page.locator('.detail-identity h1').innerText()).trim(), EXPECTED_NAME, 'detail has full product name')

  const detailBack = page.locator('.detail-topbar button').filter({ hasText: '돌아가기' })
  await pointerClick(page, detailBack, 'mobile detail back')
  await page.locator('.research-quick-view.is-editorial').waitFor({ state: 'visible', timeout: 20000 })
  assert.equal((await page.locator('.quick-view-identity h1').innerText()).trim(), EXPECTED_NAME, 'detail returns to parent quick view')

  const close = page.locator('.quick-view-topline button').filter({ hasText: '닫기' })
  await pointerClick(page, close, 'mobile quick view close')
  await page.locator('.research-quick-view.is-editorial').waitFor({ state: 'hidden', timeout: 10000 })
  assert.equal(await page.locator('.research-result-card[data-product-id="' + PRODUCT_ID + '"]').count(), 1, 'closing quick view returns to lookup results')

  report.mobile360 = {
    lookupCard: opened.cardText,
    image: opened.image,
    initial,
    compareAddRemove: true,
    detailOpenReturn: true,
    quickViewClosed: true,
  }

  await page.close()
}

{
  const page = await newGuardedPage(1440, 900)
  const opened = await openQuickView(page)
  const snapshot = await quickViewSnapshot(page)

  assert.equal(snapshot.title, EXPECTED_NAME, 'desktop full product name')
  assert.equal(snapshot.brand, EXPECTED_BRAND, 'desktop brand')
  assert.ok(snapshot.packageValue && snapshot.packageValue !== '판매 규격 미확인', 'desktop sales package is shown')
  assert.equal(snapshot.actionButtons.length, 2, 'desktop has two actions')
  assert.ok(snapshot.coreRows.length >= 6, 'desktop core information rows present')
  assert.ok(snapshot.coreRows.some(row => row.label === '판매 규격' && row.value), 'desktop sales package row present')
  assert.ok(snapshot.coreRows.some(row => row.label === '제품 표기 대상'), 'desktop target row present')
  assert.ok(snapshot.coreRows.some(row => row.label === '주요 레시피'), 'desktop recipe row present')

  const a = snapshot.actionButtons[0]
  const b = snapshot.actionButtons[1]
  assert.ok(Math.abs(a.top - b.top) <= 2, 'desktop action buttons share a row')
  assert.ok(a.right <= b.left + 1, 'desktop action buttons do not overlap')
  assert.ok(a.height >= 44 && b.height >= 44, 'desktop action buttons are >=44px')
  assert.ok(snapshot.documentScrollWidth <= 1440, 'desktop document has no horizontal overflow')
  assert.ok(snapshot.bodyScrollWidth <= 1440, 'desktop body has no horizontal overflow')
  assert.ok((snapshot.quickScrollWidth ?? 1441) <= (snapshot.quickClientWidth ?? 1440) + 1, 'desktop quick view has no horizontal overflow')

  await page.screenshot({ path: OUT + '/pr50-quick-view-1440.png', fullPage: false })

  report.desktop1440 = {
    lookupCard: opened.cardText,
    image: opened.image,
    snapshot,
  }
  await page.close()
}

assert.ok(report.apiReads.length > 0, 'live public Data API reads were observed')
assert.ok(report.apiReads.every(x => ['GET', 'HEAD', 'OPTIONS'].includes(x.method)), 'only read methods reached Data API')
assert.ok(report.apiReads.every(x => x.status >= 200 && x.status < 300), 'all observed Data API reads succeeded')
assert.ok(report.storageReads.some(x => x.status >= 200 && x.status < 300), 'live product image read succeeded')

const shortReport = [
  'PR #50 postdeploy evidence',
  'merge SHA: ' + MERGE_SHA,
  'mobile 360x844: PASS',
  'desktop 1440x900: PASS',
  'mobile package: ' + report.mobile360.initial.packageValue,
  'mobile action heights: ' + report.mobile360.initial.actionButtons.map(x => Math.round(x.height) + 'px').join(', '),
  'mobile compare add/remove: PASS',
  'mobile detail -> quick view -> close: PASS',
  'desktop core rows: ' + report.desktop1440.snapshot.coreRows.map(x => x.label).join(', '),
  'desktop action heights: ' + report.desktop1440.snapshot.actionButtons.map(x => Math.round(x.height) + 'px').join(', '),
  'horizontal overflow: none at 360/1440',
  'blocked non-GET attempts: ' + report.blockedNonGet.length,
  'blocked analytics GET attempts: ' + report.blockedAnalytics.length,
  'public API reads: ' + report.apiReads.length + ' (all 2xx)',
].join('\n') + '\n'

await writeFile(OUT + '/report.json', JSON.stringify(report, null, 2))
await writeFile(OUT + '/report.txt', shortReport)
console.log('CATFOOD_PR50_POSTDEPLOY=' + JSON.stringify(report))
console.log(shortReport)

await browser.close()
