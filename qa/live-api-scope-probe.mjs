import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const pagesUrl = 'https://osrm.github.io/catfood_web/'
const baselineUrl = 'http://127.0.0.1:4173/'
const candidateUrl = 'http://127.0.0.1:4174/'
const apiPath = '/rest/v1/effective_product_catalog_summary'

function contentType(path) {
  const ext = extname(path)
  if (ext === '.js') return 'text/javascript'
  if (ext === '.css') return 'text/css'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.png') return 'image/png'
  return 'text/html; charset=utf-8'
}

async function startStatic(root, port) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const normalized = normalize(relative)
      if (normalized.startsWith('..')) {
        response.writeHead(400)
        response.end('bad path')
        return
      }
      const target = join(root, normalized)
      const data = await readFile(target)
      response.writeHead(200, { 'content-type': contentType(target) })
      response.end(data)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
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

const baseline = await startStatic(join(process.env.BASELINE_DIR, 'dist'), 4173)
const candidate = await startStatic(join(process.env.CANDIDATE_DIR, 'dist'), 4174)
const servers = [baseline, candidate]

try {
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
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
}
