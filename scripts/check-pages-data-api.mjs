import assert from 'node:assert/strict'

const { VITE_SUPABASE_URL: baseUrl, VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey } = process.env
assert.ok(baseUrl, 'Set VITE_SUPABASE_URL to the Pages deployment API URL')
assert.ok(publishableKey?.startsWith('sb_publishable_'), 'Use the Pages deployment publishable key')

const catalog = 'effective_product_catalog_summary'

async function read(profile, relation, select) {
  const url = new URL(`/rest/v1/${relation}`, baseUrl)
  url.search = new URLSearchParams({ select, limit: '1' })
  return fetch(url, {
    headers: { apikey: publishableKey, 'Accept-Profile': profile },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
}

const catalogResponse = await read('api', catalog, 'product_id')
assert.equal(catalogResponse.status, 200, 'The public catalog must return HTTP 200')
const products = await catalogResponse.json()
assert.ok(Array.isArray(products) && products.length === 1 && typeof products[0]?.product_id === 'string' && products[0].product_id,
  'The public catalog must return a product')
console.log('Public catalog returned a product')

async function checkRejected(profile, relation, expectedStatus, expectedCode) {
  const response = await read(profile, relation, 'product_id')
  if (response.status !== expectedStatus) await response.body?.cancel()
  assert.equal(response.status, expectedStatus, `${profile}.${relation} did not return the expected rejection`)
  const { code } = await response.json()
  assert.equal(code, expectedCode, `${profile}.${relation} did not return the expected rejection code`)
  console.log(`${profile}.${relation} rejected anonymous access`)
}

await checkRejected('public', 'products', 406, 'PGRST106')
// Schema rejection is checked before relation lookup, so the catalog name can
// probe other schemas without recording internal relation names in this repo.
await checkRejected('private', catalog, 406, 'PGRST106')
await checkRejected('graphql_public', catalog, 406, 'PGRST106')
await checkRejected('api', 'products', 404, 'PGRST205')
