import type {
  CatalogProduct,
  CompareIngredients,
  CompareNutrition,
  ProductManufacturingDetail,
  ProductMarketDetail,
  ProductVariant,
} from './api'

function packageArt(brand: string, name: string, primary: string, accent: string, mark: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="340" viewBox="0 0 260 340">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${primary}"/>
        <stop offset="1" stop-color="${accent}"/>
      </linearGradient>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#0b2c25" flood-opacity="0.16"/>
      </filter>
    </defs>
    <rect width="260" height="340" fill="none"/>
    <path d="M50 34h160l13 35v222c0 10-8 18-18 18H55c-10 0-18-8-18-18V69z" fill="url(#bg)" filter="url(#shadow)"/>
    <path d="M50 34h160l8 22H42z" fill="#ffffff" fill-opacity="0.72"/>
    <rect x="57" y="84" width="146" height="130" rx="12" fill="#ffffff" fill-opacity="0.94"/>
    <circle cx="130" cy="145" r="39" fill="${primary}" fill-opacity="0.12"/>
    <text x="130" y="154" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="${primary}">${mark}</text>
    <text x="130" y="105" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="700" letter-spacing="1.3" fill="#20302b">${brand}</text>
    <text x="130" y="239" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#ffffff">${name}</text>
    <text x="130" y="260" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" fill="#ffffff" fill-opacity="0.78">DEMO FORMULA</text>
    <rect x="75" y="276" width="110" height="2" rx="1" fill="#ffffff" fill-opacity="0.35"/>
  </svg>`
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

type DemoProductSeed = {
  id: string
  brand: string
  name: string
  feedType: string
  lifeStage: string
  size: string
  weight: number
  targets: string[]
  features: string[]
  families: string[]
  details: string[]
  traits?: string[]
  confirmed: string[]
  reviewedNotFound?: string[]
  insufficient?: string[]
  countries: string[]
  markets: string[]
  formulaMarkets?: string[]
  colors: [string, string, string]
}

const SEEDS: DemoProductSeed[] = [
  {
    id: 'demo-01', brand: 'ALDER & FINCH', name: '인도어 치킨 & 오트', feedType: '건식', lifeStage: 'adult', size: '1.8kg', weight: 1800,
    targets: ['indoor'], features: ['hairball', 'digestive'], families: ['poultry'], details: ['chicken'],
    confirmed: ['chicken', 'egg'], reviewedNotFound: ['salmon'], insufficient: ['duck'], countries: ['CA'], markets: ['KR', 'CA'], formulaMarkets: ['CA'], colors: ['#173f36', '#b5905e', 'AF'],
  },
  {
    id: 'demo-02', brand: 'FELINE FORM', name: '살몬 센서티브 레시피', feedType: '건식', lifeStage: 'adult', size: '2kg', weight: 2000,
    targets: ['indoor'], features: ['digestive', 'skin_coat'], families: ['fish'], details: ['salmon', 'herring'], traits: ['grain_free'],
    confirmed: ['salmon', 'herring', 'egg'], reviewedNotFound: ['chicken'], countries: ['US'], markets: ['KR', 'US', 'JP'], formulaMarkets: ['US'], colors: ['#26485b', '#d9a15f', 'FF'],
  },
  {
    id: 'demo-03', brand: 'ATELIER NO.7', name: '터키 & 덕 스테럴라이즈드', feedType: '건식', lifeStage: 'adult', size: '1.5kg', weight: 1500,
    targets: ['sterilized'], features: ['weight_management', 'urinary'], families: ['poultry'], details: ['turkey', 'duck'], traits: ['grain_free'],
    confirmed: ['turkey', 'duck'], reviewedNotFound: ['beef'], insufficient: ['chicken'], countries: ['DE'], markets: ['KR', 'DE'], formulaMarkets: ['DE'], colors: ['#3e382f', '#b9a988', 'N7'],
  },
  {
    id: 'demo-04', brand: 'FIELDNOTE', name: '래빗 싱글 프로틴', feedType: '건식', lifeStage: 'adult', size: '1.2kg', weight: 1200,
    targets: [], features: ['digestive'], families: ['meat'], details: ['rabbit'], traits: ['grain_free'],
    confirmed: ['rabbit'], reviewedNotFound: ['chicken', 'fish'], countries: ['NZ'], markets: ['KR', 'NZ'], formulaMarkets: ['NZ'], colors: ['#584330', '#c9a86d', 'FN'],
  },
  {
    id: 'demo-05', brand: 'COAST & FIELD', name: '튜나 & 사딘 브로스', feedType: '습식', lifeStage: 'all_life_stages', size: '85g', weight: 85,
    targets: [], features: [], families: ['fish'], details: ['tuna'],
    confirmed: ['tuna', 'sardine'], reviewedNotFound: ['chicken'], countries: ['TH'], markets: ['KR', 'TH', 'JP'], formulaMarkets: ['TH'], colors: ['#20596a', '#84b7b6', 'CF'],
  },
  {
    id: 'demo-06', brand: 'VERDANT CAT CO.', name: '램 & 펌킨 밸런스', feedType: '습식', lifeStage: 'adult', size: '100g', weight: 100,
    targets: ['indoor'], features: ['digestive'], families: ['meat'], details: ['lamb'],
    confirmed: ['lamb'], insufficient: ['chicken', 'fish'], countries: ['NZ'], markets: ['KR', 'NZ'], formulaMarkets: [], colors: ['#395340', '#c89357', 'VC'],
  },
  {
    id: 'demo-07', brand: 'MORROW NUTRITION', name: '키튼 치킨 & 에그', feedType: '건식', lifeStage: 'kitten', size: '1.3kg', weight: 1300,
    targets: [], features: [], families: ['poultry'], details: ['chicken'],
    confirmed: ['chicken', 'egg'], countries: ['US'], markets: ['KR', 'US'], formulaMarkets: ['US'], colors: ['#634739', '#e0b56d', 'MN'],
  },
  {
    id: 'demo-08', brand: 'NORTHSTAR FELINE', name: '시니어 화이트피시 케어', feedType: '건식', lifeStage: 'senior', size: '1.6kg', weight: 1600,
    targets: ['indoor'], features: ['urinary', 'skin_coat'], families: ['fish'], details: ['cod', 'salmon'],
    confirmed: ['cod', 'salmon'], reviewedNotFound: ['beef'], countries: ['CA'], markets: ['KR', 'CA'], formulaMarkets: ['CA'], colors: ['#24394b', '#9da9aa', 'NF'],
  },
  {
    id: 'demo-09', brand: 'PLAIN & WELL', name: '비프 & 오트 어덜트', feedType: '건식', lifeStage: 'adult', size: '2.2kg', weight: 2200,
    targets: [], features: ['dental'], families: ['meat'], details: ['beef'],
    confirmed: ['beef'], reviewedNotFound: ['fish'], insufficient: ['chicken'], countries: ['US'], markets: ['KR', 'US'], formulaMarkets: ['US'], colors: ['#5b3030', '#b67c65', 'PW'],
  },
  {
    id: 'demo-10', brand: 'QUIET TABLE', name: '덕 & 트라우트 데일리', feedType: '건식', lifeStage: 'adult', size: '1.7kg', weight: 1700,
    targets: ['sterilized', 'indoor'], features: ['weight_management'], families: ['poultry', 'fish'], details: ['duck', 'trout'],
    confirmed: ['duck', 'trout'], insufficient: ['chicken'], countries: ['FR'], markets: ['KR', 'FR'], formulaMarkets: [], colors: ['#314d4a', '#a87e64', 'QT'],
  },
]

function toProduct(seed: DemoProductSeed): CatalogProduct {
  return {
    product_id: seed.id,
    brand: seed.brand,
    canonical_name: seed.name,
    feed_type: seed.feedType,
    life_stage: seed.lifeStage,
    display_image_url: packageArt(seed.brand, seed.name, seed.colors[0], seed.colors[1], seed.colors[2]),
    representative_variant_id: `${seed.id}-v1`,
    representative_package_size_text: seed.size,
    representative_package_weight_g: seed.weight,
    variant_count: seed.feedType === '습식' ? 2 : 3,
    has_variants: true,
    ingredient_declaration_count: 1,
    full_ingredient_declaration_count: 1,
    has_ingredient_details: true,
    has_full_ingredient_declaration: true,
    nutrition_panel_count: 1,
    has_nutrition_details: true,
    manufacturing_observation_count: 1,
    has_manufacturing_details: true,
    manufacturing_country_codes: seed.countries,
    market_observation_count: seed.markets.length,
    has_market_details: true,
    assessed_market_country_codes: seed.markets,
    current_market_country_codes: seed.markets,
    formula_match_market_country_codes: seed.formulaMarkets ?? [],
    ingredient_term_result_count: seed.confirmed.length + (seed.reviewedNotFound?.length ?? 0) + (seed.insufficient?.length ?? 0),
    confirmed_present_ingredient_terms: seed.confirmed,
    direct_evidence_ingredient_terms: seed.confirmed,
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: seed.reviewedNotFound ?? [],
    insufficient_evidence_ingredient_terms: seed.insufficient ?? [],
    official_targets: seed.targets,
    features: seed.features,
    recipe_families: seed.families,
    recipe_details: seed.details,
    official_recipe_traits: seed.traits ?? [],
  }
}

export const DEMO_PRODUCTS: CatalogProduct[] = SEEDS.map(toProduct)

export const DEMO_VARIANTS: ProductVariant[] = SEEDS.flatMap((seed) => {
  const count = seed.feedType === '습식' ? 2 : 3
  const weights = seed.feedType === '습식'
    ? [seed.weight, seed.weight * 6]
    : [seed.weight, Math.round(seed.weight * 0.55), Math.round(seed.weight * 2.2)]

  return Array.from({ length: count }, (_, index) => ({
    product_id: seed.id,
    variant_id: `${seed.id}-v${index + 1}`,
    package_size_text: seed.feedType === '습식'
      ? index === 0 ? seed.size : `${seed.size} × 6`
      : index === 0 ? seed.size : index === 1 ? `${Math.round(weights[index] / 100) / 10}kg` : `${Math.round(weights[index] / 100) / 10}kg`,
    package_weight_g: weights[index],
    units_per_sale: seed.feedType === '습식' && index === 1 ? 6 : 1,
    sale_total_weight_g: weights[index],
    sales_bundle_status: seed.feedType === '습식' && index === 1 ? 'bundle' : 'single',
    display_rank: index + 1,
    variant_count: count,
    formula_evidence_status: seed.id === 'demo-06' && index === 1 ? 'unresolved' : 'confirmed',
    recipe_families: seed.families,
    recipe_details: seed.details,
    official_recipe_traits: seed.traits ?? [],
    ingredient_term_result_count: seed.confirmed.length + (seed.reviewedNotFound?.length ?? 0) + (seed.insufficient?.length ?? 0),
    confirmed_present_ingredient_terms: seed.confirmed,
    direct_evidence_ingredient_terms: seed.confirmed,
    flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: seed.reviewedNotFound ?? [],
    insufficient_evidence_ingredient_terms: seed.insufficient ?? [],
  }))
})

const NUTRITION = [
  [38, 15, 5.2, 8.5, 7.8, 3650], [36, 17, 4.2, 9, 8.2, 3780], [40, 12, 6.1, 8, 7.5, 3480], [42, 14, 4, 8.5, 7, 3720],
  [11, 4.5, 0.8, 80, 2.1, 1020], [10.5, 5.5, 1.2, 78, 2.4, 1100], [40, 20, 3.1, 8, 7.2, 4050], [34, 13, 4.8, 9, 7.9, 3520],
  [35, 14, 5, 9, 8, 3600], [37, 13, 4.4, 8.5, 7.6, 3580],
] as const

export const DEMO_NUTRITION: CompareNutrition[] = SEEDS.map((seed, index) => {
  const [protein, fat, fiber, moisture, ash, kcal] = NUTRITION[index]
  return {
    product_id: seed.id,
    variant_id: `${seed.id}-v1`,
    observation_scope: 'variant',
    market_code: 'KR',
    panel_type: 'guaranteed_analysis',
    protein_pct: protein,
    protein_qualifier: 'min',
    fat_pct: fat,
    fat_qualifier: 'min',
    fiber_pct: fiber,
    fiber_qualifier: 'max',
    moisture_pct: moisture,
    moisture_qualifier: 'max',
    ash_pct: ash,
    ash_qualifier: null,
    kcal_per_kg: kcal,
    kcal_per_100g: Math.round(kcal / 10),
    energy_basis: 'metabolizable_energy',
    is_korea_market_observation: true,
    is_current_resolved_formula: true,
  }
})

function ingredientNames(seed: DemoProductSeed): string[] {
  const base: Record<string, string> = {
    chicken: '닭고기', egg: '계란', salmon: '연어', herring: '청어', turkey: '칠면조', duck: '오리', rabbit: '토끼',
    tuna: '참치', sardine: '정어리', lamb: '양고기', cod: '대구', beef: '소고기', trout: '송어', fish: '생선',
  }
  return [...seed.confirmed.map((value) => base[value] ?? value), seed.feedType === '습식' ? '정제수' : '현미', '완두콩', '비타민 및 미네랄']
}

export const DEMO_INGREDIENTS: CompareIngredients[] = SEEDS.map((seed) => {
  const names = ingredientNames(seed)
  return {
    product_id: seed.id,
    variant_id: `${seed.id}-v1`,
    observation_scope: 'variant',
    market_code: 'KR',
    declaration_scope: 'full',
    completeness_status: 'complete',
    raw_text: names.join(', '),
    ingredient_names: names,
    ingredient_count: names.length,
    is_korea_market_observation: true,
    is_current_resolved_formula: true,
  }
})

export const DEMO_MANUFACTURING: ProductManufacturingDetail[] = SEEDS.map((seed) => ({
  product_id: seed.id,
  observation_scope: 'product',
  country_code: seed.countries[0] ?? null,
  manufacturer: `${seed.brand} Nutrition Works`,
  plant: seed.countries[0] ? `${seed.countries[0]} Demo Plant` : null,
  is_current_resolved_formula: true,
}))

export const DEMO_MARKETS: ProductMarketDetail[] = SEEDS.flatMap((seed) => seed.markets.map((country, index) => ({
  product_id: seed.id,
  country_code: country,
  distribution_status: country === 'KR' ? 'current' : 'observed',
  formula_correspondence_status: (seed.formulaMarkets ?? []).includes(country) ? 'exact_same' : country === 'KR' ? 'reference' : 'uncertain',
  counterpart_name: country === 'KR' ? seed.name : `${seed.name} · ${country}`,
  assessed_at: '2026-09-01',
  is_current_product_confirmed: country === 'KR',
  is_formula_match_confirmed: (seed.formulaMarkets ?? []).includes(country),
  display_rank: index + 1,
  country_observation_count: 1,
})))
