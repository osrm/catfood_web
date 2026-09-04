import type {
  CatalogProduct,
  CompareIngredients,
  CompareNutrition,
  ProductManufacturingDetail,
  ProductMarketDetail,
  ProductVariant,
} from './api'

export function isStressPreview(): boolean {
  return new URLSearchParams(window.location.search).get('stresspreview') === '1'
}

const ALL_TERMS = [
  'anchovy', 'beef', 'boar', 'chicken', 'cod', 'duck', 'egg', 'goat', 'goose', 'herring', 'lamb', 'mackerel',
  'menhaden', 'pork', 'quail', 'rabbit', 'salmon', 'sardine', 'trout', 'tuna', 'turkey', 'venison', 'whitefish',
]

const STRESS_PRODUCTS: CatalogProduct[] = [
  {
    product_id: 'product_22531a6bb7f865e5', brand: '로얄캐닌', canonical_name: '인도어', feed_type: '건식', life_stage: 'adult', display_image_url: null,
    representative_variant_id: 'variant_d8ff1c5b42fb59aa', representative_package_size_text: '50 g', representative_package_weight_g: 50,
    variant_count: 6, has_variants: true, ingredient_declaration_count: 1, full_ingredient_declaration_count: 1, has_ingredient_details: true,
    has_full_ingredient_declaration: true, nutrition_panel_count: 2, has_nutrition_details: true, manufacturing_observation_count: 0,
    has_manufacturing_details: false, manufacturing_country_codes: [], market_observation_count: 0, has_market_details: false,
    assessed_market_country_codes: [], current_market_country_codes: [], formula_match_market_country_codes: [], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: ALL_TERMS, official_targets: ['indoor'], features: ['hairball', 'stool', 'weight_management'],
    recipe_families: [], recipe_details: [], official_recipe_traits: [],
  },
  {
    product_id: 'product_71d80e22240d1f3c', brand: 'Wellness', canonical_name: 'CORE Signature Selects Pate Kitten Chicken & Turkey Entree', feed_type: '습식', life_stage: 'kitten', display_image_url: null,
    representative_variant_id: 'variant_32e508efd8d0f39b', representative_package_size_text: '79 g', representative_package_weight_g: 79,
    variant_count: 2, has_variants: true, ingredient_declaration_count: 3, full_ingredient_declaration_count: 2, has_ingredient_details: true,
    has_full_ingredient_declaration: true, nutrition_panel_count: 4, has_nutrition_details: true, manufacturing_observation_count: 1,
    has_manufacturing_details: true, manufacturing_country_codes: ['TH'], market_observation_count: 6, has_market_details: true,
    assessed_market_country_codes: ['AU', 'CA', 'GB', 'NL', 'NZ', 'US'], current_market_country_codes: ['AU'], formula_match_market_country_codes: ['AU'], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: ['chicken', 'tuna', 'turkey'], direct_evidence_ingredient_terms: ['chicken', 'tuna', 'turkey'], flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: ['anchovy', 'beef', 'boar', 'cod', 'duck', 'egg', 'goat', 'goose', 'herring', 'lamb', 'mackerel', 'menhaden', 'pork', 'quail', 'rabbit', 'salmon', 'sardine', 'trout', 'venison', 'whitefish'],
    insufficient_evidence_ingredient_terms: [], official_targets: [], features: [], recipe_families: ['poultry'], recipe_details: ['chicken', 'turkey'], official_recipe_traits: [],
  },
  {
    product_id: 'product_48bac9edbe72c6df', brand: 'Almo Nature', canonical_name: 'HFC Our Adult Sterilised Fresh Cod', feed_type: '건식', life_stage: 'adult', display_image_url: null,
    representative_variant_id: 'variant_8682e4c44eee4f9a', representative_package_size_text: '300 g', representative_package_weight_g: 300,
    variant_count: 2, has_variants: true, ingredient_declaration_count: 2, full_ingredient_declaration_count: 1, has_ingredient_details: true,
    has_full_ingredient_declaration: true, nutrition_panel_count: 2, has_nutrition_details: true, manufacturing_observation_count: 0,
    has_manufacturing_details: false, manufacturing_country_codes: [], market_observation_count: 0, has_market_details: false,
    assessed_market_country_codes: [], current_market_country_codes: [], formula_match_market_country_codes: [], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: ALL_TERMS, official_targets: ['sterilized'], features: [], recipe_families: [], recipe_details: [], official_recipe_traits: [],
  },
  {
    product_id: 'product_ee2315cca61e0def', brand: '파미나', canonical_name: 'N&D 엔세스트럴 Cat 닭고기와 석류', feed_type: '건식', life_stage: 'adult', display_image_url: null,
    representative_variant_id: 'variant_c1cd6913d659ec48', representative_package_size_text: '50 g', representative_package_weight_g: 50,
    variant_count: 4, has_variants: true, ingredient_declaration_count: 1, full_ingredient_declaration_count: 1, has_ingredient_details: true,
    has_full_ingredient_declaration: true, nutrition_panel_count: 1, has_nutrition_details: true, manufacturing_observation_count: 0,
    has_manufacturing_details: false, manufacturing_country_codes: [], market_observation_count: 0, has_market_details: false,
    assessed_market_country_codes: [], current_market_country_codes: [], formula_match_market_country_codes: [], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: ALL_TERMS, official_targets: [], features: [], recipe_families: [], recipe_details: [], official_recipe_traits: [],
  },
  {
    product_id: 'product_5c03d226266089e9', brand: "Stella & Chewy's", canonical_name: 'Chicken & Tuna', feed_type: '습식', life_stage: null, display_image_url: null,
    representative_variant_id: 'variant_a0b5d25b2ebd3c07', representative_package_size_text: '79 g', representative_package_weight_g: 79,
    variant_count: 1, has_variants: true, ingredient_declaration_count: 1, full_ingredient_declaration_count: 1, has_ingredient_details: true,
    has_full_ingredient_declaration: true, nutrition_panel_count: 1, has_nutrition_details: true, manufacturing_observation_count: 0,
    has_manufacturing_details: false, manufacturing_country_codes: [], market_observation_count: 0, has_market_details: false,
    assessed_market_country_codes: [], current_market_country_codes: [], formula_match_market_country_codes: [], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: ALL_TERMS, official_targets: [], features: [], recipe_families: [], recipe_details: [], official_recipe_traits: [],
  },
  {
    product_id: 'product_363478f1f6965ace', brand: 'RAWZ', canonical_name: '밀프리 하이프로틴 Cat 사료 - 연어,디하이드레이티드치킨&흰살생선 레시피', feed_type: '건식', life_stage: 'all_life_stages', display_image_url: null,
    representative_variant_id: 'variant_4446e2c20b0d3615', representative_package_size_text: '794 g', representative_package_weight_g: 794,
    variant_count: 3, has_variants: true, ingredient_declaration_count: 1, full_ingredient_declaration_count: 1, has_ingredient_details: true,
    has_full_ingredient_declaration: true, nutrition_panel_count: 2, has_nutrition_details: true, manufacturing_observation_count: 0,
    has_manufacturing_details: false, manufacturing_country_codes: [], market_observation_count: 0, has_market_details: false,
    assessed_market_country_codes: [], current_market_country_codes: [], formula_match_market_country_codes: [], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: ALL_TERMS, official_targets: [], features: [], recipe_families: [], recipe_details: [], official_recipe_traits: [],
  },
  {
    product_id: 'product_92e22ecf2acae77e', brand: 'Instinct', canonical_name: 'Raw Boost Indoor Health Real Chicken Recipe', feed_type: '건식', life_stage: 'adult', display_image_url: null,
    representative_variant_id: 'variant_2a3cc7a67e5e0af9', representative_package_size_text: '2.2 kg', representative_package_weight_g: 2200,
    variant_count: 1, has_variants: true, ingredient_declaration_count: 2, full_ingredient_declaration_count: 1, has_ingredient_details: true,
    has_full_ingredient_declaration: true, nutrition_panel_count: 2, has_nutrition_details: true, manufacturing_observation_count: 0,
    has_manufacturing_details: false, manufacturing_country_codes: [], market_observation_count: 0, has_market_details: false,
    assessed_market_country_codes: [], current_market_country_codes: [], formula_match_market_country_codes: [], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: ['chicken', 'menhaden', 'salmon'], direct_evidence_ingredient_terms: ['chicken', 'menhaden', 'salmon'], flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: ['anchovy', 'beef', 'boar', 'cod', 'duck', 'egg', 'goat', 'goose', 'herring', 'lamb', 'mackerel', 'pork', 'quail', 'rabbit', 'sardine', 'trout', 'tuna', 'turkey', 'venison', 'whitefish'],
    insufficient_evidence_ingredient_terms: [], official_targets: ['indoor'], features: ['digestive', 'skin_coat', 'stool'], recipe_families: ['poultry'], recipe_details: ['chicken'], official_recipe_traits: ['grain_free'],
  },
  {
    product_id: 'product_51d58b8551f1e081', brand: 'Instinct', canonical_name: 'Raw Longevity Freeze-Dried Raw Meal Chicken Recipe', feed_type: '동결건조', life_stage: null, display_image_url: null,
    representative_variant_id: 'variant_6e298cf05d2a1484', representative_package_size_text: '269 g', representative_package_weight_g: 269,
    variant_count: 1, has_variants: true, ingredient_declaration_count: 1, full_ingredient_declaration_count: 0, has_ingredient_details: true,
    has_full_ingredient_declaration: false, nutrition_panel_count: 1, has_nutrition_details: true, manufacturing_observation_count: 0,
    has_manufacturing_details: false, manufacturing_country_codes: [], market_observation_count: 0, has_market_details: false,
    assessed_market_country_codes: [], current_market_country_codes: [], formula_match_market_country_codes: [], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [], reviewed_not_found_ingredient_terms: [],
    insufficient_evidence_ingredient_terms: ALL_TERMS, official_targets: [], features: [], recipe_families: [], recipe_details: [], official_recipe_traits: [],
  },
]

