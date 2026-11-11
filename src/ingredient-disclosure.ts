import type { CatalogProduct, CompareIngredients, ListIngredientSource, ProductVariant } from './api'
import { splitIngredientText } from './ingredient-composition'
import { INGREDIENT_AVOID_LABELS } from './search'

// Reads the selected source verbatim. This is a visibility aid, not an ingredient
// absence test, a manufacturer transparency score or an allergen-safety claim.
// Never merge a different supplemental formula into the selected source.
type IngredientSource = Pick<CompareIngredients, 'raw_text' | 'completeness_status'>
type IngredientScope = Partial<Pick<CompareIngredients, 'market_code' | 'observation_scope' | 'is_current_resolved_formula'>>

// Where a source applies is separate from how complete or specific its text is.
export function ingredientSourceScope(row: IngredientScope | null | undefined) {
  if (!row) return { label: '자료 범위 미확인', needsCheck: true }
  const knownScope = ['variant', 'product', 'formula'].includes(row.observation_scope ?? '')
  const matched = Boolean(row.is_current_resolved_formula)
  const needsCheck = !knownScope || row.observation_scope === 'formula' && !matched || row.market_code !== 'KR' && !matched
  const market = row.market_code === 'KR' ? '한국 자료' : row.market_code ? `${row.market_code} 자료` : matched ? '국내 동일 배합 확인 자료' : '자료 국가 미확인'
  const scope = row.observation_scope === 'variant' ? '확인한 포장 기준' : row.observation_scope === 'product' ? '제품 자료' : row.observation_scope === 'formula' ? '배합 자료' : '제품·포장 범위 미확인'
  const application = needsCheck ? '한국 판매 제품과 같은 배합인지 미확인' : matched && row.market_code ? '국내 동일 배합 확인 자료' : ''
  return { label: [market, scope, application].filter(Boolean).join(' · '), needsCheck }
}

const FISH_CATEGORY = /어유|어류(?:\s*(?:추출물|단백질|자가분해물|가수분해물))?|어개류|생선(?:\s*(?:기름|오일|추출물|육수|분말))?|해수어분|어분|피쉬\s*(?:오일|펩티드|밀|추출물)|魚介類|魚油|魚類|フィッシュ(?:オイル|ミール|エキス)|\bfish(?:\s+(?:oil|meal|(?:bone\s+)?broth|extract|protein|peptide|autolysate|hydrolysate)s?)?\b|\bwhitefish\b|\bwhite fish\b/i
const FISH_SPECIES = /연어|참치|가다랑어|정어리|멸치|청어|고등어|대구|명태|폴락|송어|볼락|가자미|우럭|호키|멘헤이든|サーモン|鮭|マグロ|カツオ|イワシ|アンチョビ|タラ|ニシン|サバ|\bsalmon\b|\btuna\b|\bsardines?\b|\banchov(?:y|ies)\b|\bherring\b|\bmackerel\b|\bcod\b|\bpollock\b|\btrout\b|\bmenhaden\b|\bhoki\b/i
const NAMED_KOREAN_FISH_OIL = new RegExp(`(?:${FISH_SPECIES.source})유$`, 'i')
const ANIMAL_CATEGORY = /동물성\s*(?:유도)?\s*(?:단백질|지방)|가금(?:류|육)|육분|육류|동물성유지|\bpoultry\b|\banimal (?:fat|protein|meal)\b|\bmeat meal\b/i
const ANIMAL_SPECIES = /닭|오리|칠면조|돼지|쇠고기|소고기|양고기|토끼|사슴|메추리|거위|\bchicken\b|\bduck\b|\bturkey\b|\bpork\b|\bbeef\b|\blamb\b|\brabbit\b|\bvenison\b|\bquail\b|\bgoose\b/i
const FLAVOR_CATEGORY = /천연\s*향(?:료|미)?|인공\s*향(?:료|미)?|향미료|조미향료|\bnatural flavo(?:u)?r\b|\bartificial flavo(?:u)?r\b|香料/i

const FISH_AVOID_TERMS = new Set(['anchovy', 'cod', 'herring', 'mackerel', 'menhaden', 'salmon', 'sardine', 'trout', 'tuna', 'whitefish'])
const POULTRY_AVOID_TERMS = new Set(['chicken', 'duck', 'turkey', 'goose', 'quail'])
const LAND_ANIMAL_AVOID_TERMS = new Set(['beef', 'lamb', 'pork', 'rabbit', 'venison', 'goat', 'boar'])
// Require a complete generic entry here. A qualifier may name a species even
// if it is outside the search vocabulary.
const GENERIC_FISH_ENTRY = new RegExp(`^(?:정제\\s*)?(?:${FISH_CATEGORY.source})(?:\\s*\\d+(?:[.,]\\d+)?\\s*%)?$`, 'i')
const GENERIC_POULTRY_ENTRY = /^(?:가금(?:류|육)(?:\s*(?:지방|단백질|육분|분말))?|poultry(?:\s+(?:fat|meal|protein))?)(?:\s*\d+(?:[.,]\d+)?\s*%)?$/i
const GENERIC_ANIMAL_ENTRY = new RegExp(`^(?:${ANIMAL_CATEGORY.source})(?:\\s*\\d+(?:[.,]\\d+)?\\s*%)?$`, 'i')

