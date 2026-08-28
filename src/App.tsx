import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchCatalog, type CatalogProduct } from './api'
import {
  INITIAL_SEARCH,
  countActiveConditions,
  filterCatalog,
  toggleValue,
  type SearchState,
} from './search'

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

type ArraySearchField =
  | 'officialTargets'
  | 'features'
  | 'recipeFamilies'
  | 'recipeDetails'

type SingleSearchField = 'feedType' | 'lifeStage'
type Option = readonly [string, string]

function optionLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replaceAll('_', ' ')
}

function compactList(values: string[], labels: Record<string, string>, max = 2): string {
  if (values.length === 0) return '—'
  const shown = values.slice(0, max).map((value) => optionLabel(value, labels))
  return values.length > max ? `${shown.join(' · ')} +${values.length - max}` : shown.join(' · ')
}

function FilterButtons({
  options,
  selected,
  onToggle,
}: {
  options: readonly Option[]
  selected: string[]
  onToggle: (value: string) => void
}) {
  return (
    <div className="choice-grid">
      {options.map(([value, label]) => (
        <button
          className={selected.includes(value) ? 'choice is-active' : 'choice'}
          key={value}
          onClick={() => onToggle(value)}
          type="button"
          aria-pressed={selected.includes(value)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function FilterSection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section className="filter-section">
      <div className="filter-heading">
        <span>{title}</span>
        {hint ? <span className="filter-hint">{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

function ValueList({ values, labels = {} }: { values: string[]; labels?: Record<string, string> }) {
  if (values.length === 0) {
    return <span className="unknown-value">확인된 값 없음</span>
  }

  return (
    <div className="inspector-tags">
      {values.map((value) => (
        <span className="data-tag" key={value}>
          {optionLabel(value, labels)}
        </span>
      ))}
    </div>
  )
}

function Definition({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="definition">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function ProductImage({ product, className }: { product: CatalogProduct; className: string }) {
  if (!product.display_image_url) {
    return <div className={`${className} image-placeholder`}>NO IMAGE</div>
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

function SignalLine({ label, value }: { label: string; value: string }) {
  return (
    <span className="signal-line">
      <b>{label}</b>
      <span>{value}</span>
    </span>
  )
}

function CoverageStatus({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <strong className={ok ? 'coverage-ok' : 'coverage-muted'}>{ok ? yes : no}</strong>
}

export default function App() {
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [search, setSearch] = useState<SearchState>(INITIAL_SEARCH)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(120)
  const [recipeSearch, setRecipeSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    fetchCatalog(controller.signal)
      .then((data) => {
        setProducts(data)
        setSelectedId(data[0]?.product_id ?? null)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(reason instanceof Error ? reason.message : '제품 데이터를 불러오지 못했습니다.')
      })
      .finally(() => setLoading(false))

    return () => controller.abort()
  }, [])

  const filtered = useMemo(() => filterCatalog(products, search), [products, search])

  useEffect(() => {
    setVisibleCount(120)
  }, [search])

  const recipeDetails = useMemo(() => {
    const values = new Set<string>()
    for (const product of products) {
      for (const value of product.recipe_details) values.add(value)
    }
    return [...values].sort((a, b) => a.localeCompare(b, 'en'))
  }, [products])

  const visibleRecipeDetails = useMemo(() => {
    const query = recipeSearch.trim().toLocaleLowerCase('ko-KR')
    return recipeDetails
      .filter((value) => {
        if (!query) return true
        const label = optionLabel(value, RECIPE_DETAIL_LABELS).toLocaleLowerCase('ko-KR')
        return value.toLocaleLowerCase('en').includes(query) || label.includes(query)
      })
      .slice(0, 36)
  }, [recipeDetails, recipeSearch])

  const selectedProduct =
    filtered.find((product) => product.product_id === selectedId) ?? filtered[0] ?? null

  const activeConditions = countActiveConditions(search)
  const visibleProducts = filtered.slice(0, visibleCount)
  const catalogState = loading ? 'LOADING' : error ? 'DATA ERROR' : 'CATALOG'

  function setSingle(field: SingleSearchField, value: string) {
    setSearch((current) => ({
      ...current,
      [field]: current[field] === value ? '' : value,
    }))
  }

  function toggleArray(field: ArraySearchField, value: string) {
    setSearch((current) => ({
      ...current,
      [field]: toggleValue(current[field], value),
    }))
  }

  function resetSearch() {
    setSearch(INITIAL_SEARCH)
    setRecipeSearch('')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          <strong>CATFOOD</strong>
          <span>/ GENERAL SCREENER</span>
        </div>
        <div className="topbar-status">
          <span>{products.length || '—'} PRODUCTS</span>
          <span>{activeConditions} CONDITIONS</span>
          <span className={error ? 'status-dot is-error' : 'status-dot'}>{catalogState}</span>
        </div>
      </header>

      <main className="workspace">
        <aside className="conditions-pane pane">
          <div className="pane-title">
            <span>SEARCH CONDITIONS</span>
            <button className="text-button" type="button" onClick={resetSearch}>
              초기화
            </button>
          </div>

          <div className="pane-scroll">
            <div className="condition-group-title">
              <span>PRIMARY</span>
              <small>기본 검색 조건</small>
            </div>

            <FilterSection title="사료 형태" hint="단일 선택">
              <FilterButtons
                options={FEED_TYPES}
                selected={search.feedType ? [search.feedType] : []}
                onToggle={(value) => setSingle('feedType', value)}
              />
            </FilterSection>

            <FilterSection title="제품 표기 생애주기" hint="단일 선택">
              <FilterButtons
                options={LIFE_STAGES}
                selected={search.lifeStage ? [search.lifeStage] : []}
                onToggle={(value) => setSingle('lifeStage', value)}
              />
              <p className="field-note">나이에서 생애주기를 자동 추론하지 않습니다.</p>
            </FilterSection>

            <FilterSection title="공식 대상" hint="복수 선택 OR">
              <FilterButtons
                options={TARGETS}
                selected={search.officialTargets}
                onToggle={(value) => toggleArray('officialTargets', value)}
              />
            </FilterSection>

            <FilterSection title="부가 기능" hint="복수 선택 AND">
              <FilterButtons
                options={FEATURES}
                selected={search.features}
                onToggle={(value) => toggleArray('features', value)}
              />
            </FilterSection>

            <div className="condition-group-title secondary-group">
              <span>RECIPE / TRAITS</span>
              <small>선택 사항</small>
            </div>

            <FilterSection title="레시피 계열" hint="복수 선택 OR">
              <FilterButtons
                options={RECIPE_FAMILIES}
                selected={search.recipeFamilies}
                onToggle={(value) => toggleArray('recipeFamilies', value)}
              />
            </FilterSection>

            <FilterSection title="공식 레시피 특성">
              <button
                className={search.grainFree ? 'choice wide is-active' : 'choice wide'}
                type="button"
                aria-pressed={search.grainFree}
                onClick={() => setSearch((current) => ({ ...current, grainFree: !current.grainFree }))}
              >
                Grain-Free 명시
              </button>
              <p className="field-note">명시적 공식 claim이 확인된 제품만 포함합니다.</p>
            </FilterSection>

            <div className="refine-title">REFINE</div>
            {search.recipeFamilies.length > 0 || search.recipeDetails.length > 0 ? (
              <FilterSection title="세부 레시피" hint="복수 선택 OR">
                {search.recipeDetails.length > 0 ? (
                  <div className="selected-refinements">
                    {search.recipeDetails.map((value) => (
                      <button
                        className="selected-refinement"
                        key={value}
                        type="button"
                        onClick={() => toggleArray('recipeDetails', value)}
                      >
                        {optionLabel(value, RECIPE_DETAIL_LABELS)} ×
                      </button>
                    ))}
                  </div>
                ) : null}
                <input
                  className="recipe-search"
                  type="search"
                  value={recipeSearch}
                  placeholder="세부 레시피 검색"
                  onChange={(event) => setRecipeSearch(event.target.value)}
                />
                <div className="recipe-detail-grid">
                  {visibleRecipeDetails.map((value) => (
                    <button
                      className={search.recipeDetails.includes(value) ? 'choice is-active' : 'choice'}
                      key={value}
                      type="button"
                      aria-pressed={search.recipeDetails.includes(value)}
                      onClick={() => toggleArray('recipeDetails', value)}
                    >
                      {optionLabel(value, RECIPE_DETAIL_LABELS)}
                    </button>
                  ))}
                </div>
              </FilterSection>
            ) : (
              <p className="refine-empty">레시피 계열을 선택하면 세부 레시피를 더 좁힐 수 있습니다.</p>
            )}
          </div>
        </aside>

        <section className="results-pane pane">
          <div className="results-header">
            <div>
              <span className="pane-kicker">RESULTS</span>
              <strong>{loading ? '—' : filtered.length}</strong>
            </div>
            <span className="results-note">STRICT MATCH</span>
          </div>

          {error ? (
            <div className="state-message error-message">
              <strong>제품 데이터를 불러오지 못했습니다.</strong>
              <span>{error}</span>
            </div>
          ) : null}

          {loading ? (
            <div className="state-message">
              <strong>제품 데이터를 불러오는 중입니다.</strong>
            </div>
          ) : null}

          {!loading && !error && filtered.length === 0 ? (
            <div className="state-message">
              <strong>검색 결과가 없습니다.</strong>
              <span>조건을 자동으로 완화하지 않습니다. SEARCH CONDITIONS 또는 REFINE을 수정하십시오.</span>
            </div>
          ) : null}

          {!error && filtered.length > 0 ? (
            <div className="result-list">
              {visibleProducts.map((product, index) => {
                const isSelected = product.product_id === selectedProduct?.product_id
                return (
                  <button
                    className={isSelected ? 'result-row is-selected' : 'result-row'}
                    key={product.product_id}
                    type="button"
                    onClick={() => setSelectedId(product.product_id)}
                  >
                    <span className="result-index">{String(index + 1).padStart(3, '0')}</span>
                    <ProductImage className="result-image" product={product} />
                    <span className="result-main">
                      <span className="result-brand">{product.brand}</span>
                      <strong>{product.canonical_name}</strong>
                      <span className="result-meta">
                        {product.feed_type ?? '형태 미확인'} ·{' '}
                        {product.life_stage
                          ? optionLabel(product.life_stage, LIFE_STAGE_LABELS)
                          : '생애주기 미확인'}{' '}
                        · {product.representative_package_size_text ?? '대표 규격 미확인'}
                      </span>
                    </span>
                    <span className="result-signals">
                      <SignalLine
                        label="TARGET"
                        value={compactList(product.official_targets, TARGET_LABELS)}
                      />
                      <SignalLine
                        label="FEATURE"
                        value={compactList(product.features, FEATURE_LABELS)}
                      />
                      <SignalLine
                        label="RECIPE"
                        value={compactList(product.recipe_details, RECIPE_DETAIL_LABELS)}
                      />
                    </span>
                  </button>
                )
              })}
              {visibleCount < filtered.length ? (
                <button
                  className="load-more"
                  type="button"
                  onClick={() => setVisibleCount((count) => count + 120)}
                >
                  + 120 MORE / {filtered.length - visibleCount} REMAIN
                </button>
              ) : null}
            </div>
          ) : null}
        </section>

        <aside className="inspector-pane pane">
          <div className="pane-title">
            <span>INSPECTOR</span>
            <span className="inspector-pane-state">SELECTED PRODUCT</span>
          </div>

          <div className="inspector-scroll">
            {selectedProduct ? (
              <>
                <section className="inspector-identity inspector-identity-compact">
                  <ProductImage className="inspector-image" product={selectedProduct} />
                  <div className="inspector-name-block">
                    <span>{selectedProduct.brand}</span>
                    <h1>{selectedProduct.canonical_name}</h1>
                    <p>
                      {selectedProduct.feed_type ?? '형태 미확인'} ·{' '}
                      {selectedProduct.life_stage
                        ? optionLabel(selectedProduct.life_stage, LIFE_STAGE_LABELS)
                        : '생애주기 미확인'}
                    </p>
                  </div>
                </section>

                <div className="subsection-title inspector-section-title">PRODUCT</div>
                <dl className="definition-list">
                  <Definition label="대표 규격">
                    {selectedProduct.representative_package_size_text ?? (
                      <span className="unknown-value">미확인</span>
                    )}
                  </Definition>
                  <Definition label="판매 SKU">
                    {selectedProduct.has_variants
                      ? `${selectedProduct.variant_count}개 확인`
                      : <span className="unknown-value">current SKU 미확인</span>}
                  </Definition>
                  <Definition label="공식 대상">
                    <ValueList values={selectedProduct.official_targets} labels={TARGET_LABELS} />
                  </Definition>
                  <Definition label="부가 기능">
                    <ValueList values={selectedProduct.features} labels={FEATURE_LABELS} />
                  </Definition>
                  <Definition label="레시피 계열">
                    <ValueList values={selectedProduct.recipe_families} labels={RECIPE_FAMILY_LABELS} />
                  </Definition>
                  <Definition label="세부 레시피">
                    <ValueList values={selectedProduct.recipe_details} labels={RECIPE_DETAIL_LABELS} />
                  </Definition>
                  <Definition label="레시피 특성">
                    <ValueList values={selectedProduct.official_recipe_traits} />
                  </Definition>
                </dl>

                <div className="subsection-title inspector-section-title">DATA COVERAGE</div>
                <div className="coverage-block">
                  <div className="coverage-row">
                    <span>원재료 선언</span>
                    <CoverageStatus
                      ok={selectedProduct.has_full_ingredient_declaration}
                      yes={`FULL · ${selectedProduct.full_ingredient_declaration_count}`}
                      no={selectedProduct.has_ingredient_details ? 'PARTIAL' : '미확인'}
                    />
                  </div>
                  <div className="coverage-row">
                    <span>영양 패널</span>
                    <CoverageStatus
                      ok={selectedProduct.has_nutrition_details}
                      yes={`${selectedProduct.nutrition_panel_count} PANEL`}
                      no="미확인"
                    />
                  </div>
                  <div className="coverage-row">
                    <span>제조 관측</span>
                    <CoverageStatus
                      ok={selectedProduct.has_manufacturing_details}
                      yes={`${selectedProduct.manufacturing_observation_count} OBS`}
                      no="미확인"
                    />
                  </div>
                  <div className="coverage-row">
                    <span>원료 term 결과</span>
                    <CoverageStatus
                      ok={selectedProduct.ingredient_term_result_count > 0}
                      yes={`${selectedProduct.ingredient_term_result_count} TERMS`}
                      no="미확인"
                    />
                  </div>
                </div>

                <div className="subsection-title inspector-section-title">MANUFACTURING / MARKET</div>
                <dl className="definition-list">
                  <Definition label="제조국">
                    <ValueList values={selectedProduct.manufacturing_country_codes} />
                  </Definition>
                  <Definition label="현재 확인 시장">
                    <ValueList values={selectedProduct.current_market_country_codes} />
                  </Definition>
                  <Definition label="동일 Formula 시장">
                    <ValueList values={selectedProduct.formula_match_market_country_codes} />
                  </Definition>
                  <Definition label="시장 관측">
                    {selectedProduct.has_market_details
                      ? `${selectedProduct.market_observation_count}건`
                      : <span className="unknown-value">확인된 값 없음</span>}
                  </Definition>
                </dl>

                <div className="inspector-record-id">{selectedProduct.product_id}</div>
              </>
            ) : (
              <div className="state-message compact">
                <strong>선택된 제품이 없습니다.</strong>
              </div>
            )}
          </div>
        </aside>
      </main>

      <footer className="footerbar">
        <span>STRICT SEARCH</span>
        <span>UNKNOWN ≠ NONE</span>
        <span>NO RECOMMENDATION SCORE</span>
      </footer>
    </div>
  )
}