function variant(product_id: string, variant_id: string, package_size_text: string, package_weight_g: number, display_rank: number, variant_count: number, formula_evidence_status: ProductVariant['formula_evidence_status'], extra: Partial<ProductVariant> = {}): ProductVariant {
  return {
    product_id, variant_id, package_size_text, package_weight_g, units_per_sale: 1, sale_total_weight_g: package_weight_g,
    sales_bundle_status: 'not_a_bundle', display_rank, variant_count, formula_evidence_status,
    recipe_families: [], recipe_details: [], official_recipe_traits: [], ingredient_term_result_count: 23,
    confirmed_present_ingredient_terms: [], direct_evidence_ingredient_terms: [], flavor_associated_ingredient_terms: [],
    reviewed_not_found_ingredient_terms: [], insufficient_evidence_ingredient_terms: ALL_TERMS,
    ...extra,
  }
}

const STRESS_VARIANTS: ProductVariant[] = [
  variant('product_22531a6bb7f865e5', 'variant_d8ff1c5b42fb59aa', '50 g', 50, 1, 6, 'confirmed'),
  variant('product_22531a6bb7f865e5', 'variant_78054445d0fb87b3', '400 g', 400, 2, 6, 'confirmed'),
  variant('product_22531a6bb7f865e5', 'variant_ae09265c50bba12d', '1.2 kg', 1200, 3, 6, 'confirmed'),
  variant('product_22531a6bb7f865e5', 'variant_a3de51d0d4e797f4', '2 kg', 2000, 4, 6, 'confirmed'),
  variant('product_22531a6bb7f865e5', 'variant_c37a72f46461b813', '4 kg', 4000, 5, 6, 'confirmed'),
  variant('product_22531a6bb7f865e5', 'variant_2b9b4078126cb613', '10 kg', 10000, 6, 6, 'confirmed'),
  variant('product_71d80e22240d1f3c', 'variant_32e508efd8d0f39b', '79 g', 79, 1, 2, 'confirmed', { recipe_families: ['poultry'], recipe_details: ['chicken', 'turkey'], confirmed_present_ingredient_terms: ['chicken', 'tuna', 'turkey'], direct_evidence_ingredient_terms: ['chicken', 'tuna', 'turkey'], reviewed_not_found_ingredient_terms: ['anchovy', 'beef', 'boar', 'cod', 'duck', 'egg', 'goat', 'goose', 'herring', 'lamb', 'mackerel', 'menhaden', 'pork', 'quail', 'rabbit', 'salmon', 'sardine', 'trout', 'venison', 'whitefish'], insufficient_evidence_ingredient_terms: [] }),
  variant('product_71d80e22240d1f3c', 'variant_c8f76bfcca81f596', '150 g', 150, 2, 2, 'confirmed', { recipe_families: ['poultry'], recipe_details: ['chicken', 'turkey'], confirmed_present_ingredient_terms: ['chicken', 'tuna', 'turkey'], direct_evidence_ingredient_terms: ['chicken', 'tuna', 'turkey'], reviewed_not_found_ingredient_terms: ['anchovy', 'beef', 'boar', 'cod', 'duck', 'egg', 'goat', 'goose', 'herring', 'lamb', 'mackerel', 'menhaden', 'pork', 'quail', 'rabbit', 'salmon', 'sardine', 'trout', 'venison', 'whitefish'], insufficient_evidence_ingredient_terms: [] }),
  variant('product_48bac9edbe72c6df', 'variant_8682e4c44eee4f9a', '300 g', 300, 1, 2, 'unresolved'),
  variant('product_48bac9edbe72c6df', 'variant_a6ae8b369ecb82cf', '1.2 kg', 1200, 2, 2, 'unresolved'),
  variant('product_ee2315cca61e0def', 'variant_c1cd6913d659ec48', '50 g', 50, 1, 4, 'not_observed'),
  variant('product_ee2315cca61e0def', 'variant_498c346875495334', '1.5 kg', 1500, 2, 4, 'not_observed'),
  variant('product_ee2315cca61e0def', 'variant_80d2039fc2c66c88', '5 kg', 5000, 3, 4, 'not_observed'),
  variant('product_ee2315cca61e0def', 'variant_a3df429d33fc0eb8', '10 kg', 10000, 4, 4, 'not_observed'),
  variant('product_5c03d226266089e9', 'variant_a0b5d25b2ebd3c07', '79 g', 79, 1, 1, 'unresolved', { confirmed_present_ingredient_terms: ['chicken', 'tuna'], direct_evidence_ingredient_terms: ['chicken', 'tuna'], flavor_associated_ingredient_terms: ['chicken'], reviewed_not_found_ingredient_terms: ['anchovy', 'beef', 'boar', 'cod', 'duck', 'egg', 'goat', 'goose', 'herring', 'lamb', 'mackerel', 'menhaden', 'pork', 'quail', 'rabbit', 'salmon', 'sardine', 'trout', 'turkey', 'venison', 'whitefish'], insufficient_evidence_ingredient_terms: [] }),
  variant('product_363478f1f6965ace', 'variant_4446e2c20b0d3615', '794 g', 794, 1, 3, 'not_observed'),
  variant('product_363478f1f6965ace', 'variant_b7cb233e2f49cca5', '1.59 kg', 1590, 2, 3, 'not_observed'),
  variant('product_363478f1f6965ace', 'variant_0c2d052b97d0c28c', '3.53 kg', 3530, 3, 3, 'not_observed'),
  variant('product_92e22ecf2acae77e', 'variant_2a3cc7a67e5e0af9', '2.2 kg', 2200, 1, 1, 'confirmed', { recipe_families: ['poultry'], recipe_details: ['chicken'], official_recipe_traits: ['grain_free'], confirmed_present_ingredient_terms: ['chicken', 'menhaden', 'salmon'], direct_evidence_ingredient_terms: ['chicken', 'menhaden', 'salmon'], reviewed_not_found_ingredient_terms: ['anchovy', 'beef', 'boar', 'cod', 'duck', 'egg', 'goat', 'goose', 'herring', 'lamb', 'mackerel', 'pork', 'quail', 'rabbit', 'sardine', 'trout', 'tuna', 'turkey', 'venison', 'whitefish'], insufficient_evidence_ingredient_terms: [] }),
  variant('product_51d58b8551f1e081', 'variant_6e298cf05d2a1484', '269 g', 269, 1, 1, 'not_observed'),
]

