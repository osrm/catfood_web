import { useState } from 'react'
import { journeyCopyText, type JourneyRecords } from './journey-records'
import { JourneyDialog } from './JourneyDialog'
import IngredientQuestionsButton from './IngredientQuestions'
import type { IngredientQuestions } from './ingredient-questions'
import { INGREDIENT_AVOID_LABELS } from './search'
import { DecisionPurposeSummary } from './DecisionPurpose'
import CandidateExplanationView from './CandidateExplanation'
import './journey-review.css'
export { JourneyDialog } from './JourneyDialog'

export function JourneyCopy({ records, onClose }: { records: JourneyRecords; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return <JourneyDialog title="검토 기록 복사" onClose={onClose}><p>이 탭에서 이어볼 수 있습니다. 필요하면 따로 복사해 두세요.</p>
    <textarea aria-label="복사할 검토 기록" readOnly value={journeyCopyText(records)} onFocus={(event) => event.target.select()} rows={12} />
    <button type="button" className="primary-action" onClick={() => { void navigator.clipboard?.writeText(journeyCopyText(records)).then(() => setCopied(true)).catch(() => setFailed(true)); if (!navigator.clipboard) setFailed(true) }}>기록 복사</button>
    {copied ? <p role="status">복사했습니다.</p> : failed ? <p role="status">위 내용을 선택해 직접 복사해 주세요.</p> : null}</JourneyDialog>
}
export function JourneyMemo({ value, onSave, onClose, title = '찾으면서 기억해 둘 점' }: { title?: string; value: string; onSave: (value: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value)
  return <JourneyDialog title={title} onClose={onClose}><p>기억해 둘 내용이 있으면 적어 두세요. 조건이나 결과는 바뀌지 않습니다.</p>
    <label>내 메모 <span>(선택, 200자)</span><textarea maxLength={200} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="예: 요즘 잘 안 먹어서 다른 사료도 알아보는 중" /></label>
    <p className="journey-note">메모는 이 탭 안에만 남고 서버로 보내지 않습니다.</p><button type="button" className="primary-action" onClick={() => { onSave(draft); onClose() }}>메모 남기기</button></JourneyDialog>
}
export function JourneyRecordsPanel({ records, selectionKey, storageAvailable, onNote, onRemove, onOutcome, onQuestions }: {
  records: JourneyRecords; selectionKey: string; storageAvailable: boolean
  onNote: (id: string, value: string) => void; onRemove: (id: string) => void
  onOutcome: (kind: 'keep_current' | 'undecided') => void
  onQuestions?: (id: string, value?: IngredientQuestions) => void
}) {
  const [copy, setCopy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = records.retained.find((row) => row.id === editingId)
  const active = records.retained.filter((row) => row.active)
  return <details className="journey-records" id="journey-records" tabIndex={-1} aria-label="남긴 후보와 이번 정리" open={active.length > 0 || Boolean(records.outcome) || !storageAvailable}>
    <summary>남긴 후보와 이번 정리 <span>{active.length}/5</span></summary>
    <div className="journey-panel-heading"><button className="secondary-action" type="button" onClick={() => setCopy(true)}>기록 복사</button></div>
    <p className="journey-note">{storageAvailable ? '이 탭에서만 보관합니다. 탭을 닫기 전 필요하면 복사해 두세요.' : '브라우저 저장을 사용할 수 없어 새로고침하면 기록을 잃을 수 있습니다. 필요한 기록은 복사해 두세요.'}</p>
    {active.length ? <ul>{active.map((row) => <li key={row.id}>
      <div className="journey-panel-heading"><strong>{row.candidate.brand} · {row.candidate.name}</strong><button className="journey-inline-action" type="button" onClick={() => onRemove(row.id)}>남긴 후보에서 제거</button></div>
      {row.context.selectionKey !== selectionKey ? <strong className="journey-old-context">이전 기준에서 남긴 후보</strong> : null}
      <p className="journey-note">기준: {row.context.current.brand} · {row.context.current.name} · {row.context.variantLabel}</p>
      {row.context.purpose ? <p className="journey-note">이 후보를 남길 때의 이유와 경험</p> : null}<DecisionPurposeSummary purpose={row.context.purpose} compact />
      <details><summary>당시 조건과 내 메모</summary><p>{row.context.labels.join(' · ') || '따로 고른 조건 없음'}</p><p>{row.note || '작성한 메모 없음'}</p><button className="journey-inline-action" type="button" onClick={() => setEditingId(row.id)}>후보 메모 {row.note ? '수정' : '쓰기'}</button></details>
      {row.explanation ? <details className="saved-candidate-explanation"><summary>남길 때 확인한 내용 · 당시 자료 기준</summary><CandidateExplanationView value={row.explanation} /></details> : null}
      <div className="saved-ingredient-questions">{row.checkQuestions ? <><strong>확인하려고 남긴 질문</strong><p>직접 확인할 때 사용할 질문 초안입니다.</p><p>질문을 남길 때 살펴본 자료 · {row.checkQuestions.source}</p><ol>{row.checkQuestions.items.map(item => <li key={item}>{item}</li>)}</ol></> : null}
        <IngredientQuestionsButton product={row.candidate} saved={row.checkQuestions} avoidLabels={row.context.criteria.filter(item => item.axis === 'ingredient' && item.role === 'ingredient_avoid').map(item => INGREDIENT_AVOID_LABELS[item.value] ?? item.value)} onSave={onQuestions ? value => onQuestions(row.id, value) : undefined} />
        {row.checkQuestions && onQuestions ? <button className="journey-inline-action" type="button" onClick={() => onQuestions(row.id)}>저장한 질문 지우기</button> : null}
      </div>
    </li>)}</ul> : <p>아직 남긴 후보가 없습니다. 후보 상세나 비교 화면에서 남길 수 있습니다.</p>}
    <div className="journey-outcome"><strong>이번에는 어떻게 정리할까요? (선택)</strong><DecisionPurposeSummary purpose={records.outcome?.context.purpose ?? records.purpose} compact /><div>
      <button className="secondary-action" type="button" aria-pressed={records.outcome?.kind === 'keep_current' && records.outcome.context.selectionKey === selectionKey} onClick={() => onOutcome('keep_current')}>지금 사료 유지</button>
      <button className="secondary-action" type="button" aria-pressed={records.outcome?.kind === 'undecided' && records.outcome.context.selectionKey === selectionKey} onClick={() => onOutcome('undecided')}>아직 못 고름</button></div><small>고른 뒤에도 계속 살펴볼 수 있습니다.</small>
      {records.outcome && records.outcome.context.selectionKey !== selectionKey ? <p>이전 기준의 정리: {records.outcome.kind === 'keep_current' ? '지금 사료 유지' : '아직 못 고름'} · {records.outcome.context.current.brand} {records.outcome.context.current.name}</p> : null}
    </div>{copy ? <JourneyCopy records={records} onClose={() => setCopy(false)} /> : null}{editing ? <JourneyMemo title="후보 메모" value={editing.note} onSave={(note) => onNote(editing.id, note)} onClose={() => setEditingId(null)} /> : null}
  </details>
}
