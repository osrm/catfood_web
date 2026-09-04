import { useEffect, useMemo, useState, type ReactNode } from 'react'
import CompareView, { type CompareItem } from './CompareView'
import ProductDetail from './ProductDetail'
import {
  fetchProductVariants,
  type CatalogProduct,
  type ProductVariant,
} from './api'
import { lookupCatalog, toggleValue, type SearchState } from './search'

const FEED_TYPES = [
  ['건식', '건식'],
  ['습식', '습식'],
  ['동결건조', '동결건조'],
] as const

const LIFE_STAGES = [
  ['kitten', '키튼'],
  ['adult', '성묘'],
  ['senior', '시니어'],
  ['all_life_stages', '전연령'],
  ['gestation_lactation_and_kitten', '임신·수유·키튼'],
] as const

const TARGETS = [
  ['indoor', '실내묘'],
  ['sterilized', '중성화묘'],
] as const

const FEATURES = [
  ['weight_management', '체중 관리'],
  ['stool', '변 상태'],
  ['hairball', '헤어볼'],
  ['digestive', '소화'],
  ['urinary', '요로'],
  ['skin_coat', '피부·피모'],
  ['dental', '덴탈'],
] as const

const RECIPE_FAMILIES = [
  ['poultry', '가금류'],
  ['meat', '육류'],
  ['fish', '생선'],
] as const

const FEED_TYPE_LABELS = Object.fromEntries(FEED_TYPES)
const LIFE_STAGE_LABELS = Object.fromEntries(LIFE_STAGES)
const TARGET_LABELS = Object.fromEntries(TARGETS)
const FEATURE_LABELS = Object.fromEntries(FEATURES)
const RECIPE_FAMILY_LABELS = Object.fromEntries(RECIPE_FAMILIES)

const RECIPE_DETAIL_LABELS: Record<string, string> = {
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

const INGREDIENT_LABELS: Record<string, string> = {
  ...RECIPE_DETAIL_LABELS,
  poultry: '가금류',
  fish: '생선',
  sardine: '정어리',
  anchovy: '멸치',
  shrimp: '새우',
  egg: '계란',
}

const COUNTRY_LABELS: Record<string, string> = {
  KR: '한국',
  US: '미국',
  CA: '캐나다',
  GB: '영국',
  AU: '호주',
  NZ: '뉴질랜드',
  NL: '네덜란드',
  TH: '태국',
  DE: '독일',
  FR: '프랑스',
  IT: '이탈리아',
  CZ: '체코',
  AT: '오스트리아',
  JP: '일본',
}

const EMPTY_CRITERIA: SearchState = {
  feedType: '',
  lifeStage: '',
  officialTargets: [],
  features: [],
  recipeFamilies: [],
  grainFree: false,
}

type SwitchStep = 'current' | 'sku' | 'change' | 'keep' | 'results'
type SecondaryMode = 'explore' | 'lookup'
type Option = readonly [string, string]
type ConditionSource = 'change' | 'keep'
type ConditionKind =
  | 'brand'
  | 'feedType'
  | 'lifeStage'
  | 'officialTarget'
  | 'feature'
  | 'recipeFamily'
  | 'grainFree'
  | 'ingredientAvoid'

type SwitchCondition = {
  source: ConditionSource
  kind: ConditionKind
  value: string
  label: string
  hard: boolean
}

type SwitchEvaluation = {
  product: CatalogProduct
  keepMatches: string[]
  changeMatches: string[]
  unknowns: string[]
  ingredientReviewedNotFound: string[]
  ingredientInsufficient: string[]
}

type IngredientEvidenceSource = Pick<
  CatalogProduct,
  | 'confirmed_present_ingredient_terms'
  | 'direct_evidence_ingredient_terms'
  | 'flavor_associated_ingredient_terms'
  | 'reviewed_not_found_ingredient_terms'
>

function optionLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replaceAll('_', ' ')
}

function ingredientLabel(value: string): string {
  return optionLabel(value, INGREDIENT_LABELS)
}

function compactList(values: string[], labels: Record<string, string>, max = 3): string {
  if (values.length === 0) return '확인된 값 없음'
  const shown = values.slice(0, max).map((value) => optionLabel(value, labels))
  return values.length > max ? `${shown.join(' · ')} +${values.length - max}` : shown.join(' · ')
}

function countryListLabel(values: string[]): string {
  if (values.length === 0) return '미확인'
  return values
    .map((value) => COUNTRY_LABELS[value] ? `${COUNTRY_LABELS[value]} (${value})` : value)
    .join(' · ')
}

function ProductImage({ product, className }: { product: CatalogProduct; className: string }) {
  if (!product.display_image_url) {
    return <div className={`${className} switch-image-placeholder`}>이미지 없음</div>
  }

  return (
    <img
      alt=""
      className={className}
      loading="lazy"
      src={product.display_image_url}
      onError={(event) => {
        event.currentTarget.style.visibility = 'hidden'
      }}
    />
  )
}

