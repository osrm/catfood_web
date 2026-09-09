import type { RefineState, SearchState } from './search'

export type AppMode = 'switch' | 'explore' | 'lookup'
export type DetailTab = 'overview' | 'nutrition' | 'ingredients' | 'context'
export type CompareTab = 'overview' | 'nutrition' | 'ingredients'

const MODES = new Set<AppMode>(['switch', 'explore', 'lookup'])
const DETAIL_TABS = new Set<DetailTab>(['overview', 'nutrition', 'ingredients', 'context'])
const COMPARE_TABS = new Set<CompareTab>(['overview', 'nutrition', 'ingredients'])

const csv = (value: string | null): string[] => value
  ? value.split(',').map((item) => item.trim()).filter(Boolean)
  : []

const unique = (values: string[], max = Number.POSITIVE_INFINITY): string[] => [...new Set(values)].slice(0, max)

export type NavigationState = {
  mode: AppMode
  screen: 'home' | 'workspace'
  lookupQuery: string
  search: SearchState
  refine: RefineState
  editingConditions: boolean
  selectedId: string | null
  visibleCount: number
  compareIds: string[]
  compareOpen: boolean
  compareTab: CompareTab
  detailProductId: string | null
  detailTab: DetailTab
}

export function parseNavigationState(searchString: string): NavigationState {
  const params = new URLSearchParams(searchString)
  const rawMode = params.get('mode') as AppMode | null
  const mode = rawMode && MODES.has(rawMode) ? rawMode : 'explore'
  const requestedWorkspace = params.get('view') === 'workspace' || params.has('detail') || params.has('compare') || params.has('q') || params.has('applied')
  const visible = Number.parseInt(params.get('visible') ?? '', 10)
  const compareIds = unique(csv(params.get('compare')), 5)
  const rawDetailTab = params.get('detailTab') as DetailTab | null
  const rawCompareTab = params.get('compareTab') as CompareTab | null

  return {
    mode,
    screen: requestedWorkspace ? 'workspace' : 'home',
    lookupQuery: params.get('q') ?? '',
    search: {
      feedType: params.get('feed') ?? '',
      lifeStage: params.get('age') ?? '',
      officialTargets: unique(csv(params.get('targets'))),
      features: unique(csv(params.get('features'))),
      recipeFamilies: unique(csv(params.get('recipes'))),
      grainFree: params.get('grainFree') === '1',
    },
    refine: { recipeDetails: unique(csv(params.get('recipeDetails'))) },
    editingConditions: params.get('applied') !== '1',
    selectedId: params.get('selected') || null,
    visibleCount: Number.isFinite(visible) && visible > 0 ? Math.min(visible, 1000) : mode === 'lookup' ? 120 : 40,
    compareIds,
    compareOpen: params.get('compareOpen') === '1' && compareIds.length > 0,
    compareTab: rawCompareTab && COMPARE_TABS.has(rawCompareTab) ? rawCompareTab : 'overview',
    detailProductId: params.get('detail') || null,
    detailTab: rawDetailTab && DETAIL_TABS.has(rawDetailTab) ? rawDetailTab : 'overview',
  }
}

function setCsv(params: URLSearchParams, key: string, values: string[]) {
  const cleaned = unique(values)
  if (cleaned.length) params.set(key, cleaned.join(','))
  else params.delete(key)
}

export function navigationSearch(state: NavigationState): string {
  const params = new URLSearchParams()
  if (state.screen === 'workspace') params.set('view', 'workspace')
  if (state.mode !== 'explore') params.set('mode', state.mode)
  if (state.mode === 'lookup' && state.lookupQuery) params.set('q', state.lookupQuery)
  if (state.mode === 'explore') {
    if (!state.editingConditions) params.set('applied', '1')
    if (state.search.feedType) params.set('feed', state.search.feedType)
    if (state.search.lifeStage) params.set('age', state.search.lifeStage)
    setCsv(params, 'targets', state.search.officialTargets)
    setCsv(params, 'features', state.search.features)
    setCsv(params, 'recipes', state.search.recipeFamilies)
    if (state.search.grainFree) params.set('grainFree', '1')
    setCsv(params, 'recipeDetails', state.refine.recipeDetails)
  }
  if (state.selectedId) params.set('selected', state.selectedId)
  const defaultVisible = state.mode === 'lookup' ? 120 : 40
  if (state.visibleCount !== defaultVisible) params.set('visible', String(state.visibleCount))
  const compareIds = unique(state.compareIds, 5)
  if (compareIds.length) params.set('compare', compareIds.join(','))
  if (state.compareOpen && compareIds.length) params.set('compareOpen', '1')
  if (state.compareTab !== 'overview') params.set('compareTab', state.compareTab)
  if (state.detailProductId) params.set('detail', state.detailProductId)
  if (state.detailProductId && state.detailTab !== 'overview') params.set('detailTab', state.detailTab)
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

export function sanitizeProductNavigation(state: NavigationState, validIds: Set<string>): NavigationState {
  const compareIds = unique(state.compareIds.filter((id) => validIds.has(id)), 5)
  return {
    ...state,
    selectedId: state.selectedId && validIds.has(state.selectedId) ? state.selectedId : null,
    detailProductId: state.detailProductId && validIds.has(state.detailProductId) ? state.detailProductId : null,
    compareIds,
    compareOpen: state.compareOpen && compareIds.length > 0,
  }
}
