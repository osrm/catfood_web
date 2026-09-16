import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const sourcePath = new URL('./switch-compare-dock-clearance-qa.mjs', import.meta.url)
let source = readFileSync(sourcePath, 'utf8')

// Chrome can still be finishing profile writes after the browser process exits.
// Profile deletion is not part of the product assertion, so do not fail QA on that race.
const cleanupLine = "  rmSync(handle.dir, { recursive: true, force: true })\n"
assert.equal(source.includes(cleanupLine), true)
source = source.replace(cleanupLine, "  try { rmSync(handle.dir, { recursive: true, force: true }) } catch {}\n")

// The old helper jumped 800px at a time and oscillated between the document
// maximum and a dock-covered position. Keep using trusted wheel input, but move
// only the distance needed to put the target inside the unobscured viewport.
const wheelStart = source.indexOf('async function wheelUntilVisible(c, selector, matcher = null) {')
const wheelEnd = source.indexOf('async function inspectClearanceState(c) {', wheelStart)
assert.ok(wheelStart >= 0 && wheelEnd > wheelStart)
const adaptiveWheel = `async function wheelUntilVisible(c, selector, matcher = null) {
  for (let i = 0; i < 40; i++) {
    const evidence = await elementEvidence(c, selector, matcher)
    assert.ok(evidence)
    const dockTop = await c.eval(\`document.querySelector('.switch-compare-dock')?.getBoundingClientRect().top ?? innerHeight\`)
    const safeTop = 16
    const safeBottom = Math.min(Number(dockTop) - 16, Number(innerHeight) - 16)
    if (evidence.rect.top >= safeTop && evidence.rect.bottom <= safeBottom && evidence.pointerAccessible) return evidence
    const owner = await ownerSnapshot(c, selector)
    assert.ok(owner)
    const x = Math.max(4, Math.min(Number(innerWidth) - 4, (owner.rect.left + owner.rect.right) / 2))
    const y = Math.max(4, Math.min(Number(innerHeight) - 4, (owner.rect.top + owner.rect.bottom) / 2))
    let deltaY
    if (evidence.rect.top < safeTop) {
      deltaY = -Math.min(320, Math.max(64, safeTop - evidence.rect.top + 24))
    } else {
      deltaY = Math.min(320, Math.max(64, evidence.rect.bottom - safeBottom + 24))
    }
    const before = owner.scrollTop
    await wheel(c, x, y, deltaY)
    const after = await ownerSnapshot(c, selector)
    if (after.scrollTop === before && !(evidence.rect.top >= safeTop && evidence.rect.bottom <= safeBottom)) {
      throw new Error(\`scroll owner stalled for \${selector}: \${JSON.stringify({ evidence, owner, deltaY })}\`)
    }
  }
  throw new Error(\`could not reach \${selector}\`)
}

`
source = source.slice(0, wheelStart) + adaptiveWheel + source.slice(wheelEnd)

// Verify the reserved space against the measured dock footprint instead of the
// CSS constants alone. Mobile reserves document space; desktop reserves space
// inside the existing candidate/inspector scrollers.
const gapAssertion = "    assert.ok(maxEvidence.gap >= 16, `expected >=16px dock gap, got ${maxEvidence.gap}`)\n"
assert.equal(source.includes(gapAssertion), true)
source = source.replace(gapAssertion, `${gapAssertion}    const dockBottomOffset = height - maxEvidence.dockRect.bottom\n    const reservedClearance = width <= 760 ? Number.parseFloat(maxEvidence.stagePaddingBottom) - 22 : Number.parseFloat(maxEvidence.listAfter.height)\n    const requiredClearance = maxEvidence.dockRect.height + dockBottomOffset + 16\n    assert.ok(reservedClearance + 0.5 >= requiredClearance, \`reserved \${reservedClearance}px < measured requirement \${requiredClearance}px\`)\n`)
const targetReturn = '    return { candidate, owner, maxEvidence, pointerLoadMore, lowerAccess, keyboard, network: await networkReport(c) }\n'
assert.equal(source.includes(targetReturn), true)
source = source.replace(targetReturn, '    return { candidate, owner, maxEvidence, clearance: { dockHeight: maxEvidence.dockRect.height, dockBottomOffset, reservedClearance, requiredClearance }, pointerLoadMore, lowerAccess, keyboard, network: await networkReport(c) }\n')

const boundaryStart = source.indexOf('async function runBoundary(width, height, mobile) {')
const boundaryEnd = source.indexOf('\nconst report = {', boundaryStart)
assert.ok(boundaryStart >= 0 && boundaryEnd > boundaryStart)
const boundaryFunction = `async function runBoundary(width, height, mobile) {
  const h = await launch(width, height, mobile); const c = h.c
  try {
    await enterResults(c, TARGET)
    await addFirstCandidate(c)
    const owner = await wheelToEnd(c, '.load-more')
    const evidence = await inspectLoadMore(c)
    assert.ok(evidence?.fullyAboveDock && evidence.pointerAccessible, \`\${width}: \${JSON.stringify(evidence)}\`)
    const dockBottomOffset = height - evidence.dockRect.bottom
    const reservedClearance = width <= 760 ? Number.parseFloat(evidence.stagePaddingBottom) - 22 : Number.parseFloat(evidence.listAfter.height)
    const requiredClearance = evidence.dockRect.height + dockBottomOffset + 16
    assert.ok(reservedClearance + 0.5 >= requiredClearance, \`\${width}: reserved \${reservedClearance}px < measured requirement \${requiredClearance}px\`)

    await wheelToStart(c, '.switch-candidate-row')
    const first = await elementEvidence(c, '.switch-candidate-row')
    assert.ok(first?.inViewport && first.pointerAccessible, \`\${width}: first candidate unavailable \${JSON.stringify(first)}\`)
    await trustedPointClick(c, '.switch-candidate-row', null, false)
    await c.wait(\`document.querySelector('.switch-candidate-inspector')\`, 'boundary inspector')
    const inspectorActionOwner = await ownerSnapshot(c, '.switch-inspector-actions .switch-compare-action')
    assert.ok(inspectorActionOwner)
    if (width <= 760) assert.equal(inspectorActionOwner.tag, 'HTML')
    else if (width >= 1280) assert.equal(inspectorActionOwner.className.includes('switch-inspector-scroll'), true, \`\${width}: \${JSON.stringify(inspectorActionOwner)}\`)
    const inspectorAction = await wheelUntilVisible(c, '.switch-inspector-actions .switch-compare-action')
    assert.ok(inspectorAction.inViewport && inspectorAction.pointerAccessible)
    const bodyOverflow = await c.eval(\`getComputedStyle(document.body).overflowY\`)
    return { owner, evidence, clearance: { dockHeight: evidence.dockRect.height, dockBottomOffset, reservedClearance, requiredClearance }, inspectorActionOwner, inspectorAction, bodyOverflow, network: await networkReport(c) }
  } finally { await cleanup(h) }
}
`
source = source.slice(0, boundaryStart) + boundaryFunction + source.slice(boundaryEnd)

const generated = new URL('./.generated-switch-compare-dock-clearance-qa.mjs', import.meta.url)
writeFileSync(generated, source)

globalThis.outerWidth = Number.MAX_SAFE_INTEGER
globalThis.innerWidth = 760
globalThis.innerHeight = Number.MAX_SAFE_INTEGER
await import(generated.href)
