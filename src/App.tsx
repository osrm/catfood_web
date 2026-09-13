import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import CompareView, { type CompareItem } from './CompareView'
import Home from './Home'
import ProductDetail from './ProductDetail'
import SwitchFlow from './SwitchFlow'
import {
  createDecisionSearchRun,
  recordProductConsideration,
  type DecisionCriterion,
} from './analytics'
import { fetchCatalog, type CatalogProduct } from './api'
import {
  navigationSearch,
  parseNavigationState,
  sanitizeProductNavigation,
  type CompareTab,
  type DetailTab,
  type NavigationState,
} from './navigation-state'
import {
  createInitialSwitchSession,
  createSwitchSessionSnapshot,
  parseSwitchSessionSnapshot,
  readSwitchSession,
  sanitizeSwitchSessionForCatalog,
  writeSwitchSession,
  type SwitchHistoryAction,
  type SwitchHistoryEntry,
  type SwitchSessionSnapshot,
  type SwitchSessionState,
  type SwitchStep,
} from './switch-session'
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

const FEED_TYPES = [['건식', '건식'], ['습식', '습식'], ['동결건조', '동결건조']] as const
const LIFE_STAGES = [
  ['kitten', '키튼'], ['adult', '성묘'], ['senior', '시니어'], ['all_life_stages', '전연령'],
  ['gestation_lactation_and_kitten', '임신·수유·키튼'],
] as const
const TARGETS = [['indoor', '실내묘'], ['sterilized', '중성화묘']] as const
const FEATURES = [
  ['weight_management', '체중 관리'], ['stool', '변 상태'], ['hairball', '헤어볼'], ['digestive', '소화'],
  ['urinary', '요로'], ['skin_coat', '피부·피모'], ['dental', '덴탈'],
] as const
const RECIPE_FAMILIES = [['poultry', '가금류'], ['meat', '육류'], ['fish', '생선']] as const
const FEED_TYPE_LABELS = Object.fromEntries(FEED_TYPES)
const LIFE_STAGE_LABELS = Object.fromEntries(LIFE_STAGES)
const TARGET_LABELS = Object.fromEntries(TARGETS)
const FEATURE_LABELS = Object.fromEntries(FEATURES)
const RECIPE_FAMILY_LABELS = Object.fromEntries(RECIPE_FAMILIES)
const RECIPE_DETAIL_LABELS: Record<string, string> = {
  chicken: '닭', duck: '오리', turkey: '칠면조', beef: '소', lamb: '양', rabbit: '토끼', salmon: '연어',
  tuna: '참치', herring: '청어', mackerel: '고등어', trout: '송어', cod: '대구', pork: '돼지', venison: '사슴',
  anchovy: '멸치', beef_liver: '소 간', bonito: '보니토(Bonito)', bream: '도미류(Bream)', cheese: '치즈',
  chicken_liver: '닭 간', coconut_oil: '코코넛오일', egg: '계란', goat: '염소', goose: '거위', green_mussel: '초록홍합',
  haddock: '해덕대구', hoki: '호키', kahawai: 'Kahawai', mussel: '홍합류', mutton: '양고기(Mutton)', pheasant: '꿩',
  poultry_hearts: '가금류 심장', poultry_liver: '가금류 간', pumpkin: '호박', quail: '메추리', rice: '쌀', rooster: '수탉',
  sardine: '정어리', sea_bass: '농어류(Sea bass)', sea_bream: '도미류(Sea bream)', shirasu: '치어(Shirasu)', shrimp: '새우',
  skipjack_tuna: '가다랑어(Skipjack tuna)', southern_blue_whiting: '남방청대구', tuna_roe: '참치알', wallaby: '왈라비',
  whitefish: '흰살생선', wild_boar: '야생 멧돼지',
}
const RECIPE_TRAIT_LABELS: Record<string, string> = { grain_free: 'Grain-Free 표기' }

type Mode = 'switch' | 'explore' | 'lookup'
type Screen = 'home' | 'workspace'
type ArraySearchField = 'officialTargets' | 'features' | 'recipeFamilies'
type SingleSearchField = 'feedType' | 'lifeStage'
type Option = readonly [string, string]
type ListRestore = { scrollTop: number; visibleCount: number; focusId: string | null }
type HistoryPayload = {
  catfoodDetailEntry?: boolean
  catfoodCompareEntry?: boolean
  catfoodList?: ListRestore
  catfoodSwitch?: SwitchSessionSnapshot
  catfoodSwitchEntry?: SwitchHistoryEntry
  catfoodSwitchParentStep?: SwitchStep
}

function optionLabel(value: string, labels: Record<string, string>) { return labels[value] ?? value.replaceAll('_', ' ') }
function compactList(values: string[], labels: Record<string, string>, max = 3) {
  if (!values.length) return '확인된 값 없음'
  const shown = values.slice(0, max).map((value) => optionLabel(value, labels))
  return values.length > max ? `${shown.join(' · ')} +${values.length - max}` : shown.join(' · ')
}
function countAdditionalConditions(search: SearchState) {
  return search.officialTargets.length + search.features.length + search.recipeFamilies.length + Number(search.grainFree)
}
function additionalConditionLabels(search: SearchState) {
  const values = [
    ...search.officialTargets.map((value) => optionLabel(value, TARGET_LABELS)),
    ...search.features.map((value) => optionLabel(value, FEATURE_LABELS)),
    ...search.recipeFamilies.map((value) => optionLabel(value, RECIPE_FAMILY_LABELS)),
  ]
  if (search.grainFree) values.push('Grain-Free 표기')
  return values
}
function packageOptionsLabel(product: CatalogProduct) {
  const labels = product.available_package_labels ?? []
  if (labels.length) return labels.join(' · ')
  const size = product.representative_package_size_text ?? '판매 규격 미확인'
  const units = product.representative_units_per_sale ?? null
  return units && units > 1 ? `${size} × ${units}` : size
}
function relationLabel(value: string) {
  const separator = value.indexOf(':')
  if (separator < 0) return value
  const group = value.slice(0, separator), raw = value.slice(separator + 1)
  if (group === '형태') return optionLabel(raw, FEED_TYPE_LABELS)
  if (group === '생애주기') return optionLabel(raw, LIFE_STAGE_LABELS)
  if (group === '대상') return optionLabel(raw, TARGET_LABELS)
  if (group === '기능') return optionLabel(raw, FEATURE_LABELS)
  if (group === '계열') return optionLabel(raw, RECIPE_FAMILY_LABELS)
  if (group === '세부') return optionLabel(raw, RECIPE_DETAIL_LABELS)
  if (group === '특성' && raw === 'grain_free') return 'Grain-Free 표기'
  return raw.replaceAll('_', ' ')
}
function unknownLabel(value: string) {
  if (value.startsWith('기능:')) return optionLabel(value.slice('기능:'.length), FEATURE_LABELS)
  return value.replace('공식 대상 ·', '제품 표기 대상 ·').replace('레시피 계열 ·', '레시피 종류 ·').replace('제품 표기 생애주기', '대상 연령')
}
function exploreCriteriaSnapshot(search: SearchState, refine: RefineState): DecisionCriterion[] {
  const criteria: DecisionCriterion[] = []
  if (search.feedType) criteria.push({ axis: 'feed_type', value: search.feedType, role: 'hard_constraint', source: 'user_selected' })
  if (search.lifeStage) criteria.push({ axis: 'life_stage', value: search.lifeStage, role: 'hard_constraint', source: 'user_selected' })
  search.officialTargets.forEach((value) => criteria.push({ axis: 'official_target', value, role: 'desired', source: 'user_selected' }))
  search.features.forEach((value) => criteria.push({ axis: 'feature', value, role: 'desired', source: 'user_selected' }))
  search.recipeFamilies.forEach((value) => criteria.push({ axis: 'recipe_family', value, role: 'desired', source: 'user_selected' }))
  if (search.grainFree) criteria.push({ axis: 'official_recipe_trait', value: 'grain_free', role: 'desired', source: 'user_selected' })
  refine.recipeDetails.forEach((value) => criteria.push({ axis: 'recipe_detail', value, role: 'evidence_required', source: 'user_selected' }))
  return criteria
}
function exploreRunKey(search: SearchState, refine: RefineState): string {
  return JSON.stringify([search, refine])
}

