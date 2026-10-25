import { isPreviewDataEnabled } from './preview-mode'

export type CollectionPurpose = 'service_improvement' | 'data_product_research'
export const COLLECTION_NOTICE_VERSION = 'decision-permissions-v1'
const KEY = 'catfood.collection-permission.v1'
export interface CollectionPolicy { noticeVersion: string; retentionSeconds: number; operator: string; contact: string }
export interface CollectionPermission {
  capability: string; purposes: CollectionPurpose[]; noticeVersion: string
  permissionId: string | null; sessionId: string | null; acceptUntil: string | null; rawUntil: string | null
}
export interface CollectionState {
  policy: CollectionPolicy | null; permission: CollectionPermission | null
  status: 'off' | 'registering' | 'active' | 'stopped' | 'deleting'
  message: string; storageAvailable: boolean
}
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x)
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const purposes = (x: unknown): x is CollectionPurpose[] => Array.isArray(x) && x.length > 0 && x.length <= 2
  && new Set(x).size === x.length && x.every(i => i === 'service_improvement' || i === 'data_product_research')
const timestamp = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x))
const listeners = new Set<() => void>(), boundaries = new Set<() => void>(), controllers = new Set<AbortController>()
let generation = 0, operation = 0, policyTask: Promise<void> | null = null
let state: CollectionState = { policy: null, permission: null, status: 'off', message: '', storageAvailable: true }
try {
  const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
  if (object(value) && object(value.permission)) {
    const p = value.permission
    if (typeof p.capability === 'string' && /^[a-f\d]{64}$/.test(p.capability) && purposes(p.purposes)
      && p.noticeVersion === COLLECTION_NOTICE_VERSION && (p.permissionId === null || uuid(p.permissionId))
      && (p.sessionId === null || uuid(p.sessionId)) && (p.acceptUntil === null || timestamp(p.acceptUntil))
      && (p.rawUntil === null || timestamp(p.rawUntil))) {
      state.permission = p as unknown as CollectionPermission
      state.status = value.status === 'active' ? 'active' : 'stopped'
    }
  }
} catch { state.storageAvailable = false }

