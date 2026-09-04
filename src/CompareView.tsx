import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import ProductDetail from './ProductDetail'
import {
  fetchCompareIngredients,
  fetchCompareNutrition,
  fetchProductVariants,
  type CatalogProduct,
  type CompareIngredients,
  type CompareNutrition,
  type ProductVariant,
} from './api'

export type CompareItem = {
  product: CatalogProduct
  confirmedMatches?: string[]
  keepMatches?: string[]
  changeMatches?: string[]
  unknowns?: string[]
  ingredientReviewedNotFound?: string[]
  ingredientInsufficient?: string[]
}

type CompareTab = 'overview' | 'nutrition' | 'ingredients'
type CompareRowTone = 'metric' | 'context'

const LIFE_STAGE_LABELS: Record<string, string> = {
  kitten: '키튼',
  adult: '성묘',
  senior: '시니어',
  all_life_stages: '전연령',
  gestation_lactation_and_kitten: '임신·수유·키튼',
}

const TARGET_LABELS: Record<string, string> = {
  indoor: '실내묘',
  sterilized: '중성화묘',
}

const FEATURE_LABELS: Record<string, string> = {
  weight_management: '체중 관리',
  stool: '변 상태',
  hairball: '헤어볼',
  digestive: '소화',
  urinary: '요로',
  skin_coat: '피부·피모',
  dental: '덴탈',
}

const RECIPE_LABELS: Record<string, string> = {
  poultry: '가금류',
  meat: '육류',
  fish: '생선',
  chicken: '닭',
  duck: '오리',
  turkey: '칠면조',
  beef: '소',
  lamb: '양',
  rabbit: '토끼',
  salmon: '연어',
  tuna: '참치',
  herring: '청어',
  mackerel: '고등어',
  trout: '송어',
  cod: '대구',
  pork: '돼지',
  venison: '사슴',
}

function labels(values: string[], map: Record<string, string>): string {
  if (values.length === 0) return '확인된 값 없음'
  return values.map((value) => map[value] ?? value.replaceAll('_', ' ')).join(' · ')
}

function formatNumber(value: number | null, suffix: string, qualifier?: string | null): string {
  if (value == null) return '미확인'
  const qualifierLabel = qualifier === 'min' ? ' 이상' : qualifier === 'max' ? ' 이하' : qualifier ? ` ${qualifier}` : ''
  return `${Number(value).toLocaleString('ko-KR')}${suffix}${qualifierLabel}`
}

function variantSizeLabel(variant: ProductVariant | null): string | null {
  if (!variant) return null
  if (variant.package_size_text?.trim()) return variant.package_size_text.trim()
  if (variant.package_weight_g != null) return `${Number(variant.package_weight_g).toLocaleString('ko-KR')}g`
  return null
}

function detailContext(
  detail: CompareNutrition | CompareIngredients | undefined,
  variants: ProductVariant[] = [],
  variantLookupFailed = false,
  variantLookupLoading = false,
): string {
  if (!detail) return '대표 확인값 없음'
  const market = detail.market_code === 'KR' ? '한국 확인' : detail.market_code ? `${detail.market_code} 확인` : '시장 미지정'
  let scope = '제품 기준'

  if (detail.observation_scope === 'variant') {
    const variant = detail.variant_id
      ? variants.find((item) => item.variant_id === detail.variant_id) ?? null
      : null
    const size = variantSizeLabel(variant)
    scope = size
      ? `${size} 규격 기준`
      : variantLookupLoading
        ? '규격 기준 · 실제 규격 확인 중'
        : variantLookupFailed
          ? '규격 기준 · 실제 규격 조회 실패'
          : '규격 기준 · 실제 규격 표기 미확인'
  } else if (detail.observation_scope === 'formula') {
    scope = detail.is_current_resolved_formula
      ? '현재 확인 배합 기준'
      : '배합 기준 · 현재 한국 배합 대응 미확정'
  }

  return `${market} · ${scope}`
}

function ProductHead({
  item,
  onRemove,
  onDetail,
}: {
  item: CompareItem
  onRemove: () => void
  onDetail: () => void
}) {
  const product = item.product
  return (
    <div className="compare-product-head">
      <button className="compare-remove" type="button" onClick={onRemove} aria-label={`${product.canonical_name} 비교에서 제거`}>×</button>
      <div className="compare-product-identity">
        {product.display_image_url ? <img src={product.display_image_url} alt="" /> : <div className="compare-image-placeholder">이미지 없음</div>}
        <div className="compare-product-copy">
          <span>{product.brand}</span>
          <strong>{product.canonical_name}</strong>
          <small>대표 규격 · {product.representative_package_size_text ?? '미확인'}</small>
        </div>
      </div>
      <button className="compare-detail-link" type="button" onClick={onDetail}>제품 상세 →</button>
    </div>
  )
}

