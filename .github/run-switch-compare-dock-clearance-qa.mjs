// The focused QA helper computes viewport coordinates in Node from browser-provided rects.
// Mobile-only removal assertions run at 360/390, so 760 preserves the intended mobile branch
// while the other clamps remain neutral for browser-provided coordinates.
globalThis.outerWidth = Number.MAX_SAFE_INTEGER
globalThis.innerWidth = 760
globalThis.innerHeight = Number.MAX_SAFE_INTEGER
await import('./switch-compare-dock-clearance-qa.mjs')
