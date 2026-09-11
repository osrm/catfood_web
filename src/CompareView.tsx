import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import ProductDetail from './ProductDetail'
import {
  fetchCompareIngredients,
  fetchCompareNutrition,
  fetchProductVariants,
  type AdditionalNutrient,
  type CatalogProduct,
  type CompareIngredients,
  type CompareNutrition,
  type ProductVariant,
} from './api'
import type { CompareTab } from './navigation-state'

export type CompareItem = {
  product: CatalogProduct
  confirmedMatches?: string[]
  keepMatches?: string[]
  changeMatches?: string[]
  unknowns?: string[]
  ingredientReviewedNotFound?: string[]
  ingredientInsufficient?: string[]
}

type CompareRowTone = 'metric' | 'context'
const TABS: Array<[CompareTab, string]> = [['overview', '개요'], ['nutrition', '영양'], ['ingredients', '원재료']]
const LIFE_STAGE_LABELS: Record<string, string> = {
  kitten: '키튼', adult: '성묘', senior: '시니어', all_life_stages: '전연령',
  gestation_lactation_and_kitten: '임신·수유·키튼',
}
const TARGET_LABELS: Record<string, string> = { indoor: '실내묘', sterilized: '중성화묘' }
const FEATURE_LABELS: Record<string, string> = {
  weight_management: '체중 관리', stool: '변 상태', hairball: '헤어볼', digestive: '소화',
  urinary: '요로', skin_coat: '피부·피모', dental: '덴탈',
}
const RECIPE_LABELS: Record<string, string> = {
  poultry: '가금류', poultry_unspecified: '가금류(종류 미상)', meat: '육류', fish: '생선', chicken: '닭',
  duck: '오리', turkey: '칠면조', goose: '거위', quail: '메추리', beef: '소', lamb: '양', goat: '염소',
  boar: '멧돼지', rabbit: '토끼', salmon: '연어', tuna: '참치', herring: '청어', mackerel: '고등어',
  trout: '송어', cod: '대구', sardine: '정어리', anchovy: '멸치', menhaden: '멘헤이든', whitefish: '흰살생선',
  pork: '돼지', venison: '사슴', egg: '계란', beef_liver: '소 간', bonito: '보니토(Bonito)', bream: '도미류(Bream)',
  cheese: '치즈', chicken_liver: '닭 간', coconut_oil: '코코넛오일', green_mussel: '초록홍합', haddock: '해덕대구',
  hoki: '호키', kahawai: 'Kahawai', mussel: '홍합류', mutton: '양고기(Mutton)', pheasant: '꿩',
  poultry_hearts: '가금류 심장', poultry_liver: '가금류 간', pumpkin: '호박', rice: '쌀', rooster: '수탉',
  sea_bass: '농어류(Sea bass)', sea_bream: '도미류(Sea bream)', shirasu: '치어(Shirasu)', shrimp: '새우',
  skipjack_tuna: '가다랑어(Skipjack tuna)', southern_blue_whiting: '남방청대구', tuna_roe: '참치알', wallaby: '왈라비',
  wild_boar: '야생 멧돼지',
}
const ADDITIONAL_NUTRIENT_LABELS: Record<string, string> = { calcium: '칼슘', phosphorus: '인', magnesium: '마그네슘', taurine: '타우린' }
const BASIS_NUTRIENT_LABELS: Record<string, string> = { protein: '단백질', fat: '지방', fiber: '조섬유', moisture: '수분', ash: '조회분' }
const SUPPLEMENTAL_NUTRITION_LABELS: Record<string, string> = {
  energy: '열량', protein: '조단백질', fat: '조지방', fiber: '조섬유', moisture: '수분', ash: '조회분', additional_nutrients: '추가 영양성분',
}
const ADDITIONAL_NUTRIENT_ORDER = ['calcium', 'phosphorus', 'magnesium', 'taurine']
const countryNames = new Intl.DisplayNames(['ko'], { type: 'region' })

