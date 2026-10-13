# Contextual energy refinement

Energy is available in general EXPLORE results only after exactly one feed type and the official weight-management feature have been selected. It is optional and does not infer dieting intent, quality, safety or feeding amounts.

- Opening the control (or restoring a valid energyMax URL) lazily reads only energy and its evidence from the existing public nutrition view. No API/schema change. Sorted 1,000-row pages are read sequentially; duplicate/overlapping pages fail. The comparison helper's five-row limit is unchanged.
- Positive finite maximum kcal/100g, entered by the user, is applied on submit. No default threshold or low/normal/high badges. kg wins when both units exist and is divided by ten; no moisture/cup conversion.
- A missing/invalid value, unknown scope, different/unknown feed type, or unresolved formula correspondence stays in the list as unknown. These never count as passing the maximum. A supplemental energy value follows its own scope and formula confirmation, not the representative panel.
- Results display the energy value or unknown state. Original unit/value and energy-specific scope remain available in a closed disclosure. This is not confirmation that every sale package has the same value.
- Loading/failure of a restored bound blocks the filtered result list, preserves the bound/basket and offers manual retry or energy-only clearing. It never presents an unfiltered list or zero results as the applied result. Existing base catalog loading/error UI retains priority.
- Data is reused during this App instance across brands, recipes, bound edits, LOOKUP and detail/compare returns. No global/persistent cache. Fresh document load reads again. A successful catalog reload invalidates this local snapshot. Abort/active guards ignore late responses after leaving the context.
- Same-condition reapply, history and full URL restore preserve the bound and comparison order. Actual base changes and Home new exploration reset it. SWITCH does not serialize or apply general energy criteria.
- LOOKUP remains unfiltered. Manual comparison additions stay in the basket and receive a numeric difference/unknown relation. Different feed types are never classified by the selected energy bound.
- The decision-intake contract has no energy axis. Energy-bound runs and their consideration events are deliberately not recorded instead of being attached to an incomplete or older run. Clearing energy resumes the existing intake path. No intake/schema change is included.

Validation uses fixtures for failure, stale responses and pagination; candidate/Pages evidence uses public reads. Single observed endpoint timing is not a performance guarantee. People/device/browser research is outside this implementation.