function RelationSummary({ item }: { item: CompareItem }) {
  const confirmed = item.confirmedMatches ?? []
  const keep = item.keepMatches ?? []
  const change = item.changeMatches ?? []
  const unknown = item.unknowns ?? []
  const reviewed = item.ingredientReviewedNotFound ?? []
  const insufficient = item.ingredientInsufficient ?? []

  if (![confirmed, keep, change, unknown, reviewed, insufficient].some((values) => values.length > 0)) {
    return <span className="compare-muted">별도 검색 관계 없음</span>
  }

  return (
    <div className="compare-relations">
      {confirmed.length ? <p className="is-confirmed"><span>조건 확인</span><strong>{confirmed.join(' · ')}</strong></p> : null}
      {keep.length ? <p className="is-keep"><span>유지 확인</span><strong>{keep.join(' · ')}</strong></p> : null}
      {change.length ? <p className="is-change"><span>변경 확인</span><strong>{change.join(' · ')}</strong></p> : null}
      {reviewed.length ? <p className="is-reviewed"><span>원료 검토</span><strong>{reviewed.join(' · ')} · 검토 근거에서 찾지 못함</strong></p> : null}
      {insufficient.length ? <p className="is-unknown"><span>원료 미확인</span><strong>{insufficient.join(' · ')} · 판단 근거 부족</strong></p> : null}
      {unknown.length ? <p className="is-unknown"><span>미확인</span><strong>{unknown.join(' · ')}</strong></p> : null}
    </div>
  )
}

function CompareRow({
  label,
  items,
  render,
  tone,
}: {
  label: string
  items: CompareItem[]
  render: (item: CompareItem) => ReactNode
  tone?: CompareRowTone
}) {
  return (
    <div className={`compare-row${tone ? ` is-${tone}` : ''}`} style={{ '--compare-count': items.length } as CSSProperties}>
      <div className="compare-row-label">{label}</div>
      {items.map((item) => <div className="compare-cell" key={item.product.product_id}>{render(item)}</div>)}
    </div>
  )
}

function CompareSection({ title, note }: { title: string; note?: string }) {
  return (
    <div className="compare-section-row">
      <strong>{title}</strong>
      {note ? <span>{note}</span> : null}
    </div>
  )
}

