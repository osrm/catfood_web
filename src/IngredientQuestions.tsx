import { useEffect, useState } from 'react'
import { fetchListIngredientSources, type ListIngredientSource } from './api'
import { JourneyDialog } from './JourneyDialog'
import { ingredientQuestions, ingredientQuestionsText, type IngredientQuestions, type QuestionProduct } from './ingredient-questions'
import './ingredient-questions.css'

export default function IngredientQuestionsButton({ product, source, avoidLabels = [], saved, onSave }: {
  product: QuestionProduct; source?: ListIngredientSource | null; avoidLabels?: string[]
  saved?: IngredientQuestions; onSave?: (value: IngredientQuestions) => void
}) {
  const [open, setOpen] = useState(false)
  return <><button className="journey-inline-action ingredient-questions-button" type="button" onClick={() => setOpen(true)}>{saved ? '저장한 질문 보기·수정' : '확인할 질문 정리하기'}</button>
    {open ? <QuestionDialog key={product.productId} product={product} source={source} avoidLabels={avoidLabels} saved={saved} onSave={onSave} onClose={() => setOpen(false)} /> : null}</>
}

function QuestionDialog({ product, source, avoidLabels, saved, onSave, onClose }: {
  product: QuestionProduct; source?: ListIngredientSource | null; avoidLabels: string[]; saved?: IngredientQuestions
  onSave?: (value: IngredientQuestions) => void; onClose: () => void
}) {
  const [draft, setDraft] = useState<IngredientQuestions | null>(saved ?? null)
  const [selected, setSelected] = useState<string[]>(saved?.items ?? [])
  const [loading, setLoading] = useState(!saved)
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [copyStatus, setCopyStatus] = useState('')
  const labelsKey = avoidLabels.join('\n')
  useEffect(() => {
    if (saved && refresh === 0) return
    const controller = new AbortController()
    setLoading(true); setError(false)
    const request = source !== undefined && refresh === 0 ? Promise.resolve(source) : fetchListIngredientSources([product.productId], controller.signal).then(rows => rows[0] ?? null)
    request.then(row => {
      if (controller.signal.aborted) return
      const next = ingredientQuestions(row, avoidLabels)
      setDraft(next); setSelected(next.items); setCopyStatus(''); setLoading(false)
    }).catch(() => { if (!controller.signal.aborted) { setError(true); setLoading(false) } })
    return () => controller.abort()
  }, [product.productId, source, labelsKey, refresh])
  const value = draft ? { ...draft, items: draft.items.filter(item => selected.includes(item)) } : null
  return <JourneyDialog title="제품 확인 질문" onClose={onClose}>
    <p><strong>{product.brand} · {product.name}</strong></p>
    <p>제조사·판매처 등에 확인할 질문 초안입니다. {onSave ? '필요한 질문을 골라 복사하거나 후보 기록에 남길 수 있습니다.' : '필요한 질문을 골라 복사해 직접 확인할 때 사용해 주세요.'}</p>
    {loading ? <p role="status">질문을 만들 자료를 확인하는 중입니다.</p> : null}
    {error ? <div role="alert"><p>새 원료 자료를 불러오지 못했습니다.{draft ? ' 기존 질문은 그대로 남아 있습니다.' : ' 자료 확인 후 질문을 만들 수 있습니다.'}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>자료 다시 불러오기</button></div> : null}
    {draft ? <><p className="question-source">질문 작성 때 살펴본 자료 · {draft.source}</p>
      <fieldset className="ingredient-question-options" disabled={loading}><legend>확인할 질문 선택</legend>{draft.items.map(item => <label key={item}><input type="checkbox" checked={selected.includes(item)} onChange={event => { setCopyStatus(''); setSelected(values => event.target.checked ? [...values, item] : values.filter(value => value !== item)) }} /><span>{item}</span></label>)}</fieldset>
      <textarea aria-label="복사할 제품 확인 질문" readOnly rows={9} value={value ? ingredientQuestionsText(product, value) : ''} onFocus={event => event.target.select()} />
      <p className="journey-note">확인하려고 정리한 질문입니다. 아직 답변이나 원료의 부재를 확인한 내용은 아닙니다.</p>
      <div className="question-actions"><button className="secondary-action" type="button" disabled={loading || !selected.length} onClick={async () => {
        if (!value) return
        try { if (!navigator.clipboard) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(ingredientQuestionsText(product, value)); setCopyStatus('질문을 복사했습니다.') }
        catch { setCopyStatus('위 내용을 선택해 직접 복사해 주세요.') }
      }}>질문 복사</button>
      {onSave ? <button className="primary-action" type="button" disabled={loading || !selected.length} onClick={() => { if (value) { onSave(value); onClose() } }}>후보 기록에 질문 남기기</button> : null}</div>
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
      {saved ? <button className="journey-inline-action" type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>현재 자료로 질문 다시 만들기</button> : null}
    </> : null}
    <p className="journey-note">{onSave ? '질문은 이 탭에만 저장됩니다. 필요하면 따로 복사해 두세요.' : '복사한 질문은 직접 확인할 때 사용해 주세요.'}</p>
  </JourneyDialog>
}
