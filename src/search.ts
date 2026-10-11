import type { CatalogProduct } from './api'

export interface SearchState {
  feedType: string
  lifeStage: string
  officialTargets: string[]
  features: string[]
  recipeFamilies: string[]
  grainFree: boolean
  // General exploration only; older state and SWITCH criteria can omit it.
  ingredientAvoidTerms?: string[]
}

export interface RefineState {
  recipeDetails: string[]
  brands?: string[]
}

export interface CandidateEvaluation {
  product: CatalogProduct
  confirmedMatches: string[]
  unknowns: string[]
  matchCount: number
  ingredientReviewedNotFound?: string[]
  ingredientInsufficient?: string[]
}

export const INITIAL_SEARCH: SearchState = {
  feedType: '',
  lifeStage: '',
  officialTargets: [],
  features: [],
  recipeFamilies: [],
  grainFree: false,
  ingredientAvoidTerms: [],
}

export const INITIAL_REFINE: RefineState = {
  recipeDetails: [],
  brands: [],
}

export const INGREDIENT_AVOID_OPTIONS = [
  ['chicken', '닭'], ['duck', '오리'], ['egg', '계란'], ['salmon', '연어'],
  ['tuna', '참치'], ['beef', '소'], ['turkey', '칠면조'], ['lamb', '양'],
  ['pork', '돼지'], ['rabbit', '토끼'], ['herring', '청어'], ['mackerel', '고등어'],
  ['cod', '대구'], ['trout', '송어'], ['sardine', '정어리'], ['anchovy', '멸치'],
  ['whitefish', '흰살생선'], ['menhaden', '멘헤이든'], ['venison', '사슴'],
  ['goat', '염소'], ['goose', '거위'], ['quail', '메추리'], ['boar', '멧돼지'],
] as const
export const INGREDIENT_AVOID_LABELS: Record<string, string> = Object.fromEntries(INGREDIENT_AVOID_OPTIONS)
const INGREDIENT_AVOID_TERMS = new Set<string>(INGREDIENT_AVOID_OPTIONS.map(([term]) => term))

