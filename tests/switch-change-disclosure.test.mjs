import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const flow = await readFile(new URL('../src/SwitchFlow.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/switch-change-disclosure.css', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('mobile CHANGE disclosure counts only additional change selections', () => {
  const helper = flow.slice(
    flow.indexOf('function additionalChangeLabels'),
    flow.indexOf('function buildConditions'),
  )
  for (const token of ['criteria.lifeStage', 'ingredientAvoidTerms', 'criteria.officialTargets', 'criteria.features', 'criteria.recipeFamilies', 'criteria.grainFree']) {
    assert.match(helper, new RegExp(token.replace('.', '\\.')))
  }
  assert.doesNotMatch(helper, /changeBrand|criteria\.feedType/)
})

test('mobile CHANGE disclosure preserves explicit user control and re-entry initialization', () => {
  assert.match(flow, /aria-expanded=\{changeAdditionalOpen\}/)
  assert.match(flow, /aria-controls=\{additionalControlsId\}/)
  assert.match(flow, /hidden=\{!changeAdditionalOpen\}/)
  assert.match(flow, /onClick=\{\(\) => setChangeAdditionalOpen\(\(value\) => !value\)\}/)
  assert.match(flow, /if \(step === 'change' && previousStep !== 'change'\)/)
  assert.match(flow, /setChangeAdditionalOpen\(additionalChangeLabels\(change, ingredientAvoidTerms\)\.length > 0\)/)
  assert.match(flow, /\}, \[step\]\)/)
})

test('mobile-only presentation leaves desktop criteria available above 760px', () => {
  assert.match(css, /\.switch-change-mobile-criteria \{\s*display: none;/)
  assert.match(css, /@media \(max-width: 760px\)/)
  assert.match(css, /\.switch-change-desktop-criteria \{\s*display: none;/)
  assert.doesNotMatch(css, /position:\s*(?:fixed|sticky)/)
  assert.match(main, /import '\.\/switch-change-disclosure\.css'/)
  assert.match(main, /document\.addEventListener\('scroll', syncCompareScroll, true\)/)
})

test('existing CHANGE gating and no-change clearing contract remains in place', () => {
  assert.match(flow, /const hasChange = changeBrand \|\| criteriaCount\(change\) > 0 \|\| ingredientAvoidTerms\.length > 0/)
  assert.match(flow, /disabled=\{!hasChange && !noChangeIntent\}/)
  assert.match(flow, /setChange\(EMPTY_CRITERIA\)[\s\S]*setChangeBrand\(false\)[\s\S]*setIngredientAvoidTerms\(\[\]\)/)
})
