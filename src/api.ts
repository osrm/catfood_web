export interface CatalogProduct {
  product_id: string
  brand: string
  canonical_name: string
  feed_type: string | null
  life_stage: string | null
  display_image_url: string | null
  representative_variant_id: string | null
  representative_package_size_text: string | null
  representative_package_weight_g: number | null
  variant_count: number
  has_variants: boolean
  ingredient_declaration_count: number
  full_ingredient_declaration_count: number
  has_ingredient_details: boolean
  has_full_ingredient_declaration: boolean
  nutrition_panel_count: number
  has_nutrition_details: boolean
  manufacturing_observation_count: number
  has_manufacturing_details: boolean
  manufacturing_country_codes: string[]
  market_observation_count: number
  has_market_details: boolean
  assessed_market_country_codes: string[]
  current_market_country_codes: string[]
  formula_match_market_country_codes: string[]
  ingredient_term_result_count: number
  confirmed_present_ingredient_terms: string[]
  direct_evidence_ingredient_terms: string[]
  flavor_associated_ingredient_terms: string[]
  reviewed_not_found_ingredient_terms: string[]
  insufficient_evidence_ingredient_terms: string[]
  official_targets: string[]
  features: string[]
  recipe_families: string[]
  recipe_details: string[]
  official_recipe_traits: string[]
}

export type FormulaEvidenceStatus = 'confirmed' | 'conflicting' | 'unresolved' | 'not_observed'

export interface ProductVariant {
  product_id: string
  variant_id: string
  package_size_text: string | null
  package_weight_g: number | null
  units_per_sale: number | null
  sale_total_weight_g: number | null
  sales_bundle_status: string | null
  display_rank: number
  variant_count: number
  formula_evidence_status: FormulaEvidenceStatus
  recipe_families: string[]
  recipe_details: string[]
  official_recipe_traits: string[]
  ingredient_term_result_count: number
  confirmed_present_ingredient_terms: string[]
  direct_evidence_ingredient_terms: string[]
  flavor_associated_ingredient_terms: string[]
  reviewed_not_found_ingredient_terms: string[]
  insufficient_evidence_ingredient_terms: string[]
}

export interface CompareNutrition {
  product_id: string
  variant_id: string | null
  observation_scope: string
  market_code: string | null
  panel_type: string | null
  protein_pct: number | null
  protein_qualifier: string | null
  fat_pct: number | null
  fat_qualifier: string | null
  fiber_pct: number | null
  fiber_qualifier: string | null
  moisture_pct: number | null
  moisture_qualifier: string | null
  ash_pct: number | null
  ash_qualifier: string | null
  kcal_per_kg: number | null
  kcal_per_100g: number | null
  energy_basis: string | null
  is_korea_market_observation: boolean
  is_current_resolved_formula: boolean
}

export interface CompareIngredients {
  product_id: string
  variant_id: string | null
  observation_scope: string
  market_code: string | null
  declaration_scope: string | null
  completeness_status: string | null
  raw_text: string | null
  ingredient_names: string[]
  ingredient_count: number
  is_korea_market_observation: boolean
  is_current_resolved_formula: boolean
}

const CATALOG_FIELDS = [
  'product_id',
  'brand',
  'canonical_name',
  'feed_type',
  'life_stage',
  'display_image_url',
  'representative_variant_id',
  'representative_package_size_text',
  'representative_package_weight_g',
  'variant_count',
  'has_variants',
  'ingredient_declaration_count',
  'full_ingredient_declaration_count',
  'has_ingredient_details',
  'has_full_ingredient_declaration',
  'nutrition_panel_count',
  'has_nutrition_details',
  'manufacturing_observation_count',
  'has_manufacturing_details',
  'manufacturing_country_codes',
  'market_observation_count',
  'has_market_details',
  'assessed_market_country_codes',
  'current_market_country_codes',
  'formula_match_market_country_codes',
  'ingredient_term_result_count',
  'confirmed_present_ingredient_terms',
  'direct_evidence_ingredient_terms',
  'flavor_associated_ingredient_terms',
  'reviewed_not_found_ingredient_terms',
  'insufficient_evidence_ingredient_terms',
  'official_targets',
  'features',
  'recipe_families',
  'recipe_details',
  'official_recipe_traits',
].join(',')

