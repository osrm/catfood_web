import { useEffect, useState, useSyncExternalStore } from 'react'
import { JourneyDialog } from './JourneyReview'
import { activeCollectionPermission, collectionConfigured, expireCollectionPermission, loadCollectionPolicy, readCollectionState,
  setCollectionPurposes, stopAndDeleteCollection, subscribeCollectionState, type CollectionPurpose } from './collection-permission'
import './collection-preferences.css'

function duration(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400}일`
  if (seconds % 3600 === 0) return `${seconds / 3600}시간`
  if (seconds % 60 === 0) return `${seconds / 60}분`
  return `${seconds}초`
}
export default function CollectionPreferences() {
  const value = useSyncExternalStore(subscribeCollectionState, readCollectionState, readCollectionState)
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState<CollectionPurpose[]>([])
  useEffect(() => { void loadCollectionPolicy() }, [])
  useEffect(() => {
    if (value.status !== 'active' || !value.permission?.acceptUntil) return
    const timeout = setTimeout(expireCollectionPermission, Math.max(0, Date.parse(value.permission.acceptUntil) - Date.now()))
    return () => clearTimeout(timeout)
  }, [value.status, value.permission?.acceptUntil])
  if (!value.permission && !value.policy) return null
  const busy = value.status === 'deleting' || value.status === 'registering'
  const canStart = collectionConfigured() && Boolean(value.policy)
  const active = activeCollectionPermission() !== null
  const toggle = (purpose: CollectionPurpose) => setChoices(current => current.includes(purpose) ? current.filter(x => x !== purpose) : [...current, purpose])
  const change = value.permission && JSON.stringify([...value.permission.purposes].sort()) !== JSON.stringify([...choices].sort())
  const replacing = change || value.permission?.permissionId && !active && !value.deletionPending
  return <>
    <button type="button" className="collection-entry" onClick={() => { setChoices(value.permission?.purposes ?? []); setOpen(true) }}>기록 공유 설정</button>
    {open ? <JourneyDialog title="탐색 기록 공유" onClose={() => setOpen(false)}>
      <div className="collection-settings">
        <p>공유하지 않아도 검색·비교·메모는 그대로 이용할 수 있습니다.</p>
        {value.policy ? <>
          <fieldset disabled={busy || !canStart}>
            <legend>허용할 용도만 골라 주세요. <span>선택</span></legend>
            <label><input type="checkbox" checked={choices.includes('service_improvement')} onChange={() => toggle('service_improvement')} /><span><strong>서비스 개선</strong><small>선택한 조건과 후보를 살펴본 기록으로 불편한 흐름을 찾습니다.</small></span></label>
            <label><input type="checkbox" checked={choices.includes('data_product_research')} onChange={() => toggle('data_product_research')} /><span><strong>데이터 상품의 내부 연구</strong><small>어떤 기준으로 사료를 살피는지 집계해 활용 가능성을 검토합니다. 외부 제공·판매는 포함하지 않습니다.</small></span></label>
          </fieldset>
          <p className="collection-scope">적용 조건·후보 검토·직접 남긴 선택을 공유 시작 후 최대 {duration(value.policy.retentionSeconds)} 보관합니다. 메모·검색어는 보내지 않습니다.</p>
          <details className="collection-notice"><summary>보내는 내용과 보관·삭제 안내</summary>
            <p>전송을 중지한 기록도 삭제를 확인하기 전에는 보관 기한까지 남을 수 있습니다.</p>
            <p>아래에서 중지·삭제할 수 있습니다. 삭제 확인 뒤에도 늦은 재전송을 막는 최소 정보는 최대 24시간 남으며 정기 삭제됩니다.</p>
            <p>삭제에 필요한 정보는 이 탭에 보관합니다. 탭을 닫으면 직접 삭제할 수 없을 수 있으므로, 그 전에 삭제하거나 <a href={value.policy.contact} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">운영자에게 문의</a>해 주세요.</p>
            <p>처리 주체: {value.policy.operator}</p>
          </details>
        </> : <p>현재 새 공유는 중지되어 있습니다. 이전에 보낸 기록은 아래에서 삭제할 수 있습니다.</p>}
        <p className="collection-state">{active ? '선택한 용도로 공유 중입니다.' : '새 탐색 기록을 보내지 않습니다.'}</p>
        {value.message ? <p role="status">{value.message}</p> : null}
        {replacing ? <p>이전에 보낸 탐색 기록을 삭제하고 이후 기록부터 새로 공유합니다. 이 탭의 메모와 남긴 후보는 유지됩니다.</p> : null}
        <div className="collection-actions">
          {canStart && !value.deletionPending && (!active || change) ? <button type="button" className="primary-action" disabled={busy || !choices.length}
            onClick={() => { void setCollectionPurposes(choices) }}>{busy ? '처리 중…' : change ? '보낸 기록을 지우고 용도 변경' : replacing ? '보낸 기록을 지우고 다시 공유' : '선택한 용도로 공유 시작'}</button> : null}
          {value.permission ? <button type="button" className={value.deletionPending ? 'primary-action' : 'secondary-action'} disabled={value.status === 'deleting'} onClick={() => { void stopAndDeleteCollection() }}>{value.status === 'deleting' ? '삭제 확인 중…' : value.deletionPending ? '보낸 기록 삭제 다시 시도' : '공유 중지·보낸 기록 삭제'}</button>
            : <button type="button" className="secondary-action" disabled={busy} onClick={() => setOpen(false)}>공유하지 않고 닫기</button>}
        </div>
      </div>
    </JourneyDialog> : null}
  </>
}
