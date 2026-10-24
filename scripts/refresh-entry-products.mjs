import fs from 'node:fs/promises'
import { loadEnv } from 'vite'

// Only already-public catalog identity fields are retained. This is an explicit
// maintenance command; builds never depend on a live API request.
const entries = [
  ['aatu-salmon', 'product_d99406c26240b263'],
  ['go-lid-duck', 'product_a0e685be674c6617'],
  ['natural-balance-indoor', 'product_b47d3ae674773585'],
]
const env = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env }
const endpoint = new URL('/rest/v1/effective_product_catalog_summary', env.VITE_SUPABASE_URL)
endpoint.searchParams.set('select', 'product_id,brand,canonical_name,feed_type,life_stage,display_image_url')
endpoint.searchParams.set('product_id', `in.(${entries.map(([, id]) => id).join(',')})`)
endpoint.searchParams.set('limit', '3')
const response = await fetch(endpoint, { headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Accept-Profile': 'api' } })
if (!response.ok) throw new Error(`Public identity read failed: ${response.status}`)
const rows = await response.json()
const products = entries.map(([slug, id]) => {
  const row = rows.find(item => item.product_id === id)
  if (!row || !row.brand || !row.canonical_name) throw new Error(`Missing published product: ${id}`)
  const image = row.display_image_url ? new URL(row.display_image_url) : null
  if (image && (!['http:', 'https:'].includes(image.protocol) || image.username || image.password)) throw new Error('Invalid public image URL')
  return { slug, productId: id, brand: row.brand, name: row.canonical_name, feedType: row.feed_type, lifeStage: row.life_stage, image: image?.href ?? null }
})
await fs.mkdir('data', { recursive: true })
await fs.writeFile('data/entry-products.json', JSON.stringify({ version: 1, retrievedAt: new Date().toISOString(), products }, null, 2) + '\n')
console.log(`Saved ${products.length} published product identities; no private source data.`)
