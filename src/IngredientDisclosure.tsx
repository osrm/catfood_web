import type { CompareIngredients } from './api'
import { ingredientDisclosureReading, ingredientSourceScope, ingredientWordingExamples } from './ingredient-disclosure'
import './ingredient-disclosure.css'

// List coverage and unspecified source wording remain independent facts.
export default function IngredientDisclosure({ row, sourceContext }: { row: CompareIngredients; sourceContext?: string }) {
  const reading = ingredientDisclosureReading(row)
  return <span className="ingredient-disclosure" role="group" aria-label="원료 정보 확인 범위">
    {reading.details.length
      ? reading.details.map(item => <span className="ingredient-disclosure-example" key={item.phrase}><q>{item.phrase}</q><span>{item.note}</span></span>)
      : ingredientWordingExamples(row).map(example => <span className="ingredient-disclosure-example" key={example}>{example}</span>)}
    <span className="ingredient-disclosure-row"><small>확인한 원료표</small><strong>{reading.listLabel}</strong></span>
    <span className="ingredient-disclosure-row ingredient-source-scope"><small>자료 범위</small><strong>{ingredientSourceScope(row).label}</strong></span>
    <details className="ingredient-disclosure-help">
      <summary>확인 범위 읽는 법</summary>
      {sourceContext ? <span className="ingredient-disclosure-note">{sourceContext}</span> : null}
      <span className="ingredient-disclosure-note">{reading.listExplanation}</span>
      <span className="ingredient-disclosure-note">{reading.explanation}</span>
    </details>
  </span>
}