function FilterButtons({ options, selected, onToggle }: { options: readonly Option[]; selected: string[]; onToggle: (value: string) => void }) {
  return <div className="choice-grid">{options.map(([value, label]) => <button className={selected.includes(value) ? 'choice is-active' : 'choice'} key={value} onClick={() => onToggle(value)} type="button" aria-pressed={selected.includes(value)}>{label}</button>)}</div>
}
function FilterSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="filter-section"><div className="filter-heading"><span>{title}</span>{hint ? <span className="filter-hint">{hint}</span> : null}</div>{children}</section>
}
function ValueList({ values, labels = {} }: { values: string[]; labels?: Record<string, string> }) {
  if (!values.length) return <span className="unknown-value">확인된 값 없음</span>
  return <div className="inspector-tags">{values.map((value) => <span className="data-tag" key={value}>{optionLabel(value, labels)}</span>)}</div>
}
function Definition({ label, children }: { label: string; children: ReactNode }) { return <div className="definition"><dt>{label}</dt><dd>{children}</dd></div> }
function SummaryRow({ label, value }: { label: string; value: string }) { return <div className="condition-summary-row"><span>{label}</span><strong>{value}</strong></div> }
function ProductImage({ product, className }: { product: CatalogProduct; className: string }) {
  if (!product.display_image_url) return <div className={`${className} image-placeholder`}>이미지 없음</div>
  return <img alt="" className={className} loading="lazy" src={product.display_image_url} onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
}
function ModeButton({ mode, active, label, onClick }: { mode: Mode; active: Mode; label: string; onClick: (mode: Mode) => void }) {
  return <button className={mode === active ? 'mode-button is-active' : 'mode-button'} type="button" aria-current={mode === active ? 'page' : undefined} onClick={() => onClick(mode)}>{label}</button>
}
function RelationSummary({ evaluation }: { evaluation: CandidateEvaluation }) {
  const confirmed = evaluation.confirmedMatches.map(relationLabel), unknown = evaluation.unknowns.map(unknownLabel)
  if (!confirmed.length && !unknown.length) return <p className="result-relation-empty">추가 조건 없음</p>
  return <div className="result-relations">{confirmed.length ? <div className="relation-line is-confirmed"><span>확인됨</span><strong>{confirmed.slice(0, 3).join(' · ')}</strong></div> : null}{unknown.length ? <div className="relation-line is-unknown"><span>미확인</span><strong>{unknown.slice(0, 2).join(' · ')}</strong></div> : null}</div>
}

