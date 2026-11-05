import { useEffect, useMemo, useState } from 'react'
import { fetchListIngredientSources, type ListIngredientSource } from './api'
import { ingredientDisclosureReading, ingredientSourceScope } from './ingredient-disclosure'
import './ingredient-list-reason.css'

// An explanation of source wording; never used to change the catalog's term verdict.
export function useIngredientListReasons(productIds: string[]) {
  const key = [...new Set(productIds)].sort().join(',')
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{ key: string; rows: ListIngredientSource[]; status: 'loaded' | 'error' }>({ key: '', rows: [], status: 'loaded' })
  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    fetchListIngredientSources(key.split(','), controller.signal).then(rows => {
      if (!controller.signal.aborted) setResult({ key, rows, status: 'loaded' })
    }).catch(() => { if (!controller.signal.aborted) setResult({ key, rows: [], status: 'error' }) })
    return () => controller.abort()
  }, [key, retry])
  const status = !key ? 'loaded' : result.key === key ? result.status : 'loading'
  const byProduct = useMemo(() => new Map(result.rows.map(row => [row.product_id, row])), [result.rows])
  return { status, byProduct, retry: () => setRetry(value => value + 1) }
}

export function IngredientReasonStatus({ status, onRetry }: { status: string; onRetry: () => void }) {
  if (status === 'loaded') return null
  return <div className="ingredient-reason-status" role={status === 'error' ? 'alert' : 'status'}>
    <span>{status === 'error' ? '원료표의 추가 안내를 불러오지 못했습니다.' : '원료표의 추가 확인 사항을 불러오는 중입니다.'}</span>
    {status === 'error' ? <><span>기존 원료 판정과 후보 목록은 유지됩니다.</span><button type="button" onClick={onRetry}>추가 확인 사항 다시 불러오기</button></> : null}
  </div>
}

export function IngredientListReason({ row }: { row?: ListIngredientSource }) {
  const reading = ingredientDisclosureReading(row)
  const scope = ingredientSourceScope(row)
  if (row && scope.needsCheck) {
    return <span className="ingredient-list-reason"><strong>자료 적용 확인 필요</strong><span>{scope.label}</span></span>
  }
  return <span className="ingredient-list-reason">
    <strong>원료표에서 더 확인할 점</strong>
    {reading.details.length ? reading.details.slice(0, 2).map(detail => <span key={detail.phrase}>{detail.phrase} — {detail.note}</span>) : <span>{reading.listLabel === '전체 원료표 확인' ? '이 자료에 전체 목록이 있어도 특정 원료의 부재를 보증하지 않습니다.' : '이 자료 기준 · ' + reading.listLabel}</span>}
    {reading.details.length && row?.completeness_status !== 'full' ? <span>이 자료 기준 · {reading.listLabel}</span> : null}
    {row?.raw_text ? <small>자료 범위 · {scope.label}</small> : null}
    <span>피하려는 원료의 포함 여부는 별도로 확인해 주세요.</span>
  </span>
}
