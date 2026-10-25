# Public source links

Source links are disabled by default (`VITE_PUBLIC_SOURCE_LINKS_ENABLED=false`). Do not enable them until the dedicated public source RPCs and reviewed public source rows are approved and available. This flag does not enable decision collection.

The browser uses GET on `api.compare_product_nutrition_sources_scoped` or `api.compare_product_ingredients_sources_scoped`, always for one product ID. It requests only `product_id,field,source_url,publisher,checked_at`. The current SWITCH food stays separate from its five candidates. No catalogue-wide source fetch or global source cache is added.

Reads begin only when the enclosing native disclosure opens. Loaded results are reused during that mounted disclosure's lifetime; navigation may create a fresh disclosure. Closing an unfinished request or changing the product aborts it; late responses cannot replace the active product. An explicit retry follows a failed request and restores focus to the stable summary. Empty public results add no missing-value warning or placeholder source. Existing raw text, values, qualifiers and significant package/Formula exceptions remain available.

Comparison links live in the existing original-value/raw-source disclosures. When enabled their labels say “표기와 출처 보기” and “원문과 출처 보기” so the links are discoverable. In product detail, nutrition uses the original-value disclosure; ingredients group existing context and links under “출처 확인”, including raw-only lists. Unresolved Formula and partial-list cautions remain outside the collapsed area. The feature-disabled build keeps the existing labels and ingredient presentation.

Rows are validated for exact product, applicable field, unique field, timestamp and safe HTTPS URL. Unknown query parameters, credentials, local/numeric hosts, fragments and control characters are rejected. Same URL/check-date fields are grouped. The displayed site name follows the public hostname rather than treating the stored publisher as proof of official status. “CATFOOD 확인” is our check date, not a manufacturer update date. External links open separately without forwarding the exploration URL.

`tests/source-links.test.mjs` uses synthetic example.com references. Browser candidate verification may combine existing real public product reads with explicitly intercepted synthetic source responses because the source API is not yet deployed. Those results prove UI/request behavior, not live public-source publication. No private snapshots, SQL, internal IDs or unpublished provenance belong in this public repository or public artifacts.
