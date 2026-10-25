import { activeCollectionPermission, collectionGeneration, sendCollectionEvent, subscribeCollectionBoundary } from './collection-permission'
import { clearJourneyCollectionLinks } from './journey-records'

export type DecisionMode = 'switch' | 'explore'
export type DecisionAxis =
  | 'brand'
  | 'feed_type'
  | 'life_stage'
  | 'official_target'
  | 'feature'
  | 'recipe_family'
  | 'recipe_detail'
  | 'official_recipe_trait'
  | 'ingredient'
export type DecisionRole =
  | 'hard_constraint'
  | 'desired'
  | 'desired_change'
  | 'keep'
  | 'ingredient_avoid'
  | 'evidence_required'
export type DecisionSource = 'user_selected' | 'current_baseline_derived'
export type ConsiderationSignal =
  | 'quick_view_open'
  | 'detail_open'
  | 'compare_add'
  | 'compare_view'

export interface DecisionCriterion {
  axis: DecisionAxis
  value: string
  role: DecisionRole
  source: DecisionSource
}

export interface DecisionSearchRunInput {
  parentSearchRunId: string | null
  mode: DecisionMode
  currentProductId: string | null
  currentVariantId: string | null
  criteriaSnapshot: DecisionCriterion[]
  candidateCount: number
  initialPresentedProductIds: string[]
  runOrigin?: 'submitted' | 'restored'
}

