import { useEffect, useState } from 'react'
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

type DetailTab = 'overview' | 'nutrition' | 'ingredients' | 'context'
type DetailResource = 'variants' | 'nutrition' | 'ingredients' | 'manufacturing' | 'markets'

const INITIAL_LOADING: Record<DetailResource, boolean> = {
  variants: true,
  nutrition: true,
  ingredients: true,
  manufacturing: true,
  markets: true,
}

const INITIAL_ERRORS: Record<DetailResource, string | null> = {
  variants: null,
  nutrition: null,
  ingredients: null,
  manufacturing: null,
  markets: null,
}

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

const ADDITIONAL_NUTRIENT_LABELS: Record<string, string> = {
  calcium: '칼슘',
  phosphorus: '인',
  magnesium: '마그네슘',
  taurine: '타우린',
}

const SUPPLEMENTAL_NUTRITION_LABELS: Record<string, string> = {
  energy: '열량',
  protein: '조단백질',
  fat: '조지방',
  fiber: '조섬유',
  moisture: '수분',
  ash: '조회분',
  additional_nutrients: '추가 영양성분',
}

function valueLabel(value: string, map: Record<string, string>): string {
  return map[value] ?? value.replaceAll('_', ' ')
}

function listLabel(values: string[], map: Record<string, string>): string {
  return values.map((value) => valueLabel(value, map)).join(' · ')
}

function countryLabel(value: string | null): string {
  if (!value) return '미확인'
  return COUNTRY_LABELS[value] ? `${COUNTRY_LABELS[value]} (${value})` : value
}

function scopeLabel(scope: string): string {
  if (scope === 'variant') return '규격 기준'
  if (scope === 'formula') return '배합 기준'
  if (scope === 'product') return '제품 기준'
  return '범위 미확인'
}

function completenessLabel(status: string | null): string {
  if (status === 'full') return '전체 목록 확인'
  if (status === 'partial') return '일부 목록'
  if (status === 'summary') return '요약 정보'
  return '목록 상태 미확인'
}

function distributionLabel(status: string): string {
  if (status === 'current_product_confirmed') return '현재 제품 유통 확인'
  if (status === 'gate_confirmed_product_not_found') return '공식 유통 경로 확인 · 해당 제품 미확인'
  if (status === 'distribution_not_confirmed') return '공식 유통 미확인'
  return status.replaceAll('_', ' ')
}

function formulaMarketLabel(status: string): string {
  if (status === 'exact_same') return '동일 배합 확인'
  if (status === 'same_formula_different_package') return '동일 배합 · 다른 패키지'
  if (status === 'different_generation') return '다른 세대 확인'
  if (status === 'uncertain') return '배합 대응 미확정'
  if (status === 'not_found') return '동일 배합 미확인'
  return status.replaceAll('_', ' ')
}

function qualifierLabel(value: string | null): string {
  if (value === 'min') return '이상 '
  if (value === 'max') return '이하 '
  return value ? `${value} ` : ''
}

function nutrientValue(value: number | null, qualifier: string | null, unit = '%'): string {
  if (value == null) return '미확인'
  return `${Number(value).toLocaleString('ko-KR')}${unit} ${qualifierLabel(qualifier)}`.trim()
}

function additionalNutrientLabel(value: AdditionalNutrient): string {
  return ADDITIONAL_NUTRIENT_LABELS[value.nutrient_key] ?? value.raw_name ?? value.nutrient_key.replaceAll('_', ' ')
}

function additionalNutrientValue(value: AdditionalNutrient): string {
  const unit = value.unit ?? ''
  const suffix = unit === '%' ? '%' : unit ? ` ${unit}` : ''
  return nutrientValue(value.amount, value.qualifier, suffix)
}

function energyValue(row: CompareNutrition | null): string {
  if (!row) return '미확인'
  if (row.kcal_per_kg != null) return `${Number(row.kcal_per_kg).toLocaleString('ko-KR')} kcal/kg`
  if (row.kcal_per_100g != null) return `${Number(row.kcal_per_100g).toLocaleString('ko-KR')} kcal/100g`
  return '미확인'
}

function hasStructuredNutrition(row: CompareNutrition | null): boolean {
  if (!row) return false
  return [
    row.protein_pct,
    row.fat_pct,
    row.fiber_pct,
    row.moisture_pct,
    row.ash_pct,
    row.kcal_per_kg,
    row.kcal_per_100g,
  ].some((value) => value != null)
    || (row.additional_nutrients ?? []).some((value) => value.amount != null)
}