function labels(values: string[], map: Record<string, string>) {
  if (!values.length) return '확인된 값 없음'
  return values.map((value) => map[value] ?? value.replaceAll('_', ' ')).join(' · ')
}
function formatNumber(value: number | null | undefined, suffix: string, qualifier?: string | null) {
  if (value == null) return '미확인'
  const q = qualifier === 'min' ? ' 이상' : qualifier === 'max' ? ' 이하' : qualifier === 'typical' ? ' 평균값' : qualifier && qualifier !== 'reported' && qualifier !== 'exact' ? ` ${qualifier}` : ''
  return `${Number(value).toLocaleString('ko-KR')}${suffix}${q}`
}
function formatWeight(value: number | null | undefined) {
  if (value == null) return null
  return value >= 1000 ? `${Number((value / 1000).toFixed(3)).toLocaleString('ko-KR')} kg` : `${Number(value).toLocaleString('ko-KR')} g`
}
function representativePackageLabel(product: CatalogProduct) {
  const packageLabels = product.available_package_labels ?? []
  if (packageLabels.length) return packageLabels.join(' · ')
  const size = product.representative_package_size_text ?? '판매 규격 미확인'
  const units = product.representative_units_per_sale ?? null
  const total = formatWeight(product.representative_sale_total_weight_g)
  return units && units > 1 ? `${size} × ${units}${total ? ` · 총 ${total}` : ''}` : size
}
function additionalNutrient(row: CompareNutrition | undefined, key: string) { return (row?.additional_nutrients ?? []).find((item) => item.nutrient_key === key) }
function additionalNutrientLabel(key: string, rows: CompareNutrition[]) {
  const raw = rows.flatMap((row) => row.additional_nutrients ?? []).find((item) => item.nutrient_key === key)?.raw_name
  return ADDITIONAL_NUTRIENT_LABELS[key] ?? raw ?? key.replaceAll('_', ' ')
}
function formatAdditionalNutrient(value: AdditionalNutrient | undefined) {
  if (!value || value.amount == null) return '미확인'
  const unit = value.unit ?? ''
  return formatNumber(value.amount, unit === '%' ? '%' : unit ? ` ${unit}` : '', value.qualifier)
}
function basisSpecificNutrient(row: CompareNutrition | undefined, key: string) {
  return (row?.basis_specific_nutrition_values ?? []).find((item) => item.nutrient_key === key && item.amount != null)
}
function formatStandardNutrient(row: CompareNutrition | undefined, key: string, value: number | null | undefined, qualifier?: string | null) {
  if (value != null) return formatNumber(value, '%', qualifier)
  if (basisSpecificNutrient(row, key)) return row?.basis_specific_nutrition_basis === 'dry_matter' ? '건물 기준 자료만 확인' : '다른 기준 자료만 확인'
  return '미확인'
}
function basisSpecificSummary(row: CompareNutrition | undefined) {
  const values = (row?.basis_specific_nutrition_values ?? []).filter((value) => value.amount != null)
  if (!values.length) return '해당 없음'
  const basis = row?.basis_specific_nutrition_basis === 'dry_matter' ? '건물 기준(Dry Matter)' : row?.basis_specific_nutrition_basis?.replaceAll('_', ' ') ?? '다른 기준'
  return `${basis} · ${values.map((value) => `${BASIS_NUTRIENT_LABELS[value.nutrient_key] ?? value.raw_name ?? value.nutrient_key} ${formatAdditionalNutrient(value)}`).join(' · ')}`
}
function variantSizeLabel(variant: ProductVariant | null) {
  if (!variant) return null
  if (variant.package_size_text?.trim()) return variant.package_size_text.trim()
  return variant.package_weight_g != null ? `${Number(variant.package_weight_g).toLocaleString('ko-KR')}g` : null
}
function detailContext(detail: CompareNutrition | CompareIngredients | undefined, variants: ProductVariant[] = [], failed = false, loading = false) {
  if (!detail) return '확인값 없음'
  const market = detail.market_code === 'KR' ? '한국 판매 제품 자료' : detail.market_code ? `${countryNames.of(detail.market_code) ?? detail.market_code} 제품 자료` : ''
  let scope = '제품 자료'
  if (detail.observation_scope === 'variant') {
    const variant = detail.variant_id ? variants.find((item) => item.variant_id === detail.variant_id) ?? null : null
    const size = variantSizeLabel(variant)
    scope = size ? `${size} 제품에서 확인` : loading ? '포장 용량 확인 중' : failed ? '포장 용량 조회 실패' : '확인한 포장 용량 정보 없음'
  } else if (detail.observation_scope === 'formula') {
    scope = detail.is_current_resolved_formula ? '같은 배합으로 확인된 제품 자료' : '한국 판매 제품과 배합이 같은지 확인되지 않은 자료'
  }
  return [market, scope].filter(Boolean).join(' · ')
}
function nutritionDetailContext(detail: CompareNutrition | undefined, variants: ProductVariant[] = [], failed = false, loading = false) {
  let context = detailContext(detail, variants, failed, loading)
  const fields = detail?.supplemental_nutrition_fields ?? []
  if (fields.length) {
    const fieldLabels = fields.map((field) => SUPPLEMENTAL_NUTRITION_LABELS[field] ?? field.replaceAll('_', ' ')).join(' · ')
    context += ` · ${fieldLabels}: ${detail?.supplemental_is_current_resolved_formula ? '현재 확인 배합 자료로 보완' : '보조 영양 근거로 보완'}`
  }
  if (detail?.basis_specific_nutrition_values?.some((value) => value.amount != null)) context += detail.basis_specific_nutrition_basis === 'dry_matter' ? ' · 건물 기준 자료 별도 확인' : ' · 다른 기준 자료 별도 확인'
  return context
}
function ingredientDetailContext(detail: CompareIngredients | undefined, variants: ProductVariant[] = [], failed = false, loading = false) {
  const base = detailContext(detail, variants, failed, loading)
  if (!(detail?.supplemental_full_ingredient_names?.length || detail?.supplemental_full_raw_text?.trim())) return base
  return `${base} · ${detail.supplemental_is_current_resolved_formula ? '현재 확인 배합 전체 목록 별도 확인' : '보조 전체 목록 별도 확인'}`
}

