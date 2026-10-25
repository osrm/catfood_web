import { collectionFixtureFetch, activateCollectionFixture } from './collection-fixture.mjs'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('', { url: 'https://catfood.test/' })
globalThis.window = dom.window
globalThis.sessionStorage = dom.window.sessionStorage
let api, temp, calls
const originalFetch = globalThis.fetch
const originalNow = Date.now
const criterion = { axis: 'brand', value: 'AATU', role: 'desired_change', source: 'current_baseline_derived' }
const input = () => ({ parentSearchRunId: null, mode: 'switch', currentProductId: 'product_current', currentVariantId: 'variant_current', criteriaSnapshot: [criterion], candidateCount: 85, initialPresentedProductIds: Array.from({ length: 40 }, (_, i) => `product_${i}`) })
before(async () => {
  temp = await mkdtemp(resolve('node_modules/.cache/north-star-intake-'))
  const result = await build({ configFile: false, logLevel: 'silent', define: {
    'import.meta.env.DEV': 'false', 'import.meta.env.VITE_DECISION_INTAKE_ENABLED': '"true"',
    'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"', 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
  }, build: { ssr: 'tests/entry.ts', write: false, minify: false } })
  const path = resolve(temp, 'entry.mjs')
  await writeFile(path, result.output.find((row) => row.type === 'chunk' && row.isEntry).code)
  api = await import(pathToFileURL(path).href)
})
beforeEach(async () => {
  sessionStorage.clear(); calls = []; Date.now = originalNow
  globalThis.fetch = collectionFixtureFetch(api, async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body })
    if (url.endsWith('/search-runs')) return Response.json({ search_run_id: body.client_run_id, status: 'created' })
    return Response.json({ status: 'recorded' })
  })
  await activateCollectionFixture(api)
  calls = []
})
after(async () => { globalThis.fetch = originalFetch; Date.now = originalNow; dom.window.close(); await rm(temp, { recursive: true }) })

test('V2 exact typed payload excludes free text and reconnects the original valid run', async () => {
  const run = await api.createDecisionSearchRun({ ...input(), memo: 'PRIVATE NOTE', query: 'PRIVATE QUERY' })
  assert.match(calls[0].url, /\/decision-collection\/search-runs$/)
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['client_run_id','parent_search_run_id','mode','current_product_id','current_variant_id','criteria_snapshot','candidate_count','initial_presented_product_ids','run_origin'].sort())
  assert.equal(calls[0].body.run_origin, 'submitted')
  assert.equal(calls[0].body.contract_version, undefined)
  assert.equal(await api.createDecisionSearchRun({ ...input(), runOrigin: 'restored' }), run)
  assert.equal(calls.length, 1)
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE/)
  await api.recordProductConsideration(run, 'product_84', 'quick_view_open', { kind: 'named_search', presentedProductIds: ['product_84'] })
  assert.deepEqual(calls[1].body, { search_run_id: run, product_id: 'product_84', signal_type: 'quick_view_open', context_kind: 'named_search', presented_product_ids: ['product_84'], position: 0, displayed_product_ids: [] })
  await api.recordProductConsideration(run, 'product_84', 'compare_view', { kind: 'named_search', presentedProductIds: ['product_84'], displayedProductIds: ['product_84'] })
  assert.deepEqual(calls[2].body.displayed_product_ids, ['product_84'])
  await api.recordExplicitDecision({ recordId: '946cb414-72ea-4c3a-8fa0-898a0c750965', revision: 1, previousRevision: 0, searchRunId: run, kind: 'candidate_retained', productId: 'product_84', note: 'PRIVATE NOTE' })
  assert.deepEqual(Object.keys(calls[3].body).sort(), ['operation_id','record_id','revision','expected_previous_revision','search_run_id','kind','product_id'].sort())
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE/)
})

