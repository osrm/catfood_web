import { isPreviewDataEnabled } from './preview-mode'

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

const SESSION_KEY = 'catfood.decision-session.v1'
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CONTRACT_VERSION = 'decision-v2'
const NOTICE_VERSION = 'decision-collection-v2'

let memorySession: { session_id: string; created_at: number } | null = null

export function isDecisionCollectionEnabled(): boolean {
  return !isPreviewDataEnabled()
    && import.meta.env.VITE_DECISION_INTAKE_ENABLED?.trim().toLowerCase() === 'true'
}

function intakeConfig(): { endpoint: string; publishableKey: string } | null {
  if (!isDecisionCollectionEnabled()) return null
  const baseUrl = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/$/, '')
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  if (!baseUrl || !publishableKey) return null
  return {
    endpoint: `${baseUrl}/functions/v1/decision-intake`,
    publishableKey,
  }
}

function freshSession(): { session_id: string; created_at: number } {
  return { session_id: crypto.randomUUID(), created_at: Date.now() }
}

function session(): { session_id: string; created_at: number } {
  const now = Date.now()
  try {
    const stored = sessionStorage.getItem(SESSION_KEY)
    if (stored) {
      const value = JSON.parse(stored) as unknown
      if (
        value
        && typeof value === 'object'
        && 'session_id' in value
        && typeof value.session_id === 'string'
        && 'created_at' in value
        && typeof value.created_at === 'number'
        && now - value.created_at >= 0
        && now - value.created_at < SESSION_MAX_AGE_MS
      ) {
        return { session_id: value.session_id, created_at: value.created_at }
      }
    }

    const next = freshSession()
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next))
    return next
  } catch {
    if (
      !memorySession
      || now - memorySession.created_at < 0
      || now - memorySession.created_at >= SESSION_MAX_AGE_MS
    ) {
      memorySession = freshSession()
    }
    return memorySession
  }
}

