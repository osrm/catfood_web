import { useEffect, useMemo, useState } from 'react'
import { fetchListIngredientSources, type ListIngredientSource } from './api'
import { ingredientDisclosureReading, ingredientSourceScope, ingredientWordingExamples } from './ingredient-disclosure'
import './ingredient-list-reason.css'

// An explanation of source wording; never used to change the catalog's term verdict.
export function useIngredientListReasons(productIds: string[]) {
  // A completed read without a source is recorded as null. Errors leave the
  // affected products unread so that a retry can request them again.
  const [sources, setSources] = useState(() => new Map<string, ListIngredientSource | null>())
  const [attempt, setAttempt] = useState(0)
  const [failure, setFailure] = useState<{ key: string; attempt: number }>()
  const missingKey = [...new Set(productIds)].filter(id => !sources.has(id)).sort().join(',')
  useEffect(() => {
    if (!missingKey) return
    const ids = missingKey.split(',')
    const controller = new AbortController()
    fetchListIngredientSources(ids, controller.signal).then(rows => {
      if (controller.signal.aborted) return
      const received = new Map(rows.map(row => [row.product_id, row]))
      setSources(previous => {
        const next = new Map(previous)
        ids.forEach(id => next.set(id, received.get(id) ?? null))
        return next
      })
    }).catch(() => {
      if (!controller.signal.aborted) setFailure({ key: missingKey, attempt })
    })
    return () => controller.abort()
  }, [missingKey, attempt])
  const status: 'loaded' | 'loading' | 'error' = !missingKey ? 'loaded' : failure?.key === missingKey && failure.attempt === attempt ? 'error' : 'loading'
  const byProduct = useMemo(() => new Map([...sources].filter((entry): entry is [string, ListIngredientSource] => entry[1] !== null)), [sources])
  return { status, byProduct, isLoaded: (id: string) => sources.has(id), retry: () => setAttempt(value => value + 1) }
}

export function IngredientReasonStatus({ status, onRetry }: { status: string; onRetry: () => void }) {
  if (status === 'loaded') return null
  return <div className="ingredient-reason-status" role={status === 'error' ? 'alert' : 'status'}>
    <span>{status === 'error' ? '원료표의 추가 안내를 불러오지 못했습니다.' : '원료표의 추가 확인 사항을 불러오는 중입니다.'}</span>
    {status === 'error' ? <><span>기존 원료 확인 결과과 후보 목록은 유지됩니다.</span><button type="button" onClick={onRetry}>추가 확인 사항 다시 불러오기</button></> : null}
  </div>
}

export function IngredientListReason({ row, focused = false, shownPhrases = [] }: { row?: ListIngredientSource; focused?: boolean; shownPhrases?: string[] }) {
  const reading = ingredientDisclosureReading(row)
  const scope = ingredientSourceScope(row)
  if (!focused && row && scope.needsCheck) {
    return <span className="ingredient-list-reason"><strong>자료 적용 확인 필요</strong><span>{scope.label}</span></span>
  }
  if (focused) return <span className="ingredient-list-reason is-focused">
    <strong>{reading.listLabel}</strong>
    {row?.raw_text && scope.needsCheck ? <span>한국 제품에 적용 여부 미확인</span> : null}
    {ingredientWordingExamples(row).length ? ingredientWordingExamples(row).map(example => <span key={example}>{example}</span>) : row?.raw_text ? <span>세부 원료명은 원문에서 살펴보세요.</span> : null}
    {row?.raw_text ? <small>{scope.label}</small> : null}
  </span>
  const details = reading.details.filter(detail => !shownPhrases.includes(detail.phrase))
  const incomplete = reading.listLabel !== '전체 원료표 확인'
  if (!details.length && !incomplete) return null
  return <span className="ingredient-list-reason">
    {details.length ? <>
      <strong>원료표에서 더 확인할 점</strong>
      {details.slice(0, 2).map(detail => <span key={detail.phrase}>{detail.phrase} — {detail.note}</span>)}
    </> : null}
    {incomplete ? <span>{reading.listLabel}</span> : null}
  </span>
}
