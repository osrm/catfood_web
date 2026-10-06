# Consumer frontend design

All five screen families share SiteHeader and pinned Pretendard Variable body text. HOME and comparison use a limited Noto Serif KR400/500 title role from the official Google Fonts CDN. Product identity, readable facts and existing actions lead; evidence remains available on demand. The canvas uses warm paper, record surfaces are white, text and product-brand facts are neutral, enabled primary actions use deep green, selection/navigation retain their separate slate role, and energy graphics use gray. These roles do not rank products or imply suitability.

## Stylesheet ownership

main.tsx imports seven stylesheets in order: styles.css, home.css, research-ui.css, product-detail.css, compare.css, switch-workflow.css, and catalog-design-refresh.css. The first six retain structural, responsive and interaction rules. catalog-design-refresh.css owns the shared visual treatment and its screen-specific typography/composition adjustments; its --atlas-* tokens are the active design roles. Shared structural controls continue to use --cf-*.

Edit the current rules in their owner rather than importing another historical refinement stylesheet or creating a separate theme per screen. Check computed styles where existing selectors overlap; a source declaration alone does not establish the rendered result.

## Reading and interaction

HOME begins with a wide search area, followed by two subordinate entry paths and actual white catalog records. Title, package photography and full product names form the visual hierarchy. Package images identify products alongside full names, form/age and representative selling-package facts. Examples come from the loaded public catalog and are not recommendations. Existing empty/error/loading states, search handlers and reading-guide focus behavior remain.

Product identity precedes actions and facts. Detail comparison actions use the existing handlers and five-product cap. Returning from detail preserves basket changes. SWITCH keeps its own current product, selected package and candidate basket. Candidate photos align with the full product name; the basket uses a compact white surface and primary action rather than a large dark overlay. Desktop basket content shares one row; mobile retains selected-name context below the count/action and reserves matching bottom clearance.

Nutrition units, minimum/maximum qualifiers, missing values, item-level supplemental evidence, Product/SKU/Formula and market scopes remain. Original ingredients and reviewed reading-help mappings remain. General mobile overview/nutrition reduces enclosing boxes and vertical rules, using horizontal separators and label/value hierarchy. Mobile nutrition keeps two values together; ingredients retain the reviewed horizontal alignment and keyboard behavior.

## Validation

Use a production build with public read data. Install write/analytics guards before the first navigation and await data, fonts and visible images before capturing evidence. Verify changed composition at narrow, intermediate and desktop widths, long names and controls; check the state contracts affected by the actual change. Numeric row counts and contrast measurements support review but do not prove visual brand quality.

Record source SHA and distinguish candidate evidence from deployed Pages evidence. Draft PR review does not authorize merge, deployment or a human study.

## Design provenance

The latest Stitch native screens were inspected and were not approved as complete screens: they invented archive copy, facts/features and inconsistent comparison chrome. Limited serif/sans roles, HOME composition and its actual warm-paper/deep-green treatment inform the implementation. Keeping Pretendard body text and simplifying comparison are Codex interpretations. Native source and actual React candidate evidence are kept separately; no human/design approval is implied.

## Comparison reading choices

Comparison keeps overview as the default and preserves applied criteria and tab/history. Nutrition starts with the exact provided/normalized values; a local format button enables the existing zero-based, common-axis energy graphic. This does not rank products, infer health or change values, order or URLs. A closed min/max explanation appears only when known min/max amounts exist in the displayed products; qualifiers with missing amounts do not trigger it. Mobile uses its displayed pair/current+candidate; desktop uses all shown columns. Evidence, original units and item-level supplemental scopes remain. These are reversible design judgments informed by decision research, not measured improvements in human preference, understanding or choice. The independent concept with a large photo stage, energy-first secondary navigation and a 22 kcal difference headline is not adopted.
