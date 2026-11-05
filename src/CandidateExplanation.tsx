import type { CandidateExplanation } from './candidate-explanation'
import './candidate-explanation.css'

export default function CandidateExplanationView({ value, compact = false, id }: { value: CandidateExplanation; compact?: boolean; id?: string }) {
  const Tag = compact ? 'span' : 'div'
  return <Tag id={id} className={`candidate-explanation${compact ? ' is-compact' : ''}`} role={compact ? undefined : 'group'} aria-label={compact ? undefined : '현재 사료와 연결해 보기'}>
    {([['kept', '유지되는 점', '유지할 조건을 따로 확인하지 않았습니다.'], ['differences', '확인한 차이', '현재 사료와 다르다고 확인한 항목이 없습니다.'], ['unknowns', '아직 모르는 점', '고르지 않은 조건과 실제 먹는 반응은 별도 확인이 필요합니다.']] as const).map(([key, label, empty]) => {
      const rows = value[key], limit = compact ? key === 'differences' ? 1 : 2 : rows.length
      return <Tag className={`candidate-explanation-group is-${key}`} key={key}><strong>{label}</strong><Tag>{rows.length ? rows.slice(0, limit).map(row => <span key={row}>{row}</span>) : <span>{empty}</span>}{rows.length > limit ? <small>추가 {rows.length - limit}개 · 빠른 보기에서 확인</small> : null}</Tag></Tag>
    })}
    {!compact && value.references.length ? <details><summary>이 설명에 사용한 자료 범위</summary>{value.references.map(row => <p key={row}>{row}</p>)}</details> : null}
  </Tag>
}
