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
  representative_units_per_sale?: number | null
  representative_sale_total_weight_g?: number | null
  available_package_labels?: string[]
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

interface CatalogPackageOption {
  product_id: string
  variant_id: string
  package_size_text: string | null
  package_weight_g: number | null
  units_per_sale: number | null
  sale_total_weight_g: number | null
  display_rank: number
}

export interface AdditionalNutrient {
  nutrient_key: string
  raw_name: string | null
  amount: number | null
  unit: string | null
  qualifier: string | null
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
  additional_nutrients?: AdditionalNutrient[]
  additional_nutrient_count?: number
  supplemental_nutrition_fields?: string[]
  supplemental_observation_scope?: string | null
  supplemental_market_code?: string | null
  supplemental_is_current_resolved_formula?: boolean
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

export interface ProductManufacturingDetail {
  product_id: string
  observation_scope: string
  country_code: string | null
  manufacturer: string | null
  plant: string | null
  is_current_resolved_formula: boolean
}

export interface ProductMarketDetail {
  product_id: string
  country_code: string
  distribution_status: string
  formula_correspondence_status: string
  counterpart_name: string | null
  assessed_at: string | null
  is_current_product_confirmed: boolean
  is_formula_match_confirmed: boolean
  display_rank: number
  country_observation_count: number
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
  'representative_units_per_sale',
  'representative_sale_total_weight_g',
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

const CATALOG_PACKAGE_FIELDS = [
  'product_id',
  'variant_id',
  'package_size_text',
  'package_weight_g',
  'units_per_sale',
  'sale_total_weight_g',
  'display_rank',
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
  'additional_nutrients',
  'additional_nutrient_count',
  'supplemental_nutrition_fields',
  'supplemental_observation_scope',
  'supplemental_market_code',
  'supplemental_is_current_resolved_formula',
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

const PRODUCT_MANUFACTURING_FIELDS = [
  'product_id',
  'observation_scope',
  'country_code',
  'manufacturer',
  'plant',
  'is_current_resolved_formula',
].join(',')

const PRODUCT_MARKET_FIELDS = [
  'product_id',
  'country_code',
  'distribution_status',
  'formula_correspondence_status',
  'counterpart_name',
  'assessed_at',
  'is_current_product_confirmed',
  'is_formula_match_confirmed',
  'display_rank',
  'country_observation_count',
].join(',')

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeProduct(value: CatalogProduct): CatalogProduct {
  return {
    ...value,
    available_package_labels: asStringArray(value.available_package_labels),
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

function normalizeCompareNutrition(value: CompareNutrition): CompareNutrition {
  return {
    ...value,
    supplemental_nutrition_fields: asStringArray(value.supplemental_nutrition_fields),
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

function requestHeaders(publishableKey: string) {
  return {
    apikey: publishableKey,
    'Accept-Profile': 'api',
  }
}

async function fetchRows<T>(
  view: string,
  fields: string,
  productFilter: string,
  signal?: AbortSignal,
  order?: string,
  limit = '20',
): Promise<T[]> {
  const { baseUrl, publishableKey } = apiConfig()
  const url = new URL(`${baseUrl}/rest/v1/${view}`)
  url.searchParams.set('select', fields)
  url.searchParams.set('product_id', productFilter)
  if (order) url.searchParams.set('order', order)
  url.searchParams.set('limit', limit)

  const response = await fetch(url, {
    signal,
    headers: requestHeaders(publishableKey),
  })

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240)
    throw new Error(`Data API ${response.status}: ${detail || response.statusText}`)
  }

  return (await response.json()) as T[]
}

async function fetchCompareRows<T>(
  view: 'compare_product_nutrition' | 'compare_product_ingredients',
  fields: string,
  productIds: string[],
  signal?: AbortSignal,
): Promise<T[]> {
  if (productIds.length === 0) return []
  return fetchRows<T>(view, fields, `in.(${productIds.join(',')})`, signal, undefined, '5')
}

function fallbackPackageLabel(product: CatalogProduct): string {
  const size = product.representative_package_size_text?.trim()
  if (!size) return '판매 규격 미확인'
  const units = product.representative_units_per_sale ?? null
  return units && units > 1 ? `${size} × ${units}` : size
}

function packageOptionLabel(option: CatalogPackageOption): string | null {
  const size = option.package_size_text?.trim()
    || (option.package_weight_g != null ? `${Number(option.package_weight_g).toLocaleString('ko-KR')} g` : null)
  if (!size) return null
  return option.units_per_sale && option.units_per_sale > 1
    ? `${size} × ${option.units_per_sale}`
    : size
}

function packageLabelsByProduct(rows: CatalogPackageOption[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const row of rows) {
    const label = packageOptionLabel(row)
    if (!label) continue
    const current = result.get(row.product_id) ?? []
    if (!current.includes(label)) current.push(label)
    result.set(row.product_id, current)
  }
  return result
}

export function productPackageOptionsLabel(product: CatalogProduct): string {
  return product.available_package_labels?.length
    ? product.available_package_labels.join(' · ')
    : fallbackPackageLabel(product)
}

async function fetchCatalogPackageOptions(signal?: AbortSignal): Promise<CatalogPackageOption[]> {
  const { baseUrl, publishableKey } = apiConfig()
  const url = new URL(`${baseUrl}/rest/v1/switch_current_variant_options`)
  url.searchParams.set('select', CATALOG_PACKAGE_FIELDS)
  url.searchParams.set('order', 'product_id.asc,display_rank.asc,variant_id.asc')
  // The public API caps each response at 1,000 rows, even with a larger limit.
  const pageSize = 1000
  url.searchParams.set('limit', String(pageSize))
  const rows: CatalogPackageOption[] = []
  for (let offset = 0; ; offset += pageSize) {
    url.searchParams.set('offset', String(offset))
    const response = await fetch(url, {
      signal,
      headers: requestHeaders(publishableKey),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240)
      throw new Error(`Package API ${response.status}: ${detail || response.statusText}`)
    }
    const page = (await response.json()) as CatalogPackageOption[]
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

export async function fetchCatalog(signal?: AbortSignal): Promise<CatalogProduct[]> {
  const { baseUrl, publishableKey } = apiConfig()
  const url = new URL(`${baseUrl}/rest/v1/effective_product_catalog_summary`)
  url.searchParams.set('select', CATALOG_FIELDS)
  url.searchParams.set('order', 'brand.asc,canonical_name.asc')
  url.searchParams.set('limit', '1000')

  const response = await fetch(url, {
    signal,
    headers: requestHeaders(publishableKey),
  })

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240)
    throw new Error(`Catalog API ${response.status}: ${detail || response.statusText}`)
  }

  const rawProducts = (await response.json()) as CatalogProduct[]
  let packageRows: CatalogPackageOption[] = []
  try {
    packageRows = await fetchCatalogPackageOptions(signal)
  } catch (reason: unknown) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason
  }
  const packages = packageLabelsByProduct(packageRows)

  return rawProducts.map((value) => normalizeProduct({
    ...value,
    available_package_labels: packages.get(value.product_id) ?? [],
  }))
}

export async function fetchProductVariants(
  productId: string,
  signal?: AbortSignal,
): Promise<ProductVariant[]> {
  const data = await fetchRows<ProductVariant>(
    'switch_current_variant_options',
    VARIANT_FIELDS,
    `eq.${productId}`,
    signal,
    'display_rank.asc,variant_id.asc',
    '100',
  )
  return data.map(normalizeVariant)
}

export async function fetchCompareNutrition(
  productIds: string[],
  signal?: AbortSignal,
): Promise<CompareNutrition[]> {
  const data = await fetchCompareRows<CompareNutrition>(
    'compare_product_nutrition',
    COMPARE_NUTRITION_FIELDS,
    productIds,
    signal,
  )
  return data.map(normalizeCompareNutrition)
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

export async function fetchProductManufacturing(
  productId: string,
  signal?: AbortSignal,
): Promise<ProductManufacturingDetail | null> {
  const rows = await fetchRows<ProductManufacturingDetail>(
    'product_detail_manufacturing',
    PRODUCT_MANUFACTURING_FIELDS,
    `eq.${productId}`,
    signal,
    undefined,
    '1',
  )
  return rows[0] ?? null
}

export async function fetchProductMarkets(
  productId: string,
  signal?: AbortSignal,
): Promise<ProductMarketDetail[]> {
  return fetchRows<ProductMarketDetail>(
    'product_detail_markets',
    PRODUCT_MARKET_FIELDS,
    `eq.${productId}`,
    signal,
    'display_rank.asc,country_code.asc',
    '50',
  )
}
