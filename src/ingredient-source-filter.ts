import type { ListIngredientSource } from './api'
import { ingredientDisclosureReading, ingredientSourceScope } from './ingredient-disclosure'

export const SOURCE_FILTERS = [
  ['all', '모두 보기'],
  ['full', '전체 목록이 있는 자료'],
  ['partial', '일부 목록·전체 여부 미확인'],
  ['missing', '원료표 미확인'],
  ['wording', '세부 종류를 더 확인할 표기'],
  ['scope', '한국 제품에 적용 여부 미확인'],
] as const
export type IngredientSourceFilter = 'off' | typeof SOURCE_FILTERS[number][0]
export function parseSourceFilter(value: unknown): IngredientSourceFilter {
  return SOURCE_FILTERS.some(([key]) => key === value) ? value as IngredientSourceFilter : 'off'
}
export function sourceFilterLabel(filter: IngredientSourceFilter) {
  return SOURCE_FILTERS.find(([key]) => key === filter)?.[1] ?? ''
}
// These predicates describe the selected source. They never certify ingredient absence,
// disclosure of every sub-ingredient, manufacturer quality, or Korean applicability.
export function matchesSourceFilter(row: ListIngredientSource | undefined, filter: IngredientSourceFilter) {
  const hasText = Boolean(row?.raw_text?.trim())
  if (filter === 'off' || filter === 'all') return true
  if (filter === 'missing') return !hasText
  if (filter === 'full') return hasText && row?.completeness_status === 'full'
  if (filter === 'partial') return hasText && row?.completeness_status !== 'full'
  if (filter === 'wording') return hasText && ingredientDisclosureReading(row).details.length > 0
  return hasText && ingredientSourceScope(row).needsCheck
}
