import { useEffect, useState } from 'react'
import type { ExploreEnergy } from './api'
import type { SearchState, RefineState } from './search'
import { nutritionInterpretationNote } from './nutrition-reading'

export function canRefineEnergy(search: SearchState) {
  return search.feedType.length === 1 && ['건식', '습식', '동결건조'].includes(search.feedType[0]) && search.features.includes('weight_management')
}
export function parseEnergyMax(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim()))) return undefined
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 && amount <= Number.MAX_SAFE_INTEGER ? amount : undefined
}
export function energyBound(search: SearchState, refine: RefineState) {
  return canRefineEnergy(search) ? parseEnergyMax(refine.energyMax) : undefined
}
export function energyAmount(row: ExploreEnergy | undefined) {
  const amount = row?.kcal_per_kg != null ? row.kcal_per_kg / 10 : row?.kcal_per_100g
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : null
}
export function usableEnergy(row: ExploreEnergy | undefined) {
  const scope = row?.supplemental_nutrition_fields?.includes('energy') ? row.supplemental_observation_scope : row?.observation_scope
  if (!scope || !['variant', 'product', 'formula'].includes(scope) || nutritionInterpretationNote(row, 'energy')) return null
  return energyAmount(row)
}
export const energyText = (value: number) => Number(value.toPrecision(12)).toLocaleString('ko-KR', { maximumFractionDigits: 10 }) + ' kcal/100g'

export function EnergyRefine({ max, status, known, unknown, onOpen, onRetry, onChange }: {
  max?: number; status: 'idle' | 'loading' | 'error' | 'loaded'; known: number; unknown: number
  onOpen: () => void; onRetry: () => void; onChange: (max?: number) => void
}) {
  const [draft, setDraft] = useState(max == null ? '' : String(max))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setDraft(max == null ? '' : String(max)); setInvalid(false) }, [max])
  return <section className="filter-section energy-refine" aria-label="열량으로 좁히기">
    <h3>열량</h3>
    {max != null ? <p className="field-note">선택한 최대 열량 · {energyText(max)} <button className="recipe-list-toggle" type="button" onClick={() => onChange()}>열량 조건 지우기</button></p> : null}
    {status === 'idle' ? <><p className="field-note">같은 사료 형태 안에서 열량을 고릅니다.</p><button className="secondary-action" type="button" onClick={onOpen}>열량으로 좁히기</button></> : null}
    {status === 'loading' ? <p className="field-note" role="status">열량을 불러오는 중입니다.</p> : null}
    {status === 'error' ? <div role="alert"><p className="field-note">열량을 불러오지 못했습니다. 선택한 조건은 유지됩니다.</p><button className="secondary-action" type="button" onClick={onRetry}>열량 다시 불러오기</button></div> : null}
    {status === 'loaded' ? <form onSubmit={(event) => { event.preventDefault(); const value = parseEnergyMax(draft); setInvalid(value == null); if (value != null) onChange(value) }}>
      <p className="field-note">열량 확인 {known}개 · 미확인 {unknown}개</p>
      <label htmlFor="energy-max">최대 열량 (kcal/100g)</label>
      <input className="recipe-search" id="energy-max" type="number" min="0" step="any" inputMode="decimal" value={draft} aria-invalid={invalid} aria-describedby="energy-unknown-note" onChange={event => { setDraft(event.target.value); setInvalid(false) }} />
      {invalid ? <p className="field-note" role="alert">0보다 큰 숫자를 입력해 주세요.</p> : null}
      <button className="secondary-action" type="submit">이 열량 이하로 보기</button>
      <p id="energy-unknown-note" className="field-note">열량이 미확인인 제품도 남습니다.</p>
    </form> : null}
  </section>
}
export function EnergyResult({ row, sameFeed = true }: { row?: ExploreEnergy; sameFeed?: boolean }) {
  const amount = energyAmount(row), usable = sameFeed ? usableEnergy(row) : null
  const supplemental = row?.supplemental_nutrition_fields?.includes('energy')
  const scope = supplemental ? row?.supplemental_observation_scope : row?.observation_scope
  return <div className="explore-energy-result">
    <strong>{usable == null ? '열량 미확인' : energyText(usable)}</strong>
    {amount != null ? <details><summary>원래 열량 표기</summary>
      <p>{row?.kcal_per_kg != null ? row.kcal_per_kg.toLocaleString('ko-KR') + ' kcal/kg' : amount.toLocaleString('ko-KR') + ' kcal/100g'}</p>
      <p>{nutritionInterpretationNote(row, 'energy') ?? (scope === 'variant' ? '확인한 포장 기준' : scope === 'formula' ? '같은 배합으로 확인한 자료' : scope === 'product' ? '제품에 대해 확인한 자료' : '자료 범위 미확인')}</p>
    </details> : null}
  </div>
}