function ProductHead({ item, onRemove, onDetail }: { item: CompareItem; onRemove: () => void; onDetail: () => void }) {
  const product = item.product
  return <div className="compare-product-head">
    <button className="compare-remove" type="button" onClick={onRemove} aria-label={`${product.canonical_name} 비교에서 제거`}>×</button>
    <div className="compare-product-identity">{product.display_image_url ? <img src={product.display_image_url} alt="" /> : <div className="compare-image-placeholder">이미지 없음</div>}<div className="compare-product-copy"><span>{product.brand}</span><strong>{product.canonical_name}</strong><small>판매 규격 · {representativePackageLabel(product)}</small></div></div>
    <button className="compare-detail-link" type="button" onClick={onDetail}>상세 보기 →</button>
  </div>
}
function RelationSummary({ item }: { item: CompareItem }) {
  const confirmed = item.confirmedMatches ?? [], keep = item.keepMatches ?? [], change = item.changeMatches ?? [], unknown = item.unknowns ?? [], reviewed = item.ingredientReviewedNotFound ?? [], insufficient = item.ingredientInsufficient ?? []
  if (![confirmed, keep, change, unknown, reviewed, insufficient].some((values) => values.length)) return <span className="compare-muted">비교할 검색 조건 없음</span>
  return <div className="compare-relations">
    {confirmed.length ? <p className="is-confirmed"><span>확인됨</span><strong>{confirmed.join(' · ')}</strong></p> : null}
    {keep.length ? <p className="is-keep"><span>유지 조건</span><strong>{keep.join(' · ')}</strong></p> : null}
    {change.length ? <p className="is-change"><span>변경 조건</span><strong>{change.join(' · ')}</strong></p> : null}
    {reviewed.length ? <p className="is-reviewed"><span>원료 확인</span><strong>{reviewed.join(' · ')} · 검토한 자료에서 찾지 못함</strong></p> : null}
    {insufficient.length ? <p className="is-unknown"><span>원료 미확인</span><strong>{insufficient.join(' · ')} · 판단 근거 부족</strong></p> : null}
    {unknown.length ? <p className="is-unknown"><span>미확인</span><strong>{unknown.join(' · ')}</strong></p> : null}
  </div>
}
function CompareRow({ label, items, render, tone }: { label: string; items: CompareItem[]; render: (item: CompareItem) => ReactNode; tone?: CompareRowTone }) {
  return <div className={`compare-row${tone ? ` is-${tone}` : ''}`} style={{ '--compare-count': items.length } as CSSProperties}><div className="compare-row-label">{label}</div>{items.map((item) => <div className="compare-cell" key={item.product.product_id}>{render(item)}</div>)}</div>
}
function CompareSection({ title, note }: { title: string; note?: string }) { return <div className="compare-section-row"><strong>{title}</strong>{note ? <span>{note}</span> : null}</div> }

