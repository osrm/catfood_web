import type { CompareTab, DetailTab } from './navigation-state'
import type { SearchState } from './search'

export type SwitchStep = 'current' | 'sku' | 'change' | 'keep' | 'results'
export type SwitchHistoryAction = 'replace' | 'push'
export type SwitchHistoryEntry = 'step' | 'detail' | 'compare'
export type SwitchVariantSelection =
  | { kind: 'unselected'; variantId: null }
  | { kind: 'unknown'; variantId: null }
  | { kind: 'variant'; variantId: string }

export type SwitchSessionState = {
  query: string
  currentProductId: string | null
  variantSelection: SwitchVariantSelection
  change: SearchState
  keep: SearchState
  changeBrand: boolean
  keepBrand: boolean
  ingredientAvoidTerms: string[]
  noChangeIntent: boolean
  step: SwitchStep
  visibleCandidateCount: number
  selectedCandidateId: string | null
  compareIds: string[]
  compareOpen: boolean
  compareTab: CompareTab
  detailProductId: string | null
  detailTab: DetailTab
}

export type SwitchSessionSnapshot = {
  version: 1
  state: SwitchSessionState
}

export type SwitchSessionUpdate = (
  update: SwitchSessionState | ((current: SwitchSessionState) => SwitchSessionState),
  action?: SwitchHistoryAction,
  entry?: SwitchHistoryEntry | null,
) => void

const STORAGE_KEY = 'catfood.switch-session.v1'
const SNAPSHOT_VERSION = 1
const STEPS = new Set<SwitchStep>(['current', 'sku', 'change', 'keep', 'results'])
const DETAIL_TABS = new Set<DetailTab>(['overview', 'nutrition', 'ingredients', 'context'])
const COMPARE_TABS = new Set<CompareTab>(['overview', 'nutrition', 'ingredients'])
const FEED_TYPES = new Set(['건식', '습식', '동결건조'])
const LIFE_STAGES = new Set(['kitten', 'adult', 'senior', 'all_life_stages', 'gestation_lactation_and_kitten'])
const TARGETS = new Set(['indoor', 'sterilized'])
const FEATURES = new Set(['weight_management', 'stool', 'hairball', 'digestive', 'urinary', 'skin_coat', 'dental'])
const RECIPE_FAMILIES = new Set(['poultry', 'meat', 'fish'])

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}
function uniqueStrings(value: unknown, max = 50): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))].slice(0, max)
}
function allowedStrings(value: unknown, options: Set<string>, max = 50): string[] {
  return uniqueStrings(value, max).filter((item) => options.has(item))
}
function allowedOne(value: unknown, options: Set<string>): string {
  return typeof value === 'string' && options.has(value) ? value : ''
}
function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
function parseCriteria(value: unknown): SearchState {
  const source = record(value) ?? {}
  return {
    feedType: allowedOne(source.feedType, FEED_TYPES),
    lifeStage: allowedOne(source.lifeStage, LIFE_STAGES),
    officialTargets: allowedStrings(source.officialTargets, TARGETS),
    features: allowedStrings(source.features, FEATURES),
    recipeFamilies: allowedStrings(source.recipeFamilies, RECIPE_FAMILIES),
    grainFree: source.grainFree === true,
  }
}
function parseVariantSelection(value: unknown): SwitchVariantSelection {
  const source = record(value)
  if (source?.kind === 'variant' && typeof source.variantId === 'string' && source.variantId.length > 0) {
    return { kind: 'variant', variantId: source.variantId }
  }
  if (source?.kind === 'unknown') return { kind: 'unknown', variantId: null }
  return { kind: 'unselected', variantId: null }
}

export function emptySwitchCriteria(): SearchState {
  return { feedType: '', lifeStage: '', officialTargets: [], features: [], recipeFamilies: [], grainFree: false }
}

export function createInitialSwitchSession(query = ''): SwitchSessionState {
  return {
    query,
    currentProductId: null,
    variantSelection: { kind: 'unselected', variantId: null },
    change: emptySwitchCriteria(),
    keep: emptySwitchCriteria(),
    changeBrand: false,
    keepBrand: false,
    ingredientAvoidTerms: [],
    noChangeIntent: false,
    step: 'current',
    visibleCandidateCount: 40,
    selectedCandidateId: null,
    compareIds: [],
    compareOpen: false,
    compareTab: 'overview',
    detailProductId: null,
    detailTab: 'overview',
  }
}

