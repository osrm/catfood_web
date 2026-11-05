import type { CompareIngredients } from './api'
import { ingredientDisclosureReading, ingredientSourceScope, ingredientWordingExamples } from './ingredient-disclosure'
import './ingredient-disclosure.css'

// List coverage and unspecified source wording remain independent facts.
export default function IngredientDisclosure({ row }: { row: CompareIngredients }) {
  const reading = ingredientDisclosureReading(row)
  return <span className="ingredient-disclosure" role="group" aria-label="원료 정보 확인 범위">
    <span className="ingredient-disclosure-row"><small>원료표 확보</small><strong>{reading.listLabel}</strong></span>
    <span className="ingredient-disclosure-row ingredient-source-scope"><small>자료 범위</small><strong>{ingredientSourceScope(row).label}</strong></span>
    {reading.details.length ? <>
      <span className="ingredient-disclosure-row"><small>세부 종류</small><strong>표기에서 더 확인할 점</strong></span>
      {reading.details.map(item => <span className="ingredient-disclosure-example" key={item.phrase}><q>{item.phrase}</q><span>{item.note}</span></span>)}
    </> : ingredientWordingExamples(row).map(example => <span className="ingredient-disclosure-example" key={example}>{example}</span>)}
    <details className="ingredient-disclosure-help"><summary>확인 범위 읽는 법</summary><span className="ingredient-disclosure-note">{reading.listExplanation}</span><span className="ingredient-disclosure-note">{reading.explanation}</span></details>
  </span>
}
