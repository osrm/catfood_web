import { useState } from 'react'
import type { DecisionPurpose } from './journey-records'
import './decision-purpose.css'

export const PURPOSE_OPTIONS = [
  ['disclosure', '원료가 얼마나 구체적으로 적혀 있는지', '어유의 어종처럼, 표기된 내용과 모르는 부분을 비교해요.'],
  ['ingredients', '피하고 싶은 원료가 들어 있는지', '피할 원료는 직접 고르고, 미발견과 미확인을 나눠 봐요.'],
  ['energy', '지금 사료와 표기 열량이 얼마나 다른지', '같은 형태의 열량과 근거 포장을 비교해요.'],
  ['other', '다른 기준을 직접 정하고 싶어요', '브랜드·형태·레시피 등의 조건을 직접 정할 수 있어요.'],
] as const

export function purposeLabel(purpose?: DecisionPurpose | null) {
  return PURPOSE_OPTIONS.find(([key]) => key === purpose?.focus)?.[1] ?? ''
}

export function DecisionPurposeEditor({ value, onChange }: { value?: DecisionPurpose; onChange: (value: DecisionPurpose) => void }) {
  const purpose = value ?? { focus: null, reason: '', positives: '' }
  const [showAll, setShowAll] = useState(false)
  return <section className="decision-purpose-editor" aria-labelledby="purpose-title">
    <h2 id="purpose-title">이번에는 무엇을 확인하고 싶나요?</h2>
    <div className="decision-purpose-options">{PURPOSE_OPTIONS.filter(([focus]) => !purpose.focus || showAll || focus === purpose.focus).map(([focus, label, hint]) => <button key={focus} type="button" aria-pressed={purpose.focus === focus} onClick={() => { onChange({ ...purpose, focus: purpose.focus === focus ? null : focus }); setShowAll(false) }}>
      <span className="decision-purpose-check" aria-hidden="true">{purpose.focus === focus ? '✓' : ''}</span><span><strong>{label}</strong><small>{hint}</small></span>
    </button>)}</div>
    {purpose.focus ? <button className="purpose-change-focus" type="button" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? '다른 정보 접기' : '살펴볼 정보 바꾸기'}</button> : null}
    <details className="decision-purpose-writing">
      <summary>내 말로 이유와 좋았던 점 남기기 <span>(선택)</span></summary>
      <label>사료를 바꾸려는 이유<textarea maxLength={200} rows={2} value={purpose.reason} onChange={event => onChange({ ...purpose, reason: event.target.value })} placeholder="예: 원료가 구체적으로 적힌 다른 사료도 알아보고 싶어요" /></label>
      <label>지금 사료에서 좋았던 점<textarea maxLength={200} rows={2} value={purpose.positives} onChange={event => onChange({ ...purpose, positives: event.target.value })} placeholder="예: 잘 먹었고, 건식으로 먹이는 게 편했어요" /></label>
      <p>적은 경험은 제품의 효능이나 검색 조건으로 바꾸지 않습니다. 이 탭에서만 보관합니다.</p>
    </details>
  </section>
}

export function DecisionPurposeSummary({ purpose, compact = false }: { purpose?: DecisionPurpose | null; compact?: boolean }) {
  if (!purpose || !purpose.focus && !purpose.reason && !purpose.positives) return null
  return <div className={`decision-purpose-summary${compact ? ' is-compact' : ''}`}>
    {purpose.focus ? <p><span>이번에 살펴볼 점</span><strong>{purposeLabel(purpose)}</strong></p> : null}
    {purpose.reason || purpose.positives ? <details><summary>내가 남긴 이유와 경험</summary>
      {purpose.reason ? <p><span>바꾸려는 이유</span>{purpose.reason}</p> : null}
      {purpose.positives ? <><p><span>지금 사료에서 좋았던 점</span>{purpose.positives}</p><small>보호자가 남긴 경험입니다. 다음 제품의 같은 반응을 보장하지 않습니다.</small></> : null}
    </details> : null}
  </div>
}
