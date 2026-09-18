import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import ProductDetail from './ProductDetail'
import './mobile-switch-compare-picker.css'
import './mobile-two-product-overview.css'
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
type OverviewField = 'feedType' | 'lifeStage' | 'targets' | 'features' | 'recipeFamilies' | 'recipeDetails' | 'grainFree' | 'packages' | 'country'
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
function overviewValue(product: CatalogProduct, field: OverviewField): ReactNode {
  if (field === 'feedType') return product.feed_type ?? '미확인'
  if (field === 'lifeStage') return product.life_stage ? LIFE_STAGE_LABELS[product.life_stage] ?? product.life_stage : '미확인'
  if (field === 'targets') return labels(product.official_targets, TARGET_LABELS)
  if (field === 'features') return labels(product.features, FEATURE_LABELS)
  if (field === 'recipeFamilies') return labels(product.recipe_families, RECIPE_LABELS)
  if (field === 'recipeDetails') return labels(product.recipe_details, RECIPE_LABELS)
  if (field === 'grainFree') return product.official_recipe_traits.includes('grain_free') ? '확인됨' : '공식 표기 미확인'
  if (field === 'packages') return representativePackageLabel(product)
  return product.manufacturing_country_codes.map((code) => countryNames.of(code) ?? code).join(' · ') || '미확인'
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

function ProductHead({ item, onRemove, onDetail, roleLabel }: { item: CompareItem; onRemove: () => void; onDetail: () => void; roleLabel?: string }) {
  const product = item.product
  return <div className="compare-product-head">
    <button className="compare-remove" type="button" onClick={onRemove} aria-label={`${product.canonical_name} 비교에서 제거`}>×</button>
    {roleLabel ? <span className="compare-column-role">{roleLabel}</span> : null}
    <div className="compare-product-identity">{product.display_image_url ? <img src={product.display_image_url} alt="" /> : <div className="compare-image-placeholder">이미지 없음</div>}<div className="compare-product-copy"><span>{product.brand}</span><strong>{product.canonical_name}</strong><small>판매 규격 · {representativePackageLabel(product)}</small></div></div>
    <button className="compare-detail-link" type="button" onClick={onDetail}>상세 보기 →</button>
  </div>
}
function CurrentProductHead({ product, variantText }: { product: CatalogProduct; variantText?: string }) {
  return <div className="compare-product-head compare-current-product-head">
    <span className="compare-column-role">현재 사료 · 기준</span>
    <div className="compare-product-identity">{product.display_image_url ? <img src={product.display_image_url} alt="" /> : <div className="compare-image-placeholder">이미지 없음</div>}<div className="compare-product-copy"><span>{product.brand}</span><strong>{product.canonical_name}</strong><small>사용 규격 · {variantText || '사용 규격 모름'}</small><small>판매 규격 · {representativePackageLabel(product)}</small></div></div>
  </div>
}
function MobileProductHead({ role, product, variantText, onDetail, onRemove }: { role: string; product: CatalogProduct; variantText?: string; onDetail?: () => void; onRemove?: () => void }) {
  return <div className={`compare-mobile-product-head${onRemove ? ' is-candidate' : ' is-current'}`}>
    <span>{role}</span>
    <small className="compare-mobile-product-brand">{product.brand}</small>
    <strong>{product.canonical_name}</strong>
    {variantText ? <small>사용 규격 · {variantText}</small> : null}
    <small>판매 규격 · {representativePackageLabel(product)}</small>
    {onDetail || onRemove ? <div className="compare-mobile-head-actions">{onDetail ? <button type="button" onClick={onDetail}>상세 보기 →</button> : null}{onRemove ? <button type="button" onClick={onRemove}>비교에서 제거</button> : null}</div> : null}
  </div>
}
function hasRelationData(item: CompareItem) {
  return [item.confirmedMatches, item.keepMatches, item.changeMatches, item.unknowns, item.ingredientReviewedNotFound, item.ingredientInsufficient].some((values) => values?.length)
}
function RelationSummary({ item }: { item: CompareItem }) {
  const confirmed = item.confirmedMatches ?? [], keep = item.keepMatches ?? [], change = item.changeMatches ?? [], unknown = item.unknowns ?? [], reviewed = item.ingredientReviewedNotFound ?? [], insufficient = item.ingredientInsufficient ?? []
  if (!hasRelationData(item)) return <span className="compare-muted">비교할 검색 조건 없음</span>
  return <div className="compare-relations">
    {confirmed.length ? <p className="is-confirmed"><span>확인됨</span><strong>{confirmed.join(' · ')}</strong></p> : null}
    {keep.length ? <p className="is-keep"><span>유지 조건</span><strong>{keep.join(' · ')}</strong></p> : null}
    {change.length ? <p className="is-change"><span>변경 조건</span><strong>{change.join(' · ')}</strong></p> : null}
    {reviewed.length ? <p className="is-reviewed"><span>원료 확인</span><strong>{reviewed.join(' · ')} · 검토한 자료에서 찾지 못함</strong></p> : null}
    {insufficient.length ? <p className="is-unknown"><span>원료 미확인</span><strong>{insufficient.join(' · ')} · 판단 근거 부족</strong></p> : null}
    {unknown.length ? <p className="is-unknown"><span>미확인</span><strong>{unknown.join(' · ')}</strong></p> : null}
  </div>
}
function BaselineSummary() {
  return <div className="compare-baseline-summary"><strong>기준 제품</strong></div>
}
function CompareRow({ label, items, render, tone }: { label: string; items: CompareItem[]; render: (item: CompareItem) => ReactNode; tone?: CompareRowTone }) {
  return <div className={`compare-row${tone ? ` is-${tone}` : ''}`} style={{ '--compare-count': items.length } as CSSProperties}><div className="compare-row-label">{label}</div>{items.map((item) => <div className="compare-cell" key={item.product.product_id}>{render(item)}</div>)}</div>
}
function SwitchOverviewRow({ label, currentProduct, items, currentValue, candidateValue }: { label: string; currentProduct: CatalogProduct; items: CompareItem[]; currentValue: (product: CatalogProduct) => ReactNode; candidateValue: (item: CompareItem) => ReactNode }) {
  return <div className="compare-row compare-switch-overview-row" style={{ '--compare-count': items.length + 1 } as CSSProperties}><div className="compare-row-label">{label}</div><div className="compare-cell is-current">{currentValue(currentProduct)}</div>{items.map((item) => <div className="compare-cell" key={item.product.product_id}>{candidateValue(item)}</div>)}</div>
}
function MobileOverviewRow({ label, current, candidate }: { label: string; current: ReactNode; candidate: ReactNode }) {
  return <div className="compare-mobile-overview-row"><strong className="compare-mobile-row-label">{label}</strong><div className="compare-mobile-pair"><div><span>현재 사료</span><div>{current}</div></div><div><span>후보</span><div>{candidate}</div></div></div></div>
}
function MobileTwoProductOverviewRow({ fieldKey, label, items, render }: { fieldKey: string; label: string; items: CompareItem[]; render: (item: CompareItem) => ReactNode }) {
  const labelId = `compare-mobile-two-row-${fieldKey}`
  return <div className="compare-mobile-two-product-row" role="group" aria-labelledby={labelId}>
    <strong className="compare-mobile-two-product-row-label" id={labelId}>{label}</strong>
    <div className="compare-mobile-two-product-values">
      {items.map((item, index) => {
        const ownerId = `compare-mobile-two-owner-${index + 1}-${item.product.product_id}`
        return <div className="compare-mobile-two-product-value" key={item.product.product_id} aria-labelledby={`${labelId} ${ownerId}`}>{render(item)}</div>
      })}
    </div>
  </div>
}

function MobileTwoProductOverview({ items, onDetail, onRemove }: { items: CompareItem[]; onDetail: (productId: string) => void; onRemove: (productId: string) => void }) {
  return <div className="compare-mobile-two-product-overview" aria-label="2개 제품 개요 비교">
    <div className="compare-mobile-two-product-heads">
      {items.map((item, index) => {
        const product = item.product
        const ownerId = `compare-mobile-two-owner-${index + 1}-${product.product_id}`
        return <article className="compare-mobile-two-product-head" key={product.product_id}>
          <span className="compare-mobile-two-product-a11y-name" id={ownerId}>{`제품 ${index + 1} · ${product.brand} · ${product.canonical_name}`}</span>
          <div className="compare-mobile-two-product-identity">
            {product.display_image_url ? <img src={product.display_image_url} alt="" /> : <div className="compare-image-placeholder">이미지 없음</div>}
            <div className="compare-mobile-two-product-meta">
              <span className="compare-mobile-two-product-slot">제품 {index + 1}</span>
              <span className="compare-mobile-two-product-brand">{product.brand}</span>
            </div>
          </div>
          <strong className="compare-mobile-two-product-name">{product.canonical_name}</strong>
          <div className="compare-mobile-two-product-actions">
            <button type="button" aria-label={`${product.brand} ${product.canonical_name} 상세 보기`} onClick={() => onDetail(product.product_id)}>상세 보기</button>
            <button type="button" aria-label={`${product.brand} ${product.canonical_name} 비교에서 제거`} onClick={() => onRemove(product.product_id)}>제거</button>
          </div>
        </article>
      })}
    </div>

    <div className="compare-mobile-two-product-key" aria-hidden="true">
      {items.map((item, index) => <div key={item.product.product_id}><span>제품 {index + 1}</span><strong>{item.product.canonical_name}</strong></div>)}
    </div>

    {items.some(hasRelationData) ? <>
      <CompareSection title="선택한 조건과 비교" />
      <MobileTwoProductOverviewRow fieldKey="relation" label="조건 확인" items={items} render={(item) => <RelationSummary item={item} />} />
    </> : null}

    <CompareSection title="제품 기본 정보" />
    <MobileTwoProductOverviewRow fieldKey="feed-type" label="사료 형태" items={items} render={(item) => overviewValue(item.product, 'feedType')} />
    <MobileTwoProductOverviewRow fieldKey="life-stage" label="대상 연령" items={items} render={(item) => overviewValue(item.product, 'lifeStage')} />
    <MobileTwoProductOverviewRow fieldKey="targets" label="제품 표기 대상" items={items} render={(item) => overviewValue(item.product, 'targets')} />
    <MobileTwoProductOverviewRow fieldKey="features" label="제품 특징" items={items} render={(item) => overviewValue(item.product, 'features')} />

    <CompareSection title="레시피 · 판매 정보" />
    <MobileTwoProductOverviewRow fieldKey="recipe-families" label="레시피 종류" items={items} render={(item) => overviewValue(item.product, 'recipeFamilies')} />
    <MobileTwoProductOverviewRow fieldKey="recipe-details" label="주요 레시피" items={items} render={(item) => overviewValue(item.product, 'recipeDetails')} />
    <MobileTwoProductOverviewRow fieldKey="grain-free" label="Grain-Free 표기" items={items} render={(item) => overviewValue(item.product, 'grainFree')} />
    <MobileTwoProductOverviewRow fieldKey="packages" label="판매 규격" items={items} render={(item) => overviewValue(item.product, 'packages')} />
    <MobileTwoProductOverviewRow fieldKey="country" label="제조국" items={items} render={(item) => overviewValue(item.product, 'country')} />
  </div>
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
  const [mobileCandidateId, setMobileCandidateId] = useState<string | null>(() => items[0]?.product.product_id ?? null)
  const [mobileCandidatePickerOpen, setMobileCandidatePickerOpen] = useState(false)
  const detailProductId = controlledDetailProductId === undefined ? localDetailProductId : controlledDetailProductId
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const mobileCandidateToggleRef = useRef<HTMLButtonElement | null>(null)
  const mobileCandidateOptionsId = useId()

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
  const mobileCandidate = items.find((item) => item.product.product_id === mobileCandidateId) ?? items[0] ?? null
  const mobileCandidateIndex = mobileCandidate ? items.findIndex((item) => item.product.product_id === mobileCandidate.product.product_id) : -1

  useEffect(() => {
    setMobileCandidateId((current) => current && productIds.includes(current) ? current : productIds[0] ?? null)
    setMobileCandidatePickerOpen(false)
  }, [productIds.join('|')])

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

  function openDetail(productId: string) {
    if (onDetailOpen) onDetailOpen(productId)
    else setLocalDetailProductId(productId)
  }
  function selectMobileCandidate(productId: string) {
    setMobileCandidateId(productId)
    setMobileCandidatePickerOpen(false)
    requestAnimationFrame(() => mobileCandidateToggleRef.current?.focus({ preventScroll: true }))
  }
  function removeComparedProduct(productId: string) {
    if (mobileCandidateId === productId) {
      const index = items.findIndex((item) => item.product.product_id === productId)
      const fallback = items[index + 1] ?? items[index - 1] ?? null
      setMobileCandidateId(fallback?.product.product_id ?? null)
      setMobileCandidatePickerOpen(false)
    }
    onRemove(productId)
  }

  if (detailItem) return <ProductDetail product={detailItem.product} onClose={() => onDetailClose ? onDetailClose() : setLocalDetailProductId(null)} initialTab={detailTab} onTabChange={onDetailTabChange} />

  const panelId = `compare-panel-${tab}`
  const tabId = `compare-tab-${tab}`
  const switchCompare = Boolean(currentProduct)
  const switchOverview = Boolean(currentProduct && tab === 'overview')
  const twoProductOverview = !switchCompare && tab === 'overview' && items.length === 2
  const stageClassName = `compare-stage${switchCompare ? ' is-switch-compare' : ''}${switchOverview ? ' is-switch-overview' : ''}`
  const headerCopy = currentProduct
    ? tab === 'overview'
      ? `현재 사료와 ${items.length}개 후보의 제품 정보를 같은 항목으로 비교합니다.`
      : tab === 'nutrition'
        ? `담아둔 ${items.length}개 후보의 영양 정보를 비교합니다. 현재 사료는 포함하지 않습니다.`
        : `담아둔 ${items.length}개 후보의 원재료 정보를 비교합니다. 현재 사료는 포함하지 않습니다.`
    : `${items.length}개 제품을 나란히 비교합니다. 최대 5개까지 선택할 수 있습니다.`

  return <main className={stageClassName}>
    <header className="compare-header"><div><span>COMPARE</span><h1>제품 비교</h1><p>{headerCopy}</p></div><button type="button" onClick={onClose}>← 제품 목록으로</button></header>
    <nav className="compare-tabs" aria-label="비교 항목" role="tablist">{TABS.map(([key, label], index) => <button
      key={key} id={`compare-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`compare-panel-${key}`} tabIndex={tab === key ? 0 : -1}
      className={tab === key ? 'is-active' : ''} type="button" ref={(node) => { tabRefs.current[index] = node }} onKeyDown={(event) => onTabKeyDown(event, index)} onClick={() => selectTab(key)}
    >{label}</button>)}</nav>

    {tab === 'nutrition' && nutritionError ? <div className="compare-state is-error" role="alert"><p>{nutritionError}</p><button type="button" onClick={() => setReload((value) => value + 1)}>다시 시도</button></div> : null}
    {tab === 'ingredients' && ingredientsError ? <div className="compare-state is-error" role="alert"><p>{ingredientsError}</p><button type="button" onClick={() => setReload((value) => value + 1)}>다시 시도</button></div> : null}
    {tab === 'nutrition' && nutritionLoading ? <div className="compare-state">영양 정보를 불러오는 중입니다.</div> : null}
    {tab === 'ingredients' && ingredientsLoading ? <div className="compare-state">원재료 정보를 불러오는 중입니다.</div> : null}

    <section className={`compare-table-wrap${twoProductOverview ? ' is-mobile-two-product-overview' : ''}`} id={panelId} role="tabpanel" aria-labelledby={tabId} tabIndex={0}>
      {switchOverview && currentProduct ? <>
        <div className="compare-table compare-switch-overview-desktop" style={{ '--compare-count': items.length + 1 } as CSSProperties}>
          <div className="compare-head-row" style={{ '--compare-count': items.length + 1 } as CSSProperties}><div className="compare-corner">비교 항목</div><CurrentProductHead product={currentProduct} variantText={currentVariantText} />{items.map((item) => <ProductHead key={item.product.product_id} item={item} roleLabel="후보" onRemove={() => removeComparedProduct(item.product.product_id)} onDetail={() => openDetail(item.product.product_id)} />)}</div>
          <CompareSection title="제품 기본 정보" note="제품에 표시된 기본 정보를 같은 항목으로 비교합니다." />
          <SwitchOverviewRow label="사료 형태" currentProduct={currentProduct} items={items} currentValue={(product) => overviewValue(product, 'feedType')} candidateValue={(item) => overviewValue(item.product, 'feedType')} />
          <SwitchOverviewRow label="대상 연령" currentProduct={currentProduct} items={items} currentValue={(product) => overviewValue(product, 'lifeStage')} candidateValue={(item) => overviewValue(item.product, 'lifeStage')} />
          <SwitchOverviewRow label="제품 표기 대상" currentProduct={currentProduct} items={items} currentValue={(product) => overviewValue(product, 'targets')} candidateValue={(item) => overviewValue(item.product, 'targets')} />
          <SwitchOverviewRow label="제품 특징" currentProduct={currentProduct} items={items} currentValue={(product) => overviewValue(product, 'features')} candidateValue={(item) => overviewValue(item.product, 'features')} />
          <CompareSection title="레시피 · 판매 정보" note="사용 규격과 제품의 판매 규격을 구분해 표시합니다." />
          <SwitchOverviewRow label="레시피 종류" currentProduct={currentProduct} items={items} currentValue={(product) => overviewValue(product, 'recipeFamilies')} candidateValue={(item) => overviewValue(item.product, 'recipeFamilies')} />
          <SwitchOverviewRow label="주요 레시피" currentProduct={currentProduct} items={items} currentValue={(product) => overviewValue(product, 'recipeDetails')} candidateValue={(item) => overviewValue(item.product, 'recipeDetails')} />
          <SwitchOverviewRow label="Grain-Free 표기" currentProduct={currentProduct} items={items} currentValue={(product) => overviewValue(product, 'grainFree')} candidateValue={(item) => overviewValue(item.product, 'grainFree')} />
          <SwitchOverviewRow label="판매 규격" currentProduct={currentProduct} items={items} currentValue={(product) => overviewValue(product, 'packages')} candidateValue={(item) => overviewValue(item.product, 'packages')} />
          <SwitchOverviewRow label="제조국" currentProduct={currentProduct} items={items} currentValue={(product) => overviewValue(product, 'country')} candidateValue={(item) => overviewValue(item.product, 'country')} />
          <CompareSection title="선택한 조건" note="조건 확인 결과는 후보에만 표시합니다." />
          <SwitchOverviewRow label="후보 조건 확인" currentProduct={currentProduct} items={items} currentValue={() => <BaselineSummary />} candidateValue={(item) => <RelationSummary item={item} />} />
        </div>

        {mobileCandidate ? <div className="compare-switch-mobile-overview">
          {items.length > 1 ? <div className={`compare-mobile-candidate-picker${mobileCandidatePickerOpen ? ' is-open' : ''}`} role="group" aria-label="표시할 후보">
            <button
              ref={mobileCandidateToggleRef}
              className="compare-mobile-candidate-toggle"
              type="button"
              aria-expanded={mobileCandidatePickerOpen}
              aria-controls={mobileCandidateOptionsId}
              onClick={() => setMobileCandidatePickerOpen((open) => !open)}
            >
              <span className="compare-mobile-candidate-meta">후보 {items.length}개 · {Math.max(mobileCandidateIndex + 1, 1)}/{items.length}</span>
              <span className="compare-mobile-candidate-current">
                <span className="compare-mobile-candidate-brand">{mobileCandidate.product.brand}</span>
                <strong className="compare-mobile-candidate-name">{mobileCandidate.product.canonical_name}</strong>
              </span>
              <span className="compare-mobile-candidate-chevron" aria-hidden="true">⌄</span>
            </button>
            <div id={mobileCandidateOptionsId} className="compare-mobile-candidate-options" hidden={!mobileCandidatePickerOpen}>
              {items.map((item, index) => <button
                key={item.product.product_id}
                data-product-id={item.product.product_id}
                type="button"
                aria-pressed={mobileCandidate.product.product_id === item.product.product_id}
                className={mobileCandidate.product.product_id === item.product.product_id ? 'is-active' : ''}
                onClick={() => selectMobileCandidate(item.product.product_id)}
                aria-label={`후보 ${index + 1}: ${item.product.brand} ${item.product.canonical_name} 표시`}
              >{item.product.brand} · {item.product.canonical_name}</button>)}
            </div>
          </div> : null}
          <div className="compare-mobile-head-grid">
            <MobileProductHead role="현재 사료 · 기준" product={currentProduct} variantText={currentVariantText || '사용 규격 모름'} />
            <MobileProductHead role="표시 중인 후보" product={mobileCandidate.product} onDetail={() => openDetail(mobileCandidate.product.product_id)} onRemove={() => removeComparedProduct(mobileCandidate.product.product_id)} />
          </div>
          <CompareSection title="제품 기본 정보" note="같은 항목의 두 값을 나란히 봅니다." />
          <MobileOverviewRow label="사료 형태" current={overviewValue(currentProduct, 'feedType')} candidate={overviewValue(mobileCandidate.product, 'feedType')} />
          <MobileOverviewRow label="대상 연령" current={overviewValue(currentProduct, 'lifeStage')} candidate={overviewValue(mobileCandidate.product, 'lifeStage')} />
          <MobileOverviewRow label="제품 표기 대상" current={overviewValue(currentProduct, 'targets')} candidate={overviewValue(mobileCandidate.product, 'targets')} />
          <MobileOverviewRow label="제품 특징" current={overviewValue(currentProduct, 'features')} candidate={overviewValue(mobileCandidate.product, 'features')} />
          <CompareSection title="레시피 · 판매 정보" note="사용 규격은 머리의 현재 사료 정보에 별도로 표시합니다." />
          <MobileOverviewRow label="레시피 종류" current={overviewValue(currentProduct, 'recipeFamilies')} candidate={overviewValue(mobileCandidate.product, 'recipeFamilies')} />
          <MobileOverviewRow label="주요 레시피" current={overviewValue(currentProduct, 'recipeDetails')} candidate={overviewValue(mobileCandidate.product, 'recipeDetails')} />
          <MobileOverviewRow label="Grain-Free 표기" current={overviewValue(currentProduct, 'grainFree')} candidate={overviewValue(mobileCandidate.product, 'grainFree')} />
          <MobileOverviewRow label="판매 규격" current={overviewValue(currentProduct, 'packages')} candidate={overviewValue(mobileCandidate.product, 'packages')} />
          <MobileOverviewRow label="제조국" current={overviewValue(currentProduct, 'country')} candidate={overviewValue(mobileCandidate.product, 'country')} />
          <CompareSection title="선택한 조건" note="조건 확인 결과는 후보에만 표시합니다." />
          <MobileOverviewRow label="후보 조건 확인" current={<BaselineSummary />} candidate={<RelationSummary item={mobileCandidate} />} />
        </div> : null}
      </> : <>
        {twoProductOverview ? <MobileTwoProductOverview items={items} onDetail={openDetail} onRemove={removeComparedProduct} /> : null}
        <div className={`compare-table${twoProductOverview ? ' compare-two-product-overview-desktop' : ''}`} style={{ '--compare-count': items.length } as CSSProperties}>
        <div className="compare-head-row"><div className="compare-corner">비교 항목</div>{items.map((item) => <ProductHead key={item.product.product_id} item={item} roleLabel={currentProduct ? '후보' : undefined} onRemove={() => removeComparedProduct(item.product.product_id)} onDetail={() => openDetail(item.product.product_id)} />)}</div>
        {tab === 'overview' ? <>
          {items.some(hasRelationData) ? <>
            <CompareSection title="선택한 조건과 비교" note="선택한 조건과 각 제품이 어떻게 맞는지 확인합니다." />
            <CompareRow label="선택한 조건과 비교" items={items} render={(item) => <RelationSummary item={item} />} />
          </> : null}
          <CompareSection title="제품 기본 정보" note="제품에 표시된 기본 정보를 나란히 봅니다." />
          <CompareRow label="사료 형태" items={items} render={(item) => overviewValue(item.product, 'feedType')} />
          <CompareRow label="대상 연령" items={items} render={(item) => overviewValue(item.product, 'lifeStage')} />
          <CompareRow label="제품 표기 대상" items={items} render={(item) => overviewValue(item.product, 'targets')} />
          <CompareRow label="제품 특징" items={items} render={(item) => overviewValue(item.product, 'features')} />
          <CompareSection title="레시피 · 판매 정보" note="레시피와 판매 규격을 함께 비교합니다." />
          <CompareRow label="레시피 종류" items={items} render={(item) => overviewValue(item.product, 'recipeFamilies')} />
          <CompareRow label="주요 레시피" items={items} render={(item) => overviewValue(item.product, 'recipeDetails')} />
          <CompareRow label="Grain-Free 표기" items={items} render={(item) => overviewValue(item.product, 'grainFree')} />
          <CompareRow label="판매 규격" items={items} render={(item) => overviewValue(item.product, 'packages')} />
          <CompareRow label="제조국" items={items} render={(item) => overviewValue(item.product, 'country')} />
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
      </div></>}
    </section>
    {tab === 'nutrition' ? <p className="compare-footnote">영양값은 확인된 표시값과 한정자·단위를 그대로 보존합니다. 기준이 다른 자료는 환산하지 않고 별도 표시합니다.</p> : null}
    {tab === 'ingredients' ? <p className="compare-footnote">정규화된 원료명은 검색·요약용이며 출처 원문을 대체하지 않습니다.</p> : null}
  </main>
}
