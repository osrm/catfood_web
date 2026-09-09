import type { RefineState, SearchState } from './search'

export type AppMode = 'switch' | 'explore' | 'lookup'
export type DetailTab = 'overview' | 'nutrition' | 'ingredients' | 'context'
export type CompareTab = 'overview' | 'nutrition' | 'ingredients'

const MODES = new Set<AppMode>(['switch', 'explore', 'lookup'])
const DETAIL_TABS = new Set<DetailTab>(['overview', 'nutrition', 'ingredients', 'context'])
const COMPARE_TABS = new Set<CompareTab>(['overview', 'nutrition', 'ingredients'])
const FEED_TYPES = new Set(['건식', '습식', '동결건조'])
const LIFE_STAGES = new Set(['kitten', 'adult', 'senior', 'all_life_stages', 'gestation_lactation_and_kitten'])
const TARGETS = new Set(['indoor', 'sterilized'])
const FEATURES = new Set(['weight_management', 'stool', 'hairball', 'digestive', 'urinary', 'skin_coat', 'dental'])
const RECIPE_FAMILIES = new Set(['poultry', 'meat', 'fish'])

const csv = (value: string | null): string[] => value
  ? value.split(',').map((item) => item.trim()).filter(Boolean)
  : []
const unique = (values: string[], max = Number.POSITIVE_INFINITY): string[] => [...new Set(values)].slice(0, max)
const allowed = (values: string[], options: Set<string>): string[] => unique(values.filter((value) => options.has(value)))
const allowedOne = (value: string | null, options: Set<string>): string => value && options.has(value) ? value : ''

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
      feedType: allowedOne(params.get('feed'), FEED_TYPES),
      lifeStage: allowedOne(params.get('age'), LIFE_STAGES),
      officialTargets: allowed(csv(params.get('targets')), TARGETS),
      features: allowed(csv(params.get('features')), FEATURES),
      recipeFamilies: allowed(csv(params.get('recipes')), RECIPE_FAMILIES),
      grainFree: params.get('grainFree') === '1',
    },
    refine: { recipeDetails: unique(csv(params.get('recipeDetails')), 36) },
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
  if (state.screen === 'home') return ''

  const params = new URLSearchParams()
  params.set('view', 'workspace')
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
