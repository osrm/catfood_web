# Current-food entry and combined criteria editor

The current product and package are selected in one search workspace. Selecting a product opens its package options directly. Only an actual package selection or explicit unknown selection can continue. A repeated click on the same product keeps its loaded package state; changing the product invalidates dependent state and stale responses.

CHANGE and KEEP are edited together. KEEP is never inferred from merely viewing current facts. CHANGE clears only conflicting KEEP axes. Applying unchanged criteria retains the candidate basket and search; changed applied criteria use the existing reset policy. Unselected and explicit no-change intent remain distinct.

Persisted V1 `current`, `sku`, `change`, `keep`, and `results` steps remain readable. `current`/`sku` share the product/package workspace, and `change`/`keep` share the criteria editor. No storage version or evaluator change is required.

General product detail can start SWITCH with that exact product. The package must still be confirmed. If the same current product already has a search, the action resumes it. Another product cannot replace an existing search or journey records without an explicit replacement action. Cancel leaves the current search unchanged. Browser back returns to the original product detail.

An empty local review panel starts collapsed. Retained candidates or an explicit outcome open the panel; unavailable tab storage keeps its warning visible. Expanding the panel does not create an outcome. Compare, retained candidate, keep-current, and undecided remain separate actions. Remote collection stays controlled by the existing disabled-by-default flag.
