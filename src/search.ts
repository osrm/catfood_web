import type { CatalogProduct } from './api'

export interface SearchState {
  query: string
  feedType: string
  lifeStage: string
  officialTargets: string[]
  features: string[]
  recipeFamilies: string[]
  recipeDetails: string[]
  grainFree: boolean
}

export const INITIAL_SEARCH: SearchState = {
  query: '',
  feedType: '',
  lifeStage: '',
  officialTargets: [],
  features: [],
  recipeFamilies: [],
  recipeDetails: [],
  grainFree: false,
}

export function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value]
}

export function filterCatalog(
  products: CatalogProduct[],
  search: SearchState,
): CatalogProduct[] {
  const query = search.query.trim().toLocaleLowerCase('ko-KR')

  return products.filter((product) => {
    if (query) {
      const searchable = `${product.brand} ${product.canonical_name}`.toLocaleLowerCase('ko-KR')
      if (!searchable.includes(query)) return false
    }

    if (search.feedType && product.feed_type !== search.feedType) return false
    if (search.lifeStage && product.life_stage !== search.lifeStage) return false

    if (
      search.officialTargets.length > 0 &&
      !search.officialTargets.some((value) => product.official_targets.includes(value))
    ) {
      return false
    }

    if (
      search.features.length > 0 &&
      !search.features.every((value) => product.features.includes(value))
    ) {
      return false
    }

    if (
      search.recipeFamilies.length > 0 &&
      !search.recipeFamilies.some((value) => product.recipe_families.includes(value))
    ) {
      return false
    }

    if (
      search.recipeDetails.length > 0 &&
      !search.recipeDetails.some((value) => product.recipe_details.includes(value))
    ) {
      return false
    }

    if (search.grainFree && !product.official_recipe_traits.includes('grain_free')) {
      return false
    }

    return true
  })
}

export function countActiveConditions(search: SearchState): number {
  return (
    Number(Boolean(search.query.trim())) +
    Number(Boolean(search.feedType)) +
    Number(Boolean(search.lifeStage)) +
    search.officialTargets.length +
    search.features.length +
    search.recipeFamilies.length +
    search.recipeDetails.length +
    Number(search.grainFree)
  )
}
