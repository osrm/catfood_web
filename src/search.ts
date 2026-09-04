import type { CatalogProduct } from './api'

export interface SearchState {
  feedType: string
  lifeStage: string
  officialTargets: string[]
  features: string[]
  recipeFamilies: string[]
  grainFree: boolean
}

export interface RefineState {
  recipeDetails: string[]
}

export interface CandidateEvaluation {
  product: CatalogProduct
  confirmedMatches: string[]
  unknowns: string[]
  matchCount: number
}

export const INITIAL_SEARCH: SearchState = {
  feedType: '',
  lifeStage: '',
  officialTargets: [],
  features: [],
  recipeFamilies: [],
  grainFree: false,
}

export const INITIAL_REFINE: RefineState = {
  recipeDetails: [],
}

const OFFICIAL_TARGET_LABELS: Record<string, string> = {
  indoor: '실내묘',
  sterilized: '중성화묘',
}

const RECIPE_FAMILY_LABELS: Record<string, string> = {
  poultry: '가금류',
  meat: '육류',
  fish: '생선',
}

export function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value]
}

function normalizedText(value: string): string {
  return value.trim().toLocaleLowerCase('ko-KR')
}

function conditionLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replaceAll('_', ' ')
}

export function lookupCatalog(products: CatalogProduct[], query: string): CatalogProduct[] {
  const needle = normalizedText(query)
  if (!needle) return []

  return products.filter((product) => {
    const searchable = normalizedText(`${product.brand} ${product.canonical_name}`)
    return searchable.includes(needle)
  })
}

export function evaluateCatalog(
  products: CatalogProduct[],
  search: SearchState,
  refine: RefineState = INITIAL_REFINE,
): CandidateEvaluation[] {
  const candidates: CandidateEvaluation[] = []

  for (const product of products) {
    const confirmedMatches: string[] = []
    const unknowns: string[] = []
    let hasHardConflict = false

    if (search.feedType) {
      if (!product.feed_type) {
        unknowns.push('사료 형태')
      } else if (product.feed_type === search.feedType) {
        confirmedMatches.push(`형태:${search.feedType}`)
      } else {
        hasHardConflict = true
      }
    }

    if (search.lifeStage) {
      if (!product.life_stage) {
        unknowns.push('제품 표기 생애주기')
      } else if (product.life_stage === search.lifeStage) {
        confirmedMatches.push(`생애주기:${search.lifeStage}`)
      } else {
        hasHardConflict = true
      }
    }

    if (hasHardConflict) continue

    for (const target of search.officialTargets) {
      if (product.official_targets.includes(target)) {
        confirmedMatches.push(`대상:${target}`)
      } else {
        unknowns.push(`공식 대상 · ${conditionLabel(target, OFFICIAL_TARGET_LABELS)}`)
      }
    }

    for (const feature of search.features) {
      if (product.features.includes(feature)) {
        confirmedMatches.push(`기능:${feature}`)
      } else {
        unknowns.push(`기능:${feature}`)
      }
    }

    for (const family of search.recipeFamilies) {
      if (product.recipe_families.includes(family)) {
        confirmedMatches.push(`계열:${family}`)
      } else {
        unknowns.push(`레시피 계열 · ${conditionLabel(family, RECIPE_FAMILY_LABELS)}`)
      }
    }

    if (search.grainFree) {
      if (product.official_recipe_traits.includes('grain_free')) {
        confirmedMatches.push('특성:grain_free')
      } else {
        unknowns.push('Grain-Free 공식 표방')
      }
    }

    if (refine.recipeDetails.length > 0) {
      const matches = refine.recipeDetails.filter((value) => product.recipe_details.includes(value))
      if (matches.length === 0) continue
      confirmedMatches.push(...matches.map((value) => `세부:${value}`))
    }

    candidates.push({
      product,
      confirmedMatches,
      unknowns,
      matchCount: confirmedMatches.length,
    })
  }

  return candidates.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount

    const brandOrder = a.product.brand.localeCompare(b.product.brand, 'ko-KR')
    if (brandOrder !== 0) return brandOrder

    const nameOrder = a.product.canonical_name.localeCompare(b.product.canonical_name, 'ko-KR')
    if (nameOrder !== 0) return nameOrder

    return a.product.product_id.localeCompare(b.product.product_id, 'en')
  })
}

export function countActiveConditions(search: SearchState, refine: RefineState = INITIAL_REFINE): number {
  return (
    Number(Boolean(search.feedType)) +
    Number(Boolean(search.lifeStage)) +
    search.officialTargets.length +
    search.features.length +
    search.recipeFamilies.length +
    Number(search.grainFree) +
    refine.recipeDetails.length
  )
}