export function parseSwitchSessionState(value: unknown): SwitchSessionState | null {
  const source = record(value)
  if (!source) return null
  const currentProductId = nullableString(source.currentProductId)
  const compareIds = uniqueStrings(source.compareIds, 5)
  const rawVisible = typeof source.visibleCandidateCount === 'number' ? source.visibleCandidateCount : Number.NaN
  const visibleCandidateCount = Number.isFinite(rawVisible) && rawVisible > 0 ? Math.min(Math.floor(rawVisible), 1000) : 40
  const rawStep = source.step as SwitchStep | undefined
  const step = currentProductId && rawStep && STEPS.has(rawStep) ? rawStep : 'current'
  const rawCompareTab = source.compareTab as CompareTab | undefined
  const rawDetailTab = source.detailTab as DetailTab | undefined
  return {
    query: typeof source.query === 'string' ? source.query : '',
    currentProductId,
    variantSelection: currentProductId ? parseVariantSelection(source.variantSelection) : { kind: 'unselected', variantId: null },
    change: currentProductId ? parseCriteria(source.change) : emptySwitchCriteria(),
    keep: currentProductId ? parseCriteria(source.keep) : emptySwitchCriteria(),
    changeBrand: currentProductId && source.changeBrand === true,
    keepBrand: currentProductId && source.keepBrand === true,
    ingredientAvoidTerms: currentProductId ? uniqueStrings(source.ingredientAvoidTerms) : [],
    noChangeIntent: currentProductId && source.noChangeIntent === true,
    step,
    visibleCandidateCount,
    selectedCandidateId: currentProductId ? nullableString(source.selectedCandidateId) : null,
    compareIds: currentProductId ? compareIds : [],
    compareOpen: Boolean(currentProductId && source.compareOpen === true && compareIds.length > 0),
    compareTab: rawCompareTab && COMPARE_TABS.has(rawCompareTab) ? rawCompareTab : 'overview',
    detailProductId: currentProductId ? nullableString(source.detailProductId) : null,
    detailTab: rawDetailTab && DETAIL_TABS.has(rawDetailTab) ? rawDetailTab : 'overview',
  }
}

export function createSwitchSessionSnapshot(state: SwitchSessionState): SwitchSessionSnapshot {
  return { version: SNAPSHOT_VERSION, state }
}

export function parseSwitchSessionSnapshot(value: unknown): SwitchSessionState | null {
  const snapshot = record(value)
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) return null
  return parseSwitchSessionState(snapshot.state)
}

function sessionStorageOrNull(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function readSwitchSession(storage: StorageLike | null = sessionStorageOrNull()): SwitchSessionState | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(STORAGE_KEY)
    return raw ? parseSwitchSessionSnapshot(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function writeSwitchSession(state: SwitchSessionState, storage: StorageLike | null = sessionStorageOrNull()): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(createSwitchSessionSnapshot(state)))
  } catch {
    // Storage may be blocked or full. The in-memory App state remains usable.
  }
}

export function sanitizeSwitchSessionForCatalog(state: SwitchSessionState, validIds: Set<string>): SwitchSessionState {
  if (state.currentProductId && !validIds.has(state.currentProductId)) {
    return createInitialSwitchSession(state.query)
  }
  if (!state.currentProductId) return state
  const selectedCandidateId = state.selectedCandidateId && validIds.has(state.selectedCandidateId) ? state.selectedCandidateId : null
  const compareIds = state.compareIds.filter((id) => validIds.has(id))
  const detailProductId = state.detailProductId && validIds.has(state.detailProductId) ? state.detailProductId : null
  if (
    selectedCandidateId === state.selectedCandidateId
    && detailProductId === state.detailProductId
    && compareIds.length === state.compareIds.length
  ) return state
  return {
    ...state,
    selectedCandidateId,
    compareIds,
    compareOpen: state.compareOpen && compareIds.length > 0,
    detailProductId,
    detailTab: detailProductId ? state.detailTab : 'overview',
  }
}
