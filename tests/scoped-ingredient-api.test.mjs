import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

let api, temp
const nativeFetch = globalThis.fetch
before(async () => {
  await mkdir('node_modules/.cache', { recursive: true })
  temp = await mkdtemp(resolve('node_modules/.cache/scoped-api-'))
  const result = await build({ configFile: false, logLevel: 'silent',
    define: { 'import.meta.env.VITE_SUPABASE_URL': '"https://api.test"', 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"test-public-key"' },
    build: { ssr: 'src/api.ts', write: false, minify: false },
  })
  const file = resolve(temp, 'api.mjs')
  await writeFile(file, result.output.find((item) => item.type === 'chunk' && item.isEntry).code)
  api = await import(pathToFileURL(file).href)
})
after(async () => { globalThis.fetch = nativeFetch; if (temp) await rm(temp, { recursive: true }) })

test('empty ingredient selection does not make a request', async () => {
  globalThis.fetch = () => { throw new Error('unexpected request') }
  assert.deepEqual(await api.fetchCompareIngredients([]), [])
})

test('ingredient GET scopes one, two and five products and preserves source fields', async () => {
  for (const size of [1, 2, 5]) {
    const ids = Array.from({ length: size }, (_, i) => `product_${i}`)
    const controller = new AbortController()
    globalThis.fetch = async (input, init) => {
      const url = new URL(input)
      assert.equal(url.pathname, '/rest/v1/rpc/compare_product_ingredients_scoped')
      assert.equal(init.method ?? 'GET', 'GET')
      assert.equal(init.body, undefined)
      assert.equal(init.signal, controller.signal)
      assert.equal(init.headers['Accept-Profile'], 'api')
      assert.equal(init.headers.apikey, 'test-public-key')
      assert.equal(url.searchParams.has('product_id'), false)
      assert.deepEqual(JSON.parse(`[${url.searchParams.get('p_product_ids').slice(1, -1)}]`), ids)
      assert.equal(url.searchParams.get('select').split(',').length, 17)
      assert.equal(url.searchParams.get('limit'), '5')
      return Response.json(ids.map((id) => ({ product_id: id, ingredient_names: ['duck meal'], supplemental_full_ingredient_names: null, raw_text: 'Duck meal', observation_scope: 'formula', completeness_status: 'partial', ingredient_count: 1 })))
    }
    const rows = await api.fetchCompareIngredients(ids, controller.signal)
    assert.deepEqual(rows.map((row) => row.product_id), ids)
    assert.equal(rows[0].raw_text, 'Duck meal')
    assert.equal(rows[0].observation_scope, 'formula')
    assert.equal(rows[0].completeness_status, 'partial')
    assert.deepEqual(rows[0].supplemental_full_ingredient_names, [])
  }
})

test('ingredient IDs are quoted as array elements, not query syntax', async () => {
  const ids = ['product_a,b', 'product_"quoted"', 'product_back\\slash']
  globalThis.fetch = async (input) => {
    const value = new URL(input).searchParams.get('p_product_ids')
    assert.deepEqual(JSON.parse(`[${value.slice(1, -1)}]`), ids)
    return Response.json([])
  }
  await api.fetchCompareIngredients(ids)
})

test('ingredient errors stay errors and retry is a new explicit call', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return calls === 1 ? Response.json({ code: '57014' }, { status: 500 }) : Response.json([])
  }
  await assert.rejects(api.fetchCompareIngredients(['product_a']), /Data API 500/)
  assert.equal(calls, 1, 'no automatic retry or old-view fallback')
  assert.deepEqual(await api.fetchCompareIngredients(['product_a']), [])
  assert.equal(calls, 2)
})

test('ingredient request cancellation is propagated', async () => {
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async (_, init) => {
    assert.equal(init.signal, controller.signal)
    throw new DOMException('Aborted', 'AbortError')
  }
  await assert.rejects(api.fetchCompareIngredients(['product_a'], controller.signal), { name: 'AbortError' })
})
