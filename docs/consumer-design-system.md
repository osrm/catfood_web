# Consumer frontend design

All five screen families share SiteHeader and pinned Pretendard Variable. Product identity, readable facts and existing actions lead; evidence remains available on demand. The paper background is white, text and product-brand facts are neutral, enabled primary actions use a paprika accent, selected products and active navigation use slate, and comparison energy graphics use gray. These roles do not rank products or imply suitability.

## Stylesheet ownership

main.tsx imports seven stylesheets in order: styles.css, home.css, research-ui.css, product-detail.css, compare.css, switch-workflow.css, and catalog-design-refresh.css. The first six retain structural, responsive and interaction rules. catalog-design-refresh.css owns the shared visual treatment and its screen-specific typography/composition adjustments; its --atlas-* tokens are the active design roles. Shared structural controls continue to use --cf-*.

Edit the current rules in their owner rather than importing another historical refinement stylesheet or creating a separate theme per screen. Check computed styles where existing selectors overlap; a source declaration alone does not establish the rendered result.

## Reading and interaction

HOME begins with search, followed by the two existing entry paths and actual catalog records. Package images identify products alongside full names, form/age and representative selling-package facts. Examples come from the loaded public catalog and are not recommendations. Existing empty/error/loading states, search handlers and reading-guide focus behavior remain.

Product identity precedes actions and facts. Detail comparison actions use the existing handlers and five-product cap. Returning from detail preserves basket changes. SWITCH keeps its own current product, selected package and candidate basket.

Nutrition units, minimum/maximum qualifiers, missing values, item-level supplemental evidence, Product/SKU/Formula and market scopes remain. Original ingredients and reviewed reading-help mappings remain. Mobile nutrition keeps two values together; ingredients retain the reviewed horizontal alignment and keyboard behavior.

## Validation

Use a production build with public read data. Install write/analytics guards before the first navigation and await data, fonts and visible images before capturing evidence. Verify changed composition at narrow, intermediate and desktop widths, long names and controls; check the state contracts affected by the actual change. Numeric row counts and contrast measurements support review but do not prove visual brand quality.

Record source SHA and distinguish candidate evidence from deployed Pages evidence. Draft PR review does not authorize merge, deployment or a human study.
