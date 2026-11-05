import { SOURCE_FILTERS, type IngredientSourceFilter } from './ingredient-source-filter'
import './ingredient-source-filter.css'

export default function IngredientSourceFilterPanel({ value, total, counts, status, displayed, onChange, onRetry }: {
  value: IngredientSourceFilter; total: number; counts: Map<IngredientSourceFilter, number>; status: string; displayed: number
  onChange: (value: IngredientSourceFilter) => void; onRetry: () => void
}) {
  if (value === 'off') return <div className="source-filter-entry"><button type="button" onClick={() => onChange('all')}>원료표 상태로 살펴보기</button><span>현재 조건의 후보 전체에서 확인합니다.</span></div>
  const ready = status === 'loaded'
  return <section className="ingredient-source-filter" aria-label="원료표 상태로 살펴보기">
    <header><h2>확보한 원료표로 나눠 보기</h2><button type="button" onClick={() => onChange('off')}>원료표 보기 닫기</button></header>
    <p>현재 조건의 후보 {total.toLocaleString('ko-KR')}개 전체 기준입니다. 이름 검색과 열량 조건은 아래 목록에 함께 적용됩니다.</p>
    {!ready ? <div role={status === 'error' ? 'alert' : 'status'}>
      <p>{status === 'error' ? '원료표 상태를 모두 불러오지 못했습니다. 원료표 조건은 적용하지 않고 후보를 보여줍니다.' : '후보 전체의 원료표 상태를 확인 중입니다. 아직 원료표 조건을 적용하지 않았습니다.'}</p>
      {status === 'error' ? <button type="button" onClick={onRetry}>원료표 상태 다시 불러오기</button> : null}
    </div> : null}
    <div className="source-filter-options" role="group" aria-label="원료표 보기 기준">{SOURCE_FILTERS.map(([key, label]) => <button key={key} type="button" disabled={!ready} aria-pressed={value === key} onClick={() => onChange(key)}><span>{label}</span>{ready ? <strong>{counts.get(key) ?? 0}개</strong> : null}</button>)}</div>
    {ready ? <p className="source-filter-result" role="status">선택한 원료표 기준과 검색 조건으로 {displayed.toLocaleString('ko-KR')}개 후보를 살펴봅니다.</p> : null}
    <details><summary>이 기준은 어떻게 읽나요?</summary><p>전체 목록이 있어도 어유의 어종이나 향료의 세부 구성까지 적혀 있다는 뜻은 아닙니다. 확인한 자료의 범위와 표기 예를 함께 살펴보세요.</p><p>목록 상태와 추가 확인 항목은 서로 겹칠 수 있습니다. 원문 미확보는 원료가 없거나 제조사가 공개하지 않았다는 판정이 아닙니다.</p></details>
  </section>
}