const RUN_KEY = 'catfood.decision-runs.v3'
const OPERATIONS_KEY = 'catfood.decision-operations.v3'
type RunBody = Record<string, unknown> & { session_id: string; permission_id: string; client_run_id: string; initial_presented_product_ids: string[] }
type SavedRun = { key: string; body: RunBody; runId: string | null; createdAt: number }
let runs: SavedRun[] = [], memoryOperations: Record<string, Record<string, unknown>> = {}
const pendingRuns = new Map<string, Promise<string | null>>()
export function isDecisionCollectionEnabled(): boolean { return activeCollectionPermission() !== null }
subscribeCollectionBoundary(() => {
  runs = []; pendingRuns.clear(); memoryOperations = {}
  for (const key of [RUN_KEY, OPERATIONS_KEY, 'catfood.decision-session.v1', 'catfood.decision-runs.v2', 'catfood.decision-operations.v2']) {
    try { sessionStorage.removeItem(key) } catch { /* no stored delivery queue can be used without the current permission */ }
  }
  clearJourneyCollectionLinks()
})
function savedRuns(): SavedRun[] {
  const p = activeCollectionPermission()
  if (!p) return []
  try { const value: unknown = JSON.parse(sessionStorage.getItem(RUN_KEY) ?? '[]'); runs = Array.isArray(value) ? value as SavedRun[] : [] } catch { /* same-page memory only */ }
  return runs.filter(row => row && typeof row.key === 'string' && row.body?.session_id === p.sessionId && row.body.permission_id === p.permissionId
    && typeof row.body.client_run_id === 'string' && Array.isArray(row.body.initial_presented_product_ids)
    && row.body.initial_presented_product_ids.every(id => typeof id === 'string') && Number.isFinite(row.createdAt)
    && row.createdAt <= Date.now() && Date.now() - row.createdAt < 86400000)
}
function storeRuns(value: SavedRun[]) { runs = value; try { sessionStorage.setItem(RUN_KEY, JSON.stringify(value)) } catch { /* sharing failure never blocks browsing */ } }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value) }
export interface ConsiderationContext { kind: 'initial' | 'load_more' | 'named_search'; presentedProductIds: string[]; displayedProductIds?: string[] }
export async function createDecisionSearchRun(input: DecisionSearchRunInput): Promise<string | null> {
  const p = activeCollectionPermission(), epoch = collectionGeneration()
  if (!p) return null
  const criteria = input.criteriaSnapshot.map(row => ({ axis: row.axis, value: row.value, role: row.role, source: row.source }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const key = JSON.stringify([p.permissionId, input.mode, input.currentProductId, input.currentVariantId, criteria, input.candidateCount, input.initialPresentedProductIds])
  const previous = savedRuns(), existing = previous.find(row => row.key === key)
  if (existing?.runId) return existing.runId
  const pending = pendingRuns.get(key); if (pending) return pending
  // A parent can only belong to this permission; old local journey IDs never bridge consent changes.
  const parent = previous.find(row => row.runId && row.runId === input.parentSearchRunId)?.runId ?? null
  const entry: SavedRun = existing ?? { key, runId: null, createdAt: Date.now(), body: {
    client_run_id: crypto.randomUUID(), session_id: p.sessionId!, permission_id: p.permissionId!,
    parent_search_run_id: parent, mode: input.mode, current_product_id: input.currentProductId, current_variant_id: input.currentVariantId,
    criteria_snapshot: criteria, candidate_count: input.candidateCount, initial_presented_product_ids: [...input.initialPresentedProductIds], run_origin: input.runOrigin ?? 'submitted',
  } }
  if (!existing) storeRuns([...previous, entry])
  const b = entry.body
  const task = sendCollectionEvent('search_run', { client_run_id: b.client_run_id, parent_search_run_id: b.parent_search_run_id,
    mode: b.mode, current_product_id: b.current_product_id, current_variant_id: b.current_variant_id,
    criteria_snapshot: criteria, candidate_count: b.candidate_count, initial_presented_product_ids: b.initial_presented_product_ids, run_origin: b.run_origin,
  }).then(result => {
    if (collectionGeneration() !== epoch) return null
    const id = uuid(result?.search_run_id) && (result?.status === 'created' || result?.status === 'existing') ? result.search_run_id : null
    if (id) storeRuns(savedRuns().map(row => row.key === key ? { ...row, runId: id } : row))
    return id
  }).finally(() => { if (pendingRuns.get(key) === task) pendingRuns.delete(key) })
  pendingRuns.set(key, task); return task
}
export async function recordProductConsideration(searchRunId: string | null, productId: string, signalType: ConsiderationSignal, context?: ConsiderationContext): Promise<boolean> {
  if (!activeCollectionPermission() || !searchRunId) return false
  const run = savedRuns().find(row => row.runId === searchRunId); if (!run) return false
  const presented = context?.presentedProductIds ?? run.body.initial_presented_product_ids, position = presented.indexOf(productId)
  if (position < 0 || presented.length > 40 || new Set(presented).size !== presented.length) return false
  const result = await sendCollectionEvent('consideration', { search_run_id: searchRunId, product_id: productId, signal_type: signalType,
    context_kind: context?.kind ?? 'initial', presented_product_ids: [...presented], position,
    displayed_product_ids: signalType === 'compare_view' ? [...(context?.displayedProductIds ?? [productId])] : [],
  })
  return result?.status === 'recorded' || result?.status === 'existing'
}
export type ExplicitDecisionKind = 'candidate_retained' | 'retained_candidate_removed' | 'keep_current' | 'undecided'
export interface ExplicitDecisionInput { recordId: string; revision: number; previousRevision: number; searchRunId: string | null; kind: ExplicitDecisionKind; productId: string | null }
export async function recordExplicitDecision(input: ExplicitDecisionInput): Promise<boolean> {
  const p = activeCollectionPermission(); if (!p || !input.searchRunId || !savedRuns().some(row => row.runId === input.searchRunId)) return false
  const key = JSON.stringify([p.permissionId, input.searchRunId, input.recordId, input.revision, input.previousRevision, input.kind, input.productId])
  let operations = memoryOperations
  try { const value: unknown = JSON.parse(sessionStorage.getItem(OPERATIONS_KEY) ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) operations = value as typeof operations } catch { /* same-page retry keeps operation identity */ }
  const body = { operation_id: uuid(operations[key]?.operation_id) ? operations[key].operation_id : crypto.randomUUID(), record_id: input.recordId,
    revision: input.revision, expected_previous_revision: input.previousRevision, search_run_id: input.searchRunId, kind: input.kind, product_id: input.productId }
  operations[key] = body; memoryOperations = operations
  try { sessionStorage.setItem(OPERATIONS_KEY, JSON.stringify(operations)) } catch { /* no reconnection promise after reload */ }
  const result = await sendCollectionEvent('decision', body)
  return (result?.status === 'recorded' || result?.status === 'existing') && result.record_id === input.recordId && result.revision === input.revision
}