const VARIANT_FIELDS = [
  'product_id',
  'variant_id',
  'package_size_text',
  'package_weight_g',
  'units_per_sale',
  'sale_total_weight_g',
  'sales_bundle_status',
  'display_rank',
  'variant_count',
  'formula_evidence_status',
  'recipe_families',
  'recipe_details',
  'official_recipe_traits',
  'ingredient_term_result_count',
  'confirmed_present_ingredient_terms',
  'direct_evidence_ingredient_terms',
  'flavor_associated_ingredient_terms',
  'reviewed_not_found_ingredient_terms',
  'insufficient_evidence_ingredient_terms',
].join(',')

const COMPARE_NUTRITION_FIELDS = [
  'product_id',
  'variant_id',
  'observation_scope',
  'market_code',
  'panel_type',
  'protein_pct',
  'protein_qualifier',
  'fat_pct',
  'fat_qualifier',
  'fiber_pct',
  'fiber_qualifier',
  'moisture_pct',
  'moisture_qualifier',
  'ash_pct',
  'ash_qualifier',
  'kcal_per_kg',
  'kcal_per_100g',
  'energy_basis',
  'is_korea_market_observation',
  'is_current_resolved_formula',
].join(',')

const COMPARE_INGREDIENT_FIELDS = [
  'product_id',
  'variant_id',
  'observation_scope',
  'market_code',
  'declaration_scope',
  'completeness_status',
  'raw_text',
  'ingredient_names',
  'ingredient_count',
  'is_korea_market_observation',
  'is_current_resolved_formula',
].join(',')

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeProduct(value: CatalogProduct): CatalogProduct {
  return {
    ...value,
    manufacturing_country_codes: asStringArray(value.manufacturing_country_codes),
    assessed_market_country_codes: asStringArray(value.assessed_market_country_codes),
    current_market_country_codes: asStringArray(value.current_market_country_codes),
    formula_match_market_country_codes: asStringArray(value.formula_match_market_country_codes),
    confirmed_present_ingredient_terms: asStringArray(value.confirmed_present_ingredient_terms),
    direct_evidence_ingredient_terms: asStringArray(value.direct_evidence_ingredient_terms),
    flavor_associated_ingredient_terms: asStringArray(value.flavor_associated_ingredient_terms),
    reviewed_not_found_ingredient_terms: asStringArray(value.reviewed_not_found_ingredient_terms),
    insufficient_evidence_ingredient_terms: asStringArray(value.insufficient_evidence_ingredient_terms),
    official_targets: asStringArray(value.official_targets),
    features: asStringArray(value.features),
    recipe_families: asStringArray(value.recipe_families),
    recipe_details: asStringArray(value.recipe_details),
    official_recipe_traits: asStringArray(value.official_recipe_traits),
  }
}

function normalizeVariant(value: ProductVariant): ProductVariant {
  return {
    ...value,
    recipe_families: asStringArray(value.recipe_families),
    recipe_details: asStringArray(value.recipe_details),
    official_recipe_traits: asStringArray(value.official_recipe_traits),
    confirmed_present_ingredient_terms: asStringArray(value.confirmed_present_ingredient_terms),
    direct_evidence_ingredient_terms: asStringArray(value.direct_evidence_ingredient_terms),
    flavor_associated_ingredient_terms: asStringArray(value.flavor_associated_ingredient_terms),
    reviewed_not_found_ingredient_terms: asStringArray(value.reviewed_not_found_ingredient_terms),
    insufficient_evidence_ingredient_terms: asStringArray(value.insufficient_evidence_ingredient_terms),
  }
}

