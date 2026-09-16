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

const wheelStart = source.indexOf('async function wheelUntilVisible(c, selector, matcher = null) {')
const wheelEnd = source.indexOf('async function inspectClearanceState(c) {', wheelStart)
assert.ok(wheelStart >= 0 && wheelEnd > wheelStart)
const diagnosticWheel = `async function wheelUntilVisible(c, selector, matcher = null) {
  const attempts = []
  for (let i = 0; i < 30; i++) {
    const evidence = await elementEvidence(c, selector, matcher)
    const owner = await ownerSnapshot(c, selector)
    const geometry = await c.eval(\`(()=>{
      const xs=[...document.querySelectorAll(\${q(selector)})]
      const n=\${matcher ? \`xs.find(x=>x.textContent.includes(\${q(matcher)}))\` : 'xs[0]'}
      const dock=document.querySelector('.switch-compare-dock')
      const inspector=document.querySelector('.switch-inspector-scroll')
      const workspace=document.querySelector('.switch-results-workspace')
      const doc=document.scrollingElement
      const rect=x=>x?(()=>{const r=x.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})():null
      const hit=n?(()=>{const r=n.getBoundingClientRect(),x=Math.max(2,Math.min(innerWidth-2,r.left+r.width/2)),y=Math.max(2,Math.min(innerHeight-2,r.top+r.height/2)),h=document.elementFromPoint(x,y);return h?{tag:h.tagName,className:typeof h.className==='string'?h.className:'',text:h.textContent?.trim().slice(0,80)??''}:null})():null
      return{exists:Boolean(n),nodeRect:rect(n),dockRect:rect(dock),inspectorRect:rect(inspector),workspaceRect:rect(workspace),hit,doc:{scrollTop:doc.scrollTop,scrollHeight:doc.scrollHeight,clientHeight:doc.clientHeight,maxScroll:doc.scrollHeight-doc.clientHeight},inspector:inspector?{scrollTop:inspector.scrollTop,scrollHeight:inspector.scrollHeight,clientHeight:inspector.clientHeight,maxScroll:inspector.scrollHeight-inspector.clientHeight,overflowY:getComputedStyle(inspector).overflowY}:null,workspace:workspace?{scrollTop:workspace.scrollTop,scrollHeight:workspace.scrollHeight,clientHeight:workspace.clientHeight,maxScroll:workspace.scrollHeight-workspace.clientHeight,overflowY:getComputedStyle(workspace).overflowY}:null}
    })()\`)
    attempts.push({ i, evidence, owner, geometry })
    if (evidence?.inViewport && evidence.pointerAccessible) return evidence
    assert.ok(evidence, \`missing \${selector}\`)
    assert.ok(owner)
    const x = Math.max(4, Math.min(innerWidth - 4, (owner.rect.left + owner.rect.right) / 2))
    const y = Math.max(4, Math.min(innerHeight - 4, (owner.rect.top + owner.rect.bottom) / 2))
    await wheel(c, x, y, evidence.rect.top < 0 ? -800 : 800)
  }
  writeFileSync(\`\${OUT}/wheel-until-visible-diagnostic.json\`, JSON.stringify({ selector, matcher, attempts }, null, 2))
  throw new Error(\`could not reach \${selector}\`)
}

`
source = source.slice(0, wheelStart) + diagnosticWheel + source.slice(wheelEnd)

const generated = new URL('./.generated-switch-compare-dock-clearance-qa.mjs', import.meta.url)
writeFileSync(generated, source)

globalThis.outerWidth = Number.MAX_SAFE_INTEGER
globalThis.innerWidth = 760
globalThis.innerHeight = Number.MAX_SAFE_INTEGER
await import(generated.href)
