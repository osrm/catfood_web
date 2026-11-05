import type { CatalogProduct, CompareIngredients, CompareNutrition, ProductVariant } from './api'
import type { CompareItem } from './CompareView'
import type { CompareTab } from './navigation-state'
import { ingredientDisclosureReading, ingredientSourceScope } from './ingredient-disclosure'
import { splitIngredientText } from './ingredient-composition'
import { energyAmount, energyText, usableEnergy } from './energy-refine'
import { EnergyEvidence, switchEnergyDifference } from './switch-energy'
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

function conditionLines(item: CompareItem) {
  return [...new Set([
    ...(item.ingredientConflicts ?? []).map(value => `피하려는 원료 확인 · ${value}`),
    ...(item.ingredientInsufficient ?? []).map(value => `${value} · 원료 판단 근거 부족`),
    ...(item.unknowns ?? []).map(value => `조건 미확인 · ${value}`),
    ...(item.changeMatches ?? []).map(value => `바꿀 조건 확인 · ${value}`),
    ...(item.keepMatches ?? []).map(value => `유지할 조건 확인 · ${value}`),
    ...(item.confirmedMatches ?? []).map(value => `선택 조건 확인 · ${value}`),
    ...(item.conditionDifferences ?? []).map(value => `선택 조건과 표기 다름 · ${value}`),
    ...(item.ingredientReviewedNotFound ?? []).map(value => `${value} · 검토한 자료에서 찾지 못함`),
  ])]
}

function IngredientHighlight({ row, loading, failed, variants, variantStatus, currentVariantId }: { row?: CompareIngredients | null; loading: boolean; failed: boolean; variants: ProductVariant[]; variantStatus: string; currentVariantId?: string | null }) {
  if (loading || failed) return <p>{loading ? '원료 자료를 불러오는 중입니다.' : '원료 자료 조회 실패 · 아래에서 다시 시도할 수 있습니다.'}</p>
  const reading = ingredientDisclosureReading(row)
  // Quote only this selected source. Supplemental or recipe metadata cannot name an unspecified oil.
  const examples = reading.details.length ? reading.details.map(value => `${value.phrase} — ${value.note}`)
    : splitIngredientText(row?.raw_text ?? '').filter(value => /어유|생선.*오일|fish\s+oil/i.test(value)).slice(0, 2).map(value => /fish\s+oil\s*\(\s*herring\s*\)/i.test(value) ? `${value} — 청어를 명시한 오일` : value)
  const sourceVariant = row?.observation_scope === 'variant' ? variants.find(value => value.variant_id === row.variant_id && value.product_id === row.product_id) : undefined
  return <>
    <p><strong>{reading.listLabel}</strong></p>
    {examples.length ? <CompactList values={examples} /> : <p>{reading.label}</p>}
    <p className="highlight-evidence">자료 범위 · {ingredientSourceScope(row).label}</p>
    {row?.observation_scope === 'variant' ? <p className="highlight-evidence">{sourceVariant?.package_size_text ? `근거 포장 · ${sourceVariant.package_size_text}` : variantStatus === 'loading' ? '근거 포장 용량 확인 중' : variantStatus === 'error' ? '근거 포장 용량 조회 실패' : '근거 포장 용량 미확인'}{currentVariantId && row.variant_id && currentVariantId !== row.variant_id ? ' · 사용 규격과 다른 포장에서 확인' : ''}</p> : null}
    {!reading.details.length && examples.length ? <p className="highlight-evidence">확인한 원료표의 표기 예</p> : null}
  </>
}