function normalizeCompareIngredients(value: CompareIngredients): CompareIngredients {
  return {
    ...value,
    ingredient_names: asStringArray(value.ingredient_names),
  }
}

function apiConfig() {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

  if (!baseUrl || !publishableKey) {
    throw new Error(
      'Supabase 연결 정보가 없습니다. .env.local에 VITE_SUPABASE_URL과 VITE_SUPABASE_PUBLISHABLE_KEY를 설정하십시오.',
    )
  }

  return { baseUrl: baseUrl.replace(/\/$/, ''), publishableKey }
}

async function fetchCompareRows<T>(
  view: 'compare_product_nutrition' | 'compare_product_ingredients',
  fields: string,
  productIds: string[],
  signal?: AbortSignal,
): Promise<T[]> {
  if (productIds.length === 0) return []

  const { baseUrl, publishableKey } = apiConfig()
  const url = new URL(`${baseUrl}/rest/v1/${view}`)
  url.searchParams.set('select', fields)
  url.searchParams.set('product_id', `in.(${productIds.join(',')})`)
  url.searchParams.set('limit', '5')

  const response = await fetch(url, {
    signal,
    headers: {
      apikey: publishableKey,
      'Accept-Profile': 'api',
    },
  })

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240)
    throw new Error(`Compare API ${response.status}: ${detail || response.statusText}`)
  }

  return (await response.json()) as T[]
}

export async function fetchCatalog(signal?: AbortSignal): Promise<CatalogProduct[]> {
  const { baseUrl, publishableKey } = apiConfig()
  const url = new URL(`${baseUrl}/rest/v1/effective_product_catalog_summary`)
  url.searchParams.set('select', CATALOG_FIELDS)
  url.searchParams.set('order', 'brand.asc,canonical_name.asc')
  url.searchParams.set('limit', '1000')

  const response = await fetch(url, {
    signal,
    headers: {
      apikey: publishableKey,
      'Accept-Profile': 'api',
    },
  })

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240)
    throw new Error(`Catalog API ${response.status}: ${detail || response.statusText}`)
  }

  const data = (await response.json()) as CatalogProduct[]
  return data.map(normalizeProduct)
}

export async function fetchProductVariants(
  productId: string,
  signal?: AbortSignal,
): Promise<ProductVariant[]> {
  const { baseUrl, publishableKey } = apiConfig()
  const url = new URL(`${baseUrl}/rest/v1/switch_current_variant_options`)
  url.searchParams.set('select', VARIANT_FIELDS)
  url.searchParams.set('product_id', `eq.${productId}`)
  url.searchParams.set('order', 'display_rank.asc,variant_id.asc')

  const response = await fetch(url, {
    signal,
    headers: {
      apikey: publishableKey,
      'Accept-Profile': 'api',
    },
  })

  if (!response.ok) {
    if ([401, 403, 404].includes(response.status)) {
      throw new Error('현재 사용 규격 선택 API를 불러오지 못했습니다. 규격을 모름으로 두고 계속할 수 있습니다.')
    }
    const detail = (await response.text()).slice(0, 240)
    throw new Error(`Variant API ${response.status}: ${detail || response.statusText}`)
  }

  const data = (await response.json()) as ProductVariant[]
  return data.map(normalizeVariant)
}

export async function fetchCompareNutrition(
  productIds: string[],
  signal?: AbortSignal,
): Promise<CompareNutrition[]> {
  return fetchCompareRows<CompareNutrition>(
    'compare_product_nutrition',
    COMPARE_NUTRITION_FIELDS,
    productIds,
    signal,
  )
}

export async function fetchCompareIngredients(
  productIds: string[],
  signal?: AbortSignal,
): Promise<CompareIngredients[]> {
  const data = await fetchCompareRows<CompareIngredients>(
    'compare_product_ingredients',
    COMPARE_INGREDIENT_FIELDS,
    productIds,
    signal,
  )
  return data.map(normalizeCompareIngredients)
}