function ingredientAvoidanceEvidence(product: CatalogProduct, search: SearchState) {
  const ingredientConflicts: string[] = []
  const ingredientReviewedNotFound: string[] = []
  const ingredientInsufficient: string[] = []
  for (const term of new Set(search.ingredientAvoidTerms ?? [])) {
    if (!INGREDIENT_AVOID_TERMS.has(term)) continue
    if (product.confirmed_present_ingredient_terms.includes(term)) ingredientConflicts.push(term)
    else if (product.reviewed_not_found_ingredient_terms.includes(term)) ingredientReviewedNotFound.push(term)
    else ingredientInsufficient.push(term)
  }
  return { ingredientConflicts, ingredientReviewedNotFound, ingredientInsufficient }
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

function normalizedLookupText(value: string): string {
  return normalizedText(value)
    .replace(/(^|[^a-z])and(?=$|[^a-z])/g, '$1&')
    .replace(/\s+/g, '')
}

// Search labels only: keep catalog identities unchanged. See docs/brand-search-aliases.md.
const CONFIRMED_BRAND_ALIAS_GROUPS = [
  ['내추럴발란스', 'natural balance'],
  ['로얄캐닌', 'royal canin'],
  ['몬지', 'monge'],
  ['쉐지애', 'schesir'],
  ['아카나', 'acana'],
  ['오리젠', 'orijen'],
  ['지위픽', 'ZIWI Peak', 'ZIWI'],
  ['파미나', 'farmina'],
  ['퓨리나', 'purina'],
  ['힐스', "Hill's", 'Hills', 'Hill’s'],
  ['AATU', '아투'],
  ['Addiction', '어딕션'],
  ['Advance', '어드밴스'],
  ['AIXIA', '아이시아'],
  ['Alleva', '알레바'],
  ['Almo Nature', '알모네이쳐'],
  ['AvoDerm', '아보덤'],
  ['Best Breed', '베스트브리드'],
  ['Blackwood', '블랙우드'],
  ['Boreal', '보레알'],
  ['Brit', '브릿'],
  ['Canada Fresh', '캐나다프레쉬'],
  ['Carna4', '카르나4'],
  ['Carnilove', '카니러브'],
  ['Caru', '카루'],
  ["Cat's Taste", 'Cat’s Taste', 'Cats Taste', '캣츠테이스트'],
  ['Catit', '캣잇'],
  ['Earthborn Holistic', '어스본홀리스틱'],
  ['Element Series', '엘레멘트'],
  ['Feline Natural', '필라인 내추럴', '펠린 내추럴'],
  ['Gather', '게더'],
  ['GO! SOLUTIONS', 'Go Solutions', '고 솔루션'],
  ['Husse', '후새'],
  ['INABA / CIAO', 'INABA', 'CIAO', '이나바', '차오'],
  ['Instinct', '인스팅트'],
  ['iti', '이티'],
  ['Josera', '요세라'],
  ['KONGO', '콩고'],
  ['LEONARDO', '레오나르도'],
  ['Lotus', '로투스'],
  ['Lucy Pet', '루시펫'],
  ['Miamor', '미아모아'],
  ['Natural Greatness', '내추럴그레이트니스'],
  ['NOW FRESH', '나우프레쉬', '나우프레시'],
  ['Nulo', '뉴로'],
  ['NurturePRO', '너처프로'],
  ['Nutrience', '뉴트리언스'],
  ['NutriSource', '뉴트리소스'],
  ['Nutro', '뉴트로'],
  ['Open Farm', '오픈팜'],
  ['Pro-Nutrition', 'Pro Nutrition', '프로뉴트리션'],
  ['PureVita', '퓨어비타'],
  ['Purina Cat Chow', '퓨리나 캣차우'],
  ['Purina Pro Plan', '퓨리나 프로플랜'],
  ['RANOVA', '라노바'],
  ['RAWZ', '로우즈'],
  ['SHEBA', '쉬바'],
  ['Signature7', '시그니처7'],
  ['Snappy Tom', '스내피톰'],
  ["Stella & Chewy's", 'Stella & Chewy’s', 'Stella & Chewys', 'Stella and Chewys', '스텔라앤츄이스'],
  ['Taste of the Wild', '테이스트 오브 더 와일드', '토우'],
  ['Terra Felis', '테라펠리스'],
  ['The Honest Kitchen', '디어니스트키친'],
  ['Thrive', '쓰라이브'],
  ['Vital Essentials', '바이탈에센셜'],
  ['Wellness', '웰니스'],
  ['Weruva', '웨루바'],
  ['WHISKAS', '위스카스'],
  ['Wishbone', '위시본'],
  ['Zealandia', '질란디아'],
] as const

// The labels never change at runtime. Normalize and index them once instead of
// walking every brand group again for every product on every input event.
const BRAND_ALIASES_BY_LOOKUP = new Map<string, readonly string[]>()
for (const group of CONFIRMED_BRAND_ALIAS_GROUPS) {
  // A parent brand plus a recipe also searches its named lines, without merging their identities.
  const aliases: readonly string[] = group[0] === 'Purina Cat Chow' || group[0] === 'Purina Pro Plan'
    ? [...group, 'Purina', '퓨리나']
    : group
  for (const label of group) {
    const key = normalizedLookupText(label)
    if (!BRAND_ALIASES_BY_LOOKUP.has(key)) BRAND_ALIASES_BY_LOOKUP.set(key, aliases)
  }
}

function confirmedBrandAliases(brand: string): readonly string[] {
  return BRAND_ALIASES_BY_LOOKUP.get(normalizedLookupText(brand)) ?? []
}

// Alias matching finds selector labels; selection uses exact catalog identity.
export function matchesBrandQuery(brand: string, query: string): boolean {
  const needle = normalizedLookupText(query)
  return !needle || [brand, ...confirmedBrandAliases(brand)].some((label) => normalizedLookupText(label).includes(needle))
}

function conditionLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replaceAll('_', ' ')
}