export function ingredientAvoidanceWording(
  product: CatalogProduct | ProductVariant,
  term: string,
  row?: ListIngredientSource | null,
  { variantId, compact = false }: { variantId?: string | null; compact?: boolean } = {},
): {
  state: 'present' | 'reviewed-not-found' | 'unknown'
  summary: string
  detail?: string
  sourcePhrase?: string
} {
  const label = INGREDIENT_AVOID_LABELS[term] ?? term
  if (product.confirmed_present_ingredient_terms?.includes(term)) {
    const flavorOnly = product.flavor_associated_ingredient_terms?.includes(term) && !product.direct_evidence_ingredient_terms?.includes(term)
    if (compact) return { state: 'present', summary: flavorOnly ? '향미 표기에서 확인' : '확인됨' }
    return { state: 'present', summary: '확인됨', detail: flavorOnly ? `향미 표기에서 ${label} 관련 표현을 확인했어요.` : `확인한 자료에서 ${label} 관련 원료를 확인했어요.` }
  }
  const reviewed = product.reviewed_not_found_ingredient_terms?.includes(term)
  const fallback = reviewed
    ? { state: 'reviewed-not-found' as const, summary: compact ? '확인한 원료표에 표기 없음' : `확인 자료에 ${label} 표기 없음`, detail: compact ? undefined : '이 표기만으로는 포함 여부를 알기 어려워요.' }
    : { state: 'unknown' as const, summary: compact ? '포장 확인 필요' : '현재 자료로는 포함 여부를 알기 어려워요.' }
  if (!row?.raw_text?.trim() || row.product_id !== product.product_id || ingredientSourceScope(row).needsCheck) return fallback
  if (row.observation_scope === 'variant' && variantId && row.variant_id !== variantId) return fallback
  const manufacturer = row.is_manufacturer_source === true
  if (reviewed && !manufacturer) return fallback
  if (row.completeness_status === 'partial' || row.completeness_status === 'summary') {
    return reviewed ? fallback : { state: 'unknown', summary: '원료표 일부만 확인', detail: fallback.summary }
  }
  if (row.completeness_status !== 'full') return fallback
  const source = manufacturer ? '제조사 원료표' : '확인한 원료표'
  const compactSource = manufacturer ? '제조사 표기' : '원료표'
  const entries = splitIngredientText(row.raw_text)
  if (FISH_AVOID_TERMS.has(term)) {
    const phrase = entries.find(entry => GENERIC_FISH_ENTRY.test(entry) && !(term === 'whitefish' && /^white\s*fish\b/i.test(entry)))
    if (phrase) return { state: fallback.state, sourcePhrase: phrase, summary: compact ? `${compactSource} · ‘${phrase}’(어종 미표기)` : `${source}에 어종 표시 없음 · ‘${phrase}’ 표기` }
  }
  if (POULTRY_AVOID_TERMS.has(term) || LAND_ANIMAL_AVOID_TERMS.has(term)) {
    const poultry = POULTRY_AVOID_TERMS.has(term)
    const phrase = entries.find(entry => GENERIC_POULTRY_ENTRY.test(entry) ? poultry : GENERIC_ANIMAL_ENTRY.test(entry))
    if (phrase) return { state: fallback.state, sourcePhrase: phrase, summary: compact ? `${compactSource} · ‘${phrase}’(동물 종류 미표기)` : `${source}에 동물 종류 표시 없음 · ‘${phrase}’ 표기` }
  }
  return fallback
}

export function hasUnspecifiedAvoidanceIngredient(product: CatalogProduct, terms: readonly string[], row?: ListIngredientSource) {
  return terms.some(term => ingredientAvoidanceWording(product, term, row).sourcePhrase !== undefined)
}

// A species elsewhere in a phrase does not identify this ingredient's source.
// Only an adjacent species or a locally specified parenthesis qualifies it.
function hasUnspecifiedCategory(ingredient: string, category: RegExp, species: RegExp) {
  const namedPrefix = new RegExp('(?:' + species.source + ')(?:고기|간|육)?\\s*$', 'i')
  const namedHeading = new RegExp('^\\s*(?:원\\s*)?[:：]\\s*(?:' + species.source + ')(?:고기|간|육)?(?:$|\\s|[·/0-9(%])', 'i')
  for (const match of ingredient.matchAll(new RegExp(category.source, 'gi'))) {
    const before = ingredient.slice(0, match.index)
    // In 연어유, the match 어유 starts inside the named species.
    if (category === FISH_CATEGORY && match[0] === '어유' && NAMED_KOREAN_FISH_OIL.test(before + match[0])) continue
    const after = ingredient.slice(match.index + match[0].length)
    const parenthesis = after.match(/^\s*[（(]([^()（）]*)[)）]/)?.[1]
    const specified = parenthesis != null
      && (species.test(parenthesis) || (category === ANIMAL_CATEGORY && /^\s*소\s*$/.test(parenthesis)))
      && !/기타|\bother\b|\betc\b|등(?:\s|$)|또는|\bor\b/i.test(parenthesis)
      && !FISH_CATEGORY.test(parenthesis) && !ANIMAL_CATEGORY.test(parenthesis) && !FLAVOR_CATEGORY.test(parenthesis)
    if (!namedPrefix.test(before) && !namedHeading.test(after) && !specified) return true
  }
  return false
}