export default function ComparisonHighlights({ tab, items, baseline, facts, criteriaLabels, nutrition, ingredients, nutritionLoading, nutritionFailed, ingredientsLoading, ingredientsFailed, variants, variantStatus, currentVariantId }: {
  tab: CompareTab; items: CompareItem[]; baseline?: CatalogProduct; facts: (product: CatalogProduct) => HighlightFact[]; criteriaLabels: string[]
  nutrition: (id: string) => CompareNutrition | null | undefined; ingredients: (id: string) => CompareIngredients | null | undefined
  nutritionLoading: (id: string) => boolean; nutritionFailed: (id: string) => boolean
  ingredientsLoading: (id: string) => boolean; ingredientsFailed: (id: string) => boolean
  variants: (id: string) => ProductVariant[]; variantStatus: (id: string) => string; currentVariantId?: string | null
}) {
  const reference = baseline ?? items[0]?.product
  if (!reference) return null
  const compared = baseline ? items : items.slice(1)
  if (!compared.length) return null
  const before = facts(reference)
  const commonConditions = conditionLines(items[0]).filter(value => /조건 확인 ·/.test(value) && items.every(item => conditionLines(item).includes(value)))
  const commonFacts = before.filter(fact => fact.known && compared.every(item => facts(item.product).some(value => value.key === fact.key && value.known && value.value === fact.value)))
  const referenceRow = nutrition(reference.product_id)
  const beforeAmount = !nutritionLoading(reference.product_id) && !nutritionFailed(reference.product_id) ? highlightEnergy(referenceRow) : null
  const packages = new Map([reference, ...compared.map(item => item.product)].flatMap(product => variants(product.product_id)).map(row => [row.variant_id, row]))
  function energySource(product: CatalogProduct, row?: CompareNutrition | null) {
    return <EnergyEvidence row={row ?? undefined} packages={packages} packageStatus={variantStatus(product.product_id)} currentVariantId={product.product_id === baseline?.product_id ? currentVariantId : undefined} />
  }
  return <section className="comparison-highlights" aria-label="핵심 차이 먼저 보기">
    <header><h2>{tab === 'overview' ? '핵심 차이 먼저 보기' : tab === 'nutrition' ? '표기 열량 차이 먼저 보기' : '원료 표기 차이 먼저 보기'}</h2>
      <p>{baseline ? '현재 사료' : '비교 기준'} · {reference.brand} {reference.canonical_name}</p>
    </header>
    {tab === 'overview' ? <>
      {criteriaLabels.length ? <p className="highlight-priorities">내가 고른 조건 · {criteriaLabels.join(' · ')}</p> : null}
      {commonConditions.length ? <p className="highlight-common">{baseline ? '후보 모두에서 확인' : '제품 모두에서 확인'} · {commonConditions.join(' / ')}</p> : null}
      {commonFacts.length ? <details className="highlight-common"><summary>함께 확인된 제품 표기 {commonFacts.length}개</summary><p>{commonFacts.map(fact => `${fact.label} · ${fact.value}`).join(' / ')}</p></details> : null}
    </> : tab === 'nutrition' ? <div className="highlight-baseline-energy">
      <p>기준 표기값 · <strong>{beforeAmount == null ? '비교 가능한 열량 미확인' : energyText(beforeAmount)}</strong></p>
      {!nutritionLoading(reference.product_id) && !nutritionFailed(reference.product_id) ? energySource(reference, referenceRow) : <p>{nutritionLoading(reference.product_id) ? '기준 자료를 불러오는 중입니다.' : '기준 자료 조회 실패'}</p>}
    </div> : null}
    <div className="highlight-cards">
      {(tab === 'ingredients' ? [{ product: reference }, ...compared] : compared).map(item => {
        const id = item.product.product_id
        const differences = differentFacts(before, facts(item.product))
        const conditions = conditionLines(item).filter(value => !commonConditions.includes(value))
        const row = nutrition(id)
        const ready = !nutritionLoading(id) && !nutritionFailed(id)
        const amount = ready ? highlightEnergy(row) : null
        const delta = beforeAmount != null && amount != null ? switchEnergyDifference(reference, item.product, referenceRow ?? undefined, row ?? undefined) : null
        return <article key={id} data-product-id={id}>
          <h3><span>{item.product.brand}</span>{item.product.canonical_name}</h3>
          {tab === 'overview' ? <>
            {conditions.length ? <div className="highlight-conditions"><CompactList values={conditions} /></div> : null}
            <CompactList values={differences.map(fact => `${fact.label}${fact.bothKnown ? '' : ' · 자료 확인 차이'}: ${fact.before} → ${fact.value}`)} />
            {!differences.length ? <p>확인된 기본 표기에서 기준 제품과의 차이를 찾지 못했습니다.</p> : null}
          </> : tab === 'nutrition' ? <>
            <p className="highlight-energy-delta"><strong>{delta == null ? '열량 차이 판단 보류' : delta === 0 ? '100g당 표기 열량 같음' : `100g당 ${Math.abs(delta).toLocaleString('ko-KR', { maximumFractionDigits: 10 })} kcal ${delta < 0 ? '낮음' : '높음'}`}</strong></p>
            <p>{amount == null ? ready && energyAmount(row ?? undefined) != null ? `참고 표기 · ${energyText(energyAmount(row ?? undefined)!)}` : '비교 가능한 열량 미확인' : energyText(amount)}</p>
            {delta == null ? <p className="highlight-evidence">{!ready ? nutritionLoading(id) ? '후보 자료를 불러오는 중입니다.' : '후보 자료 조회 실패' : reference.feed_type !== item.product.feed_type || !reference.feed_type ? '사료 형태가 다르거나 미확인입니다.' : '기준 또는 후보의 열량·자료 적용 범위를 확인해야 합니다.'}</p> : null}
            {ready ? energySource(item.product, row) : null}
          </> : <IngredientHighlight row={ingredients(id)} loading={ingredientsLoading(id)} failed={ingredientsFailed(id)} variants={variants(id)} variantStatus={variantStatus(id)} currentVariantId={id === baseline?.product_id ? currentVariantId : undefined} />}
        </article>
      })}
    </div>
    <p className="highlight-footnote">{tab === 'overview' ? '제품의 표기와 선택한 조건을 요약했습니다. 상세 항목은 아래에서 비교할 수 있습니다.' : tab === 'nutrition' ? '같은 사료 형태의 표시된 값만 비교합니다. 열량이 낮다는 것만으로 더 적합한 사료라는 뜻은 아닙니다.' : '목록의 길이나 표기 예만으로 원료의 부재와 제품의 우열을 판단할 수 없습니다.'}</p>
  </section>
}
