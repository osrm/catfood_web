import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outDir = process.env.OUT_DIR
const chromePath = process.env.CHROME_PATH
const candidateSha = process.env.CANDIDATE_SHA
const baseURL = process.env.CANDIDATE_URL || 'http://127.0.0.1:4173/'
if (!outDir || !chromePath || !candidateSha) throw new Error('OUT_DIR, CHROME_PATH and CANDIDATE_SHA are required')
await mkdir(outDir, { recursive: true })

const browser = await chromium.launch({ executablePath: chromePath, headless: true })
const measurements = { candidateSha, baseURL, scenarios: [], requests: { reads: 0, blockedWrites: 0, failures: [] } }

async function installGuards(page) {
  await page.route('**/*', async (route) => {
    const req = route.request()
    const method = req.method().toUpperCase()
    const url = req.url()
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      measurements.requests.blockedWrites += 1
      return route.abort('blockedbyclient')
    }
    if (url.includes('/rest/v1/') || url.includes('/functions/v1/')) measurements.requests.reads += 1
    return route.continue()
  })
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'request failed'
    if (!failure.includes('ERR_BLOCKED_BY_CLIENT')) measurements.requests.failures.push({ url: request.url(), failure })
  })
}

async function ready(page) {
  await page.waitForLoadState('networkidle')
  await page.evaluate(async () => {
    await document.fonts.ready
    const images = [...document.images].filter((image) => {
      const rect = image.getBoundingClientRect()
      return rect.bottom > 0 && rect.top < innerHeight
    })
    await Promise.all(images.map((image) => image.complete ? null : new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true })
      image.addEventListener('error', resolve, { once: true })
    })))
  })
}

async function capture(page, name) {
  await ready(page)
  const file = `${name}.png`
  await page.screenshot({ path: join(outDir, file), fullPage: false })
  const measure = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    scrollY,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    focused: document.activeElement instanceof HTMLElement ? document.activeElement.outerHTML.slice(0, 240) : null,
    sticky: [...document.querySelectorAll('.compare-mobile-two-product-key th, .compare-head-row .compare-product-copy')].slice(0, 8).map((node) => ({
      text: node.textContent?.trim(),
      top: node.getBoundingClientRect().top,
      bottom: node.getBoundingClientRect().bottom,
    })),
  }))
  measurements.scenarios.push({ name, file, ...measure })
}

async function runViewport(width, height) {
  const page = await browser.newPage({ viewport: { width, height } })
  await installGuards(page)
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
  await ready(page)
  await capture(page, `home-${width}`)
  await page.close()
}

try {
  await runViewport(390, 844)
  await runViewport(1440, 900)
} finally {
  await browser.close()
  await writeFile(join(outDir, 'measurements.json'), JSON.stringify(measurements, null, 2))
}
