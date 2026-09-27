import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const api = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const detail = fs.readFileSync(new URL('../src/ProductDetail.tsx', import.meta.url), 'utf8')
const compare = fs.readFileSync(new URL('../src/CompareView.tsx', import.meta.url), 'utf8')
const switchFlow = fs.readFileSync(new URL('../src/SwitchFlow.tsx', import.meta.url), 'utf8')

test('manufacturing package scope stays explicit through API and detail UI', () => {
  assert.match(api, /product_detail_manufacturing_scope/)
  assert.match(api, /variant_id/)
  assert.match(detail, /variant\.variant_id === variantId/)
  assert.match(detail, /확인되지 않은 규격에는 적용하지 않습니다/)
  assert.match(detail, /variantSizeLabel\(variant\).*countries\.map\(countryLabel\)/s)
})

test('catalog consumers disclose variant-limited manufacturing summaries', () => {
  assert.match(api, /manufacturing_has_variant_scope/)
  assert.match(compare, /manufacturing_has_variant_scope[\s\S]*일부 포장 기준/)
  assert.match(switchFlow, /manufacturing_has_variant_scope[\s\S]*일부 포장 기준/)
})