function ChoiceButtons({
  options,
  selected,
  onToggle,
  emptyText,
}: {
  options: readonly Option[]
  selected: string[]
  onToggle: (value: string) => void
  emptyText?: string
}) {
  if (options.length === 0) {
    return emptyText ? <p className="switch-option-empty">{emptyText}</p> : null
  }

  return (
    <div className="switch-choice-grid">
      {options.map(([value, label]) => (
        <button
          className={selected.includes(value) ? 'switch-choice is-active' : 'switch-choice'}
          key={value}
          type="button"
          aria-pressed={selected.includes(value)}
          onClick={() => onToggle(value)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function CriterionSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="switch-criterion-section">
      <div className="switch-criterion-heading">
        <strong>{title}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

function variantLabel(variant: ProductVariant | null): string {
  if (!variant) return '사용 규격 모름'
  const size = variant.package_size_text || '규격 표기 미확인'
  if (variant.units_per_sale && variant.units_per_sale > 1) {
    return `${size} · ${variant.units_per_sale}개 구성`
  }
  return size
}

function formulaEvidenceLabel(variant: ProductVariant | null): string {
  if (!variant) return '규격을 몰라 배합 근거 미확인'
  if (variant.formula_evidence_status === 'confirmed') return '현재 규격 배합 근거 확인됨'
  if (variant.formula_evidence_status === 'conflicting') return '현재 규격 배합 근거 충돌'
  if (variant.formula_evidence_status === 'unresolved') return '현재 규격 배합 근거 미확정'
  return '현재 규격 배합 근거 미확인'
}

function currentStepIndex(step: SwitchStep): number {
  if (step === 'current') return 0
  if (step === 'sku') return 1
  if (step === 'change') return 2
  if (step === 'keep') return 3
  return 4
}

function ingredientEvidenceLabel(source: IngredientEvidenceSource, term: string): string {
  const direct = source.direct_evidence_ingredient_terms.includes(term)
  const flavor = source.flavor_associated_ingredient_terms.includes(term)
  if (direct && flavor) return '직접 · 향미 관련 근거'
  if (direct) return '직접 근거'
  if (flavor) return '향미 관련 근거'
  return '확인 근거'
}

function ingredientAvoidanceStatus(product: CatalogProduct, term: string): string {
  if (product.confirmed_present_ingredient_terms.includes(term)) return '확인됨 — 회피 조건과 충돌'
  if (product.reviewed_not_found_ingredient_terms.includes(term)) return '검토 근거에서 찾지 못함'
  return '판단 근거 부족'
}

function SwitchTopbar({
  productCount,
  loading,
  error,
  onHome,
  onModeChange,
}: {
  productCount: number
  loading: boolean
  error: string | null
  onHome: () => void
  onModeChange: (mode: SecondaryMode) => void
}) {
  return (
    <header className="research-topbar">
      <button className="research-brand" type="button" onClick={onHome}>FELINE ARCHIVE</button>
      <nav className="mode-nav" aria-label="탐색 모드">
        <button className="mode-button" type="button" onClick={() => onModeChange('explore')}>조건으로 찾기</button>
        <button className="mode-button" type="button" onClick={() => onModeChange('lookup')}>제품 찾기</button>
        <button className="mode-button is-active" type="button">현재 사료</button>
      </nav>
      <div className="research-status">
        <span>{productCount || '—'} PRODUCTS</span>
        <span className={error ? 'is-error' : ''}>{error ? '연결 오류' : loading ? '불러오는 중' : '데이터 연결됨'}</span>
      </div>
    </header>
  )
}

function ReferenceRail({
  product,
  variant,
  step,
  onChangeProduct,
}: {
  product: CatalogProduct
  variant: ProductVariant | null
  step: SwitchStep
  onChangeProduct: () => void
}) {
  const activeIndex = currentStepIndex(step)
  const steps = ['현재 제품', '사용 규격', 'CHANGE', 'KEEP', '후보']

  return (
    <aside className="switch-reference-rail">
      <div className="switch-reference-label">CURRENT</div>
      <div className="switch-reference-product">
        <ProductImage className="switch-reference-image" product={product} />
        <div>
          <span>{product.brand}</span>
          <strong>{product.canonical_name}</strong>
          <small>
            {product.feed_type ?? '형태 미확인'} ·{' '}
            {product.life_stage ? optionLabel(product.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'}
          </small>
        </div>
      </div>
      <div className="switch-reference-sku">
        <span>현재 규격</span>
        <strong>{variantLabel(variant)}</strong>
        <span>배합 근거</span>
        <strong>{formulaEvidenceLabel(variant)}</strong>
      </div>
      <button className="switch-change-current" type="button" onClick={onChangeProduct}>현재 제품 다시 선택</button>

      <ol className="switch-progress" aria-label="현재 사료 전환 단계">
        {steps.map((label, index) => (
          <li className={index === activeIndex ? 'is-current' : index < activeIndex ? 'is-done' : ''} key={label}>
            <span>{index < activeIndex ? '✓' : index + 1}</span>
            <strong>{label}</strong>
          </li>
        ))}
      </ol>
    </aside>
  )
}

function criteriaCount(criteria: SearchState): number {
  return Number(Boolean(criteria.feedType))
    + Number(Boolean(criteria.lifeStage))
    + criteria.officialTargets.length
    + criteria.features.length
    + criteria.recipeFamilies.length
    + Number(criteria.grainFree)
}

function criteriaLabels(criteria: SearchState): string[] {
  const values: string[] = []
  if (criteria.feedType) values.push(optionLabel(criteria.feedType, FEED_TYPE_LABELS))
  if (criteria.lifeStage) values.push(optionLabel(criteria.lifeStage, LIFE_STAGE_LABELS))
  values.push(...criteria.officialTargets.map((value) => optionLabel(value, TARGET_LABELS)))
  values.push(...criteria.features.map((value) => optionLabel(value, FEATURE_LABELS)))
  values.push(...criteria.recipeFamilies.map((value) => optionLabel(value, RECIPE_FAMILY_LABELS)))
  if (criteria.grainFree) values.push('Grain-Free 공식 표방')
  return values
}

function buildConditions({
  change,
  keep,
  changeBrand,
  keepBrand,
  ingredientAvoidTerms,
  currentProduct,
}: {
  change: SearchState
  keep: SearchState
  changeBrand: boolean
  keepBrand: boolean
  ingredientAvoidTerms: string[]
  currentProduct: CatalogProduct
}): SwitchCondition[] {
  const conditions: SwitchCondition[] = []

  if (changeBrand) {
    conditions.push({ source: 'change', kind: 'brand', value: currentProduct.brand, label: '다른 브랜드', hard: true })
  }
  if (keepBrand) {
    conditions.push({ source: 'keep', kind: 'brand', value: currentProduct.brand, label: `브랜드 · ${currentProduct.brand}`, hard: true })
  }

  const pushSearch = (source: ConditionSource, criteria: SearchState) => {
    if (criteria.feedType) {
      conditions.push({ source, kind: 'feedType', value: criteria.feedType, label: `형태 · ${optionLabel(criteria.feedType, FEED_TYPE_LABELS)}`, hard: true })
    }
    if (criteria.lifeStage) {
      conditions.push({ source, kind: 'lifeStage', value: criteria.lifeStage, label: `생애주기 · ${optionLabel(criteria.lifeStage, LIFE_STAGE_LABELS)}`, hard: true })
    }
    for (const value of criteria.officialTargets) {
      conditions.push({ source, kind: 'officialTarget', value, label: `공식 대상 · ${optionLabel(value, TARGET_LABELS)}`, hard: false })
    }
    for (const value of criteria.features) {
      conditions.push({ source, kind: 'feature', value, label: `기능 · ${optionLabel(value, FEATURE_LABELS)}`, hard: false })
    }
    for (const value of criteria.recipeFamilies) {
      conditions.push({ source, kind: 'recipeFamily', value, label: `레시피 · ${optionLabel(value, RECIPE_FAMILY_LABELS)}`, hard: false })
    }
    if (criteria.grainFree) {
      conditions.push({ source, kind: 'grainFree', value: 'grain_free', label: 'Grain-Free 공식 표방', hard: false })
    }
  }

  pushSearch('change', change)
  pushSearch('keep', keep)

  for (const term of ingredientAvoidTerms) {
    conditions.push({
      source: 'change',
      kind: 'ingredientAvoid',
      value: term,
      label: ingredientLabel(term),
      hard: true,
    })
  }

  return conditions
}

function evaluateSwitchCandidate(product: CatalogProduct, conditions: SwitchCondition[]): SwitchEvaluation | null {
  const keepMatches: string[] = []
  const changeMatches: string[] = []
  const unknowns: string[] = []
  const ingredientReviewedNotFound: string[] = []
  const ingredientInsufficient: string[] = []

  for (const condition of conditions) {
    if (condition.kind === 'ingredientAvoid') {
      if (product.confirmed_present_ingredient_terms.includes(condition.value)) return null
      if (product.reviewed_not_found_ingredient_terms.includes(condition.value)) {
        ingredientReviewedNotFound.push(condition.label)
      } else {
        ingredientInsufficient.push(condition.label)
      }
      continue
    }

    let status: 'match' | 'conflict' | 'unknown' = 'unknown'

    if (condition.kind === 'brand') {
      status = condition.source === 'change'
        ? product.brand !== condition.value ? 'match' : 'conflict'
        : product.brand === condition.value ? 'match' : 'conflict'
    } else if (condition.kind === 'feedType') {
      status = !product.feed_type ? 'unknown' : product.feed_type === condition.value ? 'match' : 'conflict'
    } else if (condition.kind === 'lifeStage') {
      status = !product.life_stage ? 'unknown' : product.life_stage === condition.value ? 'match' : 'conflict'
    } else if (condition.kind === 'officialTarget') {
      status = product.official_targets.includes(condition.value) ? 'match' : 'unknown'
    } else if (condition.kind === 'feature') {
      status = product.features.includes(condition.value) ? 'match' : 'unknown'
    } else if (condition.kind === 'recipeFamily') {
      status = product.recipe_families.includes(condition.value) ? 'match' : 'unknown'
    } else if (condition.kind === 'grainFree') {
      status = product.official_recipe_traits.includes('grain_free') ? 'match' : 'unknown'
    }

    if (status === 'conflict' && condition.hard) return null
    if (status === 'match') {
      if (condition.source === 'keep') keepMatches.push(condition.label)
      else changeMatches.push(condition.label)
    } else if (status === 'unknown') {
      unknowns.push(condition.label)
    }
  }

  return {
    product,
    keepMatches,
    changeMatches,
    unknowns,
    ingredientReviewedNotFound,
    ingredientInsufficient,
  }
}

function RelationBlock({ evaluation }: { evaluation: SwitchEvaluation }) {
  const hasAny = evaluation.keepMatches.length > 0
    || evaluation.changeMatches.length > 0
    || evaluation.unknowns.length > 0
    || evaluation.ingredientReviewedNotFound.length > 0
    || evaluation.ingredientInsufficient.length > 0

  if (!hasAny) return <p className="switch-relation-empty">추가 조건 없이 탐색</p>

  return (
    <div className="switch-candidate-relations">
      {evaluation.keepMatches.length > 0 ? (
        <div className="switch-relation-line is-keep"><span>유지 확인</span><strong>{evaluation.keepMatches.slice(0, 2).join(' · ')}</strong></div>
      ) : null}
      {evaluation.changeMatches.length > 0 ? (
        <div className="switch-relation-line is-change"><span>변경 확인</span><strong>{evaluation.changeMatches.slice(0, 2).join(' · ')}</strong></div>
      ) : null}
      {evaluation.ingredientReviewedNotFound.length > 0 ? (
        <div className="switch-relation-line is-ingredient-reviewed"><span>원료 검토</span><strong>{evaluation.ingredientReviewedNotFound.slice(0, 2).join(' · ')} · 검토 근거에서 찾지 못함</strong></div>
      ) : null}
      {evaluation.ingredientInsufficient.length > 0 ? (
        <div className="switch-relation-line is-ingredient-unknown"><span>원료 미확인</span><strong>{evaluation.ingredientInsufficient.slice(0, 2).join(' · ')} · 판단 근거 부족</strong></div>
      ) : null}
      {evaluation.unknowns.length > 0 ? (
        <div className="switch-relation-line is-unknown"><span>미확인</span><strong>{evaluation.unknowns.slice(0, 2).join(' · ')}</strong></div>
      ) : null}
    </div>
  )
}

export default function SwitchFlow({
  products,
  loading,
  error,
  initialQuery = '',
  onHome,
  onModeChange,
}: {
  products: CatalogProduct[]
  loading: boolean
  error: string | null
  initialQuery?: string
  onHome: () => void
  onModeChange: (mode: SecondaryMode) => void
}) {
  const [step, setStep] = useState<SwitchStep>('current')
  const [query, setQuery] = useState(initialQuery)
  const [previewProductId, setPreviewProductId] = useState<string | null>(null)
  const [currentProductId, setCurrentProductId] = useState<string | null>(null)
  const [variants, setVariants] = useState<ProductVariant[]>([])
  const [variantLoading, setVariantLoading] = useState(false)
  const [variantError, setVariantError] = useState<string | null>(null)
  const [currentVariantId, setCurrentVariantId] = useState<string | null>(null)
  const [change, setChange] = useState<SearchState>(EMPTY_CRITERIA)
  const [keep, setKeep] = useState<SearchState>(EMPTY_CRITERIA)
  const [changeBrand, setChangeBrand] = useState(false)
  const [keepBrand, setKeepBrand] = useState(false)
  const [ingredientAvoidTerms, setIngredientAvoidTerms] = useState<string[]>([])
  const [ingredientSearch, setIngredientSearch] = useState('')
  const [noChangeIntent, setNoChangeIntent] = useState(false)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [compareOpen, setCompareOpen] = useState(false)
  const [detailProductId, setDetailProductId] = useState<string | null>(null)

  const currentProduct = products.find((product) => product.product_id === currentProductId) ?? null
  const previewProduct = products.find((product) => product.product_id === previewProductId) ?? null
  const detailProduct = products.find((product) => product.product_id === detailProductId) ?? null
  const selectedVariant = variants.find((variant) => variant.variant_id === currentVariantId) ?? null
  const currentFormulaConfirmed = selectedVariant?.formula_evidence_status === 'confirmed'
  const currentRecipeFamilies = currentFormulaConfirmed ? selectedVariant.recipe_families : []
  const currentRecipeTraits = currentFormulaConfirmed ? selectedVariant.official_recipe_traits : []
  const currentIsGrainFree = currentRecipeTraits.includes('grain_free')

  const searchResults = useMemo(() => lookupCatalog(products, query).slice(0, 80), [products, query])

  const ingredientTerms = useMemo(() => {
    const values = new Set<string>()
    for (const product of products) {
      product.confirmed_present_ingredient_terms.forEach((value) => values.add(value))
      product.reviewed_not_found_ingredient_terms.forEach((value) => values.add(value))
      product.insufficient_evidence_ingredient_terms.forEach((value) => values.add(value))
    }
    return [...values].sort((a, b) => ingredientLabel(a).localeCompare(ingredientLabel(b), 'ko-KR'))
  }, [products])

  const ingredientSearchResults = useMemo(() => {
    const normalized = ingredientSearch.trim().toLocaleLowerCase('ko-KR')
    if (!normalized) return []
    return ingredientTerms
      .filter((term) => !ingredientAvoidTerms.includes(term))
      .filter((term) => {
        const raw = term.toLocaleLowerCase('en')
        const label = ingredientLabel(term).toLocaleLowerCase('ko-KR')
        return raw.includes(normalized) || label.includes(normalized)
      })
      .slice(0, 8)
  }, [ingredientTerms, ingredientSearch, ingredientAvoidTerms])

  useEffect(() => {
    if (!currentProductId) return
    const controller = new AbortController()
    let active = true
    setVariantLoading(true)
    setVariantError(null)
    setVariants([])

    fetchProductVariants(currentProductId, controller.signal)
      .then((data) => {
        if (!active) return
        setVariants(data)
        if (data.length === 1) setCurrentVariantId(data[0].variant_id)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) setVariantError(reason instanceof Error ? reason.message : '판매 규격을 불러오지 못했습니다.')
      })
      .finally(() => {
        if (active) setVariantLoading(false)
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [currentProductId])

  const conditions = useMemo(() => currentProduct ? buildConditions({
    change,
    keep,
    changeBrand,
    keepBrand,
    ingredientAvoidTerms,
    currentProduct,
  }) : [], [change, keep, changeBrand, keepBrand, ingredientAvoidTerms, currentProduct])

  const candidates = useMemo(() => {
    if (!currentProduct) return []
    const values: SwitchEvaluation[] = []
    for (const product of products) {
      if (product.product_id === currentProduct.product_id) continue
      const evaluation = evaluateSwitchCandidate(product, conditions)
      if (evaluation) values.push(evaluation)
    }
    return values.sort((a, b) => {
      const overlapA = a.keepMatches.length + a.changeMatches.length
      const overlapB = b.keepMatches.length + b.changeMatches.length
      if (overlapB !== overlapA) return overlapB - overlapA
      const brandOrder = a.product.brand.localeCompare(b.product.brand, 'ko-KR')
      if (brandOrder !== 0) return brandOrder
      return a.product.canonical_name.localeCompare(b.product.canonical_name, 'ko-KR')
    })
  }, [products, currentProduct, conditions])

  const selectedCandidate = candidates.find((item) => item.product.product_id === selectedCandidateId) ?? null
  const hasChange = changeBrand || criteriaCount(change) > 0 || ingredientAvoidTerms.length > 0
  const compareItems = useMemo<CompareItem[]>(() => compareIds
    .map((productId) => candidates.find((item) => item.product.product_id === productId))
    .filter((item): item is SwitchEvaluation => Boolean(item))
    .map((item) => ({
      product: item.product,
      keepMatches: item.keepMatches,
      changeMatches: item.changeMatches,
      unknowns: item.unknowns,
      ingredientReviewedNotFound: item.ingredientReviewedNotFound,
      ingredientInsufficient: item.ingredientInsufficient,
    })), [compareIds, candidates])

  function clearFormulaDependentSelections() {
    setChange((current) => ({ ...current, recipeFamilies: [], grainFree: false }))
    setKeep((current) => ({ ...current, recipeFamilies: [], grainFree: false }))
    setIngredientAvoidTerms([])
    setIngredientSearch('')
  }

  function selectCurrentVariant(variantId: string | null) {
    setCurrentVariantId(variantId)
    clearFormulaDependentSelections()
  }

  function addIngredientAvoid(term: string) {
    setNoChangeIntent(false)
    setIngredientAvoidTerms((current) => current.includes(term) ? current : [...current, term])
    setIngredientSearch('')
  }

  function removeIngredientAvoid(term: string) {
    setIngredientAvoidTerms((current) => current.filter((value) => value !== term))
  }

  function toggleCompare(productId: string) {
    setCompareIds((current) => {
      if (current.includes(productId)) return current.filter((value) => value !== productId)
      if (current.length >= 5) return current
      return [...current, productId]
    })
  }

  function confirmCurrentProduct(product: CatalogProduct) {
    setCurrentProductId(product.product_id)
    setPreviewProductId(null)
    setCurrentVariantId(null)
    setChange(EMPTY_CRITERIA)
    setKeep(EMPTY_CRITERIA)
    setChangeBrand(false)
    setKeepBrand(false)
    setIngredientAvoidTerms([])
    setIngredientSearch('')
    setNoChangeIntent(false)
    setSelectedCandidateId(null)
    setCompareIds([])
    setCompareOpen(false)
    setDetailProductId(null)
    setStep('sku')
  }

  function resetCurrentProduct() {
    setStep('current')
    setCurrentProductId(null)
    setCurrentVariantId(null)
    setVariants([])
    setVariantError(null)
    setPreviewProductId(null)
    setChange(EMPTY_CRITERIA)
    setKeep(EMPTY_CRITERIA)
    setChangeBrand(false)
    setKeepBrand(false)
    setIngredientAvoidTerms([])
    setIngredientSearch('')
    setNoChangeIntent(false)
    setSelectedCandidateId(null)
    setCompareIds([])
    setCompareOpen(false)
    setDetailProductId(null)
  }

  function toggleChangeArray(field: 'officialTargets' | 'features' | 'recipeFamilies', value: string) {
    setNoChangeIntent(false)
    setChange((current) => ({ ...current, [field]: toggleValue(current[field], value) }))
  }

  function setChangeSingle(field: 'feedType' | 'lifeStage', value: string) {
    setNoChangeIntent(false)
    setChange((current) => ({ ...current, [field]: current[field] === value ? '' : value }))
  }

  function toggleKeepArray(field: 'officialTargets' | 'features' | 'recipeFamilies', value: string) {
    setKeep((current) => ({ ...current, [field]: toggleValue(current[field], value) }))
  }

  function setKeepSingle(field: 'feedType' | 'lifeStage', value: string) {
    setKeep((current) => ({ ...current, [field]: current[field] === value ? '' : value }))
  }

  function renderCurrentStage() {
    return (
      <main className="switch-find-stage">
        <section className="switch-find-hero">
          <span className="switch-eyebrow">CURRENT FOOD</span>
          <h1>현재 먹이는 사료를 찾으세요.</h1>
          <p>선택한 제품과 실제 사용 규격을 기준점으로 다음 사료의 차이를 탐색합니다.</p>
          <label className="switch-find-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
            <input
              autoFocus
              type="search"
              value={query}
              placeholder="브랜드 또는 제품명 검색"
              onChange={(event) => {
                setQuery(event.target.value)
                setPreviewProductId(null)
              }}
            />
          </label>
        </section>

        <section className={previewProduct ? 'switch-find-body is-inspecting' : 'switch-find-body'}>
          <div className="switch-find-results">
            <div className="switch-find-results-heading">
              <strong>검색 결과</strong>
              <span>{query.trim() ? `${searchResults.length}개 표시` : '브랜드 또는 제품명의 일부를 입력하세요.'}</span>
            </div>
            <div className="switch-find-results-list">
              {error ? <div className="switch-state-message is-error">{error}</div> : null}
              {loading ? <div className="switch-state-message">제품 데이터를 불러오는 중입니다.</div> : null}
              {!loading && !error && query.trim() && searchResults.length === 0 ? <div className="switch-state-message">검색 결과가 없습니다.</div> : null}
              {searchResults.map((product) => (
                <button
                  className={previewProductId === product.product_id ? 'switch-find-result is-selected' : 'switch-find-result'}
                  key={product.product_id}
                  type="button"
                  onClick={() => setPreviewProductId(product.product_id)}
                >
                  <ProductImage className="switch-find-result-image" product={product} />
                  <span className="switch-find-result-copy">
                    <span>{product.brand}</span>
                    <strong>{product.canonical_name}</strong>
                    <small>
                      {product.feed_type ?? '형태 미확인'} ·{' '}
                      {product.life_stage ? optionLabel(product.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'} ·{' '}
                      {product.representative_package_size_text ?? '대표 규격 미확인'}
                    </small>
                  </span>
                  <span className="switch-find-result-open">확인 →</span>
                </button>
              ))}
            </div>
          </div>

          {previewProduct ? (
            <aside className="switch-current-preview">
              <div className="switch-preview-topline"><span>현재 사료 확인</span><button type="button" onClick={() => setPreviewProductId(null)}>닫기 ×</button></div>
              <div className="switch-preview-scroll">
                <section className="switch-preview-identity">
                  <ProductImage className="switch-preview-image" product={previewProduct} />
                  <div>
                    <span>{previewProduct.brand}</span>
                    <h2>{previewProduct.canonical_name}</h2>
                    <p>
                      {previewProduct.feed_type ?? '형태 미확인'} ·{' '}
                      {previewProduct.life_stage ? optionLabel(previewProduct.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'} ·{' '}
                      {previewProduct.representative_package_size_text ?? '대표 규격 미확인'}
                    </p>
                  </div>
                </section>
                <section className="switch-preview-facts">
                  <dl>
                    <div><dt>공식 대상</dt><dd>{compactList(previewProduct.official_targets, TARGET_LABELS)}</dd></div>
                    <div><dt>기능</dt><dd>{compactList(previewProduct.features, FEATURE_LABELS)}</dd></div>
                    <div><dt>확인된 판매 규격</dt><dd>{previewProduct.variant_count ? `${previewProduct.variant_count}개` : '미확인'}</dd></div>
                  </dl>
                  <p>제품을 확정한 뒤 실제 사용하는 규격의 배합·원료 근거를 별도로 확인합니다.</p>
                </section>
                <button className="switch-primary-action" type="button" onClick={() => confirmCurrentProduct(previewProduct)}>이 제품을 현재 사료로 선택 →</button>
              </div>
            </aside>
          ) : null}
        </section>
      </main>
    )
  }

  function renderSkuStep() {
    if (!currentProduct) return null

    return (
      <div className="switch-step-layout">
        <ReferenceRail product={currentProduct} variant={selectedVariant} step="sku" onChangeProduct={resetCurrentProduct} />
        <main className="switch-step-main">
          <div className="switch-step-header">
            <span>사용 규격</span>
            <h1>현재 사용하는 규격을 확인하세요.</h1>
            <p>같은 제품이라도 규격·시기에 따라 확인되는 배합 정보가 다를 수 있습니다. 선택한 규격에서 확인된 근거만 다음 단계의 현재 기준으로 사용합니다.</p>
          </div>
          <section className="switch-sku-list">
            {variantLoading ? <div className="switch-state-message">판매 규격을 불러오는 중입니다.</div> : null}
            {variantError ? <div className="switch-state-message is-error">{variantError}</div> : null}
            {!variantLoading && variants.length === 0 ? <div className="switch-state-message">현재 공개 데이터에서 선택 가능한 판매 규격을 확인하지 못했습니다.</div> : null}
            {variants.map((variant) => (
              <button
                className={currentVariantId === variant.variant_id ? 'switch-sku-option is-selected' : 'switch-sku-option'}
                key={variant.variant_id}
                type="button"
                onClick={() => selectCurrentVariant(variant.variant_id)}
              >
                <span>
                  <strong>{variant.package_size_text || '규격 표기 미확인'}</strong>
                  <small>
                    {variant.units_per_sale && variant.units_per_sale > 1 ? `${variant.units_per_sale}개 구성` : '단일 판매 규격'} · {formulaEvidenceLabel(variant)}
                  </small>
                </span>
                <b>{currentVariantId === variant.variant_id ? '선택됨' : '선택'}</b>
              </button>
            ))}
          </section>
          <div className="switch-step-actions">
            <button className="switch-secondary-action" type="button" onClick={() => { selectCurrentVariant(null); setStep('change') }}>사용 규격을 모르겠어요</button>
            <button className="switch-primary-action" type="button" disabled={!currentVariantId} onClick={() => setStep('change')}>다음 · CHANGE →</button>
          </div>
        </main>
      </div>
    )
  }

  function renderIngredientAvoidance() {
    const currentConfirmed = (selectedVariant?.confirmed_present_ingredient_terms ?? [])
      .filter((term) => !ingredientAvoidTerms.includes(term))
      .sort((a, b) => ingredientLabel(a).localeCompare(ingredientLabel(b), 'ko-KR'))

    return (
      <CriterionSection title="피하고 싶은 원료" hint={selectedVariant ? '선택한 규격의 검토 근거 기준' : '현재 규격 미확인'}>
        {ingredientAvoidTerms.length > 0 ? (
          <div className="switch-ingredient-selected">
            {ingredientAvoidTerms.map((term) => <button key={term} type="button" onClick={() => removeIngredientAvoid(term)}>{ingredientLabel(term)} ×</button>)}
          </div>
        ) : null}

        {currentConfirmed.length > 0 && selectedVariant ? (
          <div className="switch-current-ingredients">
            <span>선택한 현재 규격에서 확인됨</span>
            <div>
              {currentConfirmed.slice(0, 12).map((term) => (
                <button key={term} type="button" onClick={() => addIngredientAvoid(term)}>
                  <strong>{ingredientLabel(term)}</strong>
                  <small>{ingredientEvidenceLabel(selectedVariant, term)}</small>
                </button>
              ))}
            </div>
          </div>
        ) : selectedVariant ? (
          <p className="switch-option-empty">선택한 규격에서 회피 후보로 바로 제시할 확인 원료가 없습니다. 원료를 직접 검색해 조건을 추가할 수 있습니다.</p>
        ) : (
          <p className="switch-option-empty">사용 규격을 모르므로 현재 제품 전체의 원료 정보를 이 규격의 사실처럼 사용하지 않습니다.</p>
        )}

        <input className="switch-ingredient-search" type="search" value={ingredientSearch} placeholder="원료 검색 · 예: 닭, 연어" onChange={(event) => setIngredientSearch(event.target.value)} />
        {ingredientSearch.trim() ? (
          <div className="switch-ingredient-search-results">
            {ingredientSearchResults.length > 0 ? ingredientSearchResults.map((term) => (
              <button key={term} type="button" onClick={() => addIngredientAvoid(term)}><strong>{ingredientLabel(term)}</strong><small>{term}</small></button>
            )) : <span>검토 대상 원료에서 찾지 못했습니다.</span>}
          </div>
        ) : null}
        <p className="switch-ingredient-note">후보에서 해당 원료가 <strong>확인됨</strong>이면 제외합니다. “검토 근거에서 찾지 못함”은 원료 부재나 알레르기 안전을 뜻하지 않습니다.</p>
      </CriterionSection>
    )
  }

  function renderChangeStep() {
    if (!currentProduct) return null
    const feedOptions = FEED_TYPES.filter(([value]) => value !== currentProduct.feed_type)
    const lifeOptions = LIFE_STAGES.filter(([value]) => value !== currentProduct.life_stage)
    const targetOptions = TARGETS.filter(([value]) => !currentProduct.official_targets.includes(value))
    const featureOptions = FEATURES.filter(([value]) => !currentProduct.features.includes(value))
    const recipeOptions = currentFormulaConfirmed
      ? RECIPE_FAMILIES.filter(([value]) => !currentRecipeFamilies.includes(value))
      : RECIPE_FAMILIES
    const recipeHint = currentFormulaConfirmed
      ? `현재 규격 · ${compactList(currentRecipeFamilies, RECIPE_FAMILY_LABELS)}`
      : '현재 규격 배합 미확인 · 다음 제품에서 원하는 방향 선택'

    return (
      <div className="switch-step-layout">
        <ReferenceRail product={currentProduct} variant={selectedVariant} step="change" onChangeProduct={resetCurrentProduct} />
        <main className="switch-step-main">
          <div className="switch-step-header">
            <span>CHANGE</span>
            <h1>무엇이 달라졌으면 하나요?</h1>
            <p>현재 사료에서 벗어나고 싶은 기준이나 새로 원하는 기준만 선택합니다. 규격별 배합이 확인되지 않은 값은 현재 사실로 추정하지 않습니다.</p>
          </div>

          <button
            className={noChangeIntent ? 'switch-no-change is-selected' : 'switch-no-change'}
            type="button"
            onClick={() => {
              setChange(EMPTY_CRITERIA)
              setChangeBrand(false)
              setIngredientAvoidTerms([])
              setIngredientSearch('')
              setNoChangeIntent((value) => !value)
            }}
          >
            <strong>특별히 바꿀 점 없음</strong>
            <span>전체적으로 유사한 대안을 탐색하고 KEEP에서 유지할 기준만 정합니다.</span>
          </button>

          <div className="switch-criteria-columns">
            <div>
              <CriterionSection title="브랜드" hint={`현재 · ${currentProduct.brand}`}>
                <button className={changeBrand ? 'switch-choice wide is-active' : 'switch-choice wide'} type="button" aria-pressed={changeBrand} onClick={() => { setNoChangeIntent(false); setChangeBrand((value) => !value) }}>다른 브랜드로 보기</button>
              </CriterionSection>
              <CriterionSection title="사료 형태" hint={currentProduct.feed_type ? `현재 · ${currentProduct.feed_type}` : '현재 값 미확인'}>
                <ChoiceButtons options={feedOptions} selected={change.feedType ? [change.feedType] : []} onToggle={(value) => setChangeSingle('feedType', value)} />
              </CriterionSection>
              <CriterionSection title="표기 생애주기" hint={currentProduct.life_stage ? `현재 · ${optionLabel(currentProduct.life_stage, LIFE_STAGE_LABELS)}` : '현재 값 미확인'}>
                <ChoiceButtons options={lifeOptions} selected={change.lifeStage ? [change.lifeStage] : []} onToggle={(value) => setChangeSingle('lifeStage', value)} />
              </CriterionSection>
              {renderIngredientAvoidance()}
            </div>
            <div>
              <CriterionSection title="공식 대상" hint="현재 제품에 없는 방향">
                <ChoiceButtons options={targetOptions} selected={change.officialTargets} onToggle={(value) => toggleChangeArray('officialTargets', value)} emptyText="추가로 선택할 공식 대상이 없습니다." />
              </CriterionSection>
              <CriterionSection title="부가 기능" hint="확인된 공식 표방 기준">
                <ChoiceButtons options={featureOptions} selected={change.features} onToggle={(value) => toggleChangeArray('features', value)} />
              </CriterionSection>
              <CriterionSection title="레시피 계열" hint={recipeHint}>
                <ChoiceButtons options={recipeOptions} selected={change.recipeFamilies} onToggle={(value) => toggleChangeArray('recipeFamilies', value)} />
              </CriterionSection>
              {!currentFormulaConfirmed || !currentIsGrainFree ? (
                <CriterionSection title="레시피 특성" hint={currentFormulaConfirmed ? '선택 규격의 공식 표방 기준' : '현재 규격의 공식 표방 미확인'}>
                  <button className={change.grainFree ? 'switch-choice wide is-active' : 'switch-choice wide'} type="button" aria-pressed={change.grainFree} onClick={() => { setNoChangeIntent(false); setChange((current) => ({ ...current, grainFree: !current.grainFree })) }}>Grain-Free 공식 표방</button>
                </CriterionSection>
              ) : null}
            </div>
          </div>

          <div className="switch-step-actions">
            <button className="switch-secondary-action" type="button" onClick={() => setStep('sku')}>← 사용 규격</button>
            <button className="switch-primary-action" type="button" disabled={!hasChange && !noChangeIntent} onClick={() => setStep('keep')}>다음 · KEEP →</button>
          </div>
        </main>
      </div>
    )
  }

  function renderKeepStep() {
    if (!currentProduct) return null

    return (
      <div className="switch-step-layout">
        <ReferenceRail product={currentProduct} variant={selectedVariant} step="keep" onChangeProduct={resetCurrentProduct} />
        <main className="switch-step-main">
          <div className="switch-step-header">
            <span>KEEP</span>
            <h1>무엇은 그대로 유지할까요?</h1>
            <p>현재 제품에서 확인된 속성 중 다음 제품에서도 꼭 유지하고 싶은 것만 선택합니다. 선택 규격의 배합 근거가 확인되지 않았다면 배합에 따라 달라지는 항목은 유지 조건으로 제시하지 않습니다.</p>
          </div>

          <section className="switch-current-facts-strip">
            <div><span>공식 대상 · 제품 기준</span><strong>{compactList(currentProduct.official_targets, TARGET_LABELS)}</strong></div>
            <div><span>기능 · 제품 기준</span><strong>{compactList(currentProduct.features, FEATURE_LABELS)}</strong></div>
            <div><span>레시피 · 선택 규격 기준</span><strong>{currentFormulaConfirmed ? compactList(currentRecipeFamilies, RECIPE_FAMILY_LABELS) : '규격 배합 미확인'}</strong></div>
          </section>

          <div className="switch-criteria-columns">
            <div>
              {!changeBrand ? (
                <CriterionSection title="브랜드" hint="현재 제품"><button className={keepBrand ? 'switch-choice wide is-active' : 'switch-choice wide'} type="button" aria-pressed={keepBrand} onClick={() => setKeepBrand((value) => !value)}>{currentProduct.brand} 유지</button></CriterionSection>
              ) : null}
              {!change.feedType && currentProduct.feed_type ? (
                <CriterionSection title="사료 형태" hint="현재 제품"><button className={keep.feedType ? 'switch-choice wide is-active' : 'switch-choice wide'} type="button" aria-pressed={Boolean(keep.feedType)} onClick={() => setKeepSingle('feedType', currentProduct.feed_type!)}>{currentProduct.feed_type} 유지</button></CriterionSection>
              ) : null}
              {!change.lifeStage && currentProduct.life_stage ? (
                <CriterionSection title="표기 생애주기" hint="현재 제품"><button className={keep.lifeStage ? 'switch-choice wide is-active' : 'switch-choice wide'} type="button" aria-pressed={Boolean(keep.lifeStage)} onClick={() => setKeepSingle('lifeStage', currentProduct.life_stage!)}>{optionLabel(currentProduct.life_stage, LIFE_STAGE_LABELS)} 유지</button></CriterionSection>
              ) : null}
              {currentProduct.official_targets.length > 0 ? (
                <CriterionSection title="공식 대상" hint="현재 제품에서 확인됨">
                  <ChoiceButtons options={currentProduct.official_targets.map((value) => [value, optionLabel(value, TARGET_LABELS)] as const)} selected={keep.officialTargets} onToggle={(value) => toggleKeepArray('officialTargets', value)} />
                </CriterionSection>
              ) : null}
            </div>
            <div>
              {currentProduct.features.length > 0 ? (
                <CriterionSection title="부가 기능" hint="현재 제품에서 확인됨">
                  <ChoiceButtons options={currentProduct.features.map((value) => [value, optionLabel(value, FEATURE_LABELS)] as const)} selected={keep.features} onToggle={(value) => toggleKeepArray('features', value)} />
                </CriterionSection>
              ) : null}
              {!change.recipeFamilies.length && currentFormulaConfirmed && currentRecipeFamilies.length > 0 ? (
                <CriterionSection title="레시피 계열" hint="선택한 현재 규격에서 확인됨">
                  <ChoiceButtons options={currentRecipeFamilies.map((value) => [value, optionLabel(value, RECIPE_FAMILY_LABELS)] as const)} selected={keep.recipeFamilies} onToggle={(value) => toggleKeepArray('recipeFamilies', value)} />
                </CriterionSection>
              ) : null}
              {!change.grainFree && currentFormulaConfirmed && currentIsGrainFree ? (
                <CriterionSection title="레시피 특성" hint="선택 규격의 공식 표방">
                  <button className={keep.grainFree ? 'switch-choice wide is-active' : 'switch-choice wide'} type="button" aria-pressed={keep.grainFree} onClick={() => setKeep((current) => ({ ...current, grainFree: !current.grainFree }))}>Grain-Free 공식 표방 유지</button>
                </CriterionSection>
              ) : null}
              {!currentFormulaConfirmed ? <p className="switch-option-empty">선택 규격의 배합 근거가 확인되지 않아 레시피·Grain-Free를 현재 사실로 가정하지 않습니다.</p> : null}
            </div>
          </div>

          <div className="switch-step-actions">
            <button className="switch-secondary-action" type="button" onClick={() => setStep('change')}>← CHANGE 수정</button>
            <button className="switch-primary-action" type="button" onClick={() => { setSelectedCandidateId(null); setCompareIds([]); setCompareOpen(false); setDetailProductId(null); setStep('results') }}>후보 제품 보기 →</button>
          </div>
        </main>
      </div>
    )
  }

  function renderResults() {
    if (!currentProduct) return null

    if (compareOpen && compareItems.length > 0) {
      return (
        <CompareView
          items={compareItems}
          currentProduct={currentProduct}
          currentVariantText={`${variantLabel(selectedVariant)} · ${formulaEvidenceLabel(selectedVariant)}`}
          onClose={() => setCompareOpen(false)}
          onRemove={(productId) => {
            setCompareIds((current) => current.filter((value) => value !== productId))
            if (compareIds.length <= 1) setCompareOpen(false)
          }}
        />
      )
    }

    const changeLabels = criteriaLabels(change)
    if (changeBrand) changeLabels.unshift('다른 브랜드')
    changeLabels.push(...ingredientAvoidTerms.map((term) => `피함 · ${ingredientLabel(term)}`))
    if (noChangeIntent && changeLabels.length === 0) changeLabels.push('특별히 바꿀 점 없음')
    const keepLabels = criteriaLabels(keep)
    if (keepBrand) keepLabels.unshift(`브랜드 · ${currentProduct.brand}`)
    const comparedNames = compareItems.map((item) => item.product.canonical_name)

    return (
      <main className="switch-results-stage">
        <div className="switch-session-bar">
          <div className="switch-session-current"><span>CURRENT</span><strong>{currentProduct.brand} · {currentProduct.canonical_name}</strong><small>{variantLabel(selectedVariant)} · {formulaEvidenceLabel(selectedVariant)}</small></div>
          <div><span>CHANGE</span><strong>{changeLabels.join(' · ') || '없음'}</strong></div>
          <div><span>KEEP</span><strong>{keepLabels.join(' · ') || '제약 없음'}</strong></div>
          <button type="button" onClick={() => { setCompareOpen(false); setStep('change') }}>조건 수정</button>
        </div>

        <section className={selectedCandidate ? 'switch-results-workspace is-inspecting' : 'switch-results-workspace'}>
          <div className="switch-candidate-pane">
            <div className="switch-candidate-heading"><div><strong>후보 제품</strong><span>{candidates.length}개의 제품 · 선택한 조건과 확인된 관계를 표시합니다.</span><p>후보의 레시피·Grain-Free·원료 관계는 현재 확인된 배합 정보를 제품 단위로 집계한 기준입니다. 규격별 배합은 제품 상세에서 확인하세요.</p></div></div>
            <div className="switch-candidate-list">
              {candidates.length === 0 ? <div className="switch-state-message">현재 조건에 맞는 후보가 없습니다. 조건을 자동으로 완화하지 않습니다.</div> : null}
              {candidates.map((evaluation) => {
                const product = evaluation.product
                return (
                  <button className={selectedCandidateId === product.product_id ? 'switch-candidate-row is-selected' : 'switch-candidate-row'} key={product.product_id} type="button" onClick={() => setSelectedCandidateId(product.product_id)}>
                    <ProductImage className="switch-candidate-image" product={product} />
                    <span className="switch-candidate-identity">
                      <span>{product.brand}</span><strong>{product.canonical_name}</strong>
                      <small>{product.feed_type ?? '형태 미확인'} · {product.life_stage ? optionLabel(product.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'} · {product.representative_package_size_text ?? '대표 규격 미확인'}</small>
                    </span>
                    <RelationBlock evaluation={evaluation} />
                    <span className="switch-candidate-open">보기 →</span>
                  </button>
                )
              })}
            </div>
          </div>

          {selectedCandidate ? (
            <aside className="switch-candidate-inspector">
              <div className="switch-preview-topline"><span>후보 제품 확인</span><button type="button" onClick={() => setSelectedCandidateId(null)}>닫기 ×</button></div>
              <div className="switch-inspector-scroll">
                <section className="switch-inspector-identity">
                  <ProductImage className="switch-inspector-image" product={selectedCandidate.product} />
                  <div><span>{selectedCandidate.product.brand}</span><h1>{selectedCandidate.product.canonical_name}</h1><p>{selectedCandidate.product.feed_type ?? '형태 미확인'} · {selectedCandidate.product.life_stage ? optionLabel(selectedCandidate.product.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'}</p></div>
                </section>

                <section className="switch-inspector-baseline"><span>기준 제품</span><strong>{currentProduct.brand} · {currentProduct.canonical_name}</strong><small>{variantLabel(selectedVariant)} · {formulaEvidenceLabel(selectedVariant)}</small></section>

                <div className="quick-view-actions switch-inspector-actions">
                  <button
                    className={compareIds.includes(selectedCandidate.product.product_id) ? 'switch-compare-action is-added' : 'switch-compare-action'}
                    type="button"
                    disabled={compareIds.length >= 5 && !compareIds.includes(selectedCandidate.product.product_id)}
                    onClick={() => toggleCompare(selectedCandidate.product.product_id)}
                  >
                    {compareIds.includes(selectedCandidate.product.product_id)
                      ? '비교에서 제거'
                      : compareIds.length >= 5
                        ? '비교는 최대 5개까지 가능합니다'
                        : `비교에 추가 · ${compareIds.length}/5`}
                  </button>
                  <button className="switch-compare-action" type="button" onClick={() => setDetailProductId(selectedCandidate.product.product_id)}>제품 상세 보기 →</button>
                </div>

                <section className="switch-inspector-section">
                  <h2>선택한 기준과의 관계</h2>
                  <dl>
                    <div><dt>유지 확인</dt><dd>{selectedCandidate.keepMatches.join(' · ') || '확인된 유지 항목 없음'}</dd></div>
                    <div><dt>변경 확인</dt><dd>{selectedCandidate.changeMatches.join(' · ') || '확인된 변경 항목 없음'}</dd></div>
                    <div><dt>미확인</dt><dd>{selectedCandidate.unknowns.join(' · ') || '—'}</dd></div>
                  </dl>
                </section>

                {ingredientAvoidTerms.length > 0 ? (
                  <section className="switch-inspector-section switch-ingredient-inspector">
                    <h2>피하고 싶은 원료</h2>
                    <dl>{ingredientAvoidTerms.map((term) => <div key={term}><dt>{ingredientLabel(term)}</dt><dd>{ingredientAvoidanceStatus(selectedCandidate.product, term)}</dd></div>)}</dl>
                    <p>“검토 근거에서 찾지 못함”은 해당 원료의 절대적 부재나 알레르기 안전을 보장하지 않습니다.</p>
                  </section>
                ) : null}

                <section className="switch-inspector-section">
                  <h2>제품 정보 요약</h2>
                  <dl>
                    <div><dt>대표 규격</dt><dd>{selectedCandidate.product.representative_package_size_text ?? '미확인'}</dd></div>
                    <div><dt>확인된 판매 규격</dt><dd>{selectedCandidate.product.variant_count ? `${selectedCandidate.product.variant_count}개` : '미확인'}</dd></div>
                    <div><dt>공식 대상</dt><dd>{compactList(selectedCandidate.product.official_targets, TARGET_LABELS)}</dd></div>
                    <div><dt>부가 기능</dt><dd>{compactList(selectedCandidate.product.features, FEATURE_LABELS)}</dd></div>
                    <div><dt>레시피 계열</dt><dd>{compactList(selectedCandidate.product.recipe_families, RECIPE_FAMILY_LABELS)}</dd></div>
                    <div><dt>세부 레시피</dt><dd>{compactList(selectedCandidate.product.recipe_details, RECIPE_DETAIL_LABELS)}</dd></div>
                    <div><dt>제조국</dt><dd>{countryListLabel(selectedCandidate.product.manufacturing_country_codes)}</dd></div>
                    <div><dt>현재 확인 시장</dt><dd>{countryListLabel(selectedCandidate.product.current_market_country_codes)}</dd></div>
                    <div><dt>동일 배합 확인 시장</dt><dd>{countryListLabel(selectedCandidate.product.formula_match_market_country_codes)}</dd></div>
                  </dl>
                </section>
              </div>
            </aside>
          ) : null}
        </section>

        {compareIds.length > 0 ? (
          <div className="switch-compare-dock" role="status">
            <strong>비교 {compareIds.length}/5</strong>
            <div className="switch-compare-dock-list">{comparedNames.join(' · ')}</div>
            <button type="button" onClick={() => setCompareOpen(true)}>비교 보기 →</button>
          </div>
        ) : null}
      </main>
    )
  }

  if (detailProduct) {
    return <ProductDetail product={detailProduct} onClose={() => setDetailProductId(null)} />
  }

  return (
    <div className="research-shell switch-workflow-shell">
      <SwitchTopbar productCount={products.length} loading={loading} error={error} onHome={onHome} onModeChange={onModeChange} />
      {step === 'current' ? renderCurrentStage() : null}
      {step === 'sku' ? renderSkuStep() : null}
      {step === 'change' ? renderChangeStep() : null}
      {step === 'keep' ? renderKeepStep() : null}
      {step === 'results' ? renderResults() : null}
    </div>
  )
}
