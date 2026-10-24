import entries from '../data/entry-products.json'
import type { CatalogProduct } from './api'

// Entry pages boot the same App at the project root. Metadata must follow
// actual navigation instead of retaining a previous product's canonical.
export function setProductMetadata(product: CatalogProduct) {
  const base = new URL(window.location.pathname, window.location.origin)
  const entry = entries.products.find(row => row.productId === product.product_id)
  const canonical = entry ? new URL(`foods/${entry.slug}/`, base) : new URL(`?view=workspace&mode=lookup&detail=${encodeURIComponent(product.product_id)}`, base)
  const title = `${product.brand} ${product.canonical_name} — 제품 정보 | CATFOOD`
  const description = `${product.brand} ${product.canonical_name}의 원재료와 영양 정보를 확인하세요.`
  const meta = (selector: string, attributes: Record<string, string>) => {
    let element = document.head.querySelector<HTMLElement>(selector)
    if (!element) { element = document.createElement(selector.startsWith('link') ? 'link' : 'meta'); document.head.append(element) }
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
  }
  document.title = title
  meta('meta[name="description"]', { name: 'description', content: description })
  meta('link[rel="canonical"]', { rel: 'canonical', href: canonical.href })
  meta('meta[property="og:title"]', { property: 'og:title', content: title })
  meta('meta[property="og:description"]', { property: 'og:description', content: description })
  meta('meta[property="og:url"]', { property: 'og:url', content: canonical.href })
  return () => {
    document.title = 'CATFOOD — 고양이 사료 정보'
    meta('meta[name="description"]', { name: 'description', content: '고양이 사료의 원재료와 영양 정보를 살펴보고 현재 사료에서 다음 후보를 찾아보세요.' })
    document.head.querySelector('link[rel="canonical"]')?.remove()
    for (const property of ['og:title', 'og:description', 'og:url']) document.head.querySelector(`meta[property="${property}"]`)?.remove()
  }
}
