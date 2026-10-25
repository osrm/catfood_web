import assert from 'node:assert/strict'

// Existing interaction fixtures inspect the event context through their legacy
// route handlers. This adapter first checks the REAL permission envelope, then
// dispatches only its event to those fixture handlers. It is never runtime code.
const receipts = new WeakMap()
export function collectionFixtureFetch(api, handle) {
  let registry = receipts.get(api)
  if (!registry) { registry = new Map(); receipts.set(api, registry) }
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.pathname.includes('/functions/v1/decision-collection/')) return handle(input, init)
    if (url.pathname.endsWith('/policy')) return Response.json({ enabled: true, notice_version: api.COLLECTION_NOTICE_VERSION,
      raw_retention_seconds: 172800, operator_name: 'Fixture operator', contact_url: 'https://catfood.test/contact' })
    const value = JSON.parse(init.body)
    if (url.pathname.endsWith('/delete')) { registry.delete(value.capability); return Response.json({ status: 'deleted', search_runs_deleted: 0 }) }
    if (url.pathname.endsWith('/permissions')) {
      if (!registry.has(value.capability)) registry.set(value.capability, { permission_id: crypto.randomUUID(), session_id: crypto.randomUUID(),
        purposes: [...value.purposes].sort(), notice_version: value.notice_version,
        accept_until: new Date(Date.now() + 86400000).toISOString(), raw_until: new Date(Date.now() + 172800000).toISOString() })
      return Response.json(registry.get(value.capability))
    }
    assert.deepEqual(Object.keys(value).sort(), ['permission_id', 'capability', 'kind', 'event'].sort())
    assert.match(value.capability, /^[a-f\d]{64}$/)
    assert.match(value.permission_id, /^[a-f\d-]{36}$/)
    const routes = { search_run: 'search-runs', consideration: 'considerations', decision: 'decisions' }
    assert.ok(routes[value.kind])
    const virtual = new URL(url); virtual.pathname = virtual.pathname.replace(/events$/, routes[value.kind])
    const response = await handle(virtual.href, { ...init, body: JSON.stringify(value.event) })
    if (!response.ok) return response
    const result = await response.json()
    return Response.json(value.kind === 'search_run' ? { search_run_id: value.event.client_run_id, status: result.status ?? 'created' }
      : value.kind === 'decision' ? { status: result.status ?? 'recorded', record_id: value.event.record_id, revision: value.event.revision }
        : { status: result.status ?? 'recorded' })
  }
}
export async function activateCollectionFixture(api) {
  await api.stopAndDeleteCollection()
  api.clearJourneyRecords()
  await api.loadCollectionPolicy()
  assert.equal(await api.setCollectionPurposes(['service_improvement', 'data_product_research']), true)
}
