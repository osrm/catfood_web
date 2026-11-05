import type { CompareIngredients } from './api'
import { splitIngredientText } from './ingredient-composition'

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

const FISH_CATEGORY = /어유|어류|어개류|생선(?:기름|오일|추출물|육수|분말)?|해수어분|어분|피쉬(?:오일|펩티드|밀|추출물)|魚介類|魚油|魚類|フィッシュ(?:オイル|ミール|エキス)|\bfish(?:\s+(?:oil|meal|broth|extract|protein|peptide)s?)?\b|\bwhitefish\b|\bwhite fish\b/i
const FISH_SPECIES = /연어|참치|가다랑어|정어리|멸치|청어|고등어|대구|명태|폴락|송어|볼락|가자미|우럭|호키|멘헤이든|サーモン|鮭|マグロ|カツオ|イワシ|アンチョビ|タラ|ニシン|サバ|\bsalmon\b|\btuna\b|\bsardines?\b|\banchov(?:y|ies)\b|\bherring\b|\bmackerel\b|\bcod\b|\bpollock\b|\btrout\b|\bmenhaden\b|\bhoki\b/i
const ANIMAL_CATEGORY = /동물성\s*(?:유도)?\s*(?:단백질|지방)|가금(?:류|육)|육분|육류|동물성유지|\bpoultry\b|\banimal (?:fat|protein|meal)\b|\bmeat meal\b/i
const ANIMAL_SPECIES = /닭|오리|칠면조|돼지|쇠고기|소고기|양고기|토끼|사슴|메추리|거위|\bchicken\b|\bduck\b|\bturkey\b|\bpork\b|\bbeef\b|\blamb\b|\brabbit\b|\bvenison\b|\bquail\b|\bgoose\b/i
const FLAVOR_CATEGORY = /천연\s*향(?:료|미)?|인공\s*향(?:료|미)?|향미료|조미향료|\bnatural flavo(?:u)?r\b|\bartificial flavo(?:u)?r\b|香料/i

// A species elsewhere in a phrase does not identify this ingredient's source.
// Only an adjacent species or a locally specified parenthesis qualifies it.
function hasUnspecifiedCategory(ingredient: string, category: RegExp, species: RegExp) {
  const namedPrefix = new RegExp('(?:' + species.source + ')(?:고기|간|육)?\\s*$', 'i')
  const namedHeading = new RegExp('^\\s*(?:원\\s*)?[:：]\\s*(?:' + species.source + ')(?:고기|간|육)?(?:$|\\s|[·/0-9(%])', 'i')
  for (const match of ingredient.matchAll(new RegExp(category.source, 'gi'))) {
    const before = ingredient.slice(0, match.index)
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
  if (hasUnspecifiedCategory(ingredient, FISH_CATEGORY, FISH_SPECIES)) notes.push(alternatives && FISH_SPECIES.test(ingredient) ? '사용 어종 구성 미확정' : '세부 어종 미기재')
  if (hasUnspecifiedCategory(ingredient, ANIMAL_CATEGORY, ANIMAL_SPECIES)) notes.push(alternatives && ANIMAL_SPECIES.test(ingredient) ? '사용 동물 종류 미확정' : '세부 동물 종류 미기재')
  if (hasUnspecifiedCategory(ingredient, FLAVOR_CATEGORY, new RegExp(ANIMAL_SPECIES.source + '|' + FISH_SPECIES.source, 'i'))) notes.push('향료의 세부 구성 미기재')
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
    ? { listLabel: '원료표 원문 미확보', listExplanation: '현재 선택된 자료의 원문을 확보하지 못했습니다.' }
    : row?.completeness_status === 'full'
      ? { listLabel: '전체 원료표 확인', listExplanation: '확인한 자료에 전체 원료 목록이 있습니다. 각 원료의 세부 종류까지 밝혀졌다는 뜻은 아닙니다.' }
      : { listLabel: row?.completeness_status === 'partial' || row?.completeness_status === 'summary' ? '일부 원료표만 확보' : '전체 목록 여부 미확인', listExplanation: '이 자료만으로는 전체 원료를 확인할 수 없습니다. 목록에 없는 원료도 포함될 수 있습니다.' }
  if (!raw) return {
    ...list,
    label: '원료표 원문 미확보',
    examples: [],
    details: [],
    explanation: '현재 선택된 자료의 원문이 없어 원료의 구체적인 표기 수준을 판단할 수 없습니다.',
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
    label: '일부 목록 · 공개 수준 판단 제한',
    examples: [],
    details: [],
    explanation: '확인한 자료가 전체 원료표가 아니므로 다른 원료에 포괄적인 표현이 있는지 판단할 수 없습니다.',
  }
  return {
    ...list,
    label: '확인한 원료표에서 주요 포괄 표현 미발견',
    examples: [],
    details: [],
    explanation: '검토한 표현이 보이지 않는다는 뜻입니다. 모든 세부 원료의 공개나 특정 원료의 부재를 보증하지 않습니다.',
  }
}

export function ingredientDisclosureSummary(row: IngredientSource | null | undefined) {
  const reading = ingredientDisclosureReading(row)
  const wording = reading.details.length
    ? reading.details.slice(0, 2).map(item => item.phrase + ' — ' + item.note).join(' · ') + (reading.details.length > 2 ? ' 외' : '')
    : reading.label
  return reading.listLabel === reading.label ? reading.label : reading.listLabel + ' · ' + wording
}
