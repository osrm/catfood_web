import { useEffect } from 'react'

export interface CatalogIngredientLoad {
  status: 'idle' | 'loading' | 'error' | 'loaded'
  onRequest: () => void
  onRetry: () => void
}

export function useCatalogIngredients(load: CatalogIngredientLoad | undefined, needed = true) {
  useEffect(() => {
    if (needed && load?.status === 'idle') load.onRequest()
  }, [needed, load?.status, load?.onRequest])
}

export function CatalogIngredientNotice({ load }: { load?: CatalogIngredientLoad }) {
  if (!load || load.status === 'loaded') return null
  return <div className="catalog-inline-state" role={load.status === 'error' ? 'alert' : 'status'}>
    <span>{load.status === 'error' ? '원료 확인 정보를 불러오지 못했습니다.' : '원료 확인 정보를 불러오는 중입니다.'}</span>
    {load.status === 'error' ? <button className="state-retry" type="button" onClick={load.onRetry}>다시 시도</button> : null}
  </div>
}
