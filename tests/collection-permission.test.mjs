import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
const dom = new JSDOM('<div id="root"></div>', { url: 'https://catfood.test/' })
globalThis.window = dom.window; globalThis.document = dom.window.document
globalThis.sessionStorage = dom.window.sessionStorage; globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const originalFetch = globalThis.fetch, originalNow = Date.now
let api, off, dir, calls, receipts, defaultFetch
const criterion = { axis: 'brand', value: 'AATU', role: 'desired_change', source: 'current_baseline_derived' }
const input = () => ({ parentSearchRunId: null, mode: 'switch', currentProductId: 'current', currentVariantId: 'sku1',
  criteriaSnapshot: [criterion], candidateCount: 1, initialPresentedProductIds: ['candidate'] })
async function bundle(enabled) {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_DECISION_INTAKE_ENABLED': JSON.stringify(String(enabled)),
    'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"', 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-key"',
  }, build: { ssr: 'tests/entry.ts', write: false, minify: false } })
  const file = resolve(dir, `collection-${enabled}-${crypto.randomUUID()}.mjs`)
  await writeFile(file, result.output.find(x => x.type === 'chunk' && x.isEntry).code)
  return import(pathToFileURL(file).href)
}
before(async () => { await mkdir(resolve('node_modules/.cache'), { recursive: true }); dir = await mkdtemp(resolve('node_modules/.cache/collection-')); api = await bundle(true) })
beforeEach(async () => {
  Date.now = originalNow; calls = []; receipts = new Map()
  defaultFetch = async (url, init = {}) => {
    assert.equal(new URL(url).origin, 'https://api.test')
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url: String(url), body, signal: init.signal })
    if (url.endsWith('/policy')) return Response.json({ enabled: true, notice_version: api.COLLECTION_NOTICE_VERSION,
      raw_retention_seconds: 172800, operator_name: 'Fixture operator', contact_url: 'https://catfood.test/contact' })
    if (url.endsWith('/permissions')) {
      if (!receipts.has(body.capability)) receipts.set(body.capability, { permission_id: crypto.randomUUID(), session_id: crypto.randomUUID(),
        purposes: [...body.purposes].sort(), notice_version: body.notice_version,
        accept_until: new Date(Date.now() + 86400000).toISOString(), raw_until: new Date(Date.now() + 172800000).toISOString() })
      return Response.json(receipts.get(body.capability))
    }
    if (url.endsWith('/delete')) { receipts.delete(body.capability); return Response.json({ status: 'deleted', search_runs_deleted: 1 }) }
    if (body.kind === 'search_run') return Response.json({ search_run_id: body.event.client_run_id, status: 'created' })
    if (body.kind === 'decision') return Response.json({ status: 'recorded', record_id: body.event.record_id, revision: body.event.revision })
    return Response.json({ status: 'recorded' })
  }
  globalThis.fetch = defaultFetch
  await api.stopAndDeleteCollection(); sessionStorage.clear(); await api.loadCollectionPolicy(); calls = []
})
after(async () => { globalThis.fetch = originalFetch; Date.now = originalNow; dom.window.close(); if (dir) { assert.ok(dir.startsWith(resolve('node_modules/.cache/collection-'))); await rm(dir, { recursive: true }) } })

