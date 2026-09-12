import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  fetchCompareIngredients,
  fetchCompareNutrition,
  fetchProductManufacturing,
  fetchProductMarkets,
  fetchProductVariants,
  type AdditionalNutrient,
  type CatalogProduct,
  type CompareIngredients,
  type CompareNutrition,
  type ProductManufacturingDetail,
  type ProductMarketDetail,
  type ProductVariant,
} from './api'
import type { DetailTab } from './navigation-state'

type DetailResource = 'variants' | 'nutrition' | 'ingredients' | 'manufacturing' | 'markets'

const TABS: Array<[DetailTab, string]> = [
  ['overview', '개요'],
  ['nutrition', '영양'],
  ['ingredients', '원재료'],
  ['context', '제조 · 유통'],
]
const INITIAL_LOADING: Record<DetailResource, boolean> = { variants: true, nutrition: true, ingredients: true, manufacturing: true, markets: true }
const INITIAL_ERRORS: Record<DetailResource, string | null> = { variants: null, nutrition: null, ingredients: null, manufacturing: null, markets: null }
const LIFE_STAGE_LABELS: Record<string, string> = { kitten: '키튼', adult: '성묘', senior: '시니어', all_life_stages: '전연령', gestation_lactation_and_kitten: '임신·수유·키튼' }
const TARGET_LABELS: Record<string, string> = { indoor: '실내묘', sterilized: '중성화묘' }
const FEATURE_LABELS: Record<string, string> = { weight_management: '체중 관리', stool: '변 상태', hairball: '헤어볼', digestive: '소화', urinary: '요로', skin_coat: '피부·피모', dental: '덴탈' }
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
const COUNTRY_LABELS: Record<string, string> = { KR: '한국', US: '미국', CA: '캐나다', GB: '영국', AU: '호주', NZ: '뉴질랜드', NL: '네덜란드', TH: '태국', DE: '독일', FR: '프랑스', IT: '이탈리아', CZ: '체코', AT: '오스트리아', JP: '일본' }
const ADDITIONAL_NUTRIENT_LABELS: Record<string, string> = { calcium: '칼슘', phosphorus: '인', magnesium: '마그네슘', taurine: '타우린' }
const BASIS_NUTRIENT_LABELS: Record<string, string> = { protein: '단백질', fat: '지방', fiber: '조섬유', moisture: '수분', ash: '조회분' }
const SUPPLEMENTAL_NUTRITION_LABELS: Record<string, string> = { energy: '열량', protein: '조단백질', fat: '조지방', fiber: '조섬유', moisture: '수분', ash: '조회분', additional_nutrients: '추가 영양성분' }

