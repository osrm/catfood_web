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
  | 'detail_open'
  | 'compare_add'
  | 'outbound_retailer_click'

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
}

const SESSION_KEY = 'catfood.decision-session.v1'
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CONTRACT_VERSION = 'decision-v1'
const NOTICE_VERSION = 'decision-collection-v1'

let memorySession: { session_id: string; created_at: number } | null = null

function enabled(): boolean {
  return import.meta.env.VITE_DECISION_INTAKE_ENABLED?.trim().toLowerCase() === 'true'
}

function intakeConfig(): { endpoint: string; publishableKey: string } | null {
  if (!enabled()) return null
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

export async function createDecisionSearchRun(
  input: DecisionSearchRunInput,
): Promise<string | null> {
  if (!enabled()) return null
  const activeSession = session()
  const result = await post('search-runs', {
    client_run_id: crypto.randomUUID(),
    session_id: activeSession.session_id,
    parent_search_run_id: input.parentSearchRunId,
    mode: input.mode,
    current_product_id: input.currentProductId,
    current_variant_id: input.currentVariantId,
    criteria_snapshot: input.criteriaSnapshot,
    candidate_count: input.candidateCount,
    initial_presented_product_ids: input.initialPresentedProductIds,
    contract_version: CONTRACT_VERSION,
    notice_version: NOTICE_VERSION,
  })
  return typeof result?.search_run_id === 'string' ? result.search_run_id : null
}

export async function recordProductConsideration(
  searchRunId: string | null,
  productId: string,
  signalType: ConsiderationSignal,
): Promise<void> {
  if (!enabled() || !searchRunId) return
  const activeSession = session()
  await post('considerations', {
    search_run_id: searchRunId,
    session_id: activeSession.session_id,
    product_id: productId,
    signal_type: signalType,
  })
}