export default function CompareView({ items, currentProduct, currentVariantText, onClose, onRemove, initialTab = 'overview', onTabChange, detailProductId: controlledDetailProductId, detailTab = 'overview', onDetailOpen, onDetailClose, onDetailTabChange }: {
  items: CompareItem[]
  currentProduct?: CatalogProduct | null
  currentVariantText?: string
  onClose: () => void
  onRemove: (productId: string) => void
  initialTab?: CompareTab
  onTabChange?: (tab: CompareTab) => void
  detailProductId?: string | null
  detailTab?: import('./navigation-state').DetailTab
  onDetailOpen?: (productId: string) => void
  onDetailClose?: () => void
  onDetailTabChange?: (tab: import('./navigation-state').DetailTab) => void
}) {
  const [tab, setTab] = useState<CompareTab>(initialTab)
  const [reload, setReload] = useState(0)
  const [nutrition, setNutrition] = useState<CompareNutrition[]>([])
  const [ingredients, setIngredients] = useState<CompareIngredients[]>([])
  const [variantsByProduct, setVariantsByProduct] = useState<Record<string, ProductVariant[]>>({})
  const [variantLookupFailures, setVariantLookupFailures] = useState<string[]>([])
  const [variantsLoading, setVariantsLoading] = useState(false)
  const [nutritionLoading, setNutritionLoading] = useState(false)
  const [ingredientsLoading, setIngredientsLoading] = useState(false)
  const [nutritionError, setNutritionError] = useState<string | null>(null)
  const [ingredientsError, setIngredientsError] = useState<string | null>(null)
  const [localDetailProductId, setLocalDetailProductId] = useState<string | null>(null)
  const detailProductId = controlledDetailProductId === undefined ? localDetailProductId : controlledDetailProductId
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => { setTab(initialTab) }, [initialTab])
  function selectTab(next: CompareTab, focus = false) {
    setTab(next); onTabChange?.(next)
    if (focus) requestAnimationFrame(() => tabRefs.current[TABS.findIndex(([key]) => key === next)]?.focus())
  }
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    else return
    event.preventDefault(); selectTab(TABS[next][0], true)
  }

  const productIds = useMemo(() => items.map((item) => item.product.product_id), [items])
  const nutritionByProduct = useMemo(() => new Map(nutrition.map((row) => [row.product_id, row])), [nutrition])
  const ingredientsByProduct = useMemo(() => new Map(ingredients.map((row) => [row.product_id, row])), [ingredients])
  const additionalNutrientKeys = useMemo(() => {
    const keys = new Set<string>()
    nutrition.forEach((row) => (row.additional_nutrients ?? []).forEach((value) => { if (value.amount != null) keys.add(value.nutrient_key) }))
    return [...keys].sort((a, b) => {
      const ai = ADDITIONAL_NUTRIENT_ORDER.indexOf(a), bi = ADDITIONAL_NUTRIENT_ORDER.indexOf(b)
      if (ai >= 0 || bi >= 0) { if (ai < 0) return 1; if (bi < 0) return -1; return ai - bi }
      return a.localeCompare(b, 'ko-KR')
    })
  }, [nutrition])
  const hasBasisSpecificNutrition = useMemo(() => nutrition.some((row) => row.basis_specific_nutrition_values?.some((value) => value.amount != null)), [nutrition])
  const detailItem = detailProductId ? items.find((item) => item.product.product_id === detailProductId) ?? null : null

  useEffect(() => {
    const controller = new AbortController(); let active = true
    setNutrition([]); setIngredients([]); setVariantsByProduct({}); setVariantLookupFailures([]); setVariantsLoading(true); setNutritionLoading(true); setIngredientsLoading(true); setNutritionError(null); setIngredientsError(null)
    fetchCompareNutrition(productIds, controller.signal).then((rows) => { if (active) setNutrition(rows) }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      if (active) setNutritionError('영양 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
    }).finally(() => { if (active) setNutritionLoading(false) })
    fetchCompareIngredients(productIds, controller.signal).then((rows) => { if (active) setIngredients(rows) }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      if (active) setIngredientsError('원재료 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
    }).finally(() => { if (active) setIngredientsLoading(false) })
    Promise.allSettled(productIds.map((id) => fetchProductVariants(id, controller.signal))).then((results) => {
      if (!active) return
      const next: Record<string, ProductVariant[]> = {}, failures: string[] = []
      results.forEach((result, index) => { const id = productIds[index]; if (result.status === 'fulfilled') next[id] = result.value; else if (!(result.reason instanceof DOMException && result.reason.name === 'AbortError')) failures.push(id) })
      setVariantsByProduct(next); setVariantLookupFailures(failures); setVariantsLoading(false)
    })
    return () => { active = false; controller.abort() }
  }, [productIds.join('|'), reload])

  if (detailItem) return <ProductDetail product={detailItem.product} onClose={() => onDetailClose ? onDetailClose() : setLocalDetailProductId(null)} initialTab={detailTab} onTabChange={onDetailTabChange} />

  const panelId = `compare-panel-${tab}`
  const tabId = `compare-tab-${tab}`
  return <main className="compare-stage">
    <header className="compare-header"><div><span>COMPARE</span><h1>제품 비교</h1><p>{items.length}개 제품을 나란히 비교합니다. 최대 5개까지 선택할 수 있습니다.</p></div><button type="button" onClick={onClose}>← 제품 목록으로</button></header>
    {currentProduct ? <section className="compare-current-baseline"><span>현재 사료</span><strong>{currentProduct.brand} · {currentProduct.canonical_name}</strong><small>{currentVariantText || '사용 규격 모름'}</small></section> : null}
    <nav className="compare-tabs" aria-label="비교 항목" role="tablist">{TABS.map(([key, label], index) => <button
      key={key} id={`compare-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`compare-panel-${key}`} tabIndex={tab === key ? 0 : -1}
      className={tab === key ? 'is-active' : ''} type="button" ref={(node) => { tabRefs.current[index] = node }} onKeyDown={(event) => onTabKeyDown(event, index)} onClick={() => selectTab(key)}
    >{label}</button>)}</nav>

    {tab === 'nutrition' && nutritionError ? <div className="compare-state is-error" role="alert"><p>{nutritionError}</p><button type="button" onClick={() => setReload((value) => value + 1)}>다시 시도</button></div> : null}
    {tab === 'ingredients' && ingredientsError ? <div className="compare-state is-error" role="alert"><p>{ingredientsError}</p><button type="button" onClick={() => setReload((value) => value + 1)}>다시 시도</button></div> : null}
    {tab === 'nutrition' && nutritionLoading ? <div className="compare-state">영양 정보를 불러오는 중입니다.</div> : null}
    {tab === 'ingredients' && ingredientsLoading ? <div className="compare-state">원재료 정보를 불러오는 중입니다.</div> : null}

    <section className="compare-table-wrap" id={panelId} role="tabpanel" aria-labelledby={tabId} tabIndex={0}>
      <div className="compare-table" style={{ '--compare-count': items.length } as CSSProperties}>
        <div className="compare-head-row"><div className="compare-corner">비교 항목</div>{items.map((item) => <ProductHead key={item.product.product_id} item={item} onRemove={() => onRemove(item.product.product_id)} onDetail={() => onDetailOpen ? onDetailOpen(item.product.product_id) : setLocalDetailProductId(item.product.product_id)} />)}</div>
        {tab === 'overview' ? <>
          <CompareSection title={currentProduct ? '현재 사료와 비교' : '선택한 조건과 비교'} note={currentProduct ? '현재 사료와 각 후보가 어떻게 다른지 확인합니다.' : '선택한 조건과 각 제품이 어떻게 맞는지 확인합니다.'} />
          <CompareRow label={currentProduct ? '현재 사료와 비교' : '선택한 조건과 비교'} items={items} render={(item) => <RelationSummary item={item} />} />
          <CompareSection title="제품 기본 정보" note="제품에 표시된 기본 정보를 나란히 봅니다." />
          <CompareRow label="사료 형태" items={items} render={(item) => item.product.feed_type ?? '미확인'} />
          <CompareRow label="대상 연령" items={items} render={(item) => item.product.life_stage ? LIFE_STAGE_LABELS[item.product.life_stage] ?? item.product.life_stage : '미확인'} />
          <CompareRow label="제품 표기 대상" items={items} render={(item) => labels(item.product.official_targets, TARGET_LABELS)} />
          <CompareRow label="제품 특징" items={items} render={(item) => labels(item.product.features, FEATURE_LABELS)} />
          <CompareSection title="레시피 · 판매 정보" note="레시피와 판매 규격을 함께 비교합니다." />
          <CompareRow label="레시피 종류" items={items} render={(item) => labels(item.product.recipe_families, RECIPE_LABELS)} />
          <CompareRow label="주요 레시피" items={items} render={(item) => labels(item.product.recipe_details, RECIPE_LABELS)} />
          <CompareRow label="Grain-Free 표기" items={items} render={(item) => item.product.official_recipe_traits.includes('grain_free') ? '확인됨' : '공식 표기 미확인'} />
          <CompareRow label="판매 규격" items={items} render={(item) => representativePackageLabel(item.product)} />
          <CompareRow label="제조국" items={items} render={(item) => item.product.manufacturing_country_codes.map((code) => countryNames.of(code) ?? code).join(' · ') || '미확인'} />
        </> : null}

        {tab === 'nutrition' && !nutritionLoading && !nutritionError ? <>
          <CompareSection title="자료 안내" note="같은 기준으로 확인된 일반 표시값만 위 표에서 직접 비교합니다." />
          <CompareRow label="확인 기준" items={items} tone="context" render={(item) => <span className="compare-muted">{nutritionDetailContext(nutritionByProduct.get(item.product.product_id), variantsByProduct[item.product.product_id], variantLookupFailures.includes(item.product.product_id), variantsLoading)}</span>} />
          <CompareSection title="영양 성분" note="확인된 표시값을 그대로 보여줍니다. 기준이 다른 수치는 합치지 않습니다." />
          <CompareRow label="열량" items={items} tone="metric" render={(item) => { const row = nutritionByProduct.get(item.product.product_id); if (!row) return '미확인'; return row.kcal_per_kg != null ? formatNumber(row.kcal_per_kg, ' kcal/kg') : formatNumber(row.kcal_per_100g, ' kcal/100g') }} />
          <CompareRow label="조단백질" items={items} tone="metric" render={(item) => { const row = nutritionByProduct.get(item.product.product_id); return formatStandardNutrient(row, 'protein', row?.protein_pct, row?.protein_qualifier) }} />
          <CompareRow label="조지방" items={items} tone="metric" render={(item) => { const row = nutritionByProduct.get(item.product.product_id); return formatStandardNutrient(row, 'fat', row?.fat_pct, row?.fat_qualifier) }} />
          <CompareRow label="조섬유" items={items} tone="metric" render={(item) => { const row = nutritionByProduct.get(item.product.product_id); return formatStandardNutrient(row, 'fiber', row?.fiber_pct, row?.fiber_qualifier) }} />
          <CompareRow label="수분" items={items} tone="metric" render={(item) => { const row = nutritionByProduct.get(item.product.product_id); return formatStandardNutrient(row, 'moisture', row?.moisture_pct, row?.moisture_qualifier) }} />
          <CompareRow label="조회분" items={items} tone="metric" render={(item) => { const row = nutritionByProduct.get(item.product.product_id); return formatStandardNutrient(row, 'ash', row?.ash_pct, row?.ash_qualifier) }} />
          {additionalNutrientKeys.map((key) => <CompareRow key={key} label={additionalNutrientLabel(key, nutrition)} items={items} tone="metric" render={(item) => formatAdditionalNutrient(additionalNutrient(nutritionByProduct.get(item.product.product_id), key))} />)}
          {hasBasisSpecificNutrition ? <><CompareSection title="다른 기준의 영양자료" note="건물 기준 등 다른 기준의 자료는 일반 표시값과 합치거나 환산하지 않습니다." /><CompareRow label="별도 확인 자료" items={items} tone="context" render={(item) => <span className="compare-muted">{basisSpecificSummary(nutritionByProduct.get(item.product.product_id))}</span>} /></> : null}
        </> : null}

        {tab === 'ingredients' && !ingredientsLoading && !ingredientsError ? <>
          <CompareSection title="자료 안내" note="한국어 원료 요약과 제품에 표시된 출처 원문을 구분해 봅니다." />
          <CompareRow label="확인 기준" items={items} tone="context" render={(item) => <span className="compare-muted">{ingredientDetailContext(ingredientsByProduct.get(item.product.product_id), variantsByProduct[item.product.product_id], variantLookupFailures.includes(item.product.product_id), variantsLoading)}</span>} />
          <CompareSection title="원재료" note="검토된 원료명은 검색·요약용이며 출처 원문을 대체하지 않습니다." />
          <CompareRow label="목록 상태" items={items} render={(item) => { const row = ingredientsByProduct.get(item.product.product_id); if (!row) return '미확인'; const base = row.completeness_status === 'full' ? '전체 목록 확인' : row.completeness_status === 'partial' ? '일부 목록' : row.completeness_status === 'summary' ? '요약 정보' : '상태 미확인'; return row.supplemental_full_raw_text?.trim() || row.supplemental_full_ingredient_names?.length ? `${base} · 전체 목록 보완 있음` : base }} />
          <CompareRow label="직접 확인 원료" items={items} render={(item) => labels(item.product.direct_evidence_ingredient_terms, RECIPE_LABELS)} />
          <CompareRow label="향미 연관 원료" items={items} render={(item) => labels(item.product.flavor_associated_ingredient_terms, RECIPE_LABELS)} />
          <CompareRow label="출처 원문" items={items} render={(item) => { const row = ingredientsByProduct.get(item.product.product_id); if (!row) return <span className="compare-muted">확인된 목록 없음</span>; const primaryText = row.raw_text?.trim() || row.ingredient_names.join(', '); const supplementalText = row.supplemental_full_raw_text?.trim() || row.supplemental_full_ingredient_names?.join(', '); return <div><span className="compare-muted">대표 확인 자료 · 출처 원문</span><p className="compare-ingredient-text">{primaryText || '확인된 목록 없음'}</p>{supplementalText ? <><span className="compare-muted">현재 확인 배합 전체 목록 · 출처 원문</span><p className="compare-ingredient-text">{supplementalText}</p></> : null}</div> }} />
        </> : null}
      </div>
    </section>
    {tab === 'nutrition' ? <p className="compare-footnote">영양값은 확인된 표시값과 한정자·단위를 그대로 보존합니다. 기준이 다른 자료는 환산하지 않고 별도 표시합니다.</p> : null}
    {tab === 'ingredients' ? <p className="compare-footnote">정규화된 원료명은 검색·요약용이며 출처 원문을 대체하지 않습니다.</p> : null}
  </main>
}