function valueLabel(value: string, map: Record<string, string>) { return map[value] ?? value.replaceAll('_', ' ') }
function listLabel(values: string[], map: Record<string, string>) { return values.map((value) => valueLabel(value, map)).join(' · ') }
function countryLabel(value: string | null) { return value ? COUNTRY_LABELS[value] ?? value : '미확인' }
function completenessLabel(status: string | null) {
  if (status === 'full') return '전체 목록 확인'
  if (status === 'partial') return '일부 목록'
  if (status === 'summary') return '요약 정보'
  return '목록 상태 미확인'
}
function scopeLabel(scope: string) {
  if (scope === 'variant') return '제품 포장에서 확인한 자료'
  if (scope === 'formula') return '배합 자료'
  if (scope === 'product') return '제품 자료'
  return '자료 적용 범위 미확인'
}
function distributionLabel(status: string) {
  if (status === 'current_product_confirmed') return '현재 제품 유통 확인'
  if (status === 'gate_confirmed_product_not_found') return '브랜드는 유통되지만 이 제품은 확인하지 못했습니다'
  if (status === 'distribution_not_confirmed') return '공식 유통 미확인'
  return '판매 여부 미확인'
}
function formulaMarketLabel(status: string) {
  if (status === 'exact_same') return '동일 배합 확인'
  if (status === 'same_formula_different_package') return '동일 배합 · 다른 패키지'
  if (status === 'different_generation') return '다른 세대 확인'
  if (status === 'not_found') return '동일 배합 미확인'
  return '같은 배합인지 확인하지 못했습니다'
}
function qualifierLabel(value: string | null) {
  if (value === 'min') return ' 이상'
  if (value === 'max') return ' 이하'
  if (value === 'typical') return ' 평균값'
  if (!value || value === 'reported' || value === 'exact') return ''
  return ` ${value}`
}
function nutrientValue(value: number | null, qualifier: string | null, unit = '%') {
  if (value == null) return '미확인'
  return `${Number(value).toLocaleString('ko-KR')}${unit}${qualifierLabel(qualifier)}`
}
function additionalNutrientLabel(value: AdditionalNutrient) { return ADDITIONAL_NUTRIENT_LABELS[value.nutrient_key] ?? value.raw_name ?? value.nutrient_key.replaceAll('_', ' ') }
function additionalNutrientValue(value: AdditionalNutrient) {
  const unit = value.unit ?? ''
  return nutrientValue(value.amount, value.qualifier, unit === '%' ? '%' : unit ? ` ${unit}` : '')
}
function basisValues(row: CompareNutrition | null) { return row?.basis_specific_nutrition_values ?? [] }
function basisValue(row: CompareNutrition | null, key: string) { return basisValues(row).find((item) => item.nutrient_key === key && item.amount != null) }
function basisLabel(row: CompareNutrition | null) { return row?.basis_specific_nutrition_basis === 'dry_matter' ? '건물 기준(Dry Matter)' : row?.basis_specific_nutrition_basis?.replaceAll('_', ' ') ?? '다른 기준' }
function standardStatus(row: CompareNutrition | null, key: string, value: number | null) {
  if (value != null) return null
  if (basisValue(row, key)) return row?.basis_specific_nutrition_basis === 'dry_matter' ? '건물 기준 자료만 확인' : '다른 기준 자료만 확인'
  return '미확인'
}
function energyValue(row: CompareNutrition | null) {
  if (!row) return '미확인'
  if (row.kcal_per_kg != null) return `${Number(row.kcal_per_kg).toLocaleString('ko-KR')} kcal/kg`
  if (row.kcal_per_100g != null) return `${Number(row.kcal_per_100g).toLocaleString('ko-KR')} kcal/100g`
  return '미확인'
}
function hasStructuredNutrition(row: CompareNutrition | null) {
  if (!row) return false
  return [row.protein_pct, row.fat_pct, row.fiber_pct, row.moisture_pct, row.ash_pct, row.kcal_per_kg, row.kcal_per_100g].some((value) => value != null)
    || (row.additional_nutrients ?? []).some((value) => value.amount != null)
    || basisValues(row).some((value) => value.amount != null)
}
function variantSizeLabel(variant: ProductVariant | null) {
  if (!variant) return null
  if (variant.package_size_text?.trim()) return variant.package_size_text.trim()
  return variant.package_weight_g != null ? `${Number(variant.package_weight_g).toLocaleString('ko-KR')}g` : null
}
function weightLabel(value: number | null) {
  if (value == null) return '미확인'
  const numeric = Number(value)
  return numeric >= 1000 ? `${Number((numeric / 1000).toFixed(3)).toLocaleString('ko-KR')} kg` : `${numeric.toLocaleString('ko-KR')} g`
}
function evidenceContext(detail: CompareNutrition | CompareIngredients | null, variants: ProductVariant[], variantFailed = false, variantLoading = false) {
  if (!detail) return '확인 근거 없음'
  const market = detail.market_code === 'KR' ? '한국 확인' : detail.market_code ? `${countryLabel(detail.market_code)} 확인` : ''
  const variant = detail.variant_id ? variants.find((item) => item.variant_id === detail.variant_id) ?? null : null
  let scope = scopeLabel(detail.observation_scope)
  if (detail.observation_scope === 'variant') {
    const size = variantSizeLabel(variant)
    scope = size ? `${size} 제품에서 확인` : variantLoading ? '포장 용량 확인 중' : variantFailed ? '포장 용량 조회 실패' : '확인한 포장 용량 정보 없음'
  } else if (detail.observation_scope === 'formula') {
    scope = detail.is_current_resolved_formula ? '같은 배합으로 확인된 제품 자료' : '한국 판매 제품과 배합이 같은지 확인되지 않은 자료'
  }
  return [market, scope].filter(Boolean).join(' · ')
}
function supplementalNutritionContext(detail: CompareNutrition | null) {
  const fields = detail?.supplemental_nutrition_fields ?? []
  if (!fields.length) return null
  const labels = fields.map((field) => SUPPLEMENTAL_NUTRITION_LABELS[field] ?? field.replaceAll('_', ' ')).join(' · ')
  return `${labels} · ${detail?.supplemental_is_current_resolved_formula ? '현재 확인 배합 기준' : '보조 영양 근거'} 자료로 보완`
}
function supplementalIngredientContext(detail: CompareIngredients | null) {
  if (!detail?.supplemental_full_raw_text?.trim() && !detail?.supplemental_full_ingredient_names?.length) return null
  const market = detail.supplemental_market_code === 'KR' ? '한국 확인' : detail.supplemental_market_code ? `${countryLabel(detail.supplemental_market_code)} 확인` : ''
  const scope = detail.supplemental_is_current_resolved_formula ? '현재 확인 배합 기준' : scopeLabel(detail.supplemental_observation_scope ?? '')
  return [market, scope, '전체 목록'].filter(Boolean).join(' · ')
}
function ProductImage({ product }: { product: CatalogProduct }) {
  if (!product.display_image_url) return <div className="detail-image-placeholder">이미지 없음</div>
  return <img className="detail-product-image" src={product.display_image_url} alt="" />
}
function Fact({ label, value }: { label: string; value: string }) { return <div className="detail-fact"><span>{label}</span><strong>{value}</strong></div> }
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="detail-state is-error" role="alert"><p>{message} 잠시 후 다시 시도해 주세요.</p><button type="button" onClick={onRetry}>다시 시도</button></div> }

