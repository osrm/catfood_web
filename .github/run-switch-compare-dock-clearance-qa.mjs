// The focused QA helper computes coordinates in Node from browser-provided rects.
// These large bounds keep its clamps neutral; the rect centers remain browser viewport coordinates.
globalThis.outerWidth = Number.MAX_SAFE_INTEGER
globalThis.innerHeight = Number.MAX_SAFE_INTEGER
await import('./switch-compare-dock-clearance-qa.mjs')