test('flag and ready policy alone never collect before explicit purpose choice or after refusal', async () => {
  assert.equal(api.isDecisionCollectionEnabled(), false)
  assert.equal(await api.createDecisionSearchRun(input()), null)
  assert.equal(await api.setCollectionPurposes([]), true)
  assert.equal(await api.recordProductConsideration('old', 'candidate', 'detail_open'), false)
  assert.equal(calls.length, 0)
})
test('each or both purposes get distinct server-bound receipt and exact no-free-text event bodies', async () => {
  for (const choices of [['service_improvement'], ['data_product_research'], ['service_improvement', 'data_product_research']]) {
    assert.equal(await api.setCollectionPurposes(choices), true)
    const permission = api.activeCollectionPermission()
    assert.deepEqual([...permission.purposes].sort(), [...choices].sort())
    const run = await api.createDecisionSearchRun({ ...input(), query: 'PRIVATE_QUERY', memo: 'PRIVATE_NOTE' })
    const sent = calls.findLast(x => x.body?.kind === 'search_run')
    assert.match(sent.url, /\/decision-collection\/events$/)
    assert.deepEqual(Object.keys(sent.body).sort(), ['capability', 'permission_id', 'kind', 'event'].sort())
    assert.equal(sent.body.permission_id, permission.permissionId)
    assert.equal(sent.body.event.session_id, undefined)
    assert.equal(sent.body.event.contract_version, undefined)
    assert.equal(await api.createDecisionSearchRun({ ...input(), runOrigin: 'restored' }), run)
    assert.doesNotMatch(JSON.stringify(calls), /PRIVATE_QUERY|PRIVATE_NOTE/)
    assert.ok(calls.every(x => !x.url.includes(permission.capability)))
    await api.stopAndDeleteCollection()
  }
})
test('changing purposes deletes former shared records first; local notes/candidates survive and old run cannot reconnect', async () => {
  await api.setCollectionPurposes(['service_improvement'])
  const old = await api.createDecisionSearchRun(input()), previous = api.activeCollectionPermission().permissionId
  const context = { selectionKey: 'selected', current: { productId: 'current', brand: '브랜드', name: '현재' }, variantId: 'sku1', variantLabel: '1 kg', criteria: [criterion], labels: ['다른 브랜드'] }
  api.writeJourneyRecords({ memo: 'PRIVATE_NOTE', context, retained: [{ id: 'local', revision: 1, active: true,
    candidate: { productId: 'candidate', brand: '후보', name: '후보 사료' }, context, note: '내 메모', createdAt: '2026-10-25',
    searchRunId: old, intakeRevision: 1, pendingIntake: { pending: null, following: [] } }], outcome: null })
  calls = []
  assert.equal(await api.setCollectionPurposes(['data_product_research']), true)
  assert.deepEqual(calls.map(x => x.url.split('/').at(-1)), ['delete', 'permissions'])
  assert.notEqual(api.activeCollectionPermission().permissionId, previous)
  assert.equal(api.readJourneyRecords().memo, 'PRIVATE_NOTE')
  assert.equal(api.readJourneyRecords().retained[0].note, '내 메모')
  assert.equal(api.readJourneyRecords().retained[0].searchRunId, null)
  assert.equal(api.readJourneyRecords().retained[0].pendingIntake, undefined)
  const count = calls.length
  assert.equal(await api.recordProductConsideration(old, 'candidate', 'detail_open'), false)
  assert.equal(calls.length, count)
  assert.equal(calls.some(x => x.body?.kind === 'search_run'), false, 'no backfill on purpose change by the transport')
})
test('lost registration acknowledgement preserves capability and deletes without a receipt id', async () => {
  globalThis.fetch = async (url, init) => { const result = await defaultFetch(url, init); if (url.endsWith('/permissions')) throw Error('ack lost'); return result }
  assert.equal(await api.setCollectionPurposes(['service_improvement']), false)
  assert.equal(api.activeCollectionPermission(), null)
  const token = api.readCollectionState().permission.capability
  assert.equal(receipts.has(token), true)
  assert.equal(await api.stopAndDeleteCollection(), true)
  assert.deepEqual(calls.at(-1).body, { permission_id: null, capability: token })
  assert.equal(api.readCollectionState().permission, null)
  assert.equal(receipts.has(token), false)
})
test('stop during pending registration aborts and ignores its late acknowledgement', async () => {
  let finish
  globalThis.fetch = (url, init) => url.endsWith('/permissions') ? new Promise(resolve => { finish = async () => resolve(await defaultFetch(url, init)) }) : defaultFetch(url, init)
  const pending = api.setCollectionPurposes(['service_improvement'])
  await Promise.resolve()
  assert.equal(await api.stopAndDeleteCollection(), true)
  await finish()
  assert.equal(await pending, false)
  assert.equal(api.readCollectionState().permission, null)
  assert.equal(api.isDecisionCollectionEnabled(), false)
  assert.equal(await api.createDecisionSearchRun(input()), null)
})
test('stop invalidates pending event and prevents automatic retry; late response cannot restore a run', async () => {
  await api.setCollectionPurposes(['service_improvement'])
  let finish, signal
  globalThis.fetch = (url, init) => {
    if (url.endsWith('/events')) { signal = init.signal; return new Promise(resolve => { finish = () => resolve(Response.json({ status: 'created', search_run_id: JSON.parse(init.body).event.client_run_id })) }) }
    return defaultFetch(url, init)
  }
  const pending = api.createDecisionSearchRun(input())
  await Promise.resolve(); await api.stopAndDeleteCollection()
  assert.equal(signal.aborted, true)
  finish(); assert.equal(await pending, null)
  assert.equal(sessionStorage.getItem('catfood.decision-runs.v3'), null)
})
test('failed deletion stops future events, retains capability for manual retry, and never claims deletion success', async () => {
  await api.setCollectionPurposes(['service_improvement']); await api.createDecisionSearchRun(input())
  const token = api.readCollectionState().permission.capability
  globalThis.fetch = async (url, init) => url.endsWith('/delete') ? new Response('', { status: 503 }) : defaultFetch(url, init)
  assert.equal(await api.stopAndDeleteCollection(), false)
  assert.equal(api.readCollectionState().status, 'stopped')
  assert.equal(api.readCollectionState().permission.capability, token)
  assert.match(api.readCollectionState().message, /삭제를 확인하지 못/)
  assert.equal(await api.createDecisionSearchRun(input()), null)
  globalThis.fetch = defaultFetch
  assert.equal(await api.stopAndDeleteCollection(), true)
})
test('storage refusal before signup emits zero registration; refusal after ack never starts collection', async () => {
  const storage = globalThis.sessionStorage
  try {
    globalThis.sessionStorage = { getItem() { return null }, setItem() { throw Error('blocked') }, removeItem() {} }
    assert.equal(await api.setCollectionPurposes(['service_improvement']), false)
    assert.equal(calls.length, 0)
    globalThis.sessionStorage = storage
    let writes = 0
    globalThis.sessionStorage = { getItem: k => storage.getItem(k), removeItem: k => storage.removeItem(k), setItem(k, v) { if (k === 'catfood.collection-permission.v1' && ++writes > 1) throw Error('blocked after ack'); storage.setItem(k, v) } }
    assert.equal(await api.setCollectionPurposes(['service_improvement']), false)
    assert.equal(api.activeCollectionPermission(), null)
    assert.ok(api.readCollectionState().permission, 'same-page deletion authority retained')
  } finally { globalThis.sessionStorage = storage }
})
test('expiry stops rather than silently renewing permission or collecting old actions', async () => {
  await api.setCollectionPurposes(['service_improvement']); const run = await api.createDecisionSearchRun(input())
  const count = calls.length; Date.now = () => originalNow() + 25 * 3600000
  api.expireCollectionPermission()
  assert.equal(await api.createDecisionSearchRun({ ...input(), runOrigin: 'restored' }), null)
  assert.equal(await api.recordProductConsideration(run, 'candidate', 'detail_open'), false)
  assert.equal(calls.length, count)
  assert.ok(api.readCollectionState().permission, 'expired permission remains manageable')
})
test('same-permission transient retry and lost acknowledgement retain operation identity; quota never auto-retries', async () => {
  await api.setCollectionPurposes(['service_improvement']); const run = await api.createDecisionSearchRun(input())
  const decision = { recordId: crypto.randomUUID(), revision: 1, previousRevision: 0, searchRunId: run, kind: 'candidate_retained', productId: 'candidate' }
  let failures = 1
  globalThis.fetch = async (url, init) => { if (failures-- > 0) { calls.push({ url, body: JSON.parse(init.body) }); return new Response('', { status: 503 }) } return defaultFetch(url, init) }
  assert.equal(await api.recordExplicitDecision(decision), true)
  assert.deepEqual(calls.at(-1).body, calls.at(-2).body)
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); throw Error('ack lost') }
  assert.equal(await api.recordExplicitDecision(decision), false)
  const lost = calls.at(-1).body
  globalThis.fetch = defaultFetch
  assert.equal(await api.recordExplicitDecision(decision), true)
  assert.deepEqual(calls.at(-1).body, lost)
  let quota = 0
  globalThis.fetch = async () => { quota++; return Response.json({ code: 'request_limit' }, { status: 429 }) }
  assert.equal(await api.recordExplicitDecision({ ...decision, recordId: crypto.randomUUID() }), false)
  assert.equal(quota, 1)
})
test('off build makes no policy/event request but can manage an existing same-tab permission', async () => {
  await api.setCollectionPurposes(['service_improvement']); off = await bundle(false); calls = []
  await off.loadCollectionPolicy(); assert.equal(await off.createDecisionSearchRun(input()), null)
  assert.equal(calls.length, 0)
  assert.equal(await off.stopAndDeleteCollection(), true)
  assert.deepEqual(calls.map(x => x.url.split('/').at(-1)), ['delete'])
})
test('settings start unchecked, separate the two purposes, and keep rejection usable', async () => {
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(createElement(api.CollectionPreferences)))
    const entry = [...document.querySelectorAll('button')].find(x => x.textContent === '기록 공유 설정')
    await act(async () => entry.click())
    assert.equal(document.querySelectorAll('input[type="checkbox"]:checked').length, 0)
    assert.match(document.querySelector('dialog').textContent, /외부 제공·판매는 포함하지 않습니다/)
    const close = [...document.querySelectorAll('button')].find(x => x.textContent === '공유하지 않고 닫기')
    const start = [...document.querySelectorAll('button')].find(x => x.textContent === '선택한 용도로 공유 시작')
    assert.equal(start.disabled, true)
    const count = calls.length
    await act(async () => close.click())
    assert.equal(document.querySelector('dialog'), null)
    assert.equal(calls.length, count)
  } finally { await act(async () => root.unmount()) }
})