function wordingDetail(ingredient: string) {
  const notes = []
  const alternatives = /또는|\bor\b/i.test(ingredient)
  if (hasUnspecifiedCategory(ingredient, FISH_CATEGORY, FISH_SPECIES)) notes.push(alternatives && FISH_SPECIES.test(ingredient) ? '사용 어종 추가 확인 필요' : '세부 어종 미표기')
  if (hasUnspecifiedCategory(ingredient, ANIMAL_CATEGORY, ANIMAL_SPECIES)) notes.push(alternatives && ANIMAL_SPECIES.test(ingredient) ? '사용 동물 종류 추가 확인 필요' : '세부 동물 종류 미표기')
  if (hasUnspecifiedCategory(ingredient, FLAVOR_CATEGORY, new RegExp(ANIMAL_SPECIES.source + '|' + FISH_SPECIES.source, 'i'))) notes.push('향료 세부 구성 미표기')
  return notes.join(' · ')
}

export type IngredientDisclosureReading = {
  label: string
  examples: string[]
  explanation: string
  listLabel: string
  listExplanation: string
  details: Array<{ phrase: string; note: string }>
}

export function ingredientDisclosureReading(row: IngredientSource | null | undefined): IngredientDisclosureReading {
  const raw = row?.raw_text?.trim()
  const list = !raw
    ? { listLabel: '원료표 미확인', listExplanation: '현재 확인한 자료에는 원료표 원문이 없습니다.' }
    : row?.completeness_status === 'full'
      ? { listLabel: '전체 원료표 확인', listExplanation: '확인한 자료에 전체 원료 목록이 있습니다. 각 원료의 세부 종류까지 밝혀졌다는 뜻은 아닙니다.' }
      : { listLabel: row?.completeness_status === 'partial' || row?.completeness_status === 'summary' ? '일부 원료표 확인' : '전체 목록 여부 미확인', listExplanation: '이 자료만으로는 전체 원료를 확인할 수 없습니다. 목록에 없는 원료도 포함될 수 있습니다.' }
  if (!raw) return {
    ...list,
    label: '원료표 미확인',
    examples: [],
    details: [],
    explanation: '현재 자료만으로는 세부 원료 표기를 확인하기 어렵습니다.',
  }

  const matches = [...new Set(splitIngredientText(raw).filter(ingredient => wordingDetail(ingredient)))]
  const examples = matches.slice(0, 3)
  const details = examples.map(phrase => ({ phrase, note: wordingDetail(phrase) }))

  if (matches.length) return {
    ...list,
    label: '세부 종류를 추가로 확인할 원료',
    examples,
    details,
    explanation: '위 표현은 확인한 원료표의 표기 그대로입니다. 세부 원료 종류를 임의로 추정하지 않으며, 특정 원료를 피할 때는 추가 확인이 필요할 수 있습니다.',
  }
  if (row?.completeness_status !== 'full') return {
    ...list,
    label: '일부 원료표 확인',
    examples: [],
    details: [],
    explanation: '확인한 자료가 전체 원료표가 아니므로 다른 원료에 포괄적인 표현이 있는지 판단할 수 없습니다.',
  }
  return {
    ...list,
    label: '원료표 세부 표기 안내',
    examples: [],
    details: [],
    explanation: '확인한 범위에서는 세부 종류가 생략된 표기가 보이지 않습니다. 모든 세부 원료가 확인됐거나 특정 원료가 없다는 뜻은 아닙니다.',
  }
}

export function ingredientDisclosureSummary(row: IngredientSource | null | undefined) {
  const reading = ingredientDisclosureReading(row)
  const examples = ingredientWordingExamples(row)
  if (!examples.length && row?.completeness_status === 'full' && row.raw_text?.trim()) return reading.listLabel
  const wording = examples.length ? examples.slice(0, 2).join(' · ') + (examples.length > 2 ? ' 외' : '') : reading.label
  return reading.listLabel === reading.label ? reading.label : reading.listLabel + ' · ' + wording
}

export function ingredientWordingExamples(row: IngredientSource | null | undefined) {
  const reading = ingredientDisclosureReading(row)
  if (reading.details.length) return reading.details.map(item => `${item.phrase} — ${item.note}`)
  return splitIngredientText(row?.raw_text ?? '').filter(value => /어유|생선.*오일|fish\s+oil/i.test(value)).slice(0, 2)
    .map(value => /fish\s+oil\s*\(\s*herring\s*\)/i.test(value) ? `${value} — 청어를 명시한 오일` : value)
}
