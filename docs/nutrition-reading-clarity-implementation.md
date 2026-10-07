# Nutrition reading clarity implementation

This branch keeps nutrition values, units, min/max qualifiers, missing-value semantics and evidence scopes unchanged while changing where routine source-processing context is displayed.

Routine market, package/formula scope and supplemental-source context is available from a folded `원래 표기 보기` record. Interpretation-changing exceptions remain visible near the affected value: a known SWITCH use-package versus nutrition-package mismatch, unresolved current-formula matching, and separately based nutrition values.

Additional nutrients such as calcium and phosphorus remain ordinary comparison rows. Missing values remain `미확인` and are never converted to zero.

During nutrition comparison, the displayed product brand and full product name remain available in sticky column identity. This presentation change does not alter comparison order, URL state, evaluation, API requests or ingredient scrolling.