export default function App() {
  const [initialNavigation] = useState(() => parseNavigationState(typeof window === 'undefined' ? '' : window.location.search))
  const [initialSwitchSession] = useState(() => {
    if (typeof window === 'undefined') return createInitialSwitchSession()
    const fromHistory = parseSwitchSessionSnapshot((window.history.state as HistoryPayload | null)?.catfoodSwitch)
    return fromHistory ?? readSwitchSession() ?? createInitialSwitchSession()
  })
  const [screen, setScreen] = useState<Screen>(initialNavigation.screen)
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [mode, setMode] = useState<Mode>(initialNavigation.mode)
  const [search, setSearch] = useState<SearchState>(initialNavigation.search)
  const [draftSearch, setDraftSearch] = useState<SearchState>(initialNavigation.search)
  const [refine, setRefine] = useState<RefineState>(initialNavigation.refine)
  const [editingConditions, setEditingConditions] = useState(initialNavigation.editingConditions)
  const [lookupQuery, setLookupQuery] = useState(initialNavigation.lookupQuery)
  const [switchSession, setSwitchSession] = useState<SwitchSessionState>(initialSwitchSession)
  const [selectedId, setSelectedId] = useState<string | null>(initialNavigation.selectedId)
  const [visibleCount, setVisibleCount] = useState(initialNavigation.visibleCount)
  const [recipeSearch, setRecipeSearch] = useState('')
  const [mobileRefineOpen, setMobileRefineOpen] = useState(false)
  const [mobileAdditionalOpen, setMobileAdditionalOpen] = useState(() => countAdditionalConditions(initialNavigation.search) > 0)
  const [compareIds, setCompareIds] = useState<string[]>(initialNavigation.compareIds)
  const [compareOpen, setCompareOpen] = useState(initialNavigation.compareOpen)
  const [compareTab, setCompareTab] = useState<CompareTab>(initialNavigation.compareTab)
  const [detailProductId, setDetailProductId] = useState<string | null>(initialNavigation.detailProductId)
  const [detailTab, setDetailTab] = useState<DetailTab>(initialNavigation.detailTab)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pendingRestore = useRef<ListRestore | null>(null)
  const pendingCompareReturnIds = useRef<string[] | null>(null)
  const switchSessionRef = useRef<SwitchSessionState>(initialSwitchSession)
  const pendingSwitchPopPatch = useRef<Partial<SwitchSessionState> | null>(null)
  const switchHistoryEntryRef = useRef<SwitchHistoryEntry | null>(
    ((typeof window !== 'undefined' ? window.history.state : null) as HistoryPayload | null)?.catfoodSwitchEntry ?? null,
  )
  const exploreRunId = useRef<string | null>(null)
  const exploreRunGeneration = useRef(0)
  const exploreRunTail = useRef<Promise<string | null>>(Promise.resolve(null))
  const exploreRunStateKey = useRef<string | null>(null)
  const mobileRefineToggleRef = useRef<HTMLButtonElement | null>(null)
  const catalogRequestId = useRef(0)
  const catalogRequest = useRef<{ id: number; controller: AbortController } | null>(null)

  function restoreSwitchSession(next: SwitchSessionState) {
    const resolved = !loading && !error
      ? sanitizeSwitchSessionForCatalog(next, new Set(products.map((product) => product.product_id)))
      : next
    switchSessionRef.current = resolved
    setSwitchSession(resolved)
    writeSwitchSession(resolved)
    return resolved
  }
  function commitSwitchSession(
    update: SwitchSessionState | ((current: SwitchSessionState) => SwitchSessionState),
    action: SwitchHistoryAction = 'replace',
    entry?: SwitchHistoryEntry | null,
  ) {
    const current = switchSessionRef.current
    const next = typeof update === 'function' ? update(current) : update
    if (next === current && action === 'replace' && entry === undefined) return
    switchSessionRef.current = next
    setSwitchSession(next)
    writeSwitchSession(next)
    const url = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (action === 'push') {
      const payload: HistoryPayload = { catfoodSwitch: createSwitchSessionSnapshot(next) }
      if (entry) payload.catfoodSwitchEntry = entry
      if (entry === 'step') payload.catfoodSwitchParentStep = current.step
      switchHistoryEntryRef.current = entry ?? null
      window.history.pushState(payload, '', url)
      return
    }
    const payload = { ...((window.history.state ?? {}) as HistoryPayload), catfoodSwitch: createSwitchSessionSnapshot(next) }
    if (entry !== undefined) {
      if (entry) payload.catfoodSwitchEntry = entry
      else delete payload.catfoodSwitchEntry
      if (entry !== 'step') delete payload.catfoodSwitchParentStep
      switchHistoryEntryRef.current = entry ?? null
    }
    window.history.replaceState(payload, '', url)
  }
  function backSwitchHistory(fallback: SwitchSessionState, patch?: Partial<SwitchSessionState>) {
    const payload = (window.history.state ?? {}) as HistoryPayload
    const entry = payload.catfoodSwitchEntry
    if (entry === 'step') {
      if (payload.catfoodSwitchParentStep === fallback.step) {
        pendingSwitchPopPatch.current = patch ?? null
        window.history.back()
        return
      }
      commitSwitchSession(patch ? { ...fallback, ...patch } : fallback, 'replace', null)
      return
    }
    if (entry) {
      pendingSwitchPopPatch.current = patch ?? null
      window.history.back()
      return
    }
    commitSwitchSession(patch ? { ...fallback, ...patch } : fallback, 'replace', null)
  }

  function snapshot(overrides: Partial<NavigationState> = {}): NavigationState {
    return { mode, screen, lookupQuery, search, refine, editingConditions, selectedId, visibleCount, compareIds, compareOpen, compareTab, detailProductId, detailTab, ...overrides }
  }
  function urlFor(next: NavigationState) { return `${window.location.pathname}${navigationSearch(next)}${window.location.hash}` }
  function replaceHistory(next: NavigationState, payload: HistoryPayload = (window.history.state ?? {}) as HistoryPayload) {
    window.history.replaceState({ ...payload, catfoodSwitch: createSwitchSessionSnapshot(switchSessionRef.current) }, '', urlFor(next))
  }
  function pushHistory(next: NavigationState, payload: HistoryPayload = {}) {
    window.history.pushState({ ...payload, catfoodSwitch: createSwitchSessionSnapshot(switchSessionRef.current) }, '', urlFor(next))
  }
  function applyNavigation(next: NavigationState, restore?: ListRestore | null) {
    setMode(next.mode); setScreen(next.screen); setLookupQuery(next.lookupQuery); setSearch(next.search); setDraftSearch(next.search); setRefine(next.refine)
    setEditingConditions(next.editingConditions); setSelectedId(next.selectedId); setVisibleCount(next.visibleCount); setCompareIds(next.compareIds)
    setCompareOpen(next.compareOpen); setCompareTab(next.compareTab); setDetailProductId(next.detailProductId); setDetailTab(next.detailTab)
    setMobileAdditionalOpen(next.editingConditions && countAdditionalConditions(next.search) > 0)
    if (restore) pendingRestore.current = restore
  }
  function loadCatalog() {
    if (catalogRequest.current) return
    const id = ++catalogRequestId.current
    const controller = new AbortController()
    catalogRequest.current = { id, controller }
    setLoading(true)
    setError(null)
    void fetchCatalog(controller.signal).then((data) => {
      if (catalogRequest.current?.id !== id || controller.signal.aborted) return
      setProducts(data)
      setError(null)
    }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      if (catalogRequest.current?.id === id && !controller.signal.aborted) {
        setError('인터넷 연결을 확인한 뒤 잠시 후 다시 시도해 주세요.')
      }
    }).finally(() => {
      if (catalogRequest.current?.id !== id) return
      catalogRequest.current = null
      if (!controller.signal.aborted) setLoading(false)
    })
  }

  useEffect(() => {
    writeSwitchSession(switchSessionRef.current)
    const payload = { ...((window.history.state ?? {}) as HistoryPayload), catfoodSwitch: createSwitchSessionSnapshot(switchSessionRef.current) }
    window.history.replaceState(payload, '', window.location.href)
  }, [])

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const payload = (event.state ?? {}) as HistoryPayload
      const restored = parseSwitchSessionSnapshot(payload.catfoodSwitch)
      const previousSwitchEntry = switchHistoryEntryRef.current
      const incomingSwitchEntry = payload.catfoodSwitchEntry ?? null
      let patch = pendingSwitchPopPatch.current
      pendingSwitchPopPatch.current = null
      if (
        !patch
        && previousSwitchEntry === 'compare'
        && incomingSwitchEntry !== 'detail'
        && restored
        && !restored.compareOpen
      ) {
        patch = { compareIds: switchSessionRef.current.compareIds }
      }
      if (restored || patch) {
        const next = restoreSwitchSession(patch ? { ...(restored ?? switchSessionRef.current), ...patch } : restored ?? switchSessionRef.current)
        if (patch) {
          window.history.replaceState({ ...payload, catfoodSwitch: createSwitchSessionSnapshot(next) }, '', window.location.href)
        }
      }
      switchHistoryEntryRef.current = incomingSwitchEntry
      const restore = payload.catfoodList ?? null
      const parsed = parseNavigationState(window.location.search)
      if (pendingCompareReturnIds.current !== null) {
        const next = {
          ...parsed,
          compareIds: pendingCompareReturnIds.current,
          compareOpen: false,
          compareTab: 'overview' as CompareTab,
        }
        pendingCompareReturnIds.current = null
        applyNavigation(next, restore)
        replaceHistory(next, (event.state as HistoryPayload | null) ?? {})
        return
      }
      applyNavigation(parsed, restore)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  useEffect(() => {
    if (mode !== 'explore' || editingConditions || selectedId || compareOpen || detailProductId) {
      setMobileRefineOpen(false)
    }
  }, [mode, editingConditions, selectedId, compareOpen, detailProductId])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 980px)')
    const handleChange = (event: MediaQueryListEvent) => {
      const panel = document.getElementById('mobile-recipe-refine-panel')
      const activeElement = document.activeElement
      if (event.matches) {
        if (activeElement instanceof HTMLElement && panel?.contains(activeElement)) {
          setMobileRefineOpen(true)
        }
        return
      }
      setMobileRefineOpen(false)
      if (activeElement === mobileRefineToggleRef.current) {
        window.setTimeout(() => document.querySelector<HTMLInputElement>('#mobile-recipe-refine-panel .recipe-search')?.focus(), 0)
      }
    }
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    loadCatalog()
    return () => {
      const request = catalogRequest.current
      catalogRequest.current = null
      catalogRequestId.current += 1
      request?.controller.abort()
    }
  }, [])
  useEffect(() => {
    if (loading || error) return
    const validIds = new Set(products.map((product) => product.product_id))
    if (products.length) {
      const current = snapshot(), clean = sanitizeProductNavigation(current, validIds)
      if (navigationSearch(clean) !== navigationSearch(current)) { applyNavigation(clean); replaceHistory(clean, (window.history.state ?? {}) as HistoryPayload) }
    }
    const cleanSwitch = sanitizeSwitchSessionForCatalog(switchSessionRef.current, validIds)
    if (cleanSwitch !== switchSessionRef.current) commitSwitchSession(cleanSwitch)
  }, [products, loading, error])
  useEffect(() => {
    if (!products.length || mode !== 'explore' || editingConditions || detailProductId || compareOpen) return
    const key = exploreRunKey(search, refine)
    if (exploreRunStateKey.current === key) return
    beginExploreRun(search, refine)
  }, [products.length, mode, editingConditions, search, refine, detailProductId, compareOpen])

  const evaluated = useMemo(() => evaluateCatalog(products, search, refine), [products, search, refine])
  const lookupResults = useMemo(() => lookupCatalog(products, lookupQuery), [products, lookupQuery])
  const recipeDetails = useMemo(() => {
    const values = new Set<string>()
    products.forEach((product) => product.recipe_details.forEach((value) => values.add(value)))
    return [...values].sort((a, b) => {
      const displayOrder = optionLabel(a, RECIPE_DETAIL_LABELS).localeCompare(optionLabel(b, RECIPE_DETAIL_LABELS), 'ko-KR')
      return displayOrder || a.localeCompare(b, 'en')
    })
  }, [products])
  const visibleRecipeDetails = useMemo(() => {
    const query = recipeSearch.trim().toLocaleLowerCase('ko-KR')
    return recipeDetails.filter((value) => !query || value.toLocaleLowerCase('en').includes(query) || optionLabel(value, RECIPE_DETAIL_LABELS).toLocaleLowerCase('ko-KR').includes(query))
  }, [recipeDetails, recipeSearch])
  const resultProducts = useMemo(() => mode === 'lookup' ? lookupResults : editingConditions ? [] : evaluated.map((item) => item.product), [mode, lookupResults, editingConditions, evaluated])
  const selectedProduct = selectedId ? resultProducts.find((product) => product.product_id === selectedId) ?? null : null
  const selectedEvaluation = selectedProduct && mode === 'explore' ? evaluated.find((item) => item.product.product_id === selectedProduct.product_id) ?? null : null
  const compareItems = useMemo<CompareItem[]>(() => compareIds.map((id) => products.find((product) => product.product_id === id)).filter((product): product is CatalogProduct => Boolean(product)).map((product) => { const evaluation = mode === 'explore' ? evaluated.find((item) => item.product.product_id === product.product_id) ?? null : null; return { product, confirmedMatches: evaluation?.confirmedMatches.map(relationLabel) ?? [], unknowns: evaluation?.unknowns.map(unknownLabel) ?? [] } }), [compareIds, products, mode, evaluated])
  const detailProduct = detailProductId ? products.find((product) => product.product_id === detailProductId) ?? null : null
  const activeConditions = countActiveConditions(search, refine)
  const visibleProducts = resultProducts.slice(0, visibleCount)

  useEffect(() => {
    if (!pendingRestore.current || detailProductId || compareOpen || loading) return
    const restore = pendingRestore.current
    if (visibleProducts.length < Math.min(restore.visibleCount, resultProducts.length)) return
    pendingRestore.current = null
    window.setTimeout(() => {
      const scroller = document.querySelector<HTMLElement>('.research-results-scroll')
      if (scroller) scroller.scrollTop = restore.scrollTop
      if (restore.focusId) {
        const focusTarget = Array.from(document.querySelectorAll<HTMLElement>('[data-product-id]'))
          .find((element) => element.dataset.productId === restore.focusId)
        focusTarget?.focus()
      }
    }, 0)
  }, [visibleProducts.length, detailProductId, compareOpen, loading])

  function beginExploreRun(nextSearch: SearchState, nextRefine: RefineState) {
    if (!products.length) return
    exploreRunStateKey.current = exploreRunKey(nextSearch, nextRefine)
    const candidates = evaluateCatalog(products, nextSearch, nextRefine), generation = exploreRunGeneration.current, previous = exploreRunTail.current
    const next = previous.then((previousRunId) => { if (exploreRunGeneration.current !== generation) return null; return createDecisionSearchRun({ parentSearchRunId: previousRunId ?? exploreRunId.current, mode: 'explore', currentProductId: null, currentVariantId: null, criteriaSnapshot: exploreCriteriaSnapshot(nextSearch, nextRefine), candidateCount: candidates.length, initialPresentedProductIds: candidates.slice(0, 40).map((item) => item.product.product_id) }) })
    exploreRunTail.current = next
    void next.then((id) => { if (id && exploreRunGeneration.current === generation) exploreRunId.current = id })
  }
  function recordExploreConsideration(productId: string, signal: 'detail_open' | 'compare_add') { if (!evaluated.slice(0, 40).some((item) => item.product.product_id === productId)) return; void exploreRunTail.current.then((id) => recordProductConsideration(id, productId, signal)) }
  function resetExploreRun(nextMode?: Mode) { if (nextMode !== 'explore') { exploreRunGeneration.current += 1; exploreRunTail.current = Promise.resolve(null); exploreRunId.current = null; exploreRunStateKey.current = null } }
  function setDraftSingle(field: SingleSearchField, value: string) { setDraftSearch((current) => ({ ...current, [field]: current[field] === value ? '' : value })) }
  function toggleDraftArray(field: ArraySearchField, value: string) { setDraftSearch((current) => ({ ...current, [field]: toggleValue(current[field], value) })) }
  function toggleRefineRecipe(value: string) { const nextRefine = { ...refine, recipeDetails: toggleValue(refine.recipeDetails, value) }; setVisibleCount(40); setRefine(nextRefine); setSelectedId(null); beginExploreRun(search, nextRefine); replaceHistory(snapshot({ refine: nextRefine, visibleCount: 40, selectedId: null })) }
  function openExploreProduct(productId: string) { setSelectedId(productId); if (mode === 'explore') recordExploreConsideration(productId, 'detail_open'); replaceHistory(snapshot({ selectedId: productId })) }
  function closeQuickView() { setSelectedId(null); replaceHistory(snapshot({ selectedId: null })) }
  function toggleCompare(productId: string) {
    const adding = !compareIds.includes(productId) && compareIds.length < 5
    if (adding && mode === 'explore') recordExploreConsideration(productId, 'compare_add')
    const nextIds = compareIds.includes(productId) ? compareIds.filter((value) => value !== productId) : compareIds.length >= 5 ? compareIds : [...compareIds, productId]
    setCompareIds(nextIds); const nextOpen = compareOpen && nextIds.length > 0; setCompareOpen(nextOpen); replaceHistory(snapshot({ compareIds: nextIds, compareOpen: nextOpen }))
  }
  function removeCompare(productId: string) {
    const nextIds = compareIds.filter((value) => value !== productId)
    const state = (window.history.state ?? {}) as HistoryPayload
    if (compareOpen && state.catfoodCompareEntry) {
      pendingCompareReturnIds.current = nextIds
      if (!nextIds.length) { window.history.back(); return }
    }
    const nextOpen = compareOpen && nextIds.length > 0
    setCompareIds(nextIds); setCompareOpen(nextOpen); replaceHistory(snapshot({ compareIds: nextIds, compareOpen: nextOpen }))
  }
  function openCompare() {
    if (!compareIds.length) return
    pendingCompareReturnIds.current = null
    const next = snapshot({ compareOpen: true, compareTab: 'overview' }); setCompareOpen(true); setCompareTab('overview'); pushHistory(next, { catfoodCompareEntry: true })
  }
  function closeCompare() {
    const state = (window.history.state ?? {}) as HistoryPayload
    if (state.catfoodCompareEntry) { pendingCompareReturnIds.current = compareIds; window.history.back(); return }
    setCompareOpen(false); setCompareTab('overview'); replaceHistory(snapshot({ compareOpen: false, compareTab: 'overview' }))
  }
  function changeCompareTab(nextTab: CompareTab) { setCompareTab(nextTab); replaceHistory(snapshot({ compareTab: nextTab })) }
  function captureListRestore(focusId: string | null): ListRestore { return { scrollTop: document.querySelector<HTMLElement>('.research-results-scroll')?.scrollTop ?? 0, visibleCount, focusId } }
  function openDetail(productId: string) {
    const restore = captureListRestore(productId)
    replaceHistory(snapshot(), { ...(window.history.state ?? {}), catfoodList: restore })
    const next = snapshot({ detailProductId: productId, detailTab: 'overview', selectedId: productId, screen: 'workspace' })
    setDetailProductId(productId); setDetailTab('overview'); setSelectedId(productId); pushHistory(next, { catfoodDetailEntry: true })
  }
  function closeDetail() {
    const state = (window.history.state ?? {}) as HistoryPayload
    if (state.catfoodDetailEntry) { window.history.back(); return }
    const next = snapshot({ detailProductId: null, detailTab: 'overview', screen: 'workspace' })
    setDetailProductId(null); setDetailTab('overview'); setScreen('workspace'); replaceHistory(next)
  }
  function changeDetailTab(nextTab: DetailTab) { setDetailTab(nextTab); replaceHistory(snapshot({ detailTab: nextTab })) }
  function applyConditions() {
    const nextSearch = draftSearch
    setVisibleCount(40); setSearch(nextSearch); setRefine(INITIAL_REFINE); setRecipeSearch(''); setEditingConditions(false); setSelectedId(null); setCompareIds([]); setCompareOpen(false); setDetailProductId(null)
    beginExploreRun(nextSearch, INITIAL_REFINE)
    pushHistory(snapshot({ screen: 'workspace', mode: 'explore', search: nextSearch, refine: INITIAL_REFINE, editingConditions: false, selectedId: null, visibleCount: 40, compareIds: [], compareOpen: false, compareTab: 'overview', detailProductId: null, detailTab: 'overview' }))
  }
  function editConditions() {
    setDraftSearch(search); setSelectedId(null); setEditingConditions(true)
    setMobileAdditionalOpen(countAdditionalConditions(search) > 0)
    replaceHistory(snapshot({ selectedId: null, editingConditions: true }))
  }
  function resetDraft() { setDraftSearch(INITIAL_SEARCH) }
  function changeMode(nextMode: Mode) {
    resetExploreRun(nextMode); const count = nextMode === 'lookup' ? 120 : 40
    setMode(nextMode); setScreen('workspace'); setVisibleCount(count); setSelectedId(null); setCompareIds([]); setCompareOpen(false); setDetailProductId(null)
    if (nextMode === 'explore') {
      setEditingConditions(true)
      setMobileAdditionalOpen(countAdditionalConditions(search) > 0)
    }
    pushHistory(snapshot({ mode: nextMode, screen: 'workspace', visibleCount: count, selectedId: null, compareIds: [], compareOpen: false, compareTab: 'overview', detailProductId: null, detailTab: 'overview', editingConditions: nextMode === 'explore' ? true : editingConditions, lookupQuery: nextMode === 'lookup' ? lookupQuery : '' }))
  }
  function startFromHome(nextMode: Mode, query = '') {
    if (nextMode === 'lookup') setLookupQuery(query)
    if (nextMode === 'switch' && query.trim()) commitSwitchSession((current) => ({ ...current, query }))
    if (nextMode === 'explore') {
      setEditingConditions(true)
      setMobileAdditionalOpen(countAdditionalConditions(search) > 0)
    }
    resetExploreRun(nextMode); const count = nextMode === 'lookup' ? 120 : 40
    setVisibleCount(count); setMode(nextMode); setSelectedId(null); setCompareIds([]); setCompareOpen(false); setDetailProductId(null); setScreen('workspace')
    pushHistory(snapshot({ screen: 'workspace', mode: nextMode, lookupQuery: nextMode === 'lookup' ? query : '', editingConditions: nextMode === 'explore' ? true : editingConditions, selectedId: null, visibleCount: count, compareIds: [], compareOpen: false, compareTab: 'overview', detailProductId: null, detailTab: 'overview' }))
  }
  function goHome() { setScreen('home'); setSelectedId(null); setCompareOpen(false); setDetailProductId(null); pushHistory(snapshot({ screen: 'home', selectedId: null, compareOpen: false, detailProductId: null, detailTab: 'overview' })) }
  function changeLookupQuery(value: string) { setLookupQuery(value); setVisibleCount(120); setSelectedId(null); replaceHistory(snapshot({ screen: 'workspace', mode: 'lookup', lookupQuery: value, visibleCount: 120, selectedId: null })) }
  function loadMore() { const nextCount = visibleCount + (mode === 'explore' ? 40 : 120); setVisibleCount(nextCount); replaceHistory(snapshot({ visibleCount: nextCount })) }

  function activeCriteria() {
    const values: string[] = []
    if (search.feedType) values.push(optionLabel(search.feedType, FEED_TYPE_LABELS))
    if (search.lifeStage) values.push(optionLabel(search.lifeStage, LIFE_STAGE_LABELS))
    values.push(...search.officialTargets.map((value) => optionLabel(value, TARGET_LABELS)), ...search.features.map((value) => optionLabel(value, FEATURE_LABELS)), ...search.recipeFamilies.map((value) => optionLabel(value, RECIPE_FAMILY_LABELS)))
    if (search.grainFree) values.push('Grain-Free 표기')
    values.push(...refine.recipeDetails.map((value) => optionLabel(value, RECIPE_DETAIL_LABELS)))
    return values
  }

  function renderConditionEditor() {
    const additionalCount = countAdditionalConditions(draftSearch)
    const additionalLabels = additionalConditionLabels(draftSearch)
    return <>
      <div className="condition-group-title"><span>기본 조건</span><small>확인된 불일치만 제외</small></div>
      <FilterSection title="사료 형태" hint="선택 시 필수 조건"><FilterButtons options={FEED_TYPES} selected={draftSearch.feedType ? [draftSearch.feedType] : []} onToggle={(value) => setDraftSingle('feedType', value)} /></FilterSection>
      <FilterSection title="대상 연령" hint="제품 라벨 기준"><FilterButtons options={LIFE_STAGES} selected={draftSearch.lifeStage ? [draftSearch.lifeStage] : []} onToggle={(value) => setDraftSingle('lifeStage', value)} /><p className="field-note">고양이의 실제 나이를 자동 변환하지 않고 제품이 표시한 연령 구분을 사용합니다.</p></FilterSection>
      <div className="condition-group-title secondary-group desktop-additional-title"><span>추가 조건</span><small>미확인은 후보에 유지</small></div>
      <div className="mobile-additional-disclosure">
        <button className="mobile-additional-toggle" type="button" aria-expanded={mobileAdditionalOpen} aria-controls="explore-additional-conditions" onClick={() => setMobileAdditionalOpen((current) => !current)}>
          <span>추가 조건</span><small>{additionalCount ? `${additionalCount}개 선택` : '선택 없음'}</small><span className="mobile-additional-chevron" aria-hidden="true">{mobileAdditionalOpen ? '▴' : '▾'}</span>
        </button>
        {additionalLabels.length ? <div className="mobile-additional-summary" aria-label="선택한 추가 조건">{additionalLabels.map((value) => <span key={value}>{value}</span>)}</div> : null}
      </div>
      <div className={mobileAdditionalOpen ? 'additional-condition-sections is-open' : 'additional-condition-sections'} id="explore-additional-conditions">
        <FilterSection title="제품 표기 대상" hint="여러 개 선택 가능"><FilterButtons options={TARGETS} selected={draftSearch.officialTargets} onToggle={(value) => toggleDraftArray('officialTargets', value)} /></FilterSection>
        <FilterSection title="제품 특징" hint="제조사 공식 표기 기준"><FilterButtons options={FEATURES} selected={draftSearch.features} onToggle={(value) => toggleDraftArray('features', value)} /></FilterSection>
        <FilterSection title="레시피 종류" hint="확인된 정보 기준"><FilterButtons options={RECIPE_FAMILIES} selected={draftSearch.recipeFamilies} onToggle={(value) => toggleDraftArray('recipeFamilies', value)} /></FilterSection>
        <FilterSection title="레시피 특성" hint="제품의 공식 표기만 확인"><button className={draftSearch.grainFree ? 'choice wide is-active' : 'choice wide'} type="button" aria-pressed={draftSearch.grainFree} onClick={() => setDraftSearch((current) => ({ ...current, grainFree: !current.grainFree }))}>Grain-Free 표기</button><p className="field-note">Grain-Free 표기가 없다고 해서 곡물이 들어 있다고 판단하지 않습니다.</p></FilterSection>
      </div>
      <div className="condition-actions"><button className="primary-action" type="button" onClick={applyConditions}>이 조건으로 찾기</button><button className="secondary-action" type="button" onClick={resetDraft}>초기화</button></div>
    </>
  }
  function renderConditionSummary() {
    const hasPrimary = countActiveConditions(search) > 0
    return <><div className="condition-summary">
      {search.feedType ? <SummaryRow label="형태" value={search.feedType} /> : null}
      {search.lifeStage ? <SummaryRow label="대상 연령" value={optionLabel(search.lifeStage, LIFE_STAGE_LABELS)} /> : null}
      {search.officialTargets.length ? <SummaryRow label="제품 표기 대상" value={compactList(search.officialTargets, TARGET_LABELS)} /> : null}
      {search.features.length ? <SummaryRow label="제품 특징" value={compactList(search.features, FEATURE_LABELS)} /> : null}
      {search.recipeFamilies.length ? <SummaryRow label="레시피" value={compactList(search.recipeFamilies, RECIPE_FAMILY_LABELS)} /> : null}
      {search.grainFree ? <SummaryRow label="특성" value="Grain-Free 표기" /> : null}
      {!hasPrimary ? <p className="summary-empty">추가 조건 없이 전체 제품을 봅니다.</p> : null}
    </div><div className="summary-actions"><button className="primary-action compact-action" type="button" onClick={editConditions}>조건 수정</button></div>
      <div className="refine-title">더 좁혀보기</div><FilterSection title="주요 레시피" hint="확인된 정보로 더 좁히기">
        {refine.recipeDetails.length ? <div className="selected-refinements">{refine.recipeDetails.map((value) => <button className="selected-refinement" key={value} type="button" onClick={() => toggleRefineRecipe(value)}>{optionLabel(value, RECIPE_DETAIL_LABELS)} ×</button>)}</div> : null}
        <input className="recipe-search" type="search" value={recipeSearch} placeholder="레시피 검색" onChange={(event) => setRecipeSearch(event.target.value)} />
        <div className="recipe-detail-grid">{visibleRecipeDetails.map((value) => <button className={refine.recipeDetails.includes(value) ? 'choice is-active' : 'choice'} key={value} type="button" aria-pressed={refine.recipeDetails.includes(value)} onClick={() => toggleRefineRecipe(value)}>{optionLabel(value, RECIPE_DETAIL_LABELS)}</button>)}</div>
      </FilterSection></>
  }
  function renderLeftPane() {
    if (mode === 'lookup') return <><div className="mode-intro"><strong>제품 찾기</strong><span>브랜드나 제품명을 검색합니다.</span></div><FilterSection title="브랜드 / 제품명"><input className="lookup-input" type="search" value={lookupQuery} placeholder="예: 오리젠 식스 피쉬" onChange={(event) => changeLookupQuery(event.target.value)} /></FilterSection></>
    return editingConditions ? renderConditionEditor() : renderConditionSummary()
  }
  function renderMobileRefineEntry() {
    if (mode !== 'explore' || editingConditions || selectedProduct || compareOpen || detailProductId) return null
    const togglePanel = () => {
      if (mobileRefineOpen) {
        setMobileRefineOpen(false)
        window.setTimeout(() => mobileRefineToggleRef.current?.focus(), 0)
        return
      }
      setMobileRefineOpen(true)
      window.setTimeout(() => document.querySelector<HTMLInputElement>('#mobile-recipe-refine-panel .recipe-search')?.focus(), 0)
    }
    return <div className="mobile-refine-entry"><button ref={mobileRefineToggleRef} className="secondary-action" type="button" aria-expanded={mobileRefineOpen} aria-controls="mobile-recipe-refine-panel" onClick={togglePanel}>{mobileRefineOpen ? '목록으로 돌아가기' : '더 좁혀보기'}</button></div>
  }
  function renderCriteriaBar() {
    if (mode !== 'explore' || editingConditions) return null
    const criteria = activeCriteria()
    return <div className="criteria-bar"><span className="criteria-label">적용된 조건</span><div className="criteria-chips">{criteria.length ? criteria.map((value) => <span key={value}>{value}</span>) : <span>추가 조건 없음</span>}</div><button type="button" onClick={editConditions}>조건 수정</button></div>
  }
  function renderResultList() {
    if (error) return <div className="state-message error-message" role="alert"><strong>제품 데이터를 불러오지 못했습니다.</strong><span>{error}</span><button className="state-retry" type="button" onClick={loadCatalog}>다시 시도</button></div>
    if (loading) return <div className="state-message"><strong>제품 데이터를 불러오는 중입니다.</strong></div>
    if (mode === 'explore' && editingConditions) return <div className="state-message"><strong>조건을 골라 주세요.</strong><span>확인되지 않은 정보는 자동으로 제외하지 않습니다.</span></div>
    if (mode === 'lookup' && !lookupQuery.trim()) return <div className="state-message"><strong>브랜드 또는 제품명을 입력해 주세요.</strong><span>일부만 입력해도 검색할 수 있습니다.</span></div>
    if (!resultProducts.length) return <div className="state-message"><strong>{mode === 'lookup' ? '검색 결과가 없습니다.' : '조건에 맞는 제품이 없습니다.'}</strong><span>{mode === 'explore' ? '선택한 조건은 임의로 완화하지 않습니다.' : '검색어를 다시 확인해 주세요.'}</span></div>
    return <div className="research-results-list">{visibleProducts.map((product) => { const evaluation = mode === 'explore' ? evaluated.find((item) => item.product.product_id === product.product_id) ?? null : null; const hasExploreCriteria = mode === 'explore' && activeConditions > 0; const cardClass = ['research-result-card', product.product_id === selectedId ? 'is-selected' : '', evaluation && !hasExploreCriteria ? 'is-unfiltered' : ''].filter(Boolean).join(' '); return <button data-product-id={product.product_id} className={cardClass} key={product.product_id} type="button" onClick={() => openExploreProduct(product.product_id)}><ProductImage className="research-result-image" product={product} /><span className="research-result-identity"><span className="research-result-brand">{product.brand}</span><strong>{product.canonical_name}</strong><span className="research-result-meta">{product.feed_type ?? '형태 미확인'} · {product.life_stage ? optionLabel(product.life_stage, LIFE_STAGE_LABELS) : '대상 연령 미확인'}</span><span className="research-result-packages">판매 규격 · {packageOptionsLabel(product)}</span></span>{evaluation ? hasExploreCriteria ? <RelationSummary evaluation={evaluation} /> : null : <span className="research-result-facts"><span>제품 표기 대상</span><strong>{compactList(product.official_targets, TARGET_LABELS)}</strong><span>주요 레시피</span><strong>{compactList(product.recipe_details, RECIPE_DETAIL_LABELS)}</strong></span>}<span className="research-result-open">빠른 보기 →</span></button> })}{visibleCount < resultProducts.length ? <button className="load-more" type="button" onClick={loadMore}>제품 더 보기 · {resultProducts.length - visibleProducts.length}개 남음</button> : null}</div>
  }
  function renderQuickView() {
    if (!selectedProduct) return null
    const isCompared = compareIds.includes(selectedProduct.product_id)
    return <aside className="research-quick-view"><div className="quick-view-topline"><span>빠른 보기</span><button type="button" onClick={closeQuickView}>닫기 ×</button></div><div className="quick-view-scroll"><section className="quick-view-identity"><ProductImage className="quick-view-image" product={selectedProduct} /><div><span>{selectedProduct.brand}</span><h1>{selectedProduct.canonical_name}</h1><p>{selectedProduct.feed_type ?? '형태 미확인'} · {selectedProduct.life_stage ? optionLabel(selectedProduct.life_stage, LIFE_STAGE_LABELS) : '대상 연령 미확인'}</p></div></section><div className="quick-view-actions"><button className={isCompared ? 'switch-compare-action is-added' : 'switch-compare-action'} type="button" disabled={compareIds.length >= 5 && !isCompared} onClick={() => toggleCompare(selectedProduct.product_id)}>{isCompared ? '비교에서 제거' : compareIds.length >= 5 ? '비교는 최대 5개까지 가능합니다' : `비교에 추가 · ${compareIds.length}/5`}</button><button className="switch-compare-action" type="button" onClick={() => { if (mode === 'explore') recordExploreConsideration(selectedProduct.product_id, 'detail_open'); openDetail(selectedProduct.product_id) }}>상세 보기 →</button></div>{selectedEvaluation && activeConditions > 0 ? <section className="quick-view-section"><h2>선택한 조건과 비교</h2><dl className="definition-list"><Definition label="확인됨">{selectedEvaluation.confirmedMatches.length ? selectedEvaluation.confirmedMatches.map(relationLabel).join(' · ') : <span className="unknown-value">확인된 항목 없음</span>}</Definition><Definition label="미확인">{selectedEvaluation.unknowns.length ? selectedEvaluation.unknowns.map(unknownLabel).join(' · ') : <span className="unknown-value">—</span>}</Definition></dl></section> : null}<section className="quick-view-section"><h2>핵심 정보</h2><dl className="definition-list"><Definition label="판매 규격">{packageOptionsLabel(selectedProduct)}</Definition><Definition label="제품 표기 대상"><ValueList values={selectedProduct.official_targets} labels={TARGET_LABELS} /></Definition><Definition label="제품 특징"><ValueList values={selectedProduct.features} labels={FEATURE_LABELS} /></Definition><Definition label="레시피 종류"><ValueList values={selectedProduct.recipe_families} labels={RECIPE_FAMILY_LABELS} /></Definition><Definition label="주요 레시피"><ValueList values={selectedProduct.recipe_details} labels={RECIPE_DETAIL_LABELS} /></Definition><Definition label="레시피 특성"><ValueList values={selectedProduct.official_recipe_traits} labels={RECIPE_TRAIT_LABELS} /></Definition></dl><p className="quick-view-scope-note">제조·유통 정보와 출처 근거는 상세 화면에서 확인할 수 있습니다.</p></section></div></aside>
  }

  if (detailProduct) return <ProductDetail product={detailProduct} onClose={closeDetail} initialTab={detailTab} onTabChange={changeDetailTab} />
  if (screen === 'home') return <Home productCount={products.length} loading={loading} onStart={startFromHome} />
  if (mode === 'switch') return <SwitchFlow products={products} loading={loading} error={error} session={switchSession} onSessionChange={commitSwitchSession} onHistoryBack={backSwitchHistory} onHome={goHome} onModeChange={changeMode} onRetryCatalog={loadCatalog} />

  const paneTitle = mode === 'explore' ? '조건 설정' : '제품 찾기'
  const paneDescription = mode === 'explore' ? '원하는 조건을 골라 제품을 좁혀보세요.' : '브랜드나 제품명으로 찾습니다.'
  const waitingForConditions = mode === 'explore' && editingConditions
  const comparedNames = compareItems.map((item) => item.product.canonical_name)
  const showMobileRefine = mobileRefineOpen && mode === 'explore' && !editingConditions && !selectedProduct && !compareOpen && !detailProductId
  const shellClassName = ['research-shell', selectedProduct ? 'is-inspecting' : 'is-browsing', showMobileRefine ? 'is-mobile-refining' : ''].filter(Boolean).join(' ')
  return <div className={shellClassName}><header className="research-topbar"><button className="research-brand" type="button" aria-label="CATFOOD 홈으로 이동" onClick={goHome}>FELINE ARCHIVE</button><nav className="mode-nav" aria-label="탐색 모드"><ModeButton mode="explore" active={mode} label="조건으로 찾기" onClick={changeMode} /><ModeButton mode="lookup" active={mode} label="제품 찾기" onClick={changeMode} /><ModeButton mode="switch" active={mode} label="현재 사료" onClick={changeMode} /></nav><div className="research-status"><span>{products.length || '—'} PRODUCTS</span><span className={error ? 'is-error' : ''}>{error ? '연결 오류' : loading ? '불러오는 중' : '데이터 연결됨'}</span></div></header>{compareOpen && compareItems.length ? <CompareView items={compareItems} onClose={closeCompare} onRemove={removeCompare} initialTab={compareTab} onTabChange={changeCompareTab} /> : <>{renderCriteriaBar()}{renderMobileRefineEntry()}<main className="research-workspace">{!selectedProduct ? <aside className="research-filters" id={mode === 'explore' && !editingConditions ? 'mobile-recipe-refine-panel' : undefined}><div className="research-pane-heading"><div><strong>{paneTitle}</strong><span>{paneDescription}</span>{mode === 'explore' && editingConditions ? <span className="condition-draft-count">선택한 조건 {countActiveConditions(draftSearch)}개</span> : null}</div></div><div className="research-filter-scroll">{renderLeftPane()}</div></aside> : null}<section className="research-results"><div className="research-results-heading"><div><strong>제품 목록</strong><span>{loading || waitingForConditions ? '조건을 고르면 결과가 표시됩니다.' : visibleProducts.length < resultProducts.length ? `${resultProducts.length}개 중 ${visibleProducts.length}개 표시` : `${resultProducts.length}개의 제품`}</span></div>{mode === 'explore' && !editingConditions && activeConditions > 0 ? <span className="research-results-context">조건과 확인된 제품 정보를 비교해 표시합니다.</span> : null}</div><div className="research-results-scroll">{renderResultList()}</div></section>{renderQuickView()}</main>{compareIds.length ? <div className="switch-compare-dock" role="status"><strong>비교 {compareIds.length}/5</strong><div className="switch-compare-dock-list">{comparedNames.join(' · ')}</div><button type="button" onClick={openCompare}>비교 보기 →</button></div> : null}</>}</div>
}
