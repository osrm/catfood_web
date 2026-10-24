import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ages = { kitten: '키튼', adult: '성묘', senior: '시니어', all_life_stages: '전연령', gestation_lactation_and_kitten: '임신·수유·키튼' }
export function entryApplicationUrls(pageHref, application, productId) {
  const root = new URL('../../', pageHref)
  return {
    script: new URL(application.script.slice(2), root).href,
    stylesheet: new URL(application.stylesheet.slice(2), root).href,
    location: new URL(`?view=workspace&mode=lookup&detail=${encodeURIComponent(productId)}`, root).href,
  }
}
export function renderEntryPages(snapshot, siteUrl = 'https://osrm.github.io/catfood_web/', application = null) {
  const site = new URL(siteUrl)
  if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash || !site.pathname.endsWith('/')) throw new Error('Expected a public HTTPS site base ending in /')
  if (snapshot.version !== 1 || snapshot.products?.length !== 3) throw new Error('Expected the reviewed three-product entry snapshot')
  const slugs = new Set(), ids = new Set()
  for (const p of snapshot.products) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug) || !/^product_[a-f0-9]{16}$/.test(p.productId) || !p.brand || !p.name || slugs.has(p.slug) || ids.has(p.productId)) throw new Error('Invalid or duplicate product identity')
    if (p.image) { const u = new URL(p.image); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Invalid image URL') }
    slugs.add(p.slug); ids.add(p.productId)
  }
  if (application && (!/^\.\/assets\/[A-Za-z0-9_.-]+\.js$/.test(application.script) || !/^\.\/assets\/[A-Za-z0-9_.-]+\.css$/.test(application.stylesheet))) throw new Error('Expected built application assets')
  const html = (title, description, canonical, body, depth, productId = null) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}"><link rel="stylesheet" href="${depth}entry-pages.css"></head>
<body><div id="root"><div class="public-entry"><header><a class="wordmark" href="${depth}../">CATFOOD</a><nav aria-label="제품 탐색"><a href="${depth}./">제품별 정보</a><a href="${depth}../?view=workspace&amp;mode=lookup">제품 검색</a></nav></header><main>${body}</main></div></div>${productId && application ? `<script type="module">
const urls=(${entryApplicationUrls.toString()})(location.href,${JSON.stringify(application)},${JSON.stringify(productId)});
for(const link of document.querySelectorAll('a[href],link[href]'))link.setAttribute('href',link.href);
const style=document.createElement('link');style.rel='stylesheet';style.href=urls.stylesheet;
await new Promise((resolve,reject)=>{style.onload=resolve;style.onerror=reject;document.head.append(style)});
history.replaceState(history.state,'',urls.location);
await import(urls.script);
</script>` : ''}</body></html>\n`
  const result = new Map()
  const rows = snapshot.products.map(p => `<li><a class="product-row" href="${p.slug}/">${p.image ? `<img src="${escapeHtml(p.image)}" alt="" width="80" height="100">` : ''}<span><small>${escapeHtml(p.brand)}</small><strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.feedType ?? '형태 미확인')} · ${escapeHtml(ages[p.lifeStage] ?? '연령 미확인')}</span></span><span aria-hidden="true">→</span></a></li>`).join('')
  result.set('foods/index.html', html('고양이 사료 제품 정보 — CATFOOD', '고양이 사료의 제품 정보를 확인하고 현재 사료에서 다음 후보를 찾아보세요.', new URL('foods/', site), `<h1>제품 정보</h1><p>제품을 고르면 원재료와 영양 정보를 이어서 볼 수 있습니다.</p><ul class="product-list">${rows}</ul><a class="text-link" href="../?view=workspace&amp;mode=lookup">다른 제품 검색하기 →</a>`, ''))
  for (const p of snapshot.products) {
    const name = `${p.brand} ${p.name}`, detail = `../../?view=workspace&amp;mode=lookup&amp;detail=${p.productId}`
    result.set(`foods/${p.slug}/index.html`, html(`${name} — 제품 정보 | CATFOOD`, `${name}의 제품 표기를 확인하고 원재료·영양 정보를 살펴보세요.`, new URL(`foods/${p.slug}/`, site), `<a class="back" href="../">← 제품별 정보</a><article class="product-detail"><div>${p.image ? `<img class="package" src="${escapeHtml(p.image)}" alt="${escapeHtml(name)} 포장" width="220" height="280">` : ''}</div><div><p class="brand">${escapeHtml(p.brand)}</p><h1>${escapeHtml(p.name)}</h1><dl><div><dt>사료 형태</dt><dd>${escapeHtml(p.feedType ?? '미확인')}</dd></div><div><dt>대상 연령 표기</dt><dd>${escapeHtml(ages[p.lifeStage] ?? '미확인')}</dd></div></dl><a class="primary" href="${detail}">제품 정보 보기 →</a><p class="next">원재료와 영양을 살펴본 뒤, 이 사료를 기준으로 다음 후보를 찾을 수 있습니다.</p></div></article>`, '../', p.productId))
  }
  result.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['', 'foods/', ...snapshot.products.map(p => `foods/${p.slug}/`)].map(p => `<url><loc>${escapeHtml(new URL(p, site))}</loc></url>`).join('')}</urlset>\n`)
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const snapshot = JSON.parse(await fs.readFile('data/entry-products.json', 'utf8'))
  const appHtml = await fs.readFile('dist/index.html', 'utf8')
  const application = { script: appHtml.match(/src="(\.\/assets\/[^" ]+\.js)"/)?.[1], stylesheet: appHtml.match(/href="(\.\/assets\/[^" ]+\.css)"/)?.[1] }
  for (const [file, content] of renderEntryPages(snapshot, process.env.CATFOOD_SITE_URL, application)) {
    await fs.mkdir(path.dirname(path.join('dist', file)), { recursive: true })
    await fs.writeFile(path.join('dist', file), content)
  }
  console.log('Built three public product entry pages and sitemap from reviewed public identity snapshot.')
}
