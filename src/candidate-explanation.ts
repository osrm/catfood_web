import type { CatalogProduct, ExploreEnergy, ListIngredientSource } from './api'
import { ingredientAvoidanceWording, ingredientDisclosureReading, ingredientSourceScope, ingredientWordingExamples } from './ingredient-disclosure'
import { energyText, usableEnergy } from './energy-refine'

export type CandidateExplanation = { kept: string[]; differences: string[]; unknowns: string[]; references: string[] }
type Condition = { source: 'keep' | 'change'; kind: string; value: string; label: string }
type Status = 'loading' | 'loaded' | 'error'
const age: Record<string, string> = { adult: '성묘', kitten: '키튼', senior: '시니어', all_life_stages: '전연령', gestation_lactation_and_kitten: '임신·수유·키튼' }
const unique = (values: string[]) => [...new Set(values)].slice(0, 64).map(value => value.slice(0, 600))

// Describes selected facts and evidence gaps. Never parses personal reasons, scores
// candidates or converts an absent tag / reviewed-not-found result into absence.
export function candidateExplanation({ current, candidate, conditions, focus, beforeSource, afterSource, sourceStatus, currentVariantId, beforeEnergy, afterEnergy, energyStatus }: {
  current: CatalogProduct; candidate: CatalogProduct; conditions: Condition[]
  focus?: string | null; beforeSource?: ListIngredientSource; afterSource?: ListIngredientSource; sourceStatus: Status
  currentVariantId?: string | null; beforeEnergy?: ExploreEnergy; afterEnergy?: ExploreEnergy; energyStatus?: string
}): CandidateExplanation {
  const kept: string[] = [], differences: string[] = [], unknowns: string[] = [], references: string[] = []
  const ingredientDifferences: string[] = [], ingredientUnknowns: string[] = []
  const sourceFocus = focus === 'disclosure' || focus === 'ingredients'
  if (sourceFocus) {
    if (sourceStatus !== 'loaded') unknowns.push(sourceStatus === 'error' ? '원료표 자료를 불러오지 못해 현재 사료와의 표기 차이는 미확인입니다.' : '현재 사료와 후보의 원료표 자료를 확인 중입니다.')
    else {
      const description = (row?: ListIngredientSource) => [ingredientDisclosureReading(row).listLabel, ...ingredientWordingExamples(row).slice(0, 1).map(text => text.length > 150 ? text.slice(0, 147) + '…' : text)].join(' · ')
      const before = description(beforeSource), after = description(afterSource)
      if (before !== after) differences.push(`확인한 원료표 — 현재: ${before} → 후보: ${after}`)
      const scopeChecks = ([['현재', beforeSource], ['후보', afterSource]] as const).flatMap(([label, row]) => {
        if (!row?.raw_text?.trim()) return []
        const notes = []
        if (ingredientSourceScope(row).needsCheck) notes.push(`${label} 자료의 한국 판매 제품 적용 여부 미확인`)
        if (row.observation_scope === 'variant' && (label === '후보' || !row.variant_id || row.variant_id !== currentVariantId)) notes.push(label === '현재' ? '현재 자료와 선택한 사용 규격의 일치 여부 미확인' : '후보 자료는 특정 포장 기준이며 모든 판매 규격에 동일한지 미확인')
        return notes
      })
      if (scopeChecks.length) unknowns.push(`자료 적용 범위 · ${scopeChecks.join(' / ')}`)
      if (before === after) unknowns.push('원료표 요약은 같지만, 전체 원료 구성까지 같은지는 원문 비교가 필요합니다.')
      for (const [label, row] of [['현재', beforeSource], ['후보', afterSource]] as const) {
        const reading = ingredientDisclosureReading(row)
        if (!row?.raw_text?.trim()) unknowns.push(`${label}: 원료표 자료가 없어 세부 원료를 확인하기 어렵습니다.`)
        else {
          if (row.completeness_status !== 'full') unknowns.push(`${label}: 전체 원료 목록을 확인하지 못했습니다.`)
          if (reading.details.length) unknowns.push(`${label}: ${reading.details.slice(0, 2).map(item => `${item.phrase} — ${item.note}`).join(' / ')}`)
          references.push(`${label} 원료표 · ${description(row)} · ${ingredientSourceScope(row).label}`)
          if (label === '현재' && row.observation_scope === 'variant' && row.variant_id && row.variant_id === currentVariantId) references.push('현재 원료표는 선택한 사용 규격에서 확인한 자료입니다. 다른 포장에도 동일하다는 뜻은 아닙니다.')
        }
      }
      unknowns.push('원료 표기의 구체성만으로 적합성이나 먹는 반응을 판단할 수 없습니다.')
    }
  }
  for (const condition of conditions) {
    const { kind, value, label, source } = condition
    if (kind === 'ingredientAvoid') {
      const wording = ingredientAvoidanceWording(candidate, value, afterSource)
      const unresolved = wording.state === 'unknown' || Boolean(wording.sourcePhrase)
      if (unresolved) ingredientUnknowns.push(`${label} 포함 여부 · ${wording.summary}`)
      else {
        const contrast = wording.state === 'reviewed-not-found' && current.confirmed_present_ingredient_terms?.includes(value) ? '현재 자료에서 확인 → ' : ''
        ingredientDifferences.push([`${label} 포함 여부 · ${contrast}${wording.summary}`, wording.detail].filter(Boolean).join(' · '))
      }
      continue
    }
    const field = kind === 'brand' ? 'brand' : kind === 'feedType' ? 'feed_type' : kind === 'lifeStage' ? 'life_stage' : null
    if (field) {
      const before = current[field], after = candidate[field]
      const display = (v: string) => field === 'life_stage' ? age[v] ?? v : v
      const title = field === 'brand' ? '브랜드' : field === 'feed_type' ? '사료 형태' : '연령 표기'
      if (!before || !after) unknowns.push(`${title}: ${!before ? '현재 사료' : '후보'}의 표기 미확인으로 차이를 판단할 수 없습니다.`)
      else if (before === after) kept.push(`${title} · ${display(after)}${source === 'keep' ? ' (유지 조건)' : ' (현재와 같은 표기)'}`)
      else differences.push(`${title} · ${display(before)} → ${display(after)}${source === 'keep' ? ' (함께 보기로 선택한 다른 표기)' : ''}`)
      continue
    }
    const values = (p: CatalogProduct) => kind === 'officialTarget' ? p.official_targets : kind === 'feature' ? p.features : kind === 'recipeFamily' ? p.recipe_families : kind === 'grainFree' ? p.official_recipe_traits : []
    const before = values(current).includes(value), after = values(candidate).includes(value)
    if (before && after) kept.push(`${label} · 두 제품에서 표기 확인${source === 'keep' ? ' (유지 조건)' : ''}`)
    else if (after) unknowns.push(`${label} · 후보 표기는 확인했으나 현재 제품의 같은 표기는 미확인입니다.`)
    else unknowns.push(`${label} · 후보의 표기나 근거를 확인하지 못했습니다.`)
    if (kind === 'feature') unknowns.push('기능 표기는 실제 효과나 우리 고양이에게 맞는다는 보장이 아닙니다.')
  }
  if (focus === 'energy') {
    const before = usableEnergy(beforeEnergy), after = usableEnergy(afterEnergy)
    const marketKnown = (row?: ExploreEnergy) => Boolean(row && (row.supplemental_nutrition_fields?.includes('energy') ? row.supplemental_market_code === 'KR' || row.supplemental_is_current_resolved_formula : row.market_code === 'KR' || row.is_current_resolved_formula))
    if (energyStatus !== 'loaded') unknowns.push(energyStatus === 'error' ? '열량 자료 조회 실패로 현재 사료와의 차이는 미확인입니다.' : '표기 열량을 확인 중입니다.')
    else if (!['건식', '습식', '동결건조'].includes(current.feed_type ?? '') || current.feed_type !== candidate.feed_type) unknowns.push('사료 형태가 다르거나 미확인이므로 열량 수치를 직접 비교하지 않았습니다.')
    else if (before == null || after == null || !marketKnown(beforeEnergy) || !marketKnown(afterEnergy)) unknowns.push('현재 사료 또는 후보의 열량·자료 적용 범위 미확인으로 차이를 판단할 수 없습니다.')
    else {
      const line = `표기 열량 · ${energyText(before)} → ${energyText(after)}`
      if (before === after) kept.push(line)
      else differences.push(line)
      for (const [label, row] of [['현재', beforeEnergy], ['후보', afterEnergy]] as const) {
        const supplemental = row?.supplemental_nutrition_fields?.includes('energy')
        const scope = supplemental ? row?.supplemental_observation_scope : row?.observation_scope
        const market = supplemental ? row?.supplemental_market_code : row?.market_code
        references.push(`${label} 열량 · ${market === 'KR' ? '한국' : market ?? '국가 미확인'} 자료 · ${scope === 'variant' ? '특정 포장 기준' : scope === 'formula' ? '동일 배합 확인 자료' : '제품 자료'}`)
        if (scope === 'variant' && (label === '후보' || supplemental || !row?.variant_id || row.variant_id !== currentVariantId)) unknowns.push(label === '현재' ? '현재 열량 열량 확인 포장과 선택한 사용 규격의 일치 여부는 미확인입니다.' : '후보 열량은 특정 포장 기준입니다. 모든 판매 규격의 같은 값인지는 미확인입니다.')
      }
    }
    unknowns.push('표기 열량만으로 급여량이나 체중 변화·적합성을 판단할 수 없습니다.')
  }
  // Answer the explicit avoidance criterion before general source/basic facts.
  // Compact cards show bounded lines, so this also keeps the absence caveat visible.
  return { kept: unique(kept), differences: unique([...ingredientDifferences, ...differences]), unknowns: unique([...ingredientUnknowns, ...unknowns]), references: unique(references) }
}

export function validCandidateExplanation(value: unknown): value is CandidateExplanation {
  if (!value || typeof value !== 'object') return false
  return ['kept', 'differences', 'unknowns', 'references'].every(key => {
    const rows = (value as Record<string, unknown>)[key]
    return Array.isArray(rows) && rows.length <= 64 && rows.every(row => typeof row === 'string' && row.trim().length > 0 && row.length <= 600)
  })
}