export function lookupCatalog(products: CatalogProduct[], query: string): CatalogProduct[] {
  const originalNeedle = normalizedText(query)
  const lookupNeedle = normalizedLookupText(query)
  if (!lookupNeedle) return []

  return products.filter((product) => {
    const values = [
      `${product.brand} ${product.canonical_name}`,
      ...confirmedBrandAliases(product.brand).map((alias) => `${alias} ${product.canonical_name}`),
    ]
    return values.some((value) => normalizedText(value).includes(originalNeedle) || normalizedLookupText(value).includes(lookupNeedle))
  })
}

export type ComparisonCriteriaDifference = {
  kind: 'feedType' | 'lifeStage' | 'recipeDetails' | 'brand'
  selectedValues: string[]
  productValues: string[]
}

export interface ComparisonCriteriaEvaluation {
  confirmedMatches: string[]
  unknowns: string[]
  differences: ComparisonCriteriaDifference[]
  ingredientConflicts: string[]
  ingredientReviewedNotFound: string[]
  ingredientInsufficient: string[]
}

export function evaluateComparisonCriteria(
  product: CatalogProduct,
  search: SearchState,
  refine: RefineState = INITIAL_REFINE,
): ComparisonCriteriaEvaluation {
  const confirmedMatches: string[] = []
  const unknowns: string[] = []
  const differences: ComparisonCriteriaDifference[] = []

  if (search.feedType) {
    if (!product.feed_type) {
      unknowns.push('사료 형태')
    } else if (product.feed_type === search.feedType) {
      confirmedMatches.push(`형태:${search.feedType}`)
    } else {
      differences.push({ kind: 'feedType', selectedValues: [search.feedType], productValues: [product.feed_type] })
    }
  }

  if (search.lifeStage) {
    if (!product.life_stage) {
      unknowns.push('제품 표기 생애주기')
    } else if (product.life_stage === search.lifeStage) {
      confirmedMatches.push(`생애주기:${search.lifeStage}`)
    } else {
      differences.push({ kind: 'lifeStage', selectedValues: [search.lifeStage], productValues: [product.life_stage] })
    }
  }

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
    if (matches.length > 0) {
      confirmedMatches.push(...matches.map((value) => `세부:${value}`))
    } else if (product.recipe_details.length > 0) {
      differences.push({ kind: 'recipeDetails', selectedValues: refine.recipeDetails, productValues: product.recipe_details })
    } else {
      unknowns.push('주요 레시피')
    }
  }

  if (refine.brands?.length) {
    if (!product.brand) unknowns.push('브랜드')
    else if (refine.brands.includes(product.brand)) confirmedMatches.push('브랜드:' + product.brand)
    else differences.push({ kind: 'brand', selectedValues: refine.brands, productValues: [product.brand] })
  }

  return { confirmedMatches, unknowns, differences, ...ingredientAvoidanceEvidence(product, search) }
}

export function evaluateCatalog(
  products: CatalogProduct[],
  search: SearchState,
  refine: RefineState = INITIAL_REFINE,
): CandidateEvaluation[] {
  const candidates: CandidateEvaluation[] = []

  for (const product of products) {
    if (refine.brands?.length && !refine.brands.includes(product.brand)) continue
    const ingredientEvidence = ingredientAvoidanceEvidence(product, search)
    if (ingredientEvidence.ingredientConflicts.length) continue
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

    if (refine.brands?.length) confirmedMatches.push('브랜드:' + product.brand)

    candidates.push({
      product,
      confirmedMatches,
      unknowns,
      matchCount: confirmedMatches.filter((value) => !value.startsWith('브랜드:')).length,
      ingredientReviewedNotFound: ingredientEvidence.ingredientReviewedNotFound,
      ingredientInsufficient: ingredientEvidence.ingredientInsufficient,
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
    (search.ingredientAvoidTerms?.length ?? 0) +
    refine.recipeDetails.length +
    Number(Boolean(refine.brands?.length))
  )
}