test('expiry creates a distinct restored run/session and never attaches old actions to it', async () => {
  const old = await api.createDecisionSearchRun(input())
  const firstSession = api.activeCollectionPermission().sessionId
  Date.now = () => originalNow() + 25 * 60 * 60 * 1000
  assert.equal(await api.createDecisionSearchRun({ ...input(), runOrigin: 'restored' }), null)
  await api.setCollectionPurposes(['service_improvement', 'data_product_research'])
  const restored = await api.createDecisionSearchRun({ ...input(), runOrigin: 'restored' })
  assert.notEqual(restored, old)
  assert.notEqual(api.activeCollectionPermission().sessionId, firstSession)
  assert.equal(calls[1].body.run_origin, 'restored')
  const count = calls.length
  assert.equal(await api.recordProductConsideration(old, 'product_1', 'detail_open'), false)
  assert.equal(await api.recordExplicitDecision({ recordId: '93adae61-fbd8-4213-9b1d-03d0abf1d0f2', revision: 2, previousRevision: 1, searchRunId: old, kind: 'retained_candidate_removed', productId: 'product_1' }), false)
  assert.equal(calls.length, count)
})

test('transient retry uses the same operation UUID and exact body', async () => {
  const run = await api.createDecisionSearchRun(input())
  let attempts = 0
  globalThis.fetch = collectionFixtureFetch(api, async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return ++attempts === 1 ? new Response('', { status: 503 }) : Response.json({ status: 'recorded' }) })
  assert.equal(await api.recordExplicitDecision({ recordId: '946cb414-72ea-4c3a-8fa0-898a0c750965', revision: 1, previousRevision: 0, searchRunId: run, kind: 'candidate_retained', productId: 'product_1' }), true)
  assert.deepEqual(calls[1].body, calls[2].body)
})

test('tab record context survives independent navigation and rejects malformed local identities', () => {
  const context = { selectionKey: 'old', current: { productId: 'current', brand: '현재 브랜드', name: '현재 이름' }, variantId: 'size-1', variantLabel: '1 kg', criteria: [criterion], labels: ['다른 브랜드'] }
  const row = { id: 'record', revision: 1, active: true, candidate: { productId: 'candidate', brand: '후보 브랜드', name: '후보 이름' }, context, note: '후보 개인 메모', createdAt: '2026-10-23', searchRunId: null }
  api.writeJourneyRecords({ memo: '개인 탐색 메모', context, retained: [row], outcome: null })
  const navigation = api.createInitialSwitchSession()
  navigation.currentProductId = 'new-current'
  api.writeSwitchSession(navigation)
  assert.deepEqual(api.readJourneyRecords().retained[0].context, context)
  assert.match(api.journeyCopyText(api.readJourneyRecords()), /현재 브랜드 · 현재 이름/)
  assert.match(api.journeyCopyText({ memo: '메모만 작성', context, retained: [], outcome: null }), /사용 규격: 1 kg/)
  sessionStorage.setItem('catfood.switch-review.v1', JSON.stringify({ memo: '', retained: [{ ...row, candidate: { productId: 'candidate', brand: {}, name: null } }], outcome: null }))
  assert.deepEqual(api.readJourneyRecords().retained, [])
  api.clearJourneyRecords()
  assert.equal(api.hasJourneyWork(), false)
})

test('lost acknowledgement and a later function retry reuse the persisted operation identity', async () => {
  const run = await api.createDecisionSearchRun(input())
  const decision = { recordId: '74a5e9be-503c-4dcd-9a4f-c2d99ea35fc2', revision: 1, previousRevision: 0, searchRunId: run, kind: 'candidate_retained', productId: 'product_1' }
  globalThis.fetch = collectionFixtureFetch(api, async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); throw new Error('response lost') })
  assert.equal(await api.recordExplicitDecision(decision), false)
  const original = calls[1].body
  globalThis.fetch = collectionFixtureFetch(api, async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ status: 'existing' }) })
  assert.equal(await api.recordExplicitDecision(decision), true)
  assert.deepEqual(calls.at(-1).body, original)
})

test('blocked tab storage keeps local work usable without claiming durable persistence', () => {
  const storage = globalThis.sessionStorage
  try {
    globalThis.sessionStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
    assert.equal(api.writeJourneyRecords({ memo: '로컬 메모', retained: [], outcome: null }), false)
    assert.equal(api.readJourneyRecords().memo, '로컬 메모')
  } finally { globalThis.sessionStorage = storage }
})

test('malformed stored analytics shape fails closed without blocking local search', async () => {
  sessionStorage.setItem('catfood.decision-runs.v3', 'null')
  assert.ok(await api.createDecisionSearchRun(input()))
  sessionStorage.setItem('catfood.decision-runs.v3', '{}')
  assert.ok(await api.createDecisionSearchRun({ ...input(), runOrigin: 'restored' }))
})
