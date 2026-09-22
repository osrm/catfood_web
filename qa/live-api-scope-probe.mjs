import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const pagesUrl = 'https://osrm.github.io/catfood_web/'
const baselineUrl = 'http://127.0.0.1:4173/'
const candidateUrl = 'http://127.0.0.1:4174/'
const apiPath = '/rest/v1/effective_product_catalog_summary'

function startPreview(cwd, port) {
  const child = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  return child
}

async function waitHttp(url) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`preview did not start: ${url}`)
}

async function probe(browser, label, url) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const observedAt = new Date().toISOString()

  const responsePromise = page.waitForResponse(
    (response) => {
      try {
        const u = new URL(response.url())
        return u.pathname === apiPath
      } catch {
        return false
      }
    },
    { timeout: 20000 },
  )

  const navigation = page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const response = await responsePromise
  await navigation.catch(() => {})

  const request = response.request()
  const requestUrl = new URL(request.url())
  const headers = await request.allHeaders()
  let body = ''
  try {
    body = (await response.text()).slice(0, 500)
  } catch (error) {
    body = `<unavailable: ${String(error)}>`
  }

  const result = {
    label,
    pageUrl: url,
    observedAt,
    request: {
      host: requestUrl.host,
      path: requestUrl.pathname,
      acceptProfile: headers['accept-profile'] ?? null,
    },
    response: {
      status: response.status(),
      body,
    },
  }

  await context.close()
  return result
}

const baseline = startPreview(process.env.BASELINE_DIR, 4173)
const candidate = startPreview(process.env.CANDIDATE_DIR, 4174)
const processes = [baseline, candidate]

try {
  await Promise.all([waitHttp(baselineUrl), waitHttp(candidateUrl)])
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  })
  try {
    const results = []
    for (const [label, url] of [
      ['pages', pagesUrl],
      ['baseline', baselineUrl],
      ['candidate', candidateUrl],
    ]) {
      results.push(await probe(browser, label, url))
    }

    const comparable = results.map((item) => ({
      label: item.label,
      host: item.request.host,
      path: item.request.path,
      acceptProfile: item.request.acceptProfile,
      status: item.response.status,
      body: item.response.body,
    }))
    const comparableValues = comparable.map(({ label: _label, ...item }) => item)
    const first = JSON.stringify(comparableValues[0])
    const sameRequestAndResponse = comparableValues.every((item) => JSON.stringify(item) === first)

    const report = {
      generatedAt: new Date().toISOString(),
      deployedPagesSha: process.env.PAGES_SHA,
      baselineSha: process.env.BASELINE_SHA,
      candidateSha: process.env.CANDIDATE_SHA,
      apiSourceBlobMatches: process.env.API_BLOB_MATCH === 'true',
      results,
      sameRequestAndResponse,
    }

    await writeFile(process.env.REPORT_PATH || 'live-api-scope-report.json', JSON.stringify(report, null, 2))
    console.log('CATFOOD_LIVE_API_SCOPE=' + JSON.stringify(report))
  } finally {
    await browser.close()
  }
} finally {
  for (const child of processes) child.kill('SIGTERM')
}