const STRESS_NUTRITION: CompareNutrition[] = [
  { product_id: 'product_22531a6bb7f865e5', variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'source_declaration', protein_pct: null, protein_qualifier: null, fat_pct: null, fat_qualifier: null, fiber_pct: null, fiber_qualifier: null, moisture_pct: null, moisture_qualifier: null, ash_pct: null, ash_qualifier: null, kcal_per_kg: null, kcal_per_100g: null, energy_basis: null, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_71d80e22240d1f3c', variant_id: 'variant_32e508efd8d0f39b', observation_scope: 'variant', market_code: 'KR', panel_type: 'source_declaration', protein_pct: 9.5, protein_qualifier: 'min', fat_pct: 8, fat_qualifier: 'min', fiber_pct: 1, fiber_qualifier: 'max', moisture_pct: 78, moisture_qualifier: 'max', ash_pct: 3, ash_qualifier: 'max', kcal_per_kg: null, kcal_per_100g: null, energy_basis: null, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_48bac9edbe72c6df', variant_id: 'variant_8682e4c44eee4f9a', observation_scope: 'variant', market_code: 'KR', panel_type: 'source_declaration', protein_pct: 27.8, protein_qualifier: 'min', fat_pct: 7.9, fat_qualifier: 'min', fiber_pct: 1.2, fiber_qualifier: 'max', moisture_pct: 8.5, moisture_qualifier: 'max', ash_pct: 6.9, ash_qualifier: 'max', kcal_per_kg: null, kcal_per_100g: null, energy_basis: null, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_ee2315cca61e0def', variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'source_declaration', protein_pct: null, protein_qualifier: null, fat_pct: null, fat_qualifier: null, fiber_pct: null, fiber_qualifier: null, moisture_pct: null, moisture_qualifier: null, ash_pct: null, ash_qualifier: null, kcal_per_kg: 4165, kcal_per_100g: null, energy_basis: 'direct_label', is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_5c03d226266089e9', variant_id: 'variant_a0b5d25b2ebd3c07', observation_scope: 'variant', market_code: 'KR', panel_type: 'source_declaration', protein_pct: 10, protein_qualifier: 'min', fat_pct: 2, fat_qualifier: 'min', fiber_pct: 1.5, fiber_qualifier: 'max', moisture_pct: 83, moisture_qualifier: 'max', ash_pct: 3.5, ash_qualifier: 'max', kcal_per_kg: null, kcal_per_100g: null, energy_basis: null, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_363478f1f6965ace', variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'source_declaration', protein_pct: null, protein_qualifier: null, fat_pct: null, fat_qualifier: null, fiber_pct: null, fiber_qualifier: null, moisture_pct: null, moisture_qualifier: null, ash_pct: null, ash_qualifier: null, kcal_per_kg: 3710, kcal_per_100g: null, energy_basis: 'direct_label', is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_92e22ecf2acae77e', variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'source_declaration', protein_pct: 37.5, protein_qualifier: 'min', fat_pct: 13, fat_qualifier: 'min', fiber_pct: 5, fiber_qualifier: 'max', moisture_pct: 9, moisture_qualifier: 'max', ash_pct: null, ash_qualifier: null, kcal_per_kg: 3861, kcal_per_100g: null, energy_basis: 'direct_label', is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_51d58b8551f1e081', variant_id: null, observation_scope: 'product', market_code: 'KR', panel_type: 'source_declaration', protein_pct: 44, protein_qualifier: 'min', fat_pct: 32, fat_qualifier: 'min', fiber_pct: 3, fiber_qualifier: 'max', moisture_pct: 6, moisture_qualifier: 'max', ash_pct: null, ash_qualifier: null, kcal_per_kg: 4815, kcal_per_100g: null, energy_basis: 'direct_label', is_korea_market_observation: true, is_current_resolved_formula: false },
]

const STRESS_INGREDIENTS: CompareIngredients[] = [
  { product_id: 'product_22531a6bb7f865e5', variant_id: null, observation_scope: 'product', market_code: 'KR', declaration_scope: 'retail_general', completeness_status: 'full', raw_text: '밀, 쌀, 육분(닭, 오리), 밀 글루텐, 옥수수, 동물성 지방(닭, 오리), 동물성 유도단백질(닭, 칠면조, 어류), 밀가루, 분말셀룰로오스, 혼합광물질류 합제, 사탕무박, 대두유, 효모, 어유, 프락토올리고당, 차전자피식이섬유, L-카르니틴, 아미노산제 합제, 비타민 A, 비타민 D3, 철, 요오드, 구리, 망간, 아연, 셀레늄, 제올라이트, 항산화제.', ingredient_names: ['밀','쌀','육분(닭, 오리)','밀 글루텐','옥수수','동물성 지방(닭, 오리)','동물성 유도단백질(닭, 칠면조, 어류)','밀가루','분말셀룰로오스','혼합광물질류 합제','사탕무박','대두유','효모','어유','프락토올리고당','차전자피식이섬유','L-카르니틴','아미노산제 합제','비타민 A','비타민 D3','철','요오드','구리','망간','아연','셀레늄','제올라이트','항산화제'], ingredient_count: 28, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_71d80e22240d1f3c', variant_id: 'variant_32e508efd8d0f39b', observation_scope: 'variant', market_code: 'KR', declaration_scope: 'korea_market_formula_detail', completeness_status: 'summary', raw_text: '닭고기, 닭고기 육수, 가공용 물, 참치, 칠면조, 천연 향료, 타피오카 전분, 해바라기 기름, 인산삼칼슘, 로커스트콩검, 염화칼륨, 해양 미세조류 기름(혼합 토코페롤로 보존), 구아검, 소금, 탄산나트륨, 타우린, 잔탄검, 비타민합제, 황산마그네슘, 콜린 염화물 등', ingredient_names: [], ingredient_count: 0, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_48bac9edbe72c6df', variant_id: 'variant_8682e4c44eee4f9a', observation_scope: 'variant', market_code: 'KR', declaration_scope: 'current_korea_general_food_formula_evidence', completeness_status: 'summary', raw_text: '신선한 대구(50%), 백미(10%), 가수분해동물성단백질(7.1%), 현미분(7.41%), 수수(6.44%), 완두콩(6.2%), 효모(4.75%), 감자단백질(3.13%), 닭지방(1.9%), 건크랜베리(0.1%), 미네랄(2.76%), 치커리추출이눌린(0.1%), 만난올리고당(0.1%), 유카(0.01%) 등', ingredient_names: [], ingredient_count: 0, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_ee2315cca61e0def', variant_id: null, observation_scope: 'product', market_code: 'KR', declaration_scope: 'retail_general', completeness_status: 'full', raw_text: '닭고기 - 뼈를 제거한 (24%), 건조 닭고기 단백질 (24%), 스펠트 통밀 (10%), 통귀리 (10%), 닭고기 지방, 건조 통 달걀, 청어, 건조 청어, 청어 오일, 건조 비트 펄프, 건조 당근, 햇볕에 말린 알팔파, 이눌린, 프럭토올리고당, 효모 추출물, 건조 석류 (0.5%), 건조 사과, 건조 시금치, 차전자피와 씨앗 (0.3%), 건조 오렌지 과육, 건조 블루베리, 소금, 맥주 효모, 강황 (0.2%), 비타민 A, 비타민 D3, 비타민 E, 아스코르빈산, 나이아신, 판토텐산 칼슘, 리보플라빈, 피리독신 염산염, 티아민 염산염, 비오틴, 엽산, 비타민 B12, 염화 콜린, 베타-카로틴, 킬레이트 아연, 킬레이트 망간, 킬레이트 철, 킬레이트 구리, DL-메티오닌, 타우린, L-카르니틴, 알로에 베라 젤 농축액, 녹차 추출물, 로즈마리 추출물, 천연 혼합 토코페롤(항산화제)', ingredient_names: ['닭고기 - 뼈를 제거한 (24%)','건조 닭고기 단백질 (24%)','스펠트 통밀 (10%)','통귀리 (10%)','닭고기 지방','건조 통 달걀','청어','건조 청어','청어 오일','건조 비트 펄프','건조 당근','햇볕에 말린 알팔파','이눌린','프럭토올리고당','효모 추출물','건조 석류 (0.5%)','건조 사과','건조 시금치','차전자피와 씨앗 (0.3%)','건조 오렌지 과육','건조 블루베리','소금','맥주 효모','강황 (0.2%)','비타민 A','비타민 D3','비타민 E','아스코르빈산','나이아신','판토텐산 칼슘','리보플라빈','피리독신 염산염','티아민 염산염','비오틴','엽산','비타민 B12','염화 콜린','베타-카로틴','킬레이트 아연','킬레이트 망간','킬레이트 철','킬레이트 구리','DL-메티오닌','타우린','L-카르니틴','알로에 베라 젤 농축액','녹차 추출물','로즈마리 추출물','천연 혼합 토코페롤(항산화제)'], ingredient_count: 49, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_5c03d226266089e9', variant_id: 'variant_a0b5d25b2ebd3c07', observation_scope: 'variant', market_code: 'KR', declaration_scope: 'current_korea_general_food', completeness_status: 'full', raw_text: '닭고기, 닭 육수, 참치, 해바라기씨 오일, 타피오카, 소금, 제3인산칼슘, 천연 닭고기 향, 타우린, 민들레, 황산마그네슘, 염화콜린, 염화칼슘, 셀러리파우더, 비타민 E 보충제, 티아민 보충제, 산화아연, 환원철, 나이아신 보충제, 비타민 A 보충제, 셀렌산나트륨, 황산망간, 구리 아미노산 복합체, 피리독신 염산염, 판토텐산칼슘, 리보플라빈 보충제, 엽산, 비타민 B12 보충제, 비타민 D3 보충제, 요오드화 칼륨, 비오틴 보충제', ingredient_names: ['닭고기','닭 육수','참치','해바라기씨 오일','타피오카','소금','제3인산칼슘','천연 닭고기 향','타우린','민들레','황산마그네슘','염화콜린','염화칼슘','셀러리파우더','비타민 E 보충제','티아민 보충제','산화아연','환원철','나이아신 보충제','비타민 A 보충제','셀렌산나트륨','황산망간','구리 아미노산 복합체','피리독신 염산염','판토텐산칼슘','리보플라빈 보충제','엽산','비타민 B12 보충제','비타민 D3 보충제','요오드화 칼륨','비오틴 보충제'], ingredient_count: 31, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_363478f1f6965ace', variant_id: null, observation_scope: 'formula', market_code: null, declaration_scope: 'retail_general', completeness_status: 'full', raw_text: 'Salmon, Dehydrated Deboned Chicken, Dehydrated Chicken (Source of Glucosamine and Chondroitin Sulfate), Whitefish, Turkey, Turkey Liver, Pea Starch, Dried Peas, Tapioca Starch, Dried Egg Product, Flaxseeds, Natural Chicken Flavor, Dried Tomato Pomace, Salt, Choline Chloride, Potassium Chloride, Vitamins, Minerals, Mixed Tocopherols, Taurine, dl-Methionine, Citric Acid, Rosemary Extract', ingredient_names: ['Salmon','Dehydrated Deboned Chicken','Dehydrated Chicken (Source of Glucosamine and Chondroitin Sulfate)','Whitefish','Turkey','Turkey Liver','Pea Starch','Dried Peas','Tapioca Starch','Dried Egg Product','Flaxseeds','Natural Chicken Flavor','Dried Tomato Pomace','Salt','Choline Chloride','Potassium Chloride','Vitamins','Minerals','Mixed Tocopherols','Taurine','dl-Methionine','Citric Acid','Rosemary Extract'], ingredient_count: 23, is_korea_market_observation: false, is_current_resolved_formula: false },
  { product_id: 'product_92e22ecf2acae77e', variant_id: null, observation_scope: 'product', market_code: 'KR', declaration_scope: 'retail_general', completeness_status: 'summary', raw_text: '닭고기, 닭육분, 연어어분, 완두콩, 멘헤이든생선어분, 타피오카', ingredient_names: [], ingredient_count: 0, is_korea_market_observation: true, is_current_resolved_formula: false },
  { product_id: 'product_51d58b8551f1e081', variant_id: null, observation_scope: 'product', market_code: 'KR', declaration_scope: 'retail_general', completeness_status: 'summary', raw_text: '닭고기 (빻은 닭 뼈 포함), 닭 간, 닭 심장, 빻은 아마씨, 생선 오일, 몬모릴로나이트점토', ingredient_names: [], ingredient_count: 0, is_korea_market_observation: true, is_current_resolved_formula: false },
]

const STRESS_MANUFACTURING: ProductManufacturingDetail[] = [
  { product_id: 'product_71d80e22240d1f3c', observation_scope: 'product', country_code: 'TH', manufacturer: 'Southeast Asian Packaging and Canning Ltd. (SEAPAC)', plant: null, is_current_resolved_formula: false },
]

const STRESS_MARKETS: ProductMarketDetail[] = ['AU','CA','GB','NL','NZ','US'].map((country_code, index) => ({
  product_id: 'product_71d80e22240d1f3c', country_code,
  distribution_status: country_code === 'AU' ? 'current_product_confirmed' : 'gate_confirmed_product_not_found',
  formula_correspondence_status: country_code === 'AU' ? 'exact_same' : 'not_found',
  counterpart_name: null, assessed_at: '2026-08-25', is_current_product_confirmed: country_code === 'AU', is_formula_match_confirmed: country_code === 'AU',
  display_rank: index + 1, country_observation_count: 6,
}))

function productIdsFromFilter(value: string | null): string[] | null {
  if (!value) return null
  if (value.startsWith('eq.')) return [value.slice(3)]
  if (value.startsWith('in.(') && value.endsWith(')')) return value.slice(4, -1).split(',').filter(Boolean)
  return null
}

export function installStressPreviewFetch(): void {
  if (!isStressPreview()) return

  document.documentElement.dataset.stressPreview = 'true'
  const style = document.createElement('style')
  style.textContent = `html[data-stress-preview='true'] body::after{content:'DATA STRESS TEST';position:fixed;right:14px;bottom:14px;z-index:10000;border:1px solid rgba(24,24,27,.18);padding:6px 8px;background:rgba(255,255,255,.94);color:#343439;font-size:10px;font-weight:750;pointer-events:none}`
  document.head.appendChild(style)

  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = input instanceof Request ? input.url : input.toString()
    const url = new URL(requestUrl, window.location.href)
    const view = url.pathname.split('/').filter(Boolean).at(-1)

    let rows: unknown[] | null = null
    if (view === 'effective_product_catalog_summary') rows = STRESS_PRODUCTS
    if (view === 'switch_current_variant_options') rows = STRESS_VARIANTS
    if (view === 'compare_product_nutrition') rows = STRESS_NUTRITION
    if (view === 'compare_product_ingredients') rows = STRESS_INGREDIENTS
    if (view === 'product_detail_manufacturing') rows = STRESS_MANUFACTURING
    if (view === 'product_detail_markets') rows = STRESS_MARKETS

    if (!rows) return nativeFetch(input, init)
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')

    const ids = productIdsFromFilter(url.searchParams.get('product_id'))
    const filtered = ids
      ? rows.filter((row) => row && typeof row === 'object' && 'product_id' in row && ids.includes(String((row as { product_id: unknown }).product_id)))
      : rows

    return new Response(JSON.stringify(filtered), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
  }
}
