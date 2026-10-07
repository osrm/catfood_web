import type { CompareNutrition } from './api'

export type NutritionField = 'energy' | 'protein' | 'fat' | 'fiber' | 'moisture' | 'ash' | 'additional_nutrients'

// A supplemental field follows its own source, not the representative panel's scope.
export function nutritionInterpretationNote(detail: CompareNutrition | null | undefined, field: NutritionField) {
  if (!detail) return null
  const supplemental = detail.supplemental_nutrition_fields?.includes(field)
  const scope = supplemental ? detail.supplemental_observation_scope : detail.observation_scope
  const currentFormula = supplemental ? detail.supplemental_is_current_resolved_formula : detail.is_current_resolved_formula
  return scope === 'formula' && !currentFormula ? '현재 판매 제품과 같은 배합인지 미확인' : null
}
