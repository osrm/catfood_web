import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const compare = await readFile(new URL('../src/CompareView.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/nutrition-reading-clarity.css', import.meta.url), 'utf8')

test('nutrition reading keeps routine evidence folded and interpretation exceptions local', () => {
  assert.match(compare, /label="원래 표기 보기"/)
  assert.match(compare, /원래 열량 표기/)
  assert.match(compare, /현재 판매 제품과 같은 배합인지 미확인/)
  assert.match(compare, /이 값은 \$\{evidenceSize\} 포장에서 확인/)
  assert.match(compare, /nutritionSupplementalFields\(detail\)\.includes\(field\)/)
  assert.doesNotMatch(compare, /<CompareSection title="자료 범위"/)
  assert.doesNotMatch(compare, /<MobileTwoProductSection title="자료 범위"/)
})

test('nutrition comparison keeps additional nutrients and sticky full identity hooks', () => {
  assert.match(compare, /additionalNutrientKeys\.map/)
  assert.match(compare, /switchAdditionalNutrientKeys\.map/)
  assert.match(compare, /compare-mobile-two-product-key-brand/)
  assert.match(css, /position: sticky/)
  assert.match(css, /compare-product-copy > strong/)
})
