import type { ListIngredientSource } from './api'
import { ingredientDisclosureReading, ingredientSourceScope } from './ingredient-disclosure'

export type IngredientQuestions = { source: string; items: string[] }
export type QuestionProduct = { productId: string; brand: string; name: string }

export function validIngredientQuestions(value: unknown): value is IngredientQuestions {
  if (!value || typeof value !== 'object') return false
  const row = value as IngredientQuestions
  return typeof row.source === 'string' && row.source.length > 0 && row.source.length <= 300
    && Array.isArray(row.items) && row.items.length > 0 && row.items.length <= 5
    && row.items.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 400)
}

// Questions describe what remains to ask; they never certify ingredient absence.
export function ingredientQuestions(row: ListIngredientSource | null | undefined, avoidLabels: string[] = []): IngredientQuestions {
  const reading = ingredientDisclosureReading(row)
  const scope = ingredientSourceScope(row)
  const applicable = Boolean(row && !scope.needsCheck)
  const questions: string[] = []
  if (!applicable && row) questions.push('이 자료가 현재 한국에서 판매되는 제품의 배합에도 적용되나요? 관련 자료도 확인할 수 있나요?')
  if (!row?.raw_text?.trim() || row.completeness_status !== 'full' || !applicable) questions.push('현재 한국 판매 제품의 최신 전체 원료표를 확인할 수 있나요?')
  if (applicable && row?.observation_scope === 'variant') questions.push('이 원료표가 구매하려는 포장 규격과 현재 판매 배합에도 적용되나요?')
  if (applicable) for (const detail of reading.details.slice(0, 2)) {
    const phrase = detail.phrase.length > 100 ? detail.phrase.slice(0, 100) + '…' : detail.phrase
    const subject = detail.note.includes('어종') ? '사용한 어종과 어종별 구성' : detail.note.includes('동물 종류') ? '사용한 동물 종류와 구성' : '구체적인 원료 구성'
    questions.push(`원료표의 ‘${phrase}’에 ${subject}은 무엇인가요?`)
  }
  const labels = [...new Set(avoidLabels)].slice(0, 6).map(label => label.slice(0, 30))
  if (labels.length) questions.push(`현재 한국 판매 제품의 원료·향료·오일 구성에서 ${labels.join('·')}${avoidLabels.length > 6 ? ' 등 선택한 원료' : ''} 포함 여부를 확인할 수 있나요? 관련 자료도 확인할 수 있나요?`)
  if (!questions.length) questions.push('구매하려는 포장에 적용되는 최신 전체 원료표를 확인할 수 있나요?')
  const source = !row ? reading.listLabel : `${scope.label} · ${reading.listLabel}`
  return { source, items: [...new Set(questions)].slice(0, 5) }
}

export function ingredientQuestionsText(product: QuestionProduct, value: IngredientQuestions) {
  return [`제품 확인 질문: ${product.brand} · ${product.name}`, `질문 작성 때 살펴본 자료: ${value.source}`,
    ...value.items.map((item, index) => `${index + 1}. ${item}`),
    '확인하려고 정리한 질문이며, 답변이나 원료가 없음을 확인한 기록은 아닙니다.'].join('\n')
}
