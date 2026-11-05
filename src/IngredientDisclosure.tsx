import type { CompareIngredients } from './api'
import { ingredientDisclosureReading, ingredientSourceScope } from './ingredient-disclosure'
import './ingredient-disclosure.css'

// List coverage and unspecified source wording remain independent facts.
export default function IngredientDisclosure({ row }: { row: CompareIngredients }) {
  const reading = ingredientDisclosureReading(row)
  return <span className="ingredient-disclosure" role="group" aria-label="원료 정보 확인 범위">
    <span className="ingredient-disclosure-row"><small>원료표 확보</small><strong>{reading.listLabel}</strong></span>
    <span className="ingredient-disclosure-note">{reading.listExplanation}</span>
    <span className="ingredient-disclosure-row ingredient-source-scope"><small>자료 범위</small><strong>{ingredientSourceScope(row).label}</strong></span>
    {reading.details.length ? <>
      <span className="ingredient-disclosure-row"><small>세부 종류</small><strong>{reading.label}</strong></span>
      {reading.details.map(item => <span className="ingredient-disclosure-example" key={item.phrase}><q>{item.phrase}</q><span>{item.note}</span></span>)}
      <span className="ingredient-disclosure-note">확인한 원료표의 표현입니다. 특정 원료의 포함 여부는 별도로 확인해야 합니다.</span>
    </> : row.completeness_status === 'full' && row.raw_text?.trim() ? <span className="ingredient-disclosure-note">{reading.explanation}</span> : null}
  </span>
}