export default function ProductDetail({ product, onClose, initialTab = 'overview', onTabChange }: {
  product: CatalogProduct
  onClose: () => void
  initialTab?: DetailTab
  onTabChange?: (tab: DetailTab) => void
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const [reload, setReload] = useState(0)
  const [variants, setVariants] = useState<ProductVariant[]>([])
  const [nutrition, setNutrition] = useState<CompareNutrition | null>(null)
  const [ingredients, setIngredients] = useState<CompareIngredients | null>(null)
  const [manufacturing, setManufacturing] = useState<ProductManufacturingDetail | null>(null)
  const [markets, setMarkets] = useState<ProductMarketDetail[]>([])
  const [loading, setLoading] = useState<Record<DetailResource, boolean>>(INITIAL_LOADING)
  const [errors, setErrors] = useState<Record<DetailResource, string | null>>(INITIAL_ERRORS)
  const stageRef = useRef<HTMLElement | null>(null)
  const topbarRef = useRef<HTMLElement | null>(null)
  const tabsRef = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const pendingTabChangeRef = useRef<{ tab: DetailTab; focus: boolean; productId: string } | null>(null)
  const retry = () => setReload((value) => value + 1)

  useEffect(() => { setTab(initialTab) }, [initialTab, product.product_id])
  useLayoutEffect(() => {
    const pending = pendingTabChangeRef.current
    if (!pending || pending.tab !== tab || pending.productId !== product.product_id) return
    pendingTabChangeRef.current = null

    const stage = stageRef.current
    const panel = panelRef.current
    const topbar = topbarRef.current
    const tabs = tabsRef.current
    const heading = panel?.querySelector<HTMLElement>('.detail-section-heading') ?? null
    if (stage && heading && topbar && tabs) {
      const stageRect = stage.getBoundingClientRect()
      const topbarStyle = window.getComputedStyle(topbar)
      const tabsStyle = window.getComputedStyle(tabs)
      const topbarTop = Number.parseFloat(topbarStyle.top) || 0
      const tabsTop = Number.parseFloat(tabsStyle.top) || 0
      const stickyBottom = Math.max(
        topbarTop + topbar.getBoundingClientRect().height,
        tabsTop + tabs.getBoundingClientRect().height,
      )
      const headingTop = heading.getBoundingClientRect().top - stageRect.top
      const maxScrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight)
      stage.scrollTop = Math.max(0, Math.min(maxScrollTop, stage.scrollTop + headingTop - stickyBottom))
    }

    if (pending.focus) {
      tabRefs.current[TABS.findIndex(([key]) => key === tab)]?.focus({ preventScroll: true })
    }
  }, [tab, product.product_id])

  function selectTab(next: DetailTab, focus = false) {
    if (next === tab) {
      onTabChange?.(next)
      if (focus) tabRefs.current[TABS.findIndex(([key]) => key === next)]?.focus({ preventScroll: true })
      return
    }
    pendingTabChangeRef.current = { tab: next, focus, productId: product.product_id }
    setTab(next)
    onTabChange?.(next)
  }
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    else return
    event.preventDefault()
    selectTab(TABS[next][0], true)
  }

  useEffect(() => {
    const controller = new AbortController(); let active = true
    setLoading(INITIAL_LOADING); setErrors(INITIAL_ERRORS); setVariants([]); setNutrition(null); setIngredients(null); setManufacturing(null); setMarkets([])
    function load<T>(resource: DetailResource, request: Promise<T>, apply: (value: T) => void, fallback: string) {
      request.then((value) => { if (active) apply(value) }).catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) setErrors((current) => ({ ...current, [resource]: fallback }))
      }).finally(() => { if (active) setLoading((current) => ({ ...current, [resource]: false })) })
    }
    load('variants', fetchProductVariants(product.product_id, controller.signal), setVariants, '판매 규격을 불러오지 못했습니다.')
    load('nutrition', fetchCompareNutrition([product.product_id], controller.signal), (rows) => setNutrition(rows[0] ?? null), '영양 정보를 불러오지 못했습니다.')
    load('ingredients', fetchCompareIngredients([product.product_id], controller.signal), (rows) => setIngredients(rows[0] ?? null), '원재료 정보를 불러오지 못했습니다.')
    load('manufacturing', fetchProductManufacturing(product.product_id, controller.signal), setManufacturing, '제조 정보를 불러오지 못했습니다.')
    load('markets', fetchProductMarkets(product.product_id, controller.signal), setMarkets, '유통 정보를 불러오지 못했습니다.')
    return () => { active = false; controller.abort() }
  }, [product.product_id, reload])

  const nutritionStructured = hasStructuredNutrition(nutrition)
  const alternateNutritionValues = basisValues(nutrition).filter((value) => value.amount != null)
  const nutritionSupplementContext = supplementalNutritionContext(nutrition)
  const ingredientSupplementContext = supplementalIngredientContext(ingredients)
  const supplementalIngredientNames = ingredients?.supplemental_full_ingredient_names ?? []
  const hasSupplementalFullIngredients = Boolean(ingredients?.supplemental_full_raw_text?.trim()) || supplementalIngredientNames.length > 0
  const directIngredientLabel = product.direct_evidence_ingredient_terms.length ? listLabel(product.direct_evidence_ingredient_terms, RECIPE_LABELS) : null
  const flavorIngredientLabel = product.flavor_associated_ingredient_terms.length ? listLabel(product.flavor_associated_ingredient_terms, RECIPE_LABELS) : null
  const missingManufacturingFields = manufacturing ? [!manufacturing.manufacturer?.trim() ? '제조 업체' : null, !manufacturing.plant?.trim() ? '공장' : null].filter(Boolean) : []
  const contextStatus = loading.manufacturing || loading.markets ? '불러오는 중' : errors.manufacturing && errors.markets ? '조회 실패' : errors.manufacturing || errors.markets ? '일부 조회 실패' : manufacturing || markets.length ? '확인된 정보 있음' : '확인된 정보 없음'
  const standardRows = [
    ['조단백질', 'protein', nutrition?.protein_pct ?? null, nutrition?.protein_qualifier ?? null],
    ['조지방', 'fat', nutrition?.fat_pct ?? null, nutrition?.fat_qualifier ?? null],
    ['조섬유', 'fiber', nutrition?.fiber_pct ?? null, nutrition?.fiber_qualifier ?? null],
    ['수분', 'moisture', nutrition?.moisture_pct ?? null, nutrition?.moisture_qualifier ?? null],
    ['조회분', 'ash', nutrition?.ash_pct ?? null, nutrition?.ash_qualifier ?? null],
  ] as const
  const confirmedStandardRows = standardRows.filter(([, , value]) => value != null)
  const unavailableStandardRows = standardRows.filter(([, , value]) => value == null)
  const panelId = `detail-panel-${tab}`
  const tabId = `detail-tab-${tab}`

  return <main className="detail-stage" ref={stageRef}>
    <header className="detail-topbar" ref={topbarRef}><button type="button" onClick={onClose}>← 돌아가기 · 제품 목록</button><span>PRODUCT DETAIL</span></header>
    <section className="detail-identity">
      <ProductImage product={product} />
      <div className="detail-identity-copy"><span>{product.brand}</span><h1>{product.canonical_name}</h1><p>{product.feed_type ?? '형태 미확인'} · {product.life_stage ? valueLabel(product.life_stage, LIFE_STAGE_LABELS) : '대상 연령 미확인'}</p></div>
      <div className="detail-status-grid">
        <Fact label="판매 규격" value={loading.variants ? '불러오는 중' : errors.variants ? '조회 실패' : variants.length ? `${variants.length}개 확인` : '미확인'} />
        <div className="detail-fact detail-status-action"><span>영양</span><strong>{loading.nutrition ? '불러오는 중' : errors.nutrition ? '조회 실패' : nutritionStructured ? '확인된 정보 있음' : '확인된 수치 없음'}</strong><button type="button" onClick={() => selectTab('nutrition')}>영양 정보 보기</button></div>
        <div className="detail-fact detail-status-action"><span>원재료</span><strong>{loading.ingredients ? '불러오는 중' : errors.ingredients ? '조회 실패' : ingredients ? completenessLabel(ingredients.completeness_status) : '확인 정보 없음'}</strong><button type="button" onClick={() => selectTab('ingredients')}>원재료 보기</button></div>
        <div className="detail-fact detail-status-action"><span>제조 · 유통</span><strong>{contextStatus}</strong><button type="button" onClick={() => selectTab('context')}>제조 · 유통 보기</button></div>
      </div>
    </section>
    <nav className="detail-tabs" aria-label="제품 상세 항목" role="tablist" ref={tabsRef}>
      {TABS.map(([key, label], index) => <button key={key} id={`detail-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`detail-panel-${key}`} tabIndex={tab === key ? 0 : -1} className={tab === key ? 'is-active' : ''} type="button" ref={(node) => { tabRefs.current[index] = node }} onKeyDown={(event) => onTabKeyDown(event, index)} onClick={() => selectTab(key)}>{label}</button>)}
    </nav>
    {TABS.filter(([key]) => key !== tab).map(([key]) => <div key={`hidden-${key}`} id={`detail-panel-${key}`} role="tabpanel" aria-labelledby={`detail-tab-${key}`} hidden />)}
    <div className="detail-body" id={panelId} role="tabpanel" aria-labelledby={tabId} tabIndex={0} ref={panelRef}>
      {tab === 'overview' ? <>
        <section className="detail-section"><div className="detail-section-heading"><span>01</span><div><h2>제품 기본 정보</h2><p>제품에 표시된 대상 연령과 특징입니다.</p></div></div><div className="detail-fact-table"><Fact label="사료 형태" value={product.feed_type ?? '미확인'} /><Fact label="대상 연령" value={product.life_stage ? valueLabel(product.life_stage, LIFE_STAGE_LABELS) : '미확인'} />{product.features.length ? <Fact label="제품 특징" value={listLabel(product.features, FEATURE_LABELS)} /> : null}{product.official_targets.length ? <Fact label="제품 표기 대상" value={listLabel(product.official_targets, TARGET_LABELS)} /> : null}{product.recipe_families.length ? <Fact label="레시피 종류" value={listLabel(product.recipe_families, RECIPE_LABELS)} /> : null}{product.recipe_details.length ? <Fact label="주요 레시피" value={listLabel(product.recipe_details, RECIPE_LABELS)} /> : null}{product.official_recipe_traits.includes('grain_free') ? <Fact label="Grain-Free" value="제품에 표기됨" /> : null}</div></section>
        <section className="detail-section"><div className="detail-section-heading"><span>02</span><div><h2>원재료 요약</h2><p>확인된 원료를 한국어로 요약합니다. 출처 원문은 원재료 탭에서 확인할 수 있습니다.</p></div></div>{loading.ingredients ? <div className="detail-state">원재료 정보를 불러오는 중입니다.</div> : null}{errors.ingredients ? <LoadError message={errors.ingredients} onRetry={retry} /> : null}{!loading.ingredients && !errors.ingredients && ingredients ? <div className="detail-fact-table"><Fact label="원재료 목록" value={completenessLabel(ingredients.completeness_status)} />{ingredients.ingredient_count > 0 ? <Fact label="확인된 원재료" value={`${ingredients.ingredient_count}개`} /> : null}{directIngredientLabel ? <Fact label="직접 확인 원료" value={directIngredientLabel} /> : null}{flavorIngredientLabel ? <Fact label="향미 연관 원료" value={flavorIngredientLabel} /> : null}{hasSupplementalFullIngredients ? <Fact label="전체 목록 보완" value={supplementalIngredientNames.length ? `${ingredients.supplemental_full_ingredient_count ?? supplementalIngredientNames.length}개 확인` : '출처 원문 확인'} /> : null}</div> : null}{!loading.ingredients && !errors.ingredients && !ingredients ? <div className="detail-empty">현재 공개 화면에서 확인할 수 있는 원재료 목록이 없습니다.</div> : null}</section>
        <section className="detail-section"><div className="detail-section-heading"><span>03</span><div><h2>한국 판매 규격</h2><p>현재 확인된 용량과 포장 단위입니다.</p></div></div>{loading.variants ? <div className="detail-state">판매 규격을 불러오는 중입니다.</div> : null}{errors.variants ? <LoadError message={errors.variants} onRetry={retry} /> : null}{!loading.variants && !errors.variants && variants.length ? <div className="detail-variant-list">{variants.map((variant) => <div className="detail-variant-row" key={variant.variant_id}><div><strong>{variantSizeLabel(variant) ?? '규격 표기 미확인'}</strong><span>{variant.units_per_sale && variant.units_per_sale > 1 ? `${variant.units_per_sale}개 구성` : '단일 판매 규격'}</span></div><div><span>판매 단위</span><strong>{variant.units_per_sale != null ? `${variant.units_per_sale}개` : '미확인'}</strong></div><div><span>총 판매 중량</span><strong>{weightLabel(variant.sale_total_weight_g)}</strong></div></div>)}</div> : null}{!loading.variants && !errors.variants && variants.length === 0 ? <div className="detail-empty">현재 확인된 판매 규격이 없습니다.</div> : null}</section>
      </> : null}
      {tab === 'nutrition' ? <section className="detail-section"><div className="detail-section-heading"><span>N</span><div><h2>영양 · 열량</h2><p>확인된 일반 표시값과 기준이 다른 영양자료를 분리해 보여줍니다.</p></div></div>{loading.nutrition ? <div className="detail-state">영양 정보를 불러오는 중입니다.</div> : null}{errors.nutrition ? <LoadError message={errors.nutrition} onRetry={retry} /> : null}{!loading.nutrition && !errors.nutrition && nutrition ? <><div className="detail-evidence-context">{evidenceContext(nutrition, variants, Boolean(errors.variants), loading.variants)}</div>{nutritionSupplementContext ? <div className="detail-evidence-context">일부 미기재 값 보완 · {nutritionSupplementContext}</div> : null}{nutritionStructured ? <><div className="detail-nutrition-subheading"><strong>일반 표시 영양정보</strong><span>출처에서 같은 기준으로 확인된 값입니다.</span></div><div className="detail-nutrition-grid"><Fact label="열량" value={energyValue(nutrition)} />{confirmedStandardRows.map(([label, , value, qualifier]) => <Fact key={label} label={label} value={nutrientValue(value, qualifier)} />)}{(nutrition.additional_nutrients ?? []).filter((value) => value.amount != null).map((value, index) => <Fact key={`${value.nutrient_key}-${index}`} label={additionalNutrientLabel(value)} value={additionalNutrientValue(value)} />)}</div>{unavailableStandardRows.length ? <div className="detail-nutrition-status"><strong>일반 표시값이 확인되지 않은 항목</strong><dl>{unavailableStandardRows.map(([label, key, value]) => <div key={key}><dt>{label}</dt><dd>{standardStatus(nutrition, key, value)}</dd></div>)}</dl></div> : null}{alternateNutritionValues.length ? <><div className="detail-nutrition-subheading is-basis"><strong>{basisLabel(nutrition)} 자료</strong><span>수분을 제거한 기준의 영양자료만 확인됐습니다. 일반 표시값과 기준이 달라 합치거나 환산하지 않습니다.</span></div><div className="detail-nutrition-grid">{alternateNutritionValues.map((value, index) => <Fact key={`basis-${value.nutrient_key}-${index}`} label={`${BASIS_NUTRIENT_LABELS[value.nutrient_key] ?? additionalNutrientLabel(value)} · ${basisLabel(nutrition)}`} value={additionalNutrientValue(value)} />)}</div></> : null}<p className="detail-note">표시되지 않은 값은 추정해 채우지 않습니다. 최소·최대·평균 등 출처의 한정자와 단위를 그대로 보존합니다.</p></> : <div className="detail-empty">현재 이 제품에 적용할 수 있는 영양 수치를 확인하지 못했습니다.</div>}</> : null}{!loading.nutrition && !errors.nutrition && !nutrition ? <div className="detail-empty">현재 확인된 영양 정보가 없습니다.</div> : null}</section> : null}
      {tab === 'ingredients' ? <section className="detail-section"><div className="detail-section-heading"><span>I</span><div><h2>원재료</h2><p>한국어 요약과 출처 원문을 구분해 보여줍니다.</p></div></div>{loading.ingredients ? <div className="detail-state">원재료 정보를 불러오는 중입니다.</div> : null}{errors.ingredients ? <LoadError message={errors.ingredients} onRetry={retry} /> : null}{!loading.ingredients && !errors.ingredients && ingredients ? <>{directIngredientLabel || flavorIngredientLabel ? <div className="detail-fact-table">{directIngredientLabel ? <Fact label="직접 확인 원료" value={directIngredientLabel} /> : null}{flavorIngredientLabel ? <Fact label="향미 연관 원료" value={flavorIngredientLabel} /> : null}</div> : null}<div className="detail-evidence-context">대표 확인 자료 · 출처 원문 · {evidenceContext(ingredients, variants, Boolean(errors.variants), loading.variants)} · {completenessLabel(ingredients.completeness_status)}</div><div className="detail-ingredient-copy">{ingredients.raw_text?.trim() || ingredients.ingredient_names.join(', ') || '확인된 원재료 목록 없음'}</div>{ingredients.ingredient_names.length ? <div className="detail-ingredient-list">{ingredients.ingredient_names.map((ingredient, index) => <span key={`primary-${ingredient}-${index}`}>{index + 1}. {ingredient}</span>)}</div> : null}{hasSupplementalFullIngredients ? <><div className="detail-evidence-context">현재 확인 배합 전체 목록 · 출처 원문 · {ingredientSupplementContext}</div><div className="detail-ingredient-copy">{ingredients.supplemental_full_raw_text?.trim() || supplementalIngredientNames.join(', ')}</div>{supplementalIngredientNames.length ? <div className="detail-ingredient-list">{supplementalIngredientNames.map((ingredient, index) => <span key={`supplemental-${ingredient}-${index}`}>{index + 1}. {ingredient}</span>)}</div> : null}</> : null}<p className="detail-note">일부 목록만 확인된 경우 표시되지 않은 원료가 들어 있지 않다는 뜻은 아닙니다.</p></> : null}{!loading.ingredients && !errors.ingredients && !ingredients ? <div className="detail-empty">현재 확인된 원재료 목록이 없습니다.</div> : null}</section> : null}
      {tab === 'context' ? <><section className="detail-section"><div className="detail-section-heading"><span>M</span><div><h2>제조 정보</h2><p>제조국, 제조 업체, 공장 정보는 서로 구분해 표시합니다.</p></div></div>{loading.manufacturing ? <div className="detail-state">제조 정보를 불러오는 중입니다.</div> : null}{errors.manufacturing ? <LoadError message={errors.manufacturing} onRetry={retry} /> : null}{!loading.manufacturing && !errors.manufacturing && manufacturing ? <><div className="detail-fact-table"><Fact label="제조국" value={countryLabel(manufacturing.country_code)} />{manufacturing.manufacturer?.trim() ? <Fact label="제조 업체" value={manufacturing.manufacturer} /> : null}{manufacturing.plant?.trim() ? <Fact label="제조 공장" value={manufacturing.plant} /> : null}</div>{missingManufacturingFields.length ? <p className="detail-note">{missingManufacturingFields.join('와 ')} 정보는 확인하지 못했습니다.</p> : null}{manufacturing.observation_scope === 'variant' ? <p className="detail-note">제조국은 확인한 포장을 기준으로 안내합니다. 구매할 제품의 포장도 확인해 주세요.</p> : null}</> : null}{!loading.manufacturing && !errors.manufacturing && !manufacturing ? <div className="detail-empty">현재 확정된 제조 정보가 없습니다.</div> : null}</section><section className="detail-section"><div className="detail-section-heading"><span>G</span><div><h2>해외 판매 · 배합 확인</h2><p>해외 판매 여부와 한국 제품과 같은 배합인지 여부를 따로 확인합니다.</p></div></div>{loading.markets ? <div className="detail-state">유통 정보를 불러오는 중입니다.</div> : null}{errors.markets ? <LoadError message={errors.markets} onRetry={retry} /> : null}{!loading.markets && !errors.markets && markets.length ? <div className="detail-market-list">{markets.map((market) => <div className="detail-market-row" key={`${market.country_code}-${market.display_rank}`}><div><strong>{countryLabel(market.country_code)}</strong><span>{market.assessed_at ? `${market.assessed_at} 확인` : '확인일 미기재'}</span></div><div><span>유통</span><strong>{distributionLabel(market.distribution_status)}</strong></div><div><span>한국 제품과의 배합 비교</span><strong>{formulaMarketLabel(market.formula_correspondence_status)}</strong></div>{market.counterpart_name ? <div><span>현지 제품명</span><strong>{market.counterpart_name}</strong></div> : null}</div>)}</div> : null}{!loading.markets && !errors.markets && markets.length === 0 ? <div className="detail-empty">현재 확정된 해외 유통 정보가 없습니다.</div> : null}</section></> : null}
    </div>
  </main>
}