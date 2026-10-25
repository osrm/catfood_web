import { useEffect, useRef, useState } from 'react'
import { fetchPublicSources, isPublicSourceLinksEnabled, type PublicSourceReference, type SourceResource } from './api'
import './source-links.css'

const FIELD_LABELS: Record<string, string> = {
  energy: '열량', protein: '조단백질', fat: '조지방', fiber: '조섬유', moisture: '수분', ash: '조회분',
  additional_nutrients: '추가 영양성분', basis_specific_nutrition: '다른 기준 영양값',
  ingredients: '원재료', supplemental_ingredients: '다른 자료의 전체 원재료',
}
const SITE_NAMES: Record<string, string> = {
  'aatu.co.kr': 'AATU', 'go-solutions.com': 'GO! SOLUTIONS', 'lifet.co.kr': '라이펫',
  'mamacat.co.kr': '마마캣', 'm.mamacat.co.kr': '마마캣', 'naturalbalance.co.kr': '내추럴발란스', 'treatsfactory.jp': 'TREATS FACTORY',
}
function groupedSources(rows: PublicSourceReference[]) {
  const groups = new Map<string, { url: string; date: string; fields: string[]; site: string }>()
  for (const row of rows) {
    const date = new Date(row.checked_at).toISOString().slice(0, 10)
    const key = `${row.source_url}\n${date}`
    const host = new URL(row.source_url).hostname.replace(/^www\./, '')
    const group = groups.get(key) ?? { url: row.source_url, date, fields: [], site: SITE_NAMES[host] ?? host }
    group.fields.push(row.field)
    groups.set(key, group)
  }
  const order = Object.keys(FIELD_LABELS)
  const result = [...groups.values()]
  for (const group of result) group.fields.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return result.sort((a, b) => order.indexOf(a.fields[0]) - order.indexOf(b.fields[0]))
}
type Load = { key: string; status: 'loading' | 'loaded' | 'error'; rows: PublicSourceReference[] }

/** Lives inside an existing native disclosure. No source request until that disclosure opens. */
export default function SourceLinks({ productId, resource }: { productId: string; resource: SourceResource }) {
  const enabled = isPublicSourceLinksEnabled()
  const key = `${productId}:${resource}`
  const container = useRef<HTMLDivElement>(null)
  const current = useRef<Load | null>(null)
  const [load, setLoad] = useState<Load | null>(null)
  const [open, setOpen] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const disclosure = container.current?.closest('details')
    if (!disclosure) return
    const update = () => setOpen(disclosure.open)
    update()
    disclosure.addEventListener('toggle', update)
    return () => disclosure.removeEventListener('toggle', update)
  }, [enabled, key])
  useEffect(() => {
    if (!enabled || !open || !container.current?.closest('details')?.open) return
    if (current.current?.key === key && ['loaded', 'error'].includes(current.current.status)) return
    const controller = new AbortController()
    const update = (value: Load) => { current.current = value; setLoad(value) }
    update({ key, status: 'loading', rows: [] })
    fetchPublicSources(productId, resource, controller.signal).then((rows) => {
      if (!controller.signal.aborted) update({ key, status: 'loaded', rows })
    }).catch(() => {
      if (!controller.signal.aborted) update({ key, status: 'error', rows: [] })
    })
    return () => controller.abort()
  }, [enabled, open, key, productId, resource, retry])
  if (!enabled) return null
  const active = load?.key === key ? load : null
  const groups = active?.status === 'loaded' ? groupedSources(active.rows) : []
  return <div ref={container} className="source-links" aria-live="polite">
    {active?.status === 'loading' ? <p>출처를 불러오는 중입니다.</p> : null}
    {active?.status === 'error' ? <div className="source-links-error"><p>출처 링크를 불러오지 못했습니다.</p><button type="button" onClick={() => {
      container.current?.closest('details')?.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true })
      current.current = null
      setRetry((value) => value + 1)
    }}>다시 시도</button></div> : null}
    {groups.length ? <ul aria-label="출처 링크">{groups.map((group) => <li key={`${group.url}:${group.date}`}>
      <span>{group.fields.map((field) => FIELD_LABELS[field]).join(' · ')}</span>
      <a href={group.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`${group.site} 자료 열기 (새 탭)`}>{group.site} <span aria-hidden="true">↗</span></a>
      <time dateTime={group.date}>CATFOOD 확인 · {group.date.replaceAll('-', '.')}</time>
    </li>)}</ul> : null}
  </div>
}
