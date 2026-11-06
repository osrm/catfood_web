# Reason-led switching

The current-food journey starts with what the consumer wants to inspect: ingredient wording, ingredient avoidance, declared energy, or directly chosen product criteria. This reading focus is optional and does not rank products, infer efficacy, or create hidden exclusion criteria.

The representative flow is current food/package → inspect source wording → explicitly choose any keep/change conditions → candidates with source-specific wording → ingredient comparison → retain, keep current, or remain undecided with the reason preserved.

## Input and evaluation boundaries

- A selected focus controls information visibility and the initial comparison tab. It does not change the catalog's ingredient verdicts or match evaluator. Source-wording inspection never becomes a transparency, quality, or safety score.
- Explicit energy focus opens the existing energy view at application. It does not select the lower-only filter, infer weight-management needs, or change feed-type conditions. Existing unknown and field-specific evidence guards remain.
- Ingredient avoidance still requires the consumer to choose terms. A named recipe or a personal symptom is not converted into an ingredient fact or exclusion.
- Personal reasons and observed positives are optional, limited to 200 characters each, and kept in the existing tab-local journey records. They are separate from product facts, filters, URL, navigation history, and intake payloads. A separate free-form parser or medical inference service is not introduced.
- A current-product reset clears observed positives associated with the previous product. Saved candidates retain their original context. Explicit new-start clears the existing journey, including purpose. Existing restart protection includes written purpose.

## Results and records

Source-wording focus initially reads visible candidate IDs through the existing minimal public source read. An explicit source-status view reads **all candidates under the current conditions and feed/recipe refinements**, in batches of 80. Its counts describe that universe before name search and energy filtering. A product beyond the first 40 can therefore be found using a source-status lens. Comparison selections and retained records are independent of the visible source-filtered list.

The view separates full-list material, partial/unknown list coverage, missing raw text, generic wording needing clarification, and unconfirmed Korean applicability. Coverage and additional checks overlap: a complete foreign list can also contain unspecified fish oil and have unconfirmed applicability. “Full list” never means every subingredient is named. Missing raw text never means ingredient absence or manufacturer non-disclosure. Supplemental material cannot fill a selected source's gaps.

No source lens or partial counts apply until every requested batch succeeds. Failure leaves the candidates visible and offers a source-only retry. The chosen source view survives comparison, reload and unchanged condition application; changed conditions, changing away from source focus or a new current product reset it. Without a saved source focus, restored source state cannot invisibly filter results. Its fixed label follows comparison, detail and historical decision context, with pending/failed status identified as unapplied. Source-view decisions remain local because the intake contract cannot represent this refinement; closing it cannot backfill those historical decisions as base-run choices. No collection flag is enabled.

The consumer can change focus, edit criteria, inspect all source material and use the existing compare tabs. Contextual controls fold after a focus is chosen; selected conditions and their unknown states remain accessible. No arbitrary candidate cutoff or inferred winner is introduced.

Current reading focus, reason and observed positives carry into comparison and are snapshotted when explicitly retaining a candidate or recording an outcome. Later purpose edits do not rewrite saved snapshots. Copy includes the reason and separately identifies observed positives as a consumer experience. Retention is not a purchase or feeding transition. No collection flag is enabled.

## Candidate decision explanations

With an explicit reading focus, candidate cards connect the current food and candidate through three groups: maintained facts, confirmed differences, and unanswered questions. They replace the separate condition block and focused source note. Quick view shows the complete explanation before actions; detail/comparison retention actions show it once. Compact cards mark additional items for quick view instead of silently dropping them.

Explanations use explicitly chosen conditions and existing catalog/source facts. Personal reasons and positives are never parsed into constraints or factual claims. Matching positive tags can be described as shared labels; a missing tag cannot prove absence or an improvement. Allowed adult/all-life-stage alternatives remain different age labels. Reviewed-not-found contrasts remain evidence results with an explicit absence caveat. Source wording compares quoted primary-source summaries, not ingredient equivalence, quality or safety; equal summaries do not prove equal formulas. Coverage, Korean applicability and package identity remain separate. Energy contrasts require known equal feed types, usable values and the energy field's own Korean/matched source, including supplemental scope.

The minimal source read includes seven public fields, adding `variant_id` to avoid implying that a representative source describes the selected current package. Current-source reads and retry are isolated from candidate-source counts. Candidate reads remain scoped to visible candidates, compared/selected/detail candidates, or the complete explicitly requested source-view universe. No selected candidate loses its explanation merely because a lens hides it.

Retaining a candidate snapshots the three groups and their public source-scope notes as optional tab-local data. Records and copy show them as the facts and gaps seen at that time. Later source/condition changes do not rewrite the historical explanation; explicitly removing and re-retaining a candidate refreshes the context and explanation for that new action. Malformed optional explanations are discarded without losing the saved candidate. Explanations never enter URLs, navigation history, intake payloads or inferred efficacy tags. Older records remain compatible. Card descriptions are connected through `aria-describedby`; browser QA checks page overflow and non-overlap between images, explanations and both actions.

## Comparison and visual hierarchy

Explicit ingredient-avoidance results precede general source and basic-fact differences in explanations, independently of the optional reading focus. Reviewed-not-found keeps its absence caveat in the same visible line; unresolved selected ingredients lead the unanswered questions. This prevents a compact card's one-difference/two-question limit from hiding the selected criterion behind a generic source summary. The existing bounds, full-source notes, evaluator, candidate order and historical snapshots remain unchanged.

Overview starts with known differences and grouped shared conditions; the full record is explicitly expandable. Pair/candidate controls and detail/removal actions remain available before expansion. Nutrition and ingredients use their primary comparisons, without a second stacked summary repeating the same values and source wording. The selected purpose appears once as shared context; long personal text is available in a disclosure.

Ingredient reading shows list coverage, actual wording examples and source applicability first. General explanations are available in a disclosure. This reduces repetition without removing interpretation-changing exceptions or claiming ingredient absence.

## Validation

App integration tests cover explicit reading focus, unchanged evaluators, source wording, initial comparison tab, historical snapshots, reload, invalid optional data, and absence of private text from history and intake. The browser review uses actual public products and synthetic personal text at 390, 768 and 1440 px, checks source wording, comparisons, retention, undecided outcome, copy, restoration and page overflow. This is automated evidence, not human user validation.
