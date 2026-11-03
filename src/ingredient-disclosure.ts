import type { CompareIngredients } from './api'
import { splitIngredientText } from './ingredient-composition'

// Reads the selected source verbatim. This is a visibility aid, not an ingredient
// absence test, a manufacturer transparency score or an allergen-safety claim.
// Never merge a different supplemental formula into the selected source.
type IngredientSource = Pick<CompareIngredients, 'raw_text' | 'completeness_status'>

const FISH_CATEGORY = /어유|어류|어개류|생선|해수어분|어분|피쉬(?:오일|펩티드|밀|추출물)|魚介類|魚油|魚類|フィッシュ(?:オイル|ミール|エキス)|\bfish(?:\s+(?:oil|meal|broth|extract|protein|peptide)s?)?\b|\bwhitefish\b|\bwhite fish\b/i
const FISH_SPECIES = /연어|참치|가다랑어|정어리|멸치|청어|고등어|대구|명태|폴락|송어|볼락|가자미|우럭|호키|멘헤이든|サーモン|鮭|マグロ|カツオ|イワシ|アンチョビ|タラ|ニシン|サバ|\bsalmon\b|\btuna\b|\bsardines?\b|\banchov(?:y|ies)\b|\bherring\b|\bmackerel\b|\bcod\b|\bpollock\b|\btrout\b|\bmenhaden\b|\bhoki\b/i
const ANIMAL_CATEGORY = /동물성\s*(?:유도)?\s*(?:단백질|지방)|가금(?:류|육)|육분|육류|동물성유지|\bpoultry\b|\banimal (?:fat|protein|meal)\b|\bmeat meal\b/i
const ANIMAL_SPECIES = /닭|오리|칠면조|돼지|쇠고기|소고기|양고기|토끼|사슴|메추리|거위|\bchicken\b|\bduck\b|\bturkey\b|\bpork\b|\bbeef\b|\blamb\b|\brabbit\b|\bvenison\b|\bquail\b|\bgoose\b/i
const FLAVOR_CATEGORY = /천연\s*향(?:료|미)?|인공\s*향(?:료|미)?|향미료|조미향료|\bnatural flavo(?:u)?r\b|\bartificial flavo(?:u)?r\b|香料/i

function hasBroadAnimalWord(ingredient: string) {
  return (FISH_CATEGORY.test(ingredient) && !FISH_SPECIES.test(ingredient))
    || (ANIMAL_CATEGORY.test(ingredient) && !ANIMAL_SPECIES.test(ingredient))
    || (FLAVOR_CATEGORY.test(ingredient) && !ANIMAL_SPECIES.test(ingredient) && !FISH_SPECIES.test(ingredient))
}

export type IngredientDisclosureReading = {
  label: string
  examples: string[]
  explanation: string
}

export function ingredientDisclosureReading(row: IngredientSource | null | undefined): IngredientDisclosureReading {
  const raw = row?.raw_text?.trim()
  if (!raw) return {
    label: '원료표 원문 미확보',
    examples: [],
    explanation: '현재 선택된 자료의 원문이 없어 원료의 구체적인 표기 수준을 판단할 수 없습니다.',
  }

  const matches = [...new Set(splitIngredientText(raw).filter(hasBroadAnimalWord))]
  const examples = matches.map(value => value.length > 60 ? value.slice(0, 59) + '…' : value).slice(0, 3)

  if (matches.length) return {
    label: '일부 원료 종류 포괄 표기',
    examples,
    explanation: '위 표현은 확인한 원료표의 표기 그대로입니다. 세부 원료 종류를 임의로 추정하지 않으며, 특정 원료를 피할 때는 추가 확인이 필요할 수 있습니다.',
  }
  if (row?.completeness_status !== 'full') return {
    label: '일부 목록 · 공개 수준 판단 제한',
    examples: [],
    explanation: '확인한 자료가 전체 원료표가 아니므로 다른 원료에 포괄적인 표현이 있는지 판단할 수 없습니다.',
  }
  return {
    label: '확인한 원료표에서 주요 포괄 표현 미발견',
    examples: [],
    explanation: '검토한 표현이 보이지 않는다는 뜻입니다. 모든 세부 원료의 공개나 특정 원료의 부재를 보증하지 않습니다.',
  }
}

export function ingredientDisclosureSummary(row: IngredientSource | null | undefined) {
  const reading = ingredientDisclosureReading(row)
  return reading.examples.length ? reading.label + ' · ' + reading.examples.slice(0, 2).join(' · ') + (reading.examples.length > 2 ? ' 외' : '') : reading.label
}