function variantSizeLabel(variant: ProductVariant | null): string | null {
  if (!variant) return null
  if (variant.package_size_text?.trim()) return variant.package_size_text.trim()
  if (variant.package_weight_g != null) return `${Number(variant.package_weight_g).toLocaleString('ko-KR')}g`
  return null
}

function weightLabel(value: number | null): string {
  if (value == null) return '미확인'
  const numeric = Number(value)
  if (numeric >= 1000) return `${Number((numeric / 1000).toFixed(3)).toLocaleString('ko-KR')} kg`
  return `${numeric.toLocaleString('ko-KR')} g`
}

function evidenceContext(
  detail: CompareNutrition | CompareIngredients | null,
  variants: ProductVariant[],
  variantLookupFailed = false,
  variantLookupLoading = false,
): string {
  if (!detail) return '확인 근거 없음'
  const market = detail.market_code === 'KR'
    ? '한국 확인'
    : detail.market_code
      ? `${countryLabel(detail.market_code)} 확인`
      : '시장 미지정'
  const variant = detail.variant_id
    ? variants.find((item) => item.variant_id === detail.variant_id) ?? null
    : null
  let scope = scopeLabel(detail.observation_scope)
  if (detail.observation_scope === 'variant') {
    const size = variantSizeLabel(variant)
    scope = size
      ? `${size} 규격 기준`
      : variantLookupLoading
        ? '규격 기준 · 규격 확인 중'
        : variantLookupFailed
          ? '규격 기준 · 규격 조회 실패'
          : '규격 기준 · 규격 표기 미확인'
  } else if (detail.observation_scope === 'formula') {
    scope = detail.is_current_resolved_formula
      ? '현재 확인 배합 기준'
      : '배합 기준 · 한국 배합 대응 미확정'
  }
  return `${market} · ${scope}`
}

function supplementalNutritionContext(detail: CompareNutrition | null): string | null {
  const fields = detail?.supplemental_nutrition_fields ?? []
  if (!fields.length) return null
  const labels = fields.map((field) => SUPPLEMENTAL_NUTRITION_LABELS[field] ?? field.replaceAll('_', ' ')).join(' · ')
  const source = detail?.supplemental_is_current_resolved_formula
    ? '현재 확인 배합 기준'
    : '보조 영양 근거'
  return `${labels} · ${source} 자료로 보완`
}

function supplementalIngredientContext(detail: CompareIngredients | null): string | null {
  if (!(detail?.supplemental_full_ingredient_names?.length)) return null
  const market = detail.supplemental_market_code === 'KR'
    ? '한국 확인'
    : detail.supplemental_market_code
      ? `${countryLabel(detail.supplemental_market_code)} 확인`
      : '시장 미지정'
  const scope = detail.supplemental_is_current_resolved_formula
    ? '현재 확인 배합 기준'
    : scopeLabel(detail.supplemental_observation_scope ?? '')
  return `${market} · ${scope} · 전체 목록`
}

