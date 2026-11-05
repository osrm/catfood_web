import { useEffect, useMemo, useState } from 'react'
import { fetchExploreEnergy, fetchEnergyPackages, type CatalogProduct, type ExploreEnergy, type EnergyPackage } from './api'
import { energyAmount, energyText, usableEnergy } from './energy-refine'
import { nutritionInterpretationNote } from './nutrition-reading'

export function useSwitchEnergy(enabled: boolean) {
  const [rows, setRows] = useState<ExploreEnergy[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!enabled || status === 'loaded') return
    const controller = new AbortController()
    setStatus('loading')
    fetchExploreEnergy(controller.signal).then(data => {
      if (!controller.signal.aborted) { setRows(data); setStatus('loaded') }
    }).catch(() => { if (!controller.signal.aborted) setStatus('error') })
    return () => controller.abort()
  }, [enabled, retry])
  const byProduct = useMemo(() => new Map(rows.map(row => [row.product_id, row])), [rows])
  return { byProduct, status, retry: () => setRetry(value => value + 1) }
}

function energyScope(row?: ExploreEnergy) {
  return row?.supplemental_nutrition_fields?.includes('energy') ? row.supplemental_observation_scope : row?.observation_scope
}

export function energyVariantId(row?: ExploreEnergy) {
  // The API has no supplemental variant ID; the primary panel ID cannot identify that source.
  return energyScope(row) === 'variant' && !row?.supplemental_nutrition_fields?.includes('energy') ? row?.variant_id : null
}

export function useEnergyPackages(rows: Array<ExploreEnergy | undefined>) {
  const key = [...new Set(rows.map(energyVariantId).filter((id): id is string => Boolean(id)))].sort().join(',')
  const [result, setResult] = useState<{ key: string; rows: EnergyPackage[]; status: 'loaded' | 'error' }>({ key: '', rows: [], status: 'loaded' })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    fetchEnergyPackages(key.split(','), controller.signal).then(data => {
      if (!controller.signal.aborted) setResult({ key, rows: data, status: 'loaded' })
    }).catch(() => { if (!controller.signal.aborted) setResult({ key, rows: [], status: 'error' }) })
    return () => controller.abort()
  }, [key, retry])
  const status = !key ? 'loaded' : result.key === key ? result.status : 'loading'
  const packages = useMemo(() => new Map(result.rows.map(row => [row.variant_id, row])), [result.rows])
  return { packages, status, retry: () => setRetry(value => value + 1) }
}

export function switchEnergyDifference(current: CatalogProduct, candidate: CatalogProduct, baseline?: ExploreEnergy, row?: ExploreEnergy) {
  if (!['건식', '습식', '동결건조'].includes(current.feed_type ?? '') || candidate.feed_type !== current.feed_type) return null
  const before = usableEnergy(baseline), after = usableEnergy(row)
  return before == null || after == null ? null : Number((after - before).toPrecision(12))
}

export function keepsLowerEnergyCandidate(current: CatalogProduct, candidate: CatalogProduct, baseline?: ExploreEnergy, row?: ExploreEnergy) {
  if (candidate.feed_type && ['건식', '습식', '동결건조'].includes(candidate.feed_type) && candidate.feed_type !== current.feed_type) return false
  const difference = switchEnergyDifference(current, candidate, baseline, row)
  return difference == null || difference < 0
}

export function EnergyEvidence({ row, packages, packageStatus, currentVariantId }: {
  row?: ExploreEnergy; packages: Map<string, EnergyPackage>; packageStatus: string; currentVariantId?: string | null
}) {
  if (!row || energyAmount(row) == null) return null
  const scope = energyScope(row)
  const market = row.supplemental_nutrition_fields?.includes('energy') ? row.supplemental_market_code : row.market_code
  const variantId = energyVariantId(row)
  const found = variantId ? packages.get(variantId) : undefined
  const label = found?.product_id === row.product_id ? found.package_size_text : null
  const source = scope === 'variant'
    ? label ? `근거 포장 · ${label}` : variantId && packageStatus === 'loading' ? '근거 포장 용량 확인 중' : variantId && packageStatus === 'error' ? '근거 포장 용량 조회 실패' : '근거 포장 용량 미확인'
    : scope === 'formula' ? '같은 배합으로 확인한 자료' : scope === 'product' ? '제품에 대해 확인한 자료' : '자료 범위 미확인'
  return <span className="switch-energy-evidence">
    <span>{nutritionInterpretationNote(row, 'energy') ?? source}{market ? ` · ${market === 'KR' ? '한국' : market} 자료` : ''}</span>
    {variantId && currentVariantId && variantId !== currentVariantId ? <span>사용 규격과 다른 포장에서 확인</span> : null}
  </span>
}

export function CandidateEnergy({ current, candidate, baseline, row, packages, packageStatus }: {
  current: CatalogProduct; candidate: CatalogProduct; baseline?: ExploreEnergy; row?: ExploreEnergy
  packages: Map<string, EnergyPackage>; packageStatus: string
}) {
  const amount = usableEnergy(row), rawAmount = energyAmount(row)
  const difference = switchEnergyDifference(current, candidate, baseline, row)
  const sameFeed = current.feed_type && current.feed_type === candidate.feed_type
  return <span className="switch-candidate-energy">
    <strong>{amount == null ? '열량 비교 미확인' : energyText(amount)}</strong>
    <span>{difference != null ? difference === 0 ? '현재 표기값과 같음' : `현재 표기값보다 100g당 ${Math.abs(difference).toLocaleString('ko-KR')} kcal ${difference < 0 ? '낮음' : '높음'}` : !sameFeed ? '사료 형태가 다르거나 미확인 · 차이 비교 안 함' : '현재 사료와의 열량 차이 미확인'}</span>
    {amount == null && rawAmount != null ? <span>참고 표기 · {energyText(rawAmount)}</span> : null}
    <EnergyEvidence row={row} packages={packages} packageStatus={packageStatus} />
  </span>
}
