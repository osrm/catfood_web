import type { CatalogProduct, CompareNutrition } from './api'
import type { CompareItem } from './CompareView'
import { usableEnergy } from './energy-refine'
import './comparison-highlights.css'

export type HighlightFact = { key: string; label: string; value: string; known: boolean; priority?: boolean }

export function differentFacts(baseline: HighlightFact[], candidate: HighlightFact[]) {
  return candidate.flatMap(fact => {
    const before = baseline.find(value => value.key === fact.key)
    if (!before || !before.known && !fact.known || before.known && fact.known && before.value === fact.value) return []
    return [{ ...fact, priority: fact.priority || before.priority, before: before.value, bothKnown: before.known && fact.known }]
  }).sort((a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority)))
}

// A numeric contrast follows the energy field's own market and formula source.
export function highlightEnergy(row?: CompareNutrition | null) {
  if (!row) return null
  const supplemental = row.supplemental_nutrition_fields?.includes('energy')
  const market = supplemental ? row.supplemental_market_code : row.market_code
  const matched = supplemental ? row.supplemental_is_current_resolved_formula : row.is_current_resolved_formula
  return market !== 'KR' && !matched ? null : usableEnergy(row)
}

function CompactList({ values }: { values: string[] }) {
  if (!values.length) return null
  return <><ul>{values.slice(0, 3).map(value => <li key={value}>{value}</li>)}</ul>{values.length > 3 ? <details><summary>나머지 {values.length - 3}개 보기</summary><ul>{values.slice(3).map(value => <li key={value}>{value}</li>)}</ul></details> : null}</>
}

function ingredientLines(item: CompareItem) {
  return [
    ...(item.ingredientConflicts ?? []).map(value => `피하려는 원료 확인 · ${value}`),
    ...(item.ingredientReasons ?? [
      ...(item.ingredientInsufficient ?? []).map(value => `${value} · 미확인 — 확인 자료 부족`),
      ...(item.ingredientReviewedNotFound ?? []).map(value => `${value} · 미확인 — 확인 자료에 표기 없음 (원료가 없다는 보장 아님)`),
    ]),
  ]
}

function conditionLines(item: CompareItem) {
  return [...new Set([
    ...ingredientLines(item),
    ...(item.unknowns ?? []).map(value => `조건 미확인 · ${value}`),
    ...(item.changeMatches ?? []).map(value => `바꿀 조건 확인 · ${value}`),
    ...(item.keepMatches ?? []).map(value => `유지할 조건 확인 · ${value}`),
    ...(item.confirmedMatches ?? []).map(value => `선택 조건 확인 · ${value}`),
    ...(item.conditionDifferences ?? []).map(value => `선택 조건과 표기 다름 · ${value}`),
  ])]
}

export default function ComparisonHighlights({ items, baseline, facts, criteriaLabels, onDetail, onRemove }: {
  items: CompareItem[]; baseline?: CatalogProduct; facts: (product: CatalogProduct) => HighlightFact[]; criteriaLabels: string[]
  onDetail?: (id: string) => void; onRemove?: (id: string) => void
}) {
  const reference = baseline ?? items[0]?.product
  const compared = baseline ? items : items.slice(1)
  if (!reference || !compared.length) return null
  const before = facts(reference)
  const referenceIngredients = baseline ? [] : ingredientLines(items[0])
  const commonConditions = conditionLines(items[0]).filter(value => /조건 확인 ·/.test(value) && items.every(item => conditionLines(item).includes(value)))
  const commonFacts = before.filter(fact => fact.known && compared.every(item => facts(item.product).some(value => value.key === fact.key && value.known && value.value === fact.value)))
  return <section className="comparison-highlights" aria-label="핵심 차이 먼저 보기">
    <header><h2>핵심 차이 먼저 보기</h2><p>{baseline ? '현재 사료' : '비교 기준'} · {reference.brand} {reference.canonical_name}</p>
      <CompactList values={referenceIngredients} />
      <div className="highlight-product-actions">{onDetail ? <button type="button" onClick={() => onDetail(reference.product_id)}>기준 제품 상세 보기</button> : null}{!baseline && onRemove ? <button type="button" onClick={() => onRemove(reference.product_id)}>기준 제품 비교에서 제거</button> : null}</div>
    </header>
    {criteriaLabels.length ? <p className="highlight-priorities">내가 고른 조건 · {criteriaLabels.join(' · ')}</p> : null}
    {commonConditions.length ? <p className="highlight-common">{baseline ? '후보 모두에서 확인' : '제품 모두에서 확인'} · {commonConditions.join(' / ')}</p> : null}
    {commonFacts.length ? <details className="highlight-common"><summary>함께 확인된 제품 표기 {commonFacts.length}개</summary><p>{commonFacts.map(fact => `${fact.label} · ${fact.value}`).join(' / ')}</p></details> : null}
    <div className="highlight-cards">{compared.map(item => {
      const differences = differentFacts(before, facts(item.product))
      const conditions = conditionLines(item).filter(value => !commonConditions.includes(value))
      return <article key={item.product.product_id} data-product-id={item.product.product_id}>
        {item.product.display_image_url ? <img className="highlight-product-image" src={item.product.display_image_url} alt="" /> : null}
        <h3><span>{item.product.brand}</span>{item.product.canonical_name}</h3>
        {conditions.length ? <div className="highlight-conditions"><CompactList values={conditions} /></div> : null}
        <CompactList values={differences.map(fact => `${fact.label}${fact.bothKnown ? '' : ' · 자료 확인 차이'}: ${fact.before} → ${fact.value}`)} />
        {!differences.length ? <p>확인된 기본 표기에서 기준 제품과의 차이를 찾지 못했습니다.</p> : null}
        <div className="highlight-product-actions">{onDetail ? <button type="button" onClick={() => onDetail(item.product.product_id)}>상세 보기</button> : null}{onRemove ? <button type="button" onClick={() => onRemove(item.product.product_id)}>비교에서 제거</button> : null}</div>
      </article>
    })}</div>
  </section>
}
