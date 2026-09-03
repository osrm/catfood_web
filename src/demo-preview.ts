import {
  DEMO_INGREDIENTS,
  DEMO_MANUFACTURING,
  DEMO_MARKETS,
  DEMO_NUTRITION,
  DEMO_PRODUCTS,
  DEMO_VARIANTS,
} from './demo-data'

export function isDemoPreview(): boolean {
  return new URLSearchParams(window.location.search).get('demo') === '1'
}

function repairSvgDataUrl(value: string | null): string | null {
  if (!value?.startsWith('data:image/svg+xml')) return value
  const separator = value.indexOf(',')
  if (separator < 0) return value

  try {
    const prefix = value.slice(0, separator + 1)
    const svg = decodeURIComponent(value.slice(separator + 1))
    const escaped = svg.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;')
    return `${prefix}${encodeURIComponent(escaped)}`
  } catch {
    return value
  }
}

const DEMO_PREVIEW_PRODUCTS = DEMO_PRODUCTS.map((product) => ({
  ...product,
  display_image_url: repairSvgDataUrl(product.display_image_url),
}))

function productIdsFromFilter(value: string | null): string[] | null {
  if (!value) return null
  if (value.startsWith('eq.')) return [value.slice(3)]
  if (value.startsWith('in.(') && value.endsWith(')')) {
    return value.slice(4, -1).split(',').filter(Boolean)
  }
  return null
}

export function installDemoPreviewFetch(): void {
  if (!isDemoPreview()) return

  document.documentElement.dataset.demoPreview = 'true'
  const nativeFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = input instanceof Request ? input.url : input.toString()
    const url = new URL(requestUrl, window.location.href)
    const view = url.pathname.split('/').filter(Boolean).at(-1)

    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    let rows: unknown[] | null = null
    if (view === 'effective_product_catalog_summary') rows = DEMO_PREVIEW_PRODUCTS
    if (view === 'switch_current_variant_options') rows = DEMO_VARIANTS
    if (view === 'compare_product_nutrition') rows = DEMO_NUTRITION
    if (view === 'compare_product_ingredients') rows = DEMO_INGREDIENTS
    if (view === 'product_detail_manufacturing') rows = DEMO_MANUFACTURING
    if (view === 'product_detail_markets') rows = DEMO_MARKETS

    if (!rows) return nativeFetch(input, init)

    const ids = productIdsFromFilter(url.searchParams.get('product_id'))
    const filtered = ids
      ? rows.filter((row) => {
          if (!row || typeof row !== 'object' || !('product_id' in row)) return false
          return ids.includes(String((row as { product_id: unknown }).product_id))
        })
      : rows

    return new Response(JSON.stringify(filtered), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }
}