export function collectionConfigured() {
  return !isPreviewDataEnabled() && import.meta.env.VITE_DECISION_INTAKE_ENABLED?.trim().toLowerCase() === 'true'
}
function config() {
  if (isPreviewDataEnabled()) return null
  const url = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/$/, '')
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  return url && key ? { endpoint: `${url}/functions/v1/decision-collection`, key } : null
}
function update(next: Partial<CollectionState>, boundary = false) {
  state = { ...state, ...next }
  if (boundary) {
    generation += 1
    for (const c of controllers) c.abort()
    controllers.clear()
    for (const listener of boundaries) listener()
  }
  for (const listener of listeners) listener()
}
function persist(value = state) {
  try {
    if (value.permission) sessionStorage.setItem(KEY, JSON.stringify({ permission: value.permission, status: value.status }))
    else sessionStorage.removeItem(KEY)
    if (!state.storageAvailable) update({ storageAvailable: true })
    return true
  } catch { update({ storageAvailable: false }); return false }
}
export const readCollectionState = () => state
export const collectionGeneration = () => generation
export function subscribeCollectionState(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function subscribeCollectionBoundary(listener: () => void) { boundaries.add(listener); return () => { boundaries.delete(listener) } }
export function activeCollectionPermission(): CollectionPermission | null {
  const p = state.permission
  return collectionConfigured() && state.policy && state.status === 'active' && p && p.permissionId && p.sessionId
    && p.noticeVersion === state.policy.noticeVersion && p.acceptUntil && Date.parse(p.acceptUntil) > Date.now() ? p : null
}
function stopLocally(message: string) { update({ status: state.permission ? 'stopped' : 'off', message }, true); persist() }
export function expireCollectionPermission() {
  if (state.permission?.acceptUntil && Date.parse(state.permission.acceptUntil) <= Date.now()) stopLocally('공유 기간이 끝나 전송을 중지했습니다. 보낸 기록은 삭제할 수 있습니다.')
}
async function request(route: string, body?: Record<string, unknown>, eventGeneration?: number, retry = false): Promise<Record<string, unknown> | null> {
  const c = config()
  if (!c) return null
  const controller = new AbortController(); controllers.add(controller)
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const result = await fetch(`${c.endpoint}/${route}`, {
      method: body ? 'POST' : 'GET', headers: { apikey: c.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
    })
    if (controller.signal.aborted || eventGeneration !== undefined && eventGeneration !== generation) return null
    const value: unknown = await result.json()
    if (!result.ok) {
      if (route === 'events' && object(value) && (value.code === 'collection_not_accepting' || value.code === 'collection_permission_required')) stopLocally('공유 설정을 확인할 수 없어 전송을 중지했습니다.')
      else if (retry && result.status >= 500 && eventGeneration === generation) return request(route, body, eventGeneration)
      return null
    }
    return object(value) ? value : null
  } catch {
    return retry && !controller.signal.aborted && eventGeneration === generation ? request(route, body, eventGeneration) : null
  } finally { clearTimeout(timeout); controllers.delete(controller) }
}
function policyFrom(value: Record<string, unknown> | null): CollectionPolicy | null {
  if (value?.enabled !== true || value.notice_version !== COLLECTION_NOTICE_VERSION
    || !Number.isInteger(value.raw_retention_seconds) || Number(value.raw_retention_seconds) <= 0
    || typeof value.operator_name !== 'string' || !value.operator_name.trim() || typeof value.contact_url !== 'string') return null
  try { const url = new URL(value.contact_url); if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null } catch { return null }
  return { noticeVersion: value.notice_version, retentionSeconds: Number(value.raw_retention_seconds), operator: value.operator_name, contact: value.contact_url }
}
export async function loadCollectionPolicy() {
  if (!collectionConfigured()) { if (state.status === 'active') stopLocally('공유를 중지했습니다.'); return }
  if (policyTask) return policyTask
  policyTask = (async () => {
    const policy = policyFrom(await request('policy'))
    const wasActive = activeCollectionPermission()
    update({ policy })
    if (!policy && state.status === 'active') stopLocally('공유 설정을 확인할 수 없어 전송을 중지했습니다.')
    else if (!wasActive && activeCollectionPermission()) update({}, true)
  })().finally(() => { policyTask = null })
  return policyTask
}
export async function stopAndDeleteCollection(): Promise<boolean> {
  const p = state.permission, myOperation = ++operation
  stopLocally('전송을 중지했습니다.')
  if (!p) return true
  update({ status: 'deleting' }); persist()
  const result = await request('delete', { permission_id: p.permissionId, capability: p.capability })
  if (myOperation !== operation) return false
  if (result?.status === 'deleted' && Number.isInteger(result.search_runs_deleted) && Number(result.search_runs_deleted) >= 0) {
    update({ permission: null, status: 'off', message: '보낸 탐색 기록을 삭제했습니다.' }, true); persist(); return true
  }
  update({ status: 'stopped', message: '전송은 중지했지만 삭제를 확인하지 못했습니다. 다시 시도해 주세요.' }); persist(); return false
}
export async function setCollectionPurposes(next: CollectionPurpose[]): Promise<boolean> {
  if (!next.length) return stopAndDeleteCollection()
  if (!purposes(next) || !collectionConfigured() || !state.policy || state.status === 'deleting' || state.status === 'registering') return false
  const sorted = [...next].sort() as CollectionPurpose[]
  const same = state.permission && JSON.stringify([...state.permission.purposes].sort()) === JSON.stringify(sorted)
  if (same && activeCollectionPermission()) return true
  if (state.permission && (!same || state.status === 'active' || state.permission.permissionId)) {
    if (!await stopAndDeleteCollection()) return false
  }
  const policy = state.policy
  if (!policy) return false
  const p: CollectionPermission = state.permission ?? {
    capability: Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join(''),
    purposes: sorted, noticeVersion: policy.noticeVersion, permissionId: null, sessionId: null, acceptUntil: null, rawUntil: null,
  }
  const myOperation = ++operation
  update({ permission: p, status: 'registering', message: '' }, true)
  if (!persist()) { update({ permission: null, status: 'off', message: '설정을 보관할 수 없어 공유를 시작하지 않았습니다. 검색은 계속 이용할 수 있습니다.' }); return false }
  const result = await request('permissions', { capability: p.capability, purposes: p.purposes, notice_version: p.noticeVersion })
  if (myOperation !== operation) return false
  if (result && uuid(result.permission_id) && uuid(result.session_id) && purposes(result.purposes)
    && JSON.stringify([...result.purposes].sort()) === JSON.stringify(sorted) && result.notice_version === policy.noticeVersion
    && timestamp(result.accept_until) && timestamp(result.raw_until) && Date.parse(result.accept_until) > Date.now()
    && Date.parse(result.raw_until) >= Date.parse(result.accept_until)) {
    const complete: CollectionState = { ...state, permission: { ...p, permissionId: result.permission_id, sessionId: result.session_id, acceptUntil: result.accept_until, rawUntil: result.raw_until },
      status: 'active', message: '' }
    if (!persist(complete)) {
      update({ permission: complete.permission, status: 'stopped', message: '설정을 보관하지 못해 전송을 중지했습니다. 이 창에서 보낸 기록 삭제를 다시 시도할 수 있습니다.' }, true)
      return false
    }
    update(complete, true); return true
  }
  update({ status: 'stopped', message: '공유 시작을 확인하지 못했습니다. 다시 시도하거나 전송을 중지하고 보낸 기록을 삭제할 수 있습니다.' }); persist(); return false
}
export async function sendCollectionEvent(kind: 'search_run' | 'consideration' | 'decision', event: Record<string, unknown>) {
  const p = activeCollectionPermission(), epoch = generation
  if (!p) return null
  const result = await request('events', { permission_id: p.permissionId, capability: p.capability, kind, event }, epoch, true)
  return epoch === generation && activeCollectionPermission()?.permissionId === p.permissionId ? result : null
}
