# Consumer frontend design

All production screens share `SiteHeader` and the `--cf-*` tokens in `styles.css`: warm white background, white surfaces, dark text, neutral dividers, red actions, and Noto Sans KR. Red marks an action or selection; it does not rank products or imply suitability.

## Stylesheet ownership

`main.tsx` loads six stylesheets in order: `styles.css` (tokens and shared controls/header), `home.css`, `research-ui.css` (EXPLORE/LOOKUP and quick view), `product-detail.css`, `compare.css`, and `switch-workflow.css`. Existing structural rules, responsive layouts and focus handling are consolidated into those owners. Historical refinement/override files remain in Git for reference but are not imported; do not resume layering them over the shared theme.

## Reading and interaction

HOME begins with search and two paths, followed by actual catalog examples. Example products come from the loaded public catalog, are labeled as examples, and are not recommendations. Empty/error/loading states stay explicit.

Product identity precedes actions and facts. Detail comparison actions use the existing comparison handlers and five-product cap. Returning from detail preserves changes to the basket. SWITCH keeps its own current product, selected package and candidate basket.

Nutrition units, minimum/maximum qualifiers, missing values, item-level supplemental evidence, Product/SKU/Formula and market scopes are unchanged. Original ingredients and the existing reviewed reading-help mappings are preserved. Mobile nutrition keeps two values together; ingredients retain the reviewed horizontal alignment and keyboard behavior.

## Validation

Use the production build with public read data at 390 x 844 and 1440 x 900. Install write/analytics guards before the first navigation. Check all five screen families plus detail/basket return, current-food selection, condition context and ingredient scroll. Record local candidate evidence separately from deployed Pages evidence. Draft PR review does not authorize merge or deployment.
