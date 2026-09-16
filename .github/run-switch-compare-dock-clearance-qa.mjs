import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const headCss = `/* Keep bottom content reachable above the fixed SWITCH compare dock.
   The reserved scroll space is the dock footprint plus its viewport offset
   and a small clearance. It only exists while the dock is rendered. */
.switch-results-stage:has(> .switch-compare-dock) {
  --switch-compare-dock-height: 66px;
  --switch-compare-dock-bottom: 18px;
  --switch-compare-dock-gap: 16px;
  --switch-compare-dock-clearance: calc(
    var(--switch-compare-dock-height) +
    var(--switch-compare-dock-bottom) +
    var(--switch-compare-dock-gap)
  );
}

.switch-results-stage:has(> .switch-compare-dock) > .switch-compare-dock {
  min-height: var(--switch-compare-dock-height);
  bottom: var(--switch-compare-dock-bottom);
}

@media (min-width: 761px) {
  .switch-results-stage:has(> .switch-compare-dock) .switch-candidate-list::after,
  .switch-results-stage:has(> .switch-compare-dock) .switch-inspector-scroll::after {
    content: "";
    display: block;
    height: var(--switch-compare-dock-clearance);
    pointer-events: none;
  }
}

@media (max-width: 760px) {
  .switch-workflow-shell .switch-results-stage:has(> .switch-compare-dock) {
    padding-bottom: calc(22px + var(--switch-compare-dock-clearance));
  }
}
`

const sourcePath = new URL('./switch-compare-dock-clearance-qa.mjs', import.meta.url)
let source = readFileSync(sourcePath, 'utf8')
const originalSignature = 'async function enterResults(c, base) {'
assert.equal(source.includes(originalSignature), true)
source = source.replace(originalSignature, 'async function enterResults(c, base, applyHeadCss = false) {')
const originalNav = '  await c.nav(`${base}?view=workspace&mode=switch`)\n'
const replacementNav = `${originalNav}  if (applyHeadCss) {\n    const css=${JSON.stringify(headCss)}\n    await c.eval(\`(()=>{const style=document.createElement('style');style.id='qa-head-dock-clearance';style.textContent=\${JSON.stringify(css)};document.head.appendChild(style);return style.textContent.length})()\`)\n  }\n`
assert.equal(source.includes(originalNav), true)
source = source.replace(originalNav, replacementNav)
const targetCall = 'await enterResults(c, TARGET)'
const targetCalls = source.split(targetCall).length - 1
assert.ok(targetCalls >= 2, `expected target calls, found ${targetCalls}`)
source = source.replaceAll(targetCall, 'await enterResults(c, BASELINE, true)')
const cleanupLine = "  rmSync(handle.dir, { recursive: true, force: true })\n"
assert.equal(source.includes(cleanupLine), true)
source = source.replace(cleanupLine, "  try { rmSync(handle.dir, { recursive: true, force: true }) } catch {}\n")

const generated = new URL('./.generated-switch-compare-dock-clearance-qa.mjs', import.meta.url)
writeFileSync(generated, source)

globalThis.outerWidth = Number.MAX_SAFE_INTEGER
globalThis.innerWidth = 760
globalThis.innerHeight = Number.MAX_SAFE_INTEGER
await import(generated.href)