async function post(route: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const config = intakeConfig()
  if (!config) return null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${config.endpoint}/${route}`, {
        method: 'POST',
        headers: {
          apikey: config.publishableKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        keepalive: true,
      })
      if (!response.ok) {
        if (response.status >= 500 && attempt === 0) continue
        return null
      }
      const result = await response.json() as unknown
      return result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null
    } catch {
      if (attempt === 1) return null
    }
  }
  return null
}

export interface ConsiderationContext {
  kind: 'initial' | 'load_more' | 'named_search'
  presentedProductIds: string[]
  displayedProductIds?: string[]
}
type RunBody = Record<string, unknown> & { session_id: string; client_run_id: string; initial_presented_product_ids: string[] }
type SavedRun = { key: string; body: RunBody; runId: string | null; createdAt: number }
const RUN_KEY = 'catfood.decision-runs.v2'
let runs: SavedRun[] = []
const pendingRuns = new Map<string, Promise<string | null>>()
let memoryOperations: Record<string, Record<string, unknown>> = {}
function savedRuns(): SavedRun[] {
  try { const raw = sessionStorage.getItem(RUN_KEY); const parsed: unknown = raw ? JSON.parse(raw) : []; runs = Array.isArray(parsed) ? parsed as SavedRun[] : [] } catch { /* tab memory fallback */ }
  return runs.filter((run) => run && typeof run.key === 'string' && run.body && typeof run.body.session_id === 'string' && typeof run.body.client_run_id === 'string'
    && Array.isArray(run.body.initial_presented_product_ids) && run.body.initial_presented_product_ids.every((id) => typeof id === 'string')
    && Number.isFinite(run.createdAt) && Date.now() - run.createdAt >= 0 && Date.now() - run.createdAt < SESSION_MAX_AGE_MS)
}
function storeRuns(value: SavedRun[]) { runs = value; try { sessionStorage.setItem(RUN_KEY, JSON.stringify(value)) } catch { /* UI remains usable */ } }
export async function createDecisionSearchRun(input: DecisionSearchRunInput): Promise<string | null> {
  if (!isDecisionCollectionEnabled()) return null
  const activeSession = session()
  const criteria = input.criteriaSnapshot.map((row) => ({ axis: row.axis, value: row.value, role: row.role, source: row.source }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const key = JSON.stringify([activeSession.session_id, input.mode, input.currentProductId, input.currentVariantId, criteria,
    input.candidateCount, input.initialPresentedProductIds])
  const previous = savedRuns()
  const existing = previous.find((run) => run.key === key)
  if (existing?.runId) return existing.runId
  const pending = pendingRuns.get(key)
  if (pending) return pending
  const entry: SavedRun = existing ?? { key, runId: null, createdAt: Date.now(), body: {
    client_run_id: crypto.randomUUID(), session_id: activeSession.session_id,
    parent_search_run_id: input.parentSearchRunId, mode: input.mode,
    current_product_id: input.currentProductId, current_variant_id: input.currentVariantId,
    criteria_snapshot: criteria, candidate_count: input.candidateCount,
    initial_presented_product_ids: [...input.initialPresentedProductIds], contract_version: CONTRACT_VERSION,
    notice_version: NOTICE_VERSION, evaluation_version: 'catalog-criteria-v2', run_origin: input.runOrigin ?? 'submitted',
  } }
  if (!existing) storeRuns([...previous, entry])
  const body = entry.body
  const exactBody = { client_run_id: body.client_run_id, session_id: body.session_id, parent_search_run_id: body.parent_search_run_id,
    mode: body.mode, current_product_id: body.current_product_id, current_variant_id: body.current_variant_id,
    criteria_snapshot: Array.isArray(body.criteria_snapshot) ? body.criteria_snapshot.map((row: DecisionCriterion) => ({ axis: row.axis, value: row.value, role: row.role, source: row.source })) : [],
    candidate_count: body.candidate_count, initial_presented_product_ids: body.initial_presented_product_ids, contract_version: body.contract_version,
    notice_version: body.notice_version, evaluation_version: body.evaluation_version, run_origin: body.run_origin }
  const task = post('v2/search-runs', exactBody).then((result) => {
    const id = typeof result?.search_run_id === 'string' ? result.search_run_id : null
    if (id) storeRuns(savedRuns().map((run) => run.key === key ? { ...run, runId: id } : run))
    return id
  }).finally(() => pendingRuns.delete(key))
  pendingRuns.set(key, task)
  return task
}
export async function recordProductConsideration(searchRunId: string | null, productId: string,
  signalType: ConsiderationSignal, context?: ConsiderationContext): Promise<boolean> {
  if (!isDecisionCollectionEnabled() || !searchRunId) return false
  const activeSession = session()
  const run = savedRuns().find((row) => row.runId === searchRunId && row.body.session_id === activeSession.session_id)
  if (!run) return false
  const presented = context?.presentedProductIds ?? run.body.initial_presented_product_ids
  const position = presented.indexOf(productId)
  if (position < 0 || presented.length > 40 || new Set(presented).size !== presented.length) return false
  const result = await post('v2/considerations', {
    search_run_id: searchRunId, session_id: activeSession.session_id, product_id: productId,
    signal_type: signalType, context_kind: context?.kind ?? 'initial', presented_product_ids: [...presented], position,
    displayed_product_ids: signalType === 'compare_view' ? [...(context?.displayedProductIds ?? [productId])] : [],
  })
  return result?.status === 'recorded' || result?.status === 'existing'
}
export type ExplicitDecisionKind = 'candidate_retained' | 'retained_candidate_removed' | 'keep_current' | 'undecided'
export interface ExplicitDecisionInput { recordId: string; revision: number; previousRevision: number; searchRunId: string | null; kind: ExplicitDecisionKind; productId: string | null }
// No free text or UI snapshot can enter this exact-key body. Failed operations are not rebound to a later run.
export async function recordExplicitDecision(input: ExplicitDecisionInput): Promise<boolean> {
  if (!isDecisionCollectionEnabled() || !input.searchRunId) return false
  const activeSession = session()
  const run = savedRuns().find((row) => row.runId === input.searchRunId && row.body.session_id === activeSession.session_id)
  if (!run) return false
  const operationsKey = 'catfood.decision-operations.v2'
  const key = JSON.stringify([activeSession.session_id, input.searchRunId, input.recordId, input.revision,
    input.previousRevision, input.kind, input.productId])
  let operations = memoryOperations
  try { operations = JSON.parse(sessionStorage.getItem(operationsKey) ?? '{}') as typeof operations } catch { /* memory retry still preserves the body below */ }
  const body = { operation_id: typeof operations[key]?.operation_id === 'string' ? operations[key].operation_id : crypto.randomUUID(), record_id: input.recordId, revision: input.revision,
    expected_previous_revision: input.previousRevision, search_run_id: input.searchRunId,
    session_id: activeSession.session_id, kind: input.kind, product_id: input.productId }
  operations[key] = body
  memoryOperations = operations
  try { sessionStorage.setItem(operationsKey, JSON.stringify(operations)) } catch { /* storage-blocked collection cannot reconnect after reload */ }
  const result = await post('v2/decisions', body)
  return result?.status === 'recorded' || result?.status === 'existing'
}
