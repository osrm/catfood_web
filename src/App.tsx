import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Home from './Home'
import SwitchFlow from './SwitchFlow'
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

type Mode = 'switch' | 'explore' | 'lookup'
type Screen = 'home' | 'workspace'
type ArraySearchField = 'officialTargets' | 'features' | 'recipeFamilies'
type SingleSearchField = 'feedType' | 'lifeStage'
type Option = readonly [string, string]

function optionLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replaceAll('_', ' ')
}

function compactList(values: string[], labels: Record<string, string>, max = 3): string {
  if (values.length === 0) return '—'
  const shown = values.slice(0, max).map((value) => optionLabel(value, labels))
  return values.length > max ? `${shown.join(' · ')} +${values.length - max}` : shown.join(' · ')
}

function relationLabel(value: string): string {
  const separator = value.indexOf(':')
  if (separator < 0) return value

  const group = value.slice(0, separator)
  const rawValue = value.slice(separator + 1)

  if (group === '형태') return optionLabel(rawValue, FEED_TYPE_LABELS)
  if (group === '생애주기') return optionLabel(rawValue, LIFE_STAGE_LABELS)
  if (group === '대상') return optionLabel(rawValue, TARGET_LABELS)
  if (group === '기능') return optionLabel(rawValue, FEATURE_LABELS)
  if (group === '계열') return optionLabel(rawValue, RECIPE_FAMILY_LABELS)
  if (group === '세부') return optionLabel(rawValue, RECIPE_DETAIL_LABELS)
  if (group === '특성' && rawValue === 'grain_free') return 'Grain-Free 공식 표방'

  return rawValue.replaceAll('_', ' ')
}

function unknownLabel(value: string): string {
  if (value.startsWith('기능:')) {
    return optionLabel(value.slice('기능:'.length), FEATURE_LABELS)
  }
  return value
}

