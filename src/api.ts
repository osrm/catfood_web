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
  official_targets: string[]
  features: string[]
  recipe_families: string[]
  recipe_details: string[]
  official_recipe_traits: string[]
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
  'official_targets',
  'features',
  'recipe_families',
  'recipe_details',
  'official_recipe_traits',
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
    official_targets: asStringArray(value.official_targets),
    features: asStringArray(value.features),
    recipe_families: asStringArray(value.recipe_families),
    recipe_details: asStringArray(value.recipe_details),
    official_recipe_traits: asStringArray(value.official_recipe_traits),
  }
}

export async function fetchCatalog(signal?: AbortSignal): Promise<CatalogProduct[]> {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

  if (!baseUrl || !publishableKey) {
    throw new Error(
      'Supabase 연결 정보가 없습니다. .env.local에 VITE_SUPABASE_URL과 VITE_SUPABASE_PUBLISHABLE_KEY를 설정하십시오.',
    )
  }

  const url = new URL(
    `${baseUrl.replace(/\/$/, '')}/rest/v1/effective_product_catalog_summary`,
  )
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
