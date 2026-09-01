import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Home from './Home'
import { fetchCatalog, type CatalogProduct } from './api'
import {
  INITIAL_REFINE,
  INITIAL_SEARCH,
  countActiveConditions,
  evaluateCatalog,
  lookupCatalog,
  toggleValue,
  type CandidateEvaluation,
  type RefineState,
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

type Mode = 'switch' | 'explore' | 'lookup'
type Screen = 'home' | 'workspace'
type ArraySearchField = 'officialTargets' | 'features' | 'recipeFamilies'
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

function relationLabel(value: string): string {
  const separator = value.indexOf(':')
  if (separator < 0) return value

  const group = value.slice(0, separator)
  const rawValue = value.slice(separator + 1)

  if (group === '형태') return optionLabel(rawValue, Object.fromEntries(FEED_TYPES))
  if (group === '생애주기') return optionLabel(rawValue, LIFE_STAGE_LABELS)
  if (group === '대상') return optionLabel(rawValue, TARGET_LABELS)
  if (group === '기능') return optionLabel(rawValue, FEATURE_LABELS)
  if (group === '계열') return optionLabel(rawValue, RECIPE_FAMILY_LABELS)
  if (group === '세부') return optionLabel(rawValue, RECIPE_DETAIL_LABELS)
  if (group === '특성' && rawValue === 'grain_free') return 'Grain-Free'

  return rawValue.replaceAll('_', ' ')
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

function RelationList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <span className="unknown-value">{empty}</span>

  return (
    <div className="inspector-tags">
      {values.map((value) => (
        <span className="data-tag relation-tag" key={value}>
          {relationLabel(value)}
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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="condition-summary-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ModeButton({ mode, active, label, onClick }: { mode: Mode; active: Mode; label: string; onClick: (mode: Mode) => void }) {
  return (
    <button
      className={mode === active ? 'mode-button is-active' : 'mode-button'}
      type="button"
      onClick={() => onClick(mode)}
    >
      {label}
    </button>
  )
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [mode, setMode] = useState<Mode>('explore')
  const [search, setSearch] = useState<SearchState>(INITIAL_SEARCH)
  const [draftSearch, setDraftSearch] = useState<SearchState>(INITIAL_SEARCH)
  const [refine, setRefine] = useState<RefineState>(INITIAL_REFINE)
  const [editingConditions, setEditingConditions] = useState(true)
  const [lookupQuery, setLookupQuery] = useState('')
  const [switchQuery, setSwitchQuery] = useState('')
  const [currentProductId, setCurrentProductId] = useState<string | null>(null)
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
        setError(null)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(reason instanceof Error ? reason.message : '제품 데이터를 불러오지 못했습니다.')
      })
      .finally(() => setLoading(false))

    return () => controller.abort()
  }, [])

  const evaluated = useMemo(
    () => evaluateCatalog(products, search, refine),
    [products, search, refine],
  )

  const lookupResults = useMemo(
    () => lookupCatalog(products, lookupQuery),
    [products, lookupQuery],
  )

  const switchResults = useMemo(
    () => lookupCatalog(products, switchQuery),
    [products, switchQuery],
  )

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

  const resultProducts = useMemo(() => {
    if (mode === 'lookup') return lookupResults
    if (mode === 'switch') return switchResults
    if (editingConditions) return []
    return evaluated.map((item) => item.product)
  }, [mode, lookupResults, switchResults, editingConditions, evaluated])

  const selectedProduct =
    resultProducts.find((product) => product.product_id === selectedId) ?? resultProducts[0] ?? null

  const selectedEvaluation =
    mode === 'explore' && selectedProduct
      ? evaluated.find((item) => item.product.product_id === selectedProduct.product_id) ?? null
      : null

  const currentProduct = products.find((product) => product.product_id === currentProductId) ?? null
  const activeConditions = countActiveConditions(search, refine)
  const visibleProducts = resultProducts.slice(0, visibleCount)
  const catalogState = loading ? 'LOADING' : error ? 'DATA ERROR' : 'CATALOG'

  useEffect(() => {
    setVisibleCount(120)
    setSelectedId(null)
  }, [mode, search, refine, lookupQuery, switchQuery, editingConditions])

  function setDraftSingle(field: SingleSearchField, value: string) {
    setDraftSearch((current) => ({
      ...current,
      [field]: current[field] === value ? '' : value,
    }))
  }

  function toggleDraftArray(field: ArraySearchField, value: string) {
    setDraftSearch((current) => ({
      ...current,
      [field]: toggleValue(current[field], value),
    }))
  }

  function applyConditions() {
    setSearch(draftSearch)
    setRefine(INITIAL_REFINE)
    setRecipeSearch('')
    setEditingConditions(false)
  }

  function editConditions() {
    setDraftSearch(search)
    setEditingConditions(true)
  }

  function resetDraft() {
    setDraftSearch(INITIAL_SEARCH)
  }

  function changeMode(nextMode: Mode) {
    setMode(nextMode)
    setSelectedId(null)
    setScreen('workspace')
  }

  function startFromHome(nextMode: Mode, query = '') {
    if (nextMode === 'lookup') setLookupQuery(query)
    if (nextMode === 'switch') setSwitchQuery(query)
    if (nextMode === 'explore') setEditingConditions(true)
    setMode(nextMode)
    setSelectedId(null)
    setScreen('workspace')
  }

  function exploreResultNote(): string {
    if (editingConditions) return 'SET CONDITIONS'
    if (activeConditions === 0) return 'CATALOG ORDER'
    return 'CONFIRMED OVERLAP'
  }

  function resultNote(): string {
    if (mode === 'lookup') return 'DIRECT LOOKUP'
    if (mode === 'switch') return 'CURRENT PRODUCT SEARCH'
    return exploreResultNote()
  }

  function resultCount(): string | number {
    if (loading) return '—'
    if (mode === 'explore' && editingConditions) return '—'
    return resultProducts.length
  }

  function renderConditionEditor() {
    return (
      <>
        <div className="condition-group-title">
          <span>DIRECT CONSTRAINTS</span>
          <small>충돌 시 제외</small>
        </div>

        <FilterSection title="사료 형태" hint="선택 시 필수">
          <FilterButtons
            options={FEED_TYPES}
            selected={draftSearch.feedType ? [draftSearch.feedType] : []}
            onToggle={(value) => setDraftSingle('feedType', value)}
          />
        </FilterSection>

        <FilterSection title="제품 표기 생애주기" hint="label 자체를 요구할 때">
          <FilterButtons
            options={LIFE_STAGES}
            selected={draftSearch.lifeStage ? [draftSearch.lifeStage] : []}
            onToggle={(value) => setDraftSingle('lifeStage', value)}
          />
          <p className="field-note">고양이 실제 나이를 이 값으로 자동 변환하지 않습니다.</p>
        </FilterSection>

        <div className="condition-group-title secondary-group">
          <span>POSITIVE SIGNALS</span>
          <small>확인된 겹침 우선 · 미확인 유지</small>
        </div>

        <FilterSection title="공식 대상" hint="선택 사항">
          <FilterButtons
            options={TARGETS}
            selected={draftSearch.officialTargets}
            onToggle={(value) => toggleDraftArray('officialTargets', value)}
          />
        </FilterSection>

        <FilterSection title="부가 기능" hint="각 항목 독립 확인">
          <FilterButtons
            options={FEATURES}
            selected={draftSearch.features}
            onToggle={(value) => toggleDraftArray('features', value)}
          />
        </FilterSection>

        <FilterSection title="레시피 계열" hint="확인된 제품 우선">
          <FilterButtons
            options={RECIPE_FAMILIES}
            selected={draftSearch.recipeFamilies}
            onToggle={(value) => toggleDraftArray('recipeFamilies', value)}
          />
        </FilterSection>

        <FilterSection title="공식 레시피 특성" hint="확인된 표방 우선">
          <button
            className={draftSearch.grainFree ? 'choice wide is-active' : 'choice wide'}
            type="button"
            aria-pressed={draftSearch.grainFree}
            onClick={() => setDraftSearch((current) => ({ ...current, grainFree: !current.grainFree }))}
          >
            Grain-Free 공식 표방
          </button>
          <p className="field-note">표방이 없다는 이유로 곡물 포함으로 판정하지 않습니다.</p>
        </FilterSection>

        <div className="condition-actions">
          <button className="primary-action" type="button" onClick={applyConditions}>
            결과 보기
          </button>
          <button className="secondary-action" type="button" onClick={resetDraft}>
            입력 초기화
          </button>
        </div>
      </>
    )
  }

  function renderConditionSummary() {
    const hasPrimary = countActiveConditions(search) > 0

    return (
      <>
        <div className="condition-summary">
          {search.feedType ? <SummaryRow label="형태" value={search.feedType} /> : null}
          {search.lifeStage ? (
            <SummaryRow label="표기 생애주기" value={optionLabel(search.lifeStage, LIFE_STAGE_LABELS)} />
          ) : null}
          {search.officialTargets.length > 0 ? (
            <SummaryRow label="공식 대상" value={compactList(search.officialTargets, TARGET_LABELS, 4)} />
          ) : null}
          {search.features.length > 0 ? (
            <SummaryRow label="부가 기능" value={compactList(search.features, FEATURE_LABELS, 4)} />
          ) : null}
          {search.recipeFamilies.length > 0 ? (
            <SummaryRow label="레시피 계열" value={compactList(search.recipeFamilies, RECIPE_FAMILY_LABELS, 3)} />
          ) : null}
          {search.grainFree ? <SummaryRow label="레시피 특성" value="Grain-Free 공식 표방" /> : null}
          {!hasPrimary ? <p className="summary-empty">1차 조건 없음 · 전체 catalog 탐색</p> : null}
        </div>

        <div className="summary-actions">
          <button className="primary-action compact-action" type="button" onClick={editConditions}>
            조건 수정
          </button>
        </div>

        <div className="refine-title">REFINE</div>
        <FilterSection title="세부 레시피" hint="확인된 제품만 좁히기">
          {refine.recipeDetails.length > 0 ? (
            <div className="selected-refinements">
              {refine.recipeDetails.map((value) => (
                <button
                  className="selected-refinement"
                  key={value}
                  type="button"
                  onClick={() => setRefine((current) => ({
                    ...current,
                    recipeDetails: toggleValue(current.recipeDetails, value),
                  }))}
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
                className={refine.recipeDetails.includes(value) ? 'choice is-active' : 'choice'}
                key={value}
                type="button"
                aria-pressed={refine.recipeDetails.includes(value)}
                onClick={() => setRefine((current) => ({
                  ...current,
                  recipeDetails: toggleValue(current.recipeDetails, value),
                }))}
              >
                {optionLabel(value, RECIPE_DETAIL_LABELS)}
              </button>
            ))}
          </div>
          <p className="field-note">여기서는 선택한 세부 레시피가 공식적으로 확인된 제품만 남깁니다.</p>
        </FilterSection>
      </>
    )
  }

  function renderLeftPane() {
    if (mode === 'lookup') {
      return (
        <>
          <div className="mode-intro">
            <strong>제품 직접 조회</strong>
            <span>이미 알고 있는 브랜드 또는 제품명을 검색합니다.</span>
          </div>
          <FilterSection title="브랜드 / 제품명">
            <input
              className="lookup-input"
              type="search"
              value={lookupQuery}
              placeholder="예: 오리젠 식스 피쉬"
              onChange={(event) => setLookupQuery(event.target.value)}
            />
          </FilterSection>
        </>
      )
    }

    if (mode === 'switch') {
      return (
        <>
          <div className="mode-intro">
            <strong>현재 사료에서 바꾸기</strong>
            <span>먼저 현재 먹이는 제품을 찾습니다. exact SKU 선택은 다음 단계에서 연결합니다.</span>
          </div>
          <FilterSection title="현재 제품 찾기">
            <input
              className="lookup-input"
              type="search"
              value={switchQuery}
              placeholder="브랜드 또는 제품명"
              onChange={(event) => setSwitchQuery(event.target.value)}
            />
          </FilterSection>
          {currentProduct ? (
            <div className="switch-current">
              <span>CURRENT PRODUCT</span>
              <strong>{currentProduct.brand}</strong>
              <b>{currentProduct.canonical_name}</b>
              <small>{currentProduct.representative_package_size_text ?? '대표 규격 미확인'}</small>
              <div className="switch-next-state">NEXT · EXACT SKU → CHANGE → KEEP</div>
            </div>
          ) : (
            <p className="refine-empty">검색 결과에서 제품을 확인한 뒤 Inspector에서 현재 제품으로 지정합니다.</p>
          )}
        </>
      )
    }

    return editingConditions ? renderConditionEditor() : renderConditionSummary()
  }

  function renderResultSignals(product: CatalogProduct, evaluation: CandidateEvaluation | null) {
    if (mode === 'explore' && evaluation) {
      return (
        <>
          <SignalLine
            label="MATCH"
            value={evaluation.confirmedMatches.length > 0
              ? evaluation.confirmedMatches.slice(0, 3).map(relationLabel).join(' · ')
              : '확인된 겹침 없음'}
          />
          <SignalLine
            label="UNKNOWN"
            value={evaluation.unknowns.length > 0 ? evaluation.unknowns.slice(0, 2).join(' · ') : '—'}
          />
          <SignalLine label="RECIPE" value={compactList(product.recipe_details, RECIPE_DETAIL_LABELS)} />
        </>
      )
    }

    return (
      <>
        <SignalLine label="TARGET" value={compactList(product.official_targets, TARGET_LABELS)} />
        <SignalLine label="FEATURE" value={compactList(product.features, FEATURE_LABELS)} />
        <SignalLine label="RECIPE" value={compactList(product.recipe_details, RECIPE_DETAIL_LABELS)} />
      </>
    )
  }

  if (screen === 'home') {
    return (
      <Home
        productCount={products.length}
        loading={loading}
        onStart={startFromHome}
      />
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand-mark workspace-brand" type="button" onClick={() => setScreen('home')}>
          <strong>CATFOOD</strong>
          <span>/ PRODUCT EXPLORER</span>
        </button>
        <nav className="mode-nav" aria-label="탐색 모드">
          <ModeButton mode="switch" active={mode} label="SWITCH" onClick={changeMode} />
          <ModeButton mode="explore" active={mode} label="EXPLORE" onClick={changeMode} />
          <ModeButton mode="lookup" active={mode} label="LOOKUP" onClick={changeMode} />
        </nav>
        <div className="topbar-status">
          <span>{products.length || '—'} PRODUCTS</span>
          <span>{mode === 'explore' ? `${activeConditions} CONDITIONS` : mode.toUpperCase()}</span>
          <span className={error ? 'status-dot is-error' : 'status-dot'}>{catalogState}</span>
        </div>
      </header>

      <main className="workspace">
        <aside className="conditions-pane pane">
          <div className="pane-title">
            <span>{mode === 'explore' ? 'SEARCH CONDITIONS' : mode === 'lookup' ? 'LOOKUP' : 'SWITCH'}</span>
            {mode === 'explore' && editingConditions ? (
              <button className="text-button" type="button" onClick={resetDraft}>초기화</button>
            ) : null}
          </div>
          <div className="pane-scroll">{renderLeftPane()}</div>
        </aside>

        <section className="results-pane pane">
          <div className="results-header">
            <div>
              <span className="pane-kicker">RESULTS</span>
              <strong>{resultCount()}</strong>
            </div>
            <span className="results-note">{resultNote()}</span>
          </div>

          {error ? (
            <div className="state-message error-message">
              <strong>제품 데이터를 불러오지 못했습니다.</strong>
              <span>{error}</span>
            </div>
          ) : null}

          {loading ? (
            <div className="state-message"><strong>제품 데이터를 불러오는 중입니다.</strong></div>
          ) : null}

          {!loading && !error && mode === 'explore' && editingConditions ? (
            <div className="state-message session-message">
              <strong>검색 조건을 설정하십시오.</strong>
              <span>직접 충돌 조건과 원하는 방향을 구분해 입력한 뒤 결과를 생성합니다.</span>
              <span>positive signal이 미확인인 제품은 자동으로 제외하지 않습니다.</span>
            </div>
          ) : null}

          {!loading && !error && mode !== 'explore' && resultProducts.length === 0 ? (
            <div className="state-message">
              <strong>{mode === 'lookup' ? '제품명을 검색하십시오.' : '현재 제품을 검색하십시오.'}</strong>
              <span>브랜드 또는 제품명의 일부를 입력할 수 있습니다.</span>
            </div>
          ) : null}

          {!loading && !error && mode === 'explore' && !editingConditions && resultProducts.length === 0 ? (
            <div className="state-message">
              <strong>검색 결과가 없습니다.</strong>
              <span>조건을 자동으로 완화하지 않습니다. SEARCH CONDITIONS 또는 REFINE을 수정하십시오.</span>
            </div>
          ) : null}

          {!error && resultProducts.length > 0 ? (
            <div className="result-list">
              {visibleProducts.map((product) => {
                const evaluation = mode === 'explore'
                  ? evaluated.find((item) => item.product.product_id === product.product_id) ?? null
                  : null
                const isSelected = product.product_id === selectedProduct?.product_id

                return (
                  <button
                    className={isSelected ? 'result-row is-selected' : 'result-row'}
                    key={product.product_id}
                    type="button"
                    onClick={() => setSelectedId(product.product_id)}
                  >
                    <span className="result-index">{evaluation?.matchCount ? '+' : '·'}</span>
                    <ProductImage className="result-image" product={product} />
                    <span className="result-main">
                      <span className="result-brand">{product.brand}</span>
                      <strong>{product.canonical_name}</strong>
                      <span className="result-meta">
                        {product.feed_type ?? '형태 미확인'} ·{' '}
                        {product.life_stage ? optionLabel(product.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'} ·{' '}
                        {product.representative_package_size_text ?? '대표 규격 미확인'}
                      </span>
                    </span>
                    <span className="result-signals">{renderResultSignals(product, evaluation)}</span>
                  </button>
                )
              })}
              {visibleCount < resultProducts.length ? (
                <button className="load-more" type="button" onClick={() => setVisibleCount((count) => count + 120)}>
                  + 120 MORE / {resultProducts.length - visibleCount} REMAIN
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
                      {selectedProduct.life_stage ? optionLabel(selectedProduct.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'}
                    </p>
                  </div>
                </section>

                {mode === 'explore' && selectedEvaluation ? (
                  <>
                    <div className="subsection-title inspector-section-title">SEARCH RELATION</div>
                    <dl className="definition-list">
                      <Definition label="확인된 겹침">
                        <RelationList values={selectedEvaluation.confirmedMatches} empty="확인된 겹침 없음" />
                      </Definition>
                      <Definition label="미확인">
                        <ValueList values={selectedEvaluation.unknowns} />
                      </Definition>
                    </dl>
                  </>
                ) : null}

                {mode === 'switch' ? (
                  <div className="inspector-action-block">
                    <button
                      className="primary-action"
                      type="button"
                      onClick={() => setCurrentProductId(selectedProduct.product_id)}
                    >
                      현재 제품으로 선택
                    </button>
                    <p>대표 규격을 exact SKU로 간주하지 않습니다. SKU 선택은 variant 공개 계약 연결 후 진행합니다.</p>
                  </div>
                ) : null}

                <div className="subsection-title inspector-section-title">PRODUCT FACTS</div>
                <dl className="definition-list">
                  <Definition label="대표 규격">
                    {selectedProduct.representative_package_size_text ?? <span className="unknown-value">미확인</span>}
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

                <div className="subsection-title inspector-section-title">MANUFACTURING / MARKET</div>
                <dl className="definition-list">
                  <Definition label="제조국"><ValueList values={selectedProduct.manufacturing_country_codes} /></Definition>
                  <Definition label="현재 확인 시장"><ValueList values={selectedProduct.current_market_country_codes} /></Definition>
                  <Definition label="동일 Formula 시장"><ValueList values={selectedProduct.formula_match_market_country_codes} /></Definition>
                </dl>

                <div className="inspector-record-id">{selectedProduct.product_id}</div>
              </>
            ) : (
              <div className="state-message compact"><strong>선택된 제품이 없습니다.</strong></div>
            )}
          </div>
        </aside>
      </main>

      <footer className="footerbar">
        <span>MODE {mode.toUpperCase()}</span>
        <span>UNKNOWN ≠ NONE</span>
        <span>CONFIRMED OVERLAP ≠ RECOMMENDATION</span>
      </footer>
    </div>
  )
}