export default function CompareView({
  items,
  currentProduct,
  currentVariantText,
  onClose,
  onRemove,
}: {
  items: CompareItem[]
  currentProduct?: CatalogProduct | null
  currentVariantText?: string
  onClose: () => void
  onRemove: (productId: string) => void
}) {
  const [tab, setTab] = useState<CompareTab>('overview')
  const [nutrition, setNutrition] = useState<CompareNutrition[]>([])
  const [ingredients, setIngredients] = useState<CompareIngredients[]>([])
  const [variantsByProduct, setVariantsByProduct] = useState<Record<string, ProductVariant[]>>({})
  const [variantLookupFailures, setVariantLookupFailures] = useState<string[]>([])
  const [variantsLoading, setVariantsLoading] = useState(false)
  const [nutritionLoading, setNutritionLoading] = useState(false)
  const [ingredientsLoading, setIngredientsLoading] = useState(false)
  const [nutritionError, setNutritionError] = useState<string | null>(null)
  const [ingredientsError, setIngredientsError] = useState<string | null>(null)
  const [detailProductId, setDetailProductId] = useState<string | null>(null)

  const productIds = useMemo(() => items.map((item) => item.product.product_id), [items])
  const nutritionByProduct = useMemo(() => new Map(nutrition.map((row) => [row.product_id, row])), [nutrition])
  const ingredientsByProduct = useMemo(() => new Map(ingredients.map((row) => [row.product_id, row])), [ingredients])
  const detailItem = detailProductId ? items.find((item) => item.product.product_id === detailProductId) ?? null : null

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setNutrition([])
    setIngredients([])
    setVariantsByProduct({})
    setVariantLookupFailures([])
    setVariantsLoading(true)
    setNutritionLoading(true)
    setIngredientsLoading(true)
    setNutritionError(null)
    setIngredientsError(null)

    fetchCompareNutrition(productIds, controller.signal)
      .then((rows) => {
        if (active) setNutrition(rows)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) setNutritionError(reason instanceof Error ? reason.message : '영양 정보를 불러오지 못했습니다.')
      })
      .finally(() => {
        if (active) setNutritionLoading(false)
      })

    fetchCompareIngredients(productIds, controller.signal)
      .then((rows) => {
        if (active) setIngredients(rows)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) setIngredientsError(reason instanceof Error ? reason.message : '원재료 정보를 불러오지 못했습니다.')
      })
      .finally(() => {
        if (active) setIngredientsLoading(false)
      })

    Promise.allSettled(productIds.map((productId) => fetchProductVariants(productId, controller.signal)))
      .then((results) => {
        if (!active) return
        const nextVariants: Record<string, ProductVariant[]> = {}
        const failures: string[] = []
        results.forEach((result, index) => {
          const productId = productIds[index]
          if (result.status === 'fulfilled') nextVariants[productId] = result.value
          else if (!(result.reason instanceof DOMException && result.reason.name === 'AbortError')) failures.push(productId)
        })
        setVariantsByProduct(nextVariants)
        setVariantLookupFailures(failures)
        setVariantsLoading(false)
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [productIds.join('|')])

  if (detailItem) {
    return <ProductDetail product={detailItem.product} onClose={() => setDetailProductId(null)} />
  }

  return (
    <main className="compare-stage">
      <header className="compare-header">
        <div>
          <span>COMPARE</span>
          <h1>제품 비교</h1>
          <p>{items.length}개 제품 · 최대 5개까지 직접 선택해 비교합니다.</p>
        </div>
        <button type="button" onClick={onClose}>← 후보로 돌아가기</button>
      </header>

      {currentProduct ? (
        <section className="compare-current-baseline">
          <span>현재 기준</span>
          <strong>{currentProduct.brand} · {currentProduct.canonical_name}</strong>
          <small>{currentVariantText || '사용 규격 모름'}</small>
        </section>
      ) : null}

      <nav className="compare-tabs" aria-label="비교 항목">
        <button className={tab === 'overview' ? 'is-active' : ''} type="button" onClick={() => setTab('overview')}>개요</button>
        <button className={tab === 'nutrition' ? 'is-active' : ''} type="button" onClick={() => setTab('nutrition')}>영양</button>
        <button className={tab === 'ingredients' ? 'is-active' : ''} type="button" onClick={() => setTab('ingredients')}>원재료</button>
      </nav>

      {tab === 'nutrition' && nutritionError ? <div className="compare-state is-error">영양 정보를 불러오지 못했습니다. {nutritionError}</div> : null}
      {tab === 'ingredients' && ingredientsError ? <div className="compare-state is-error">원재료 정보를 불러오지 못했습니다. {ingredientsError}</div> : null}
      {tab === 'nutrition' && nutritionLoading ? <div className="compare-state">영양 정보를 불러오는 중입니다.</div> : null}
      {tab === 'ingredients' && ingredientsLoading ? <div className="compare-state">원재료 정보를 불러오는 중입니다.</div> : null}

      <section className="compare-table-wrap">
        <div className="compare-table" style={{ '--compare-count': items.length } as CSSProperties}>
          <div className="compare-head-row">
            <div className="compare-corner">비교 기준</div>
            {items.map((item) => (
              <ProductHead
                key={item.product.product_id}
                item={item}
                onRemove={() => onRemove(item.product.product_id)}
                onDetail={() => setDetailProductId(item.product.product_id)}
              />
            ))}
          </div>

          {tab === 'overview' ? (
            <>
              <CompareSection
                title={currentProduct ? '현재 사료와의 관계' : '검색 조건과의 관계'}
                note={currentProduct ? '현재 기준과 각 후보의 확인·미확인 관계를 나란히 봅니다.' : '선택한 검색 조건과 각 제품의 확인·미확인 관계를 나란히 봅니다.'}
              />
              <CompareRow label={currentProduct ? '현재 기준과의 관계' : '검색 조건과의 관계'} items={items} render={(item) => <RelationSummary item={item} />} />
              <CompareSection title="제품 기본 정보" note="공식 표기와 현재 확인된 제품 단위 정보를 비교합니다." />
              <CompareRow label="사료 형태" items={items} render={(item) => item.product.feed_type ?? '미확인'} />
              <CompareRow label="표기 생애주기" items={items} render={(item) => item.product.life_stage ? LIFE_STAGE_LABELS[item.product.life_stage] ?? item.product.life_stage : '미확인'} />
              <CompareRow label="공식 대상" items={items} render={(item) => labels(item.product.official_targets, TARGET_LABELS)} />
              <CompareRow label="부가 기능" items={items} render={(item) => labels(item.product.features, FEATURE_LABELS)} />
              <CompareSection title="레시피·판매 정보" note="레시피 계열과 공식 표방, 대표 판매 정보를 구분해 확인합니다." />
              <CompareRow label="레시피 계열" items={items} render={(item) => labels(item.product.recipe_families, RECIPE_LABELS)} />
              <CompareRow label="세부 레시피" items={items} render={(item) => labels(item.product.recipe_details, RECIPE_LABELS)} />
              <CompareRow label="Grain-Free 공식 표방" items={items} render={(item) => item.product.official_recipe_traits.includes('grain_free') ? '확인됨' : '공식 표방 미확인'} />
              <CompareRow label="대표 규격" items={items} render={(item) => item.product.representative_package_size_text ?? '미확인'} />
              <CompareRow label="제조국" items={items} render={(item) => item.product.manufacturing_country_codes.join(' · ') || '미확인'} />
            </>
          ) : null}

          {tab === 'nutrition' && !nutritionLoading && !nutritionError ? (
            <>
              <CompareSection title="표시 기준" note="대표 영양 패널이 어떤 시장·SKU·배합 범위를 가리키는지 먼저 확인합니다." />
              <CompareRow
                label="표시 기준"
                items={items}
                tone="context"
                render={(item) => <span className="compare-muted">{detailContext(
                  nutritionByProduct.get(item.product.product_id),
                  variantsByProduct[item.product.product_id],
                  variantLookupFailures.includes(item.product.product_id),
                  variantsLoading,
                )}</span>}
              />
              <CompareSection title="영양 성분" note="공식 표시값을 같은 위치에서 읽습니다. 숫자만으로 우열을 판정하지 않습니다." />
              <CompareRow label="열량" items={items} tone="metric" render={(item) => {
                const row = nutritionByProduct.get(item.product.product_id)
                if (!row) return '미확인'
                if (row.kcal_per_kg != null) return formatNumber(row.kcal_per_kg, ' kcal/kg')
                return formatNumber(row.kcal_per_100g, ' kcal/100g')
              }} />
              <CompareRow label="조단백질" items={items} tone="metric" render={(item) => {
                const row = nutritionByProduct.get(item.product.product_id)
                return row ? formatNumber(row.protein_pct, '%', row.protein_qualifier) : '미확인'
              }} />
              <CompareRow label="조지방" items={items} tone="metric" render={(item) => {
                const row = nutritionByProduct.get(item.product.product_id)
                return row ? formatNumber(row.fat_pct, '%', row.fat_qualifier) : '미확인'
              }} />
              <CompareRow label="조섬유" items={items} tone="metric" render={(item) => {
                const row = nutritionByProduct.get(item.product.product_id)
                return row ? formatNumber(row.fiber_pct, '%', row.fiber_qualifier) : '미확인'
              }} />
              <CompareRow label="수분" items={items} tone="metric" render={(item) => {
                const row = nutritionByProduct.get(item.product.product_id)
                return row ? formatNumber(row.moisture_pct, '%', row.moisture_qualifier) : '미확인'
              }} />
              <CompareRow label="조회분" items={items} tone="metric" render={(item) => {
                const row = nutritionByProduct.get(item.product.product_id)
                return row ? formatNumber(row.ash_pct, '%', row.ash_qualifier) : '미확인'
              }} />
            </>
          ) : null}

          {tab === 'ingredients' && !ingredientsLoading && !ingredientsError ? (
            <>
              <CompareSection title="표시 기준" note="대표 원재료 근거가 어떤 시장·SKU·배합 범위를 가리키는지 먼저 확인합니다." />
              <CompareRow
                label="표시 기준"
                items={items}
                tone="context"
                render={(item) => <span className="compare-muted">{detailContext(
                  ingredientsByProduct.get(item.product.product_id),
                  variantsByProduct[item.product.product_id],
                  variantLookupFailures.includes(item.product.product_id),
                  variantsLoading,
                )}</span>}
              />
              <CompareSection title="원재료 정보" note="목록의 완전성 상태와 실제 확인 문구를 함께 봅니다." />
              <CompareRow label="원재료 목록 상태" items={items} render={(item) => {
                const row = ingredientsByProduct.get(item.product.product_id)
                if (!row) return '미확인'
                if (row.completeness_status === 'full') return '전체 목록 확인'
                if (row.completeness_status === 'partial') return '일부 목록'
                if (row.completeness_status === 'summary') return '요약 정보'
                return '상태 미확인'
              }} />
              <CompareRow label="원재료" items={items} render={(item) => {
                const row = ingredientsByProduct.get(item.product.product_id)
                if (!row) return <span className="compare-muted">확인된 목록 없음</span>
                const text = row.raw_text?.trim() || row.ingredient_names.join(', ')
                return <p className="compare-ingredient-text">{text || '확인된 목록 없음'}</p>
              }} />
            </>
          ) : null}
        </div>
      </section>

      {tab === 'nutrition' ? <p className="compare-footnote">영양값은 공개된 대표 확인 패널의 공식 표시값을 그대로 비교합니다. 서로 다른 사료 형태의 열량을 자동으로 우열 판정하지 않습니다.</p> : null}
      {tab === 'ingredients' ? <p className="compare-footnote">원재료 목록이 부분·요약 상태이면 보이지 않는 원료를 부재로 해석하지 않습니다.</p> : null}
    </main>
  )
}