function switchBaselineSearch(product: CatalogProduct): SearchState {
  return {
    feedType: product.feed_type ?? '',
    lifeStage: product.life_stage ?? '',
    officialTargets: [],
    features: [],
    recipeFamilies: [],
    grainFree: false,
  }
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
  if (values.length === 0) return <span className="unknown-value">확인된 값 없음</span>

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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="condition-summary-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ProductImage({ product, className }: { product: CatalogProduct; className: string }) {
  if (!product.display_image_url) {
    return <div className={`${className} image-placeholder`}>이미지 없음</div>
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

function ModeButton({
  mode,
  active,
  label,
  onClick,
}: {
  mode: Mode
  active: Mode
  label: string
  onClick: (mode: Mode) => void
}) {
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

function RelationSummary({ evaluation }: { evaluation: CandidateEvaluation }) {
  const confirmed = evaluation.confirmedMatches.map(relationLabel)
  const unknown = evaluation.unknowns.map(unknownLabel)

  if (confirmed.length === 0 && unknown.length === 0) {
    return <p className="result-relation-empty">선택한 추가 조건 없음</p>
  }

  return (
    <div className="result-relations">
      {confirmed.length > 0 ? (
        <div className="relation-line is-confirmed">
          <span>확인됨</span>
          <strong>{confirmed.slice(0, 3).join(' · ')}</strong>
        </div>
      ) : null}
      {unknown.length > 0 ? (
        <div className="relation-line is-unknown">
          <span>미확인</span>
          <strong>{unknown.slice(0, 2).join(' · ')}</strong>
        </div>
      ) : null}
    </div>
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
    if (mode === 'switch') {
      if (!currentProductId) return switchResults
      if (editingConditions) return []
      return evaluated
        .filter((item) => item.product.product_id !== currentProductId)
        .map((item) => item.product)
    }
    if (editingConditions) return []
    return evaluated.map((item) => item.product)
  }, [mode, lookupResults, switchResults, currentProductId, editingConditions, evaluated])

  const selectedProduct = selectedId
    ? resultProducts.find((product) => product.product_id === selectedId) ?? null
    : null

  const selectedEvaluation =
    selectedProduct && (mode === 'explore' || (mode === 'switch' && currentProductId && !editingConditions))
      ? evaluated.find((item) => item.product.product_id === selectedProduct.product_id) ?? null
      : null

  const currentProduct = products.find((product) => product.product_id === currentProductId) ?? null
  const activeConditions = countActiveConditions(search, refine)
  const visibleProducts = resultProducts.slice(0, visibleCount)

  useEffect(() => {
    setVisibleCount(120)
    setSelectedId(null)
  }, [mode, search, refine, lookupQuery, switchQuery, editingConditions, currentProductId])

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
    setSelectedId(null)
    setEditingConditions(true)
  }

  function resetDraft() {
    setDraftSearch(mode === 'switch' && currentProduct ? switchBaselineSearch(currentProduct) : INITIAL_SEARCH)
  }

  function selectCurrentProduct(product: CatalogProduct) {
    const baseline = switchBaselineSearch(product)
    setCurrentProductId(product.product_id)
    setDraftSearch(baseline)
    setSearch(INITIAL_SEARCH)
    setRefine(INITIAL_REFINE)
    setRecipeSearch('')
    setEditingConditions(true)
    setSelectedId(null)
  }

  function clearCurrentProduct() {
    setCurrentProductId(null)
    setSearch(INITIAL_SEARCH)
    setDraftSearch(INITIAL_SEARCH)
    setRefine(INITIAL_REFINE)
    setRecipeSearch('')
    setEditingConditions(true)
    setSelectedId(null)
  }

  function changeMode(nextMode: Mode) {
    setMode(nextMode)
    setSelectedId(null)
    setScreen('workspace')
  }

  function startFromHome(nextMode: Mode, query = '') {
    if (nextMode === 'lookup') setLookupQuery(query)
    if (nextMode === 'switch') {
      setSwitchQuery(query)
      setCurrentProductId(null)
      setSearch(INITIAL_SEARCH)
      setDraftSearch(INITIAL_SEARCH)
      setRefine(INITIAL_REFINE)
      setEditingConditions(true)
    }
    if (nextMode === 'explore') setEditingConditions(true)
    setMode(nextMode)
    setSelectedId(null)
    setScreen('workspace')
  }

  function activeCriteria(): string[] {
    const values: string[] = []
    if (search.feedType) values.push(optionLabel(search.feedType, FEED_TYPE_LABELS))
    if (search.lifeStage) values.push(optionLabel(search.lifeStage, LIFE_STAGE_LABELS))
    values.push(...search.officialTargets.map((value) => optionLabel(value, TARGET_LABELS)))
    values.push(...search.features.map((value) => optionLabel(value, FEATURE_LABELS)))
    values.push(...search.recipeFamilies.map((value) => optionLabel(value, RECIPE_FAMILY_LABELS)))
    if (search.grainFree) values.push('Grain-Free 공식 표방')
    values.push(...refine.recipeDetails.map((value) => optionLabel(value, RECIPE_DETAIL_LABELS)))
    return values
  }

  function renderConditionEditor() {
    return (
      <>
        <div className="condition-group-title">
          <span>{mode === 'switch' ? '유지할 기본 기준' : '기본 조건'}</span>
          <small>{mode === 'switch' ? '현재 제품 값으로 시작' : '확인된 충돌은 제외'}</small>
        </div>

        <FilterSection title="사료 형태" hint="선택하면 필수">
          <FilterButtons
            options={FEED_TYPES}
            selected={draftSearch.feedType ? [draftSearch.feedType] : []}
            onToggle={(value) => setDraftSingle('feedType', value)}
          />
        </FilterSection>

        <FilterSection title="표기 생애주기" hint="제품 라벨 기준">
          <FilterButtons
            options={LIFE_STAGES}
            selected={draftSearch.lifeStage ? [draftSearch.lifeStage] : []}
            onToggle={(value) => setDraftSingle('lifeStage', value)}
          />
          <p className="field-note">고양이 실제 나이를 이 값으로 자동 변환하지 않습니다.</p>
        </FilterSection>

        <div className="condition-group-title secondary-group">
          <span>{mode === 'switch' ? '추가로 원하는 방향' : '원하는 방향'}</span>
          <small>미확인은 후보에 남김</small>
        </div>

        <FilterSection title="공식 대상" hint="복수 선택 가능">
          <FilterButtons
            options={TARGETS}
            selected={draftSearch.officialTargets}
            onToggle={(value) => toggleDraftArray('officialTargets', value)}
          />
        </FilterSection>

        <FilterSection title="부가 기능" hint="확인된 표기와 비교">
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

        <FilterSection title="공식 레시피 특성" hint="표방 여부만 확인">
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
            {mode === 'switch' ? '후보 제품 보기' : '조건 적용하기'}
          </button>
          <button className="secondary-action" type="button" onClick={resetDraft}>
            {mode === 'switch' ? '현재 제품 기준으로' : '초기화'}
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
            <SummaryRow label="생애주기" value={optionLabel(search.lifeStage, LIFE_STAGE_LABELS)} />
          ) : null}
          {search.officialTargets.length > 0 ? (
            <SummaryRow label="공식 대상" value={compactList(search.officialTargets, TARGET_LABELS)} />
          ) : null}
          {search.features.length > 0 ? (
            <SummaryRow label="기능" value={compactList(search.features, FEATURE_LABELS)} />
          ) : null}
          {search.recipeFamilies.length > 0 ? (
            <SummaryRow label="레시피" value={compactList(search.recipeFamilies, RECIPE_FAMILY_LABELS)} />
          ) : null}
          {search.grainFree ? <SummaryRow label="특성" value="Grain-Free 공식 표방" /> : null}
          {!hasPrimary ? <p className="summary-empty">추가 조건 없이 전체 catalog를 봅니다.</p> : null}
        </div>

        <div className="summary-actions">
          <button className="primary-action compact-action" type="button" onClick={editConditions}>
            조건 수정
          </button>
        </div>

        <div className="refine-title">관련 조건</div>
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
        </FilterSection>
      </>
    )
  }

  function renderSwitchCurrent() {
    if (!currentProduct) return null

    return (
      <>
        <section className="switch-baseline-card">
          <ProductImage className="switch-baseline-image" product={currentProduct} />
          <div className="switch-baseline-copy">
            <span>현재 사료</span>
            <strong>{currentProduct.brand}</strong>
            <b>{currentProduct.canonical_name}</b>
            <small>
              {currentProduct.feed_type ?? '형태 미확인'} ·{' '}
              {currentProduct.life_stage ? optionLabel(currentProduct.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'} ·{' '}
              {currentProduct.representative_package_size_text ?? '대표 규격 미확인'}
            </small>
          </div>
          <button type="button" onClick={clearCurrentProduct}>다른 제품 선택</button>
        </section>

        <section className="switch-known-facts">
          <span>현재 제품에서 확인된 정보</span>
          <dl>
            <Definition label="공식 대상">
              {compactList(currentProduct.official_targets, TARGET_LABELS)}
            </Definition>
            <Definition label="기능">
              {compactList(currentProduct.features, FEATURE_LABELS)}
            </Definition>
            <Definition label="레시피">
              {compactList(currentProduct.recipe_families, RECIPE_FAMILY_LABELS)}
            </Definition>
          </dl>
          <small>이 정보는 자동으로 유지 조건에 넣지 않습니다. 필요한 기준만 아래에서 선택하세요.</small>
        </section>

        <div className="mode-intro switch-adjust-intro">
          <strong>무엇을 유지하고, 무엇을 추가할까요?</strong>
          <span>형태와 표기 생애주기는 현재 제품 값으로 시작합니다. 원하지 않으면 해제할 수 있습니다.</span>
        </div>
        {editingConditions ? renderConditionEditor() : renderConditionSummary()}
      </>
    )
  }

  function renderLeftPane() {
    if (mode === 'lookup') {
      return (
        <>
          <div className="mode-intro">
            <strong>제품 찾기</strong>
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
      if (currentProduct) return renderSwitchCurrent()

      return (
        <>
          <div className="mode-intro">
            <strong>현재 먹이는 사료를 찾으세요</strong>
            <span>제품을 선택한 뒤, 유지할 기준과 추가로 원하는 방향을 정합니다.</span>
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
          <p className="switch-scope-note">현재 단계는 제품 기준입니다. 정확한 SKU 선택은 아직 제공하지 않습니다.</p>
        </>
      )
    }

    return editingConditions ? renderConditionEditor() : renderConditionSummary()
  }

  function renderCriteriaBar() {
    const switchCandidates = mode === 'switch' && currentProduct && !editingConditions
    if ((mode !== 'explore' && !switchCandidates) || editingConditions) return null
    const criteria = activeCriteria()

    return (
      <div className="criteria-bar">
        <span className="criteria-label">{switchCandidates ? '현재 사료 기준' : '적용된 조건'}</span>
        <div className="criteria-chips">
          {switchCandidates ? <span className="criteria-current-product">{currentProduct.brand} · {currentProduct.canonical_name}</span> : null}
          {criteria.length > 0 ? criteria.map((value) => <span key={value}>{value}</span>) : <span>추가 조건 없음</span>}
        </div>
        <button type="button" onClick={editConditions}>조건 수정</button>
      </div>
    )
  }

  function renderResultList() {
    if (error) {
      return (
        <div className="state-message error-message">
          <strong>제품 데이터를 불러오지 못했습니다.</strong>
          <span>{error}</span>
        </div>
      )
    }

    if (loading) {
      return <div className="state-message"><strong>제품 데이터를 불러오는 중입니다.</strong></div>
    }

    if (mode === 'explore' && editingConditions) {
      return (
        <div className="state-message">
          <strong>검색 조건을 설정해 주세요.</strong>
          <span>필수 조건과 원하는 방향을 구분해 설정합니다. 미확인 정보는 자동으로 제외하지 않습니다.</span>
        </div>
      )
    }

    if (mode === 'switch' && currentProduct && editingConditions) {
      return (
        <div className="state-message switch-next-step">
          <strong>현재 사료를 기준으로 후보 조건을 정해 주세요.</strong>
          <span>형태와 표기 생애주기는 현재 제품 값으로 시작합니다. 유지하지 않을 조건은 해제하고, 원하는 방향을 추가하세요.</span>
        </div>
      )
    }

    if (mode === 'switch' && currentProduct && !editingConditions && resultProducts.length === 0) {
      return (
        <div className="state-message">
          <strong>현재 조건에 맞는 후보가 없습니다.</strong>
          <span>조건을 자동으로 완화하지 않습니다. 조건을 수정해 다시 확인해 주세요.</span>
        </div>
      )
    }

    if (mode !== 'explore' && !(mode === 'switch' && currentProduct) && resultProducts.length === 0) {
      return (
        <div className="state-message">
          <strong>{mode === 'lookup' ? '제품명을 검색해 주세요.' : '현재 제품을 검색해 주세요.'}</strong>
          <span>브랜드 또는 제품명의 일부를 입력할 수 있습니다.</span>
        </div>
      )
    }

    if (mode === 'explore' && resultProducts.length === 0) {
      return (
        <div className="state-message">
          <strong>검색 결과가 없습니다.</strong>
          <span>조건을 자동으로 완화하지 않습니다. 조건을 수정해 다시 확인해 주세요.</span>
        </div>
      )
    }

    const showEvaluation = mode === 'explore' || (mode === 'switch' && currentProduct && !editingConditions)

    return (
      <div className="research-results-list">
        {visibleProducts.map((product) => {
          const evaluation = showEvaluation
            ? evaluated.find((item) => item.product.product_id === product.product_id) ?? null
            : null
          const isSelected = product.product_id === selectedId

          return (
            <button
              className={isSelected ? 'research-result-card is-selected' : 'research-result-card'}
              key={product.product_id}
              type="button"
              onClick={() => setSelectedId(product.product_id)}
            >
              <ProductImage className="research-result-image" product={product} />
              <span className="research-result-identity">
                <span className="research-result-brand">{product.brand}</span>
                <strong>{product.canonical_name}</strong>
                <span className="research-result-meta">
                  {product.feed_type ?? '형태 미확인'} ·{' '}
                  {product.life_stage ? optionLabel(product.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'} ·{' '}
                  {product.representative_package_size_text ?? '대표 규격 미확인'}
                </span>
              </span>
              {evaluation ? <RelationSummary evaluation={evaluation} /> : (
                <span className="research-result-facts">
                  <span>공식 대상</span>
                  <strong>{compactList(product.official_targets, TARGET_LABELS)}</strong>
                  <span>레시피</span>
                  <strong>{compactList(product.recipe_details, RECIPE_DETAIL_LABELS)}</strong>
                </span>
              )}
              <span className="research-result-open">제품 보기 →</span>
            </button>
          )
        })}
        {visibleCount < resultProducts.length ? (
          <button className="load-more" type="button" onClick={() => setVisibleCount((count) => count + 120)}>
            제품 더 보기 · {resultProducts.length - visibleCount}개 남음
          </button>
        ) : null}
      </div>
    )
  }

  function renderQuickView() {
    if (!selectedProduct) return null
    const choosingCurrentProduct = mode === 'switch' && !currentProduct

    return (
      <aside className="research-quick-view">
        <div className="quick-view-topline">
          <span>{choosingCurrentProduct ? '현재 사료 확인' : '제품 정보'}</span>
          <button type="button" onClick={() => setSelectedId(null)}>닫기 ×</button>
        </div>

        <div className="quick-view-scroll">
          <section className="quick-view-identity">
            <ProductImage className="quick-view-image" product={selectedProduct} />
            <div>
              <span>{selectedProduct.brand}</span>
              <h1>{selectedProduct.canonical_name}</h1>
              <p>
                {selectedProduct.feed_type ?? '형태 미확인'} ·{' '}
                {selectedProduct.life_stage ? optionLabel(selectedProduct.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'}
              </p>
              {choosingCurrentProduct ? (
                <button
                  className="primary-action quick-view-action"
                  type="button"
                  onClick={() => selectCurrentProduct(selectedProduct)}
                >
                  이 제품을 현재 사료로 선택
                </button>
              ) : null}
            </div>
          </section>

          {mode === 'switch' && currentProduct && selectedProduct.product_id !== currentProduct.product_id ? (
            <section className="quick-view-switch-context">
              <span>기준 제품</span>
              <strong>{currentProduct.brand} · {currentProduct.canonical_name}</strong>
              <small>후보 제품의 확인된 정보와 미확인 상태를 현재 선택 조건 기준으로 봅니다.</small>
            </section>
          ) : null}

          {selectedEvaluation ? (
            <section className="quick-view-section">
              <h2>{mode === 'switch' ? '선택한 기준과의 관계' : '현재 조건과의 관계'}</h2>
              <dl className="definition-list">
                <Definition label="확인됨">
                  {selectedEvaluation.confirmedMatches.length > 0
                    ? selectedEvaluation.confirmedMatches.map(relationLabel).join(' · ')
                    : <span className="unknown-value">확인된 겹침 없음</span>}
                </Definition>
                <Definition label="미확인">
                  {selectedEvaluation.unknowns.length > 0
                    ? selectedEvaluation.unknowns.map(unknownLabel).join(' · ')
                    : <span className="unknown-value">—</span>}
                </Definition>
              </dl>
            </section>
          ) : null}

          <section className="quick-view-section">
            <h2>제품 정보 요약</h2>
            <dl className="definition-list">
              <Definition label="대표 규격">
                {selectedProduct.representative_package_size_text ?? <span className="unknown-value">미확인</span>}
              </Definition>
              <Definition label="확인된 규격">
                {selectedProduct.has_variants
                  ? `${selectedProduct.variant_count}개`
                  : <span className="unknown-value">확인된 규격 없음</span>}
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
          </section>

          <section className="quick-view-section">
            <h2>제조 / 시장</h2>
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
            </dl>
          </section>
        </div>
      </aside>
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

  if (mode === 'switch') {
    return (
      <SwitchFlow
        products={products}
        loading={loading}
        error={error}
        initialQuery={switchQuery}
        onHome={() => setScreen('home')}
        onModeChange={(nextMode) => changeMode(nextMode)}
      />
    )
  }

  const switchCandidates = mode === 'switch' && currentProduct
  const paneTitle = mode === 'explore'
    ? '검색 조건'
    : mode === 'lookup'
      ? '제품 찾기'
      : switchCandidates
        ? '바꿀 기준'
        : '현재 사료'
  const paneDescription = mode === 'explore'
    ? '원하는 제품의 기준을 설정합니다.'
    : mode === 'lookup'
      ? '제품명을 기준으로 찾습니다.'
      : switchCandidates
        ? '현재 제품을 기준으로 유지할 조건과 원하는 방향을 조정합니다.'
        : '현재 먹이는 제품을 먼저 찾습니다.'
  const resultTitle = mode === 'switch'
    ? switchCandidates ? '후보 제품' : '현재 사료 찾기'
    : '제품 목록'
  const waitingForConditions = (mode === 'explore' || Boolean(switchCandidates)) && editingConditions

  return (
    <div className={selectedProduct ? 'research-shell is-inspecting' : 'research-shell is-browsing'}>
      <header className="research-topbar">
        <button className="research-brand" type="button" onClick={() => setScreen('home')}>
          FELINE ARCHIVE
        </button>
        <nav className="mode-nav" aria-label="탐색 모드">
          <ModeButton mode="explore" active={mode} label="조건으로 찾기" onClick={changeMode} />
          <ModeButton mode="lookup" active={mode} label="제품 찾기" onClick={changeMode} />
          <ModeButton mode="switch" active={mode} label="현재 사료" onClick={changeMode} />
        </nav>
        <div className="research-status">
          <span>{products.length || '—'} PRODUCTS</span>
          <span className={error ? 'is-error' : ''}>{error ? '연결 오류' : loading ? '불러오는 중' : '데이터 연결됨'}</span>
        </div>
      </header>

      {renderCriteriaBar()}

      <main className="research-workspace">
        {!selectedProduct ? (
          <aside className="research-filters">
            <div className="research-pane-heading">
              <div>
                <strong>{paneTitle}</strong>
                <span>{paneDescription}</span>
              </div>
            </div>
            <div className="research-filter-scroll">{renderLeftPane()}</div>
          </aside>
        ) : null}

        <section className="research-results">
          <div className="research-results-heading">
            <div>
              <strong>{resultTitle}</strong>
              <span>
                {loading || waitingForConditions
                  ? switchCandidates ? '기준을 설정하면 후보가 표시됩니다.' : '조건을 설정하면 결과가 표시됩니다.'
                  : `${resultProducts.length}개의 제품`}
              </span>
            </div>
            {(mode === 'explore' || switchCandidates) && !editingConditions && activeConditions > 0 ? (
              <span className="research-results-context">선택한 조건과 확인된 정보의 관계를 표시합니다.</span>
            ) : null}
          </div>
          <div className="research-results-scroll">{renderResultList()}</div>
        </section>

        {renderQuickView()}
      </main>
    </div>
  )
}
