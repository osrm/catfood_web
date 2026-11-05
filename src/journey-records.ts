import type { DecisionCriterion, ExplicitDecisionInput, ExplicitDecisionKind } from './analytics'
import { validIngredientQuestions, type IngredientQuestions } from './ingredient-questions'
import { validCandidateExplanation, type CandidateExplanation } from './candidate-explanation'

// Deliberately separate from navigation/history: user text never enters a URL or intake body.
export type JourneyIdentity = { productId: string; brand: string; name: string }
export type DecisionPurpose = { focus: 'disclosure' | 'ingredients' | 'energy' | 'other' | null; reason: string; positives: string }
export function validDecisionPurpose(value: unknown): value is DecisionPurpose {
  if (!value || typeof value !== 'object') return false
  const row = value as DecisionPurpose
  return (row.focus === null || ['disclosure', 'ingredients', 'energy', 'other'].includes(row.focus))
    && typeof row.reason === 'string' && row.reason.length <= 200 && typeof row.positives === 'string' && row.positives.length <= 200
}
export type JourneyContext = {
  purpose?: DecisionPurpose
  criteriaUndecided?: boolean
  candidateRefined?: boolean
  selectionKey: string
  current: JourneyIdentity
  variantId: string | null
  variantLabel: string
  criteria: DecisionCriterion[]
  labels: string[]
}
export type JourneyPendingIntake = { pending: ExplicitDecisionInput | null; following: Array<{ kind: ExplicitDecisionKind; productId: string | null; runId: string | null }> }
export type RetainedCandidate = {
  id: string; revision: number; active: boolean; candidate: JourneyIdentity
  context: JourneyContext; note: string; createdAt: string
  checkQuestions?: IngredientQuestions
  explanation?: CandidateExplanation
  pendingIntake?: JourneyPendingIntake
  intakeRevision?: number
  searchRunId: string | null
}
export type JourneyOutcome = {
  id: string; revision: number; kind: 'keep_current' | 'undecided'
  context: JourneyContext; pendingIntake?: JourneyPendingIntake; intakeRevision?: number; searchRunId: string | null
}
export type JourneyRecords = { purpose?: DecisionPurpose; context?: JourneyContext | null; memo: string; retained: RetainedCandidate[]; outcome: JourneyOutcome | null }
const KEY = 'catfood.switch-review.v1'
let memory: JourneyRecords = { memo: '', retained: [], outcome: null }
export function emptyJourneyRecords(): JourneyRecords { return { memo: '', retained: [], outcome: null } }
export function readJourneyRecords(): JourneyRecords {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return memory = emptyJourneyRecords()
    const value = JSON.parse(raw) as JourneyRecords
    if (typeof value.memo !== 'string' || !Array.isArray(value.retained)) return memory
    // Only our own bounded, local record shape is restored; old navigation snapshots need no migration.
    const text = (item: unknown, max = 400): item is string => typeof item === 'string' && item.length <= max
    const identity = (item: JourneyIdentity) => item && text(item.productId, 100) && text(item.brand) && text(item.name)
    const axes = new Set(['brand', 'feed_type', 'life_stage', 'official_target', 'feature', 'recipe_family', 'recipe_detail', 'official_recipe_trait', 'ingredient'])
    const roles = new Set(['hard_constraint', 'desired', 'desired_change', 'keep', 'ingredient_avoid', 'evidence_required'])
    const validContext = (context: JourneyContext) => context && text(context.selectionKey, 12000)
      && (context.criteriaUndecided === undefined || typeof context.criteriaUndecided === 'boolean')
      && (context.candidateRefined === undefined || typeof context.candidateRefined === 'boolean')
      && identity(context.current) && (context.variantId === null || text(context.variantId, 100)) && text(context.variantLabel)
      && Array.isArray(context.labels) && context.labels.length <= 64 && context.labels.every((item) => text(item))
      && Array.isArray(context.criteria) && context.criteria.length <= 64 && context.criteria.every((item) => item && axes.has(item.axis)
        && text(item.value) && roles.has(item.role) && ['user_selected', 'current_baseline_derived'].includes(item.source))
    const decisionKinds = new Set(['candidate_retained', 'retained_candidate_removed', 'keep_current', 'undecided'])
    const cleanContext = (context: JourneyContext): JourneyContext => {
      const { purpose, ...rest } = context
      return { ...rest, ...(validDecisionPurpose(purpose) ? { purpose } : {}) }
    }
    const pending = (value: JourneyPendingIntake | undefined): JourneyPendingIntake | undefined => {
      if (!value || !Array.isArray(value.following) || value.following.length > 100) return undefined
      if (!value.following.every((row) => row && decisionKinds.has(row.kind) && (row.productId === null || text(row.productId, 100)) && (row.runId === null || text(row.runId, 100)))) return undefined
      const row = value.pending
      if (row && (!text(row.recordId, 100) || !text(row.searchRunId, 100) || !Number.isInteger(row.revision) || row.revision < 1
        || row.previousRevision !== row.revision - 1 || !decisionKinds.has(row.kind) || row.productId !== null && !text(row.productId, 100))) return undefined
      return value
    }
    const intake = (row: { pendingIntake?: JourneyPendingIntake; intakeRevision?: number }) => ({
      pendingIntake: pending(row.pendingIntake), intakeRevision: Number.isInteger(row.intakeRevision) && row.intakeRevision! >= 0 ? row.intakeRevision : undefined,
    })
    memory = { ...(validDecisionPurpose(value.purpose) ? { purpose: value.purpose } : {}), context: value.context && validContext(value.context) ? cleanContext(value.context) : null, memo: value.memo.slice(0, 200), retained: value.retained.filter((row) => row && text(row.id, 100)
      && identity(row.candidate) && text(row.note, 200) && text(row.createdAt, 100)
      && typeof row.active === 'boolean' && Number.isInteger(row.revision) && row.revision > 0 && validContext(row.context)
      && (row.searchRunId === null || text(row.searchRunId, 100))).map((row) => {
        const { checkQuestions, explanation, ...rest } = row
        return { ...rest, context: cleanContext(row.context), ...intake(row), ...(validIngredientQuestions(checkQuestions) ? { checkQuestions } : {}), ...(validCandidateExplanation(explanation) ? { explanation } : {}) }
      }),
      outcome: value.outcome && text(value.outcome.id, 100) && Number.isInteger(value.outcome.revision)
        && value.outcome.revision > 0 && validContext(value.outcome.context)
        && ['keep_current', 'undecided'].includes(value.outcome.kind) ? { ...value.outcome, context: cleanContext(value.outcome.context), ...intake(value.outcome) } : null }
    return memory
  } catch { return memory }
}
export function writeJourneyRecords(value: JourneyRecords): boolean {
  memory = value
  try { sessionStorage.setItem(KEY, JSON.stringify(value)); return true } catch { return false }
}
export function clearJourneyRecords(): void { writeJourneyRecords(emptyJourneyRecords()) }
export function hasJourneyWork(value = readJourneyRecords()): boolean {
  return Boolean(value.purpose?.focus || value.purpose?.reason || value.purpose?.positives || value.memo || value.retained.some((row) => row.active) || value.outcome)
}
export function journeyCopyText(value: JourneyRecords): string {
  const context = (row: JourneyContext) => [`현재 사료: ${row.current.brand} · ${row.current.name}`, `사용 규격: ${row.variantLabel}`,
    row.purpose?.reason ? `바꾸려는 이유: ${row.purpose.reason}` : '', row.purpose?.positives ? `지금 사료에서 좋았던 점 (보호자 경험): ${row.purpose.positives}` : '',
    row.purpose?.focus ? `먼저 살펴본 정보: ${{disclosure:'원료의 구체적인 표기',ingredients:'피하고 싶은 원료',energy:'표기 열량',other:'직접 정한 기준'}[row.purpose.focus]}` : '',
    `찾은 조건: ${row.labels.join(' / ') || '따로 고르지 않음'}`].filter(Boolean).join('\n')
  return ['사료 검토 기록', value.context ? `현재 살펴보는 기준\n${context(value.context)}` : [value.purpose?.reason ? `바꾸려는 이유: ${value.purpose.reason}` : '', value.purpose?.positives ? `지금 사료에서 좋았던 점 (보호자 경험): ${value.purpose.positives}` : ''].filter(Boolean).join('\n'), value.memo ? `탐색 메모: ${value.memo}` : '',
    ...value.retained.filter((row) => row.active).map((row) => [`남긴 후보: ${row.candidate.brand} · ${row.candidate.name}`, context(row.context), row.explanation ? ['남길 때 확인한 내용 (당시 자료 기준)', ...(['kept','differences','unknowns','references'] as const).flatMap(key => row.explanation![key].map(text => `${{kept:'유지되는 점',differences:'확인한 차이',unknowns:'아직 모르는 점',references:'자료 범위'}[key]}: ${text}`))].join('\n') : '', row.note ? `내 메모: ${row.note}` : '', row.checkQuestions ? [`확인하려고 남긴 질문`, `질문 작성 때 살펴본 자료: ${row.checkQuestions.source}`, ...row.checkQuestions.items.map((item,index) => `${index + 1}. ${item}`)].join('\n') : ''].filter(Boolean).join('\n')),
    value.outcome ? [value.outcome.kind === 'keep_current' ? '이번 정리: 지금 사료 유지' : '이번 정리: 아직 못 고름', context(value.outcome.context)].join('\n') : '',
    '검토 후보는 구매·급여 전환 기록이 아닙니다.'].filter(Boolean).join('\n\n')
}
