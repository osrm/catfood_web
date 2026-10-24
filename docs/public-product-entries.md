# Public product entries

Three reviewed identity entries live at `foods/aatu-salmon/`, `foods/go-lid-duck/` and `foods/natural-balance-indoor/`. Their initial HTML contains product identity, format, declared age, package image and real links. It is available without JavaScript. The directory is a small set of public entry pages, not the full catalog; full product search remains available.

With JavaScript, a product entry boots the existing App at the exact product detail, without an intermediate click. The existing detail fetches current public data and can start a current-food search. Bootstrap normalizes navigation to the project-root query URL so Home, back/forward, refresh and future navigation retain their existing contracts. Product metadata follows the displayed detail and is removed when leaving detail. Public entry URLs are the canonical addresses for these three identities; other details use their exact existing query URL.

`npm run build` generates these pages and `sitemap.xml` after Vite. It uses the already-built application assets and the checked-in public identity snapshot; it does not request the live API during builds. No new framework or server is needed. Set `CATFOOD_SITE_URL` to the public HTTPS project base ending in `/` when deploying at another canonical site; the default is the current GitHub Pages project.

`npm run refresh:entry-products` explicitly reads only the three published products and the identity/image/format/age fields using the same public API configuration. Inspect `data/entry-products.json` before committing updates. `retrievedAt` records when that snapshot was fetched, not a manufacturer update or verification date. No nutrition/source/private evidence snapshot is copied; current detail resources still use existing public APIs.

The Home link and directory provide crawlable anchors. The sitemap can be submitted through the site owner's search tools. Building or deploying a page is not evidence of indexing, search traffic, user demand or satisfaction. No prices, ratings, reviews or product suitability are invented for structured data.