function ProductImage({ product }: { product: CatalogProduct }) {
  if (!product.display_image_url) return <div className="detail-image-placeholder">이미지 없음</div>
  return <img className="detail-product-image" src={product.display_image_url} alt="" />
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export default function ProductDetail({
  product,
  onClose,
}: {
  product: CatalogProduct
  onClose: () => void
}) {
  const [tab, setTab] = useState<DetailTab>('overview')
  const [variants, setVariants] = useState<ProductVariant[]>([])
  const [nutrition, setNutrition] = useState<CompareNutrition | null>(null)
  const [ingredients, setIngredients] = useState<CompareIngredients | null>(null)
  const [manufacturing, setManufacturing] = useState<ProductManufacturingDetail | null>(null)
  const [markets, setMarkets] = useState<ProductMarketDetail[]>([])
  const [loading, setLoading] = useState<Record<DetailResource, boolean>>(INITIAL_LOADING)
  const [errors, setErrors] = useState<Record<DetailResource, string | null>>(INITIAL_ERRORS)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(INITIAL_LOADING)
    setErrors(INITIAL_ERRORS)
    setVariants([])
    setNutrition(null)
    setIngredients(null)
    setManufacturing(null)
    setMarkets([])

    function load<T>(
      resource: DetailResource,
      request: Promise<T>,
      apply: (value: T) => void,
      fallbackMessage: string,
    ) {
      request
        .then((value) => {
          if (active) apply(value)
        })
        .catch((reason: unknown) => {
          if (reason instanceof DOMException && reason.name === 'AbortError') return
          if (!active) return
          setErrors((current) => ({
            ...current,
            [resource]: reason instanceof Error ? reason.message : fallbackMessage,
          }))
        })
        .finally(() => {
          if (active) setLoading((current) => ({ ...current, [resource]: false }))
        })
    }

    load('variants', fetchProductVariants(product.product_id, controller.signal), setVariants, '판매 규격을 불러오지 못했습니다.')
    load('nutrition', fetchCompareNutrition([product.product_id], controller.signal), (rows) => setNutrition(rows[0] ?? null), '영양 정보를 불러오지 못했습니다.')
    load('ingredients', fetchCompareIngredients([product.product_id], controller.signal), (rows) => setIngredients(rows[0] ?? null), '원재료 정보를 불러오지 못했습니다.')
    load('manufacturing', fetchProductManufacturing(product.product_id, controller.signal), setManufacturing, '제조 정보를 불러오지 못했습니다.')
    load('markets', fetchProductMarkets(product.product_id, controller.signal), setMarkets, '유통 정보를 불러오지 못했습니다.')

    return () => {
      active = false
      controller.abort()
    }
  }, [product.product_id])

  const nutritionStructured = hasStructuredNutrition(nutrition)
  const nutritionSupplementContext = supplementalNutritionContext(nutrition)
  const ingredientSupplementContext = supplementalIngredientContext(ingredients)
  const supplementalIngredientNames = ingredients?.supplemental_full_ingredient_names ?? []
  const hasSupplementalFullIngredients = supplementalIngredientNames.length > 0
  const hasRecipeIdentity = product.recipe_families.length > 0
    || product.recipe_details.length > 0
    || product.official_recipe_traits.includes('grain_free')
  const contextStatus = loading.manufacturing || loading.markets
    ? '불러오는 중'
    : errors.manufacturing && errors.markets
      ? '조회 실패'
      : manufacturing || markets.length
        ? '확정 정보 있음'
        : '현재 확정 정보 없음'
  const ingredientPreview = ingredients?.ingredient_names.slice(0, 8) ?? []
  const ingredientPreviewLabel = ingredientPreview.length
    ? `${ingredientPreview.join(' · ')}${(ingredients?.ingredient_names.length ?? 0) > ingredientPreview.length ? ` · 외 ${(ingredients?.ingredient_names.length ?? 0) - ingredientPreview.length}개` : ''}`
    : '확인된 목록 없음'

  return (
    <main className="detail-stage">
      <header className="detail-topbar">
        <button type="button" onClick={onClose}>← 돌아가기</button>
        <span>PRODUCT DETAIL</span>
      </header>

      <section className="detail-identity">
        <ProductImage product={product} />
        <div className="detail-identity-copy">
          <span>{product.brand}</span>
          <h1>{product.canonical_name}</h1>
          <p>
            {product.feed_type ?? '형태 미확인'} ·{' '}
            {product.life_stage ? valueLabel(product.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'}
          </p>
        </div>
        <div className="detail-status-grid">
          <Fact label="판매 규격" value={loading.variants ? '불러오는 중' : errors.variants ? '조회 실패' : variants.length ? `${variants.length}개 확인` : '미확인'} />
          <Fact label="영양" value={loading.nutrition ? '불러오는 중' : errors.nutrition ? '조회 실패' : nutrition ? nutritionStructured ? '수치 확인' : '표기 확인 · 수치 정리 중' : '확인 정보 없음'} />
          <Fact label="원재료" value={loading.ingredients ? '불러오는 중' : errors.ingredients ? '조회 실패' : ingredients ? hasSupplementalFullIngredients ? `${completenessLabel(ingredients.completeness_status)} · 배합 전체 목록 보완` : completenessLabel(ingredients.completeness_status) : '확인 정보 없음'} />
          <Fact label="제조 · 유통" value={contextStatus} />
        </div>
      </section>

      <nav className="detail-tabs" aria-label="제품 상세 항목">
        <button className={tab === 'overview' ? 'is-active' : ''} type="button" onClick={() => setTab('overview')}>개요</button>
        <button className={tab === 'nutrition' ? 'is-active' : ''} type="button" onClick={() => setTab('nutrition')}>영양</button>
        <button className={tab === 'ingredients' ? 'is-active' : ''} type="button" onClick={() => setTab('ingredients')}>원재료</button>
        <button className={tab === 'context' ? 'is-active' : ''} type="button" onClick={() => setTab('context')}>제조 · 유통</button>
      </nav>

      <div className="detail-body">
        {tab === 'overview' ? (
          <>
            <section className="detail-section">
              <div className="detail-section-heading">
                <span>01</span>
                <div><h2>제품 기본 정보</h2><p>확인된 제품 정보만 보여줍니다. 비어 있는 검색용 분류는 제품 정보 없음으로 표시하지 않습니다.</p></div>
              </div>
              <div className="detail-fact-table">
                <Fact label="사료 형태" value={product.feed_type ?? '미확인'} />
                <Fact label="생애주기" value={product.life_stage ? valueLabel(product.life_stage, LIFE_STAGE_LABELS) : '미확인'} />
                {product.features.length ? <Fact label="기능" value={listLabel(product.features, FEATURE_LABELS)} /> : null}
                {product.official_targets.length ? <Fact label="공식 대상" value={listLabel(product.official_targets, TARGET_LABELS)} /> : null}
                {product.recipe_families.length ? <Fact label="공식 레시피 계열" value={listLabel(product.recipe_families, RECIPE_LABELS)} /> : null}
                {product.recipe_details.length ? <Fact label="공식 세부 레시피" value={listLabel(product.recipe_details, RECIPE_LABELS)} /> : null}
                {product.official_recipe_traits.includes('grain_free') ? <Fact label="공식 레시피 특성" value="Grain-Free 표기 확인" /> : null}
                {!product.features.length && !product.official_targets.length && !hasRecipeIdentity ? <Fact label="추가 공식 분류" value="현재 별도 확인 분류 없음" /> : null}
              </div>
            </section>

            <section className="detail-section">
              <div className="detail-section-heading">
                <span>02</span>
                <div><h2>원재료 요약</h2><p>검색용 레시피 태그 대신 실제로 확인된 원재료 목록을 우선 보여줍니다.</p></div>
              </div>
              {loading.ingredients ? <div className="detail-state">원재료 정보를 불러오는 중입니다.</div> : null}
              {errors.ingredients ? <div className="detail-state is-error">원재료 정보를 불러오지 못했습니다. {errors.ingredients}</div> : null}
              {!loading.ingredients && !errors.ingredients && ingredients ? (
                <div className="detail-fact-table">
                  <Fact label="대표 목록 상태" value={completenessLabel(ingredients.completeness_status)} />
                  <Fact label="대표 확인 범위" value={evidenceContext(ingredients, variants, Boolean(errors.variants), loading.variants)} />
                  <Fact label="대표 원재료 수" value={`${ingredients.ingredient_count}개`} />
                  <Fact label="주요 원재료" value={ingredientPreviewLabel} />
                  {hasSupplementalFullIngredients ? <Fact label="현재 확인 배합 전체 목록" value={`${ingredients.supplemental_full_ingredient_count ?? supplementalIngredientNames.length}개 확인`} /> : null}
                </div>
              ) : null}
              {!loading.ingredients && !errors.ingredients && !ingredients ? <div className="detail-empty">현재 공개 화면에서 확인할 수 있는 원재료 목록이 없습니다.</div> : null}
            </section>

            <section className="detail-section">
              <div className="detail-section-heading">
                <span>03</span>
                <div><h2>한국 판매 규격</h2><p>현재 확인된 용량과 포장 단위입니다. 규격이 다르다고 다른 레시피로 보지는 않습니다.</p></div>
              </div>
              {loading.variants ? <div className="detail-state">판매 규격을 불러오는 중입니다.</div> : null}
              {errors.variants ? <div className="detail-state is-error">판매 규격을 불러오지 못했습니다. {errors.variants}</div> : null}
              {!loading.variants && !errors.variants && variants.length ? (
                <div className="detail-variant-list">
                  {variants.map((variant) => (
                    <div className="detail-variant-row" key={variant.variant_id}>
                      <div>
                        <strong>{variantSizeLabel(variant) ?? '규격 표기 미확인'}</strong>
                        <span>{variant.units_per_sale && variant.units_per_sale > 1 ? `${variant.units_per_sale}개 구성` : '단일 판매 규격'}</span>
                      </div>
                      <div>
                        <span>판매 단위</span>
                        <strong>{variant.units_per_sale != null ? `${variant.units_per_sale}개` : '미확인'}</strong>
                      </div>
                      <div>
                        <span>총 판매 중량</span>
                        <strong>{weightLabel(variant.sale_total_weight_g)}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {!loading.variants && !errors.variants && variants.length === 0 ? <div className="detail-empty">현재 확인된 판매 규격이 없습니다.</div> : null}
            </section>
          </>
        ) : null}

        {tab === 'nutrition' ? (
          <section className="detail-section">
            <div className="detail-section-heading">
              <span>N</span>
              <div><h2>영양 · 열량</h2><p>현재 확인된 공식 표시값입니다. 다른 규격이나 배합에 그대로 적용하지 않습니다.</p></div>
            </div>
            {loading.nutrition ? <div className="detail-state">영양 정보를 불러오는 중입니다.</div> : null}
            {errors.nutrition ? <div className="detail-state is-error">영양 정보를 불러오지 못했습니다. {errors.nutrition}</div> : null}
            {!loading.nutrition && !errors.nutrition && nutrition ? (
              <>
                <div className="detail-evidence-context">{evidenceContext(nutrition, variants, Boolean(errors.variants), loading.variants)}</div>
                {nutritionSupplementContext ? <div className="detail-evidence-context">일부 미기재 값 보완 · {nutritionSupplementContext}</div> : null}
                {nutritionStructured ? (
                  <>
                    <div className="detail-nutrition-grid">
                      <Fact label="열량" value={energyValue(nutrition)} />
                      <Fact label="조단백질" value={nutrientValue(nutrition.protein_pct, nutrition.protein_qualifier)} />
                      <Fact label="조지방" value={nutrientValue(nutrition.fat_pct, nutrition.fat_qualifier)} />
                      <Fact label="조섬유" value={nutrientValue(nutrition.fiber_pct, nutrition.fiber_qualifier)} />
                      <Fact label="수분" value={nutrientValue(nutrition.moisture_pct, nutrition.moisture_qualifier)} />
                      <Fact label="조회분" value={nutrientValue(nutrition.ash_pct, nutrition.ash_qualifier)} />
                      {(nutrition.additional_nutrients ?? []).filter((value) => value.amount != null).map((value, index) => (
                        <Fact
                          key={`${value.nutrient_key}-${index}`}
                          label={additionalNutrientLabel(value)}
                          value={additionalNutrientValue(value)}
                        />
                      ))}
                    </div>
                    <p className="detail-note">표시되지 않은 값은 추정해 채우지 않습니다. 사료 형태가 다른 제품의 열량도 숫자만으로 좋고 나쁨을 판단하지 않습니다.</p>
                  </>
                ) : (
                  <div className="detail-empty">영양 표기 원문은 확인됐지만 핵심 수치 구조화가 아직 완료되지 않았습니다.</div>
                )}
              </>
            ) : null}
            {!loading.nutrition && !errors.nutrition && !nutrition ? <div className="detail-empty">현재 확인된 영양 정보가 없습니다.</div> : null}
          </section>
        ) : null}

        {tab === 'ingredients' ? (
          <section className="detail-section">
            <div className="detail-section-heading">
              <span>I</span>
              <div><h2>원재료</h2><p>대표 확인 자료와 현재 확인 배합의 전체 목록을 근거 범위별로 구분해 보여줍니다.</p></div>
            </div>
            {loading.ingredients ? <div className="detail-state">원재료 정보를 불러오는 중입니다.</div> : null}
            {errors.ingredients ? <div className="detail-state is-error">원재료 정보를 불러오지 못했습니다. {errors.ingredients}</div> : null}
            {!loading.ingredients && !errors.ingredients && ingredients ? (
              <>
                <div className="detail-evidence-context">대표 확인 자료 · {evidenceContext(ingredients, variants, Boolean(errors.variants), loading.variants)} · {completenessLabel(ingredients.completeness_status)}</div>
                <div className="detail-ingredient-copy">
                  {ingredients.raw_text?.trim() || ingredients.ingredient_names.join(', ') || '확인된 원재료 목록 없음'}
                </div>
                {ingredients.ingredient_names.length ? (
                  <div className="detail-ingredient-list">
                    {ingredients.ingredient_names.map((ingredient, index) => <span key={`primary-${ingredient}-${index}`}>{index + 1}. {ingredient}</span>)}
                  </div>
                ) : null}
                {hasSupplementalFullIngredients ? (
                  <>
                    <div className="detail-evidence-context">현재 확인 배합 전체 목록 · {ingredientSupplementContext}</div>
                    <div className="detail-ingredient-copy">
                      {ingredients.supplemental_full_raw_text?.trim() || supplementalIngredientNames.join(', ')}
                    </div>
                    <div className="detail-ingredient-list">
                      {supplementalIngredientNames.map((ingredient, index) => <span key={`supplemental-${ingredient}-${index}`}>{index + 1}. {ingredient}</span>)}
                    </div>
                  </>
                ) : null}
                <p className="detail-note">대표 목록이 일부 또는 요약 상태라면 보이지 않는 원료를 ‘없음’으로 보지 않습니다. 현재 확인 배합의 전체 목록이 별도로 있어도 한국 라벨 자체가 전체 목록이라는 뜻은 아닙니다. 알레르기 안전이나 교차오염 없음도 보장하지 않습니다.</p>
              </>
            ) : null}
            {!loading.ingredients && !errors.ingredients && !ingredients ? <div className="detail-empty">현재 확인된 원재료 목록이 없습니다.</div> : null}
          </section>
        ) : null}

        {tab === 'context' ? (
          <>
            <section className="detail-section">
              <div className="detail-section-heading">
                <span>M</span>
                <div><h2>제조 정보</h2><p>브랜드 본사와 실제 제조사는 따로 구분합니다.</p></div>
              </div>
              {loading.manufacturing ? <div className="detail-state">제조 정보를 불러오는 중입니다.</div> : null}
              {errors.manufacturing ? <div className="detail-state is-error">제조 정보를 불러오지 못했습니다. {errors.manufacturing}</div> : null}
              {!loading.manufacturing && !errors.manufacturing && manufacturing ? (
                <div className="detail-fact-table">
                  <Fact label="제조국" value={countryLabel(manufacturing.country_code)} />
                  <Fact label="실제 제조사" value={manufacturing.manufacturer ?? '미확인'} />
                  <Fact label="제조 공장" value={manufacturing.plant ?? '공장 미확인'} />
                  <Fact label="확인 범위" value={`${scopeLabel(manufacturing.observation_scope)}${manufacturing.is_current_resolved_formula ? ' · 현재 배합 대응' : ''}`} />
                </div>
              ) : null}
              {!loading.manufacturing && !errors.manufacturing && !manufacturing ? <div className="detail-empty">현재 확정된 제조 정보가 없습니다.</div> : null}
            </section>

            <section className="detail-section">
              <div className="detail-section-heading">
                <span>G</span>
                <div><h2>해외 판매 · 배합 확인</h2><p>해외에서 판매되는지와 한국 제품과 같은 배합인지를 따로 확인합니다.</p></div>
              </div>
              {loading.markets ? <div className="detail-state">유통 정보를 불러오는 중입니다.</div> : null}
              {errors.markets ? <div className="detail-state is-error">유통 정보를 불러오지 못했습니다. {errors.markets}</div> : null}
              {!loading.markets && !errors.markets && markets.length ? (
                <div className="detail-market-list">
                  {markets.map((market) => (
                    <div className="detail-market-row" key={`${market.country_code}-${market.display_rank}`}>
                      <div><strong>{countryLabel(market.country_code)}</strong><span>{market.assessed_at ? `${market.assessed_at} 확인` : '확인일 미기재'}</span></div>
                      <div><span>유통</span><strong>{distributionLabel(market.distribution_status)}</strong></div>
                      <div><span>배합 대응</span><strong>{formulaMarketLabel(market.formula_correspondence_status)}</strong></div>
                      <div><span>대응 제품</span><strong>{market.counterpart_name ?? '확인된 대응 제품 없음'}</strong></div>
                    </div>
                  ))}
                </div>
              ) : null}
              {!loading.markets && !errors.markets && markets.length === 0 ? <div className="detail-empty">현재 확정된 해외 유통 정보가 없습니다.</div> : null}
            </section>
          </>
        ) : null}
      </div>
    </main>
  )
}
