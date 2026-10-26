import { useEffect, useState } from 'react'
import { fetchCompareIngredients, type CompareIngredients } from './api'
import { ingredientComposition } from './ingredient-composition'
import './ingredient-composition.css'

export function IngredientCompositionValue({ row, loading, error, onRetry }: {
  row?: CompareIngredients | null; loading?: boolean; error?: string | null; onRetry?: () => void
}) {
  if (error) return <span>원재료를 불러오지 못했습니다.{onRetry ? <button type="button" onClick={onRetry}>다시 시도</button> : null}</span>
  if (loading) return <span>원재료 불러오는 중</span>
  const data = ingredientComposition(row)
  const groups: Array<[string, string[]]> = [['육류·어류',data.protein],['지방·오일',data.fats],['계란·유제품',data.eggsDairy],['향미',data.flavor]]
  if (!groups.some(([,values]) => values.length)) return null
  return <span className="ingredient-composition">{groups.filter(([,values]) => values.length).map(([label,values]) => <span className="ingredient-composition-line" key={label}><small>{label}</small><span>{values.join(' · ')}</span></span>)}</span>
}

// Used only for an opened inspector; never for every search-result card.
export default function IngredientComposition({ productId }: { productId: string }) {
  const [result,setResult] = useState<{ id: string; row: CompareIngredients | null; error: string | null; loading: boolean }>({ id:'',row:null,error:null,loading:true })
  const [retry,setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setResult({id:productId,row:null,error:null,loading:true})
    fetchCompareIngredients([productId],controller.signal).then(rows => {
      if (!controller.signal.aborted) setResult({id:productId,row:rows[0] ?? null,error:null,loading:false})
    }).catch(() => { if (!controller.signal.aborted) setResult({id:productId,row:null,error:'failed',loading:false}) })
    return () => controller.abort()
  },[productId,retry])
  return <IngredientCompositionValue row={result.id===productId ? result.row : null} loading={result.id!==productId || result.loading} error={result.id===productId ? result.error : null} onRetry={() => setRetry(value=>value+1)} />
}
