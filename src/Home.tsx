import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { fetchCatalog, type CatalogProduct } from './api'

type HomeMode = 'switch' | 'explore' | 'lookup'

const LIFE_STAGE_LABELS: Record<string, string> = {
  kitten: '키튼',
  adult: '성묘',
  senior: '시니어',
  all_life_stages: '전연령',
  gestation_lactation_and_kitten: '임신·수유·키튼',
}

const TARGET_LABELS: Record<string, string> = {
  indoor: '실내묘',
  sterilized: '중성화묘',
}

const RECIPE_FAMILY_LABELS: Record<string, string> = {
  poultry: '가금류',
  meat: '육류',
  fish: '생선',
}

const INGREDIENT_LABELS: Record<string, string> = {
  chicken: '닭',
  duck: '오리',
  turkey: '칠면조',
  beef: '소',
  lamb: '양',
  rabbit: '토끼',
  salmon: '연어',
  tuna: '참치',
  herring: '청어',
  mackerel: '고등어',
  trout: '송어',
  cod: '대구',
  pork: '돼지',
  venison: '사슴',
  sardine: '정어리',
  anchovy: '멸치',
  shrimp: '새우',
  egg: '계란',
}

function label(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replaceAll('_', ' ')
}

function compact(values: string[], labels: Record<string, string>, max = 2): string {
  if (values.length === 0) return '확인된 값 없음'
  const shown = values.slice(0, max).map((value) => label(value, labels))
  return values.length > max ? `${shown.join(' · ')} +${values.length - max}` : shown.join(' · ')
}

function productRichness(product: CatalogProduct): number {
  return Number(Boolean(product.display_image_url)) * 12
    + Number(Boolean(product.representative_package_size_text)) * 4
    + Number(Boolean(product.feed_type)) * 2
    + Number(Boolean(product.life_stage)) * 2
    + Number(product.has_ingredient_details) * 4
    + Number(product.has_nutrition_details) * 4
    + Number(product.has_manufacturing_details) * 3
    + Number(product.has_market_details) * 3
    + Math.min(product.recipe_families.length, 2)
    + Math.min(product.confirmed_present_ingredient_terms.length, 2)
}

function pickVisualProducts(products: CatalogProduct[]): CatalogProduct[] {
  const brands = new Set<string>()
  const selected: CatalogProduct[] = []

  for (const product of [...products].sort((a, b) => productRichness(b) - productRichness(a))) {
    if (!product.display_image_url || brands.has(product.brand)) continue
    selected.push(product)
    brands.add(product.brand)
    if (selected.length === 3) break
  }

  return selected
}

function ProductImage({ product, className }: { product: CatalogProduct; className: string }) {
  const fallback = product.brand.trim().slice(0, 2).toUpperCase() || 'CF'

  return (
    <div className={`${className} home-product-image-shell`}>
      <span className="home-product-image-fallback" aria-hidden="true">{fallback}</span>
      {product.display_image_url ? (
        <img
          src={product.display_image_url}
          alt={`${product.brand} ${product.canonical_name} 제품 이미지`}
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      ) : null}
    </div>
  )
}

function EvidenceRow({ state, labelText, value }: { state: 'confirmed' | 'unknown' | 'reviewed'; labelText: string; value: string }) {
  return (
    <div className={`home-specimen-evidence-row is-${state}`}>
      <span className="home-specimen-state-dot" aria-hidden="true" />
      <div>
        <span>{labelText}</span>
        <strong>{value}</strong>
      </div>
    </div>
  )
}

export default function Home({
  productCount,
  loading,
  onStart,
}: {
  productCount: number
  loading: boolean
  onStart: (mode: HomeMode, query?: string) => void
}) {
  const [query, setQuery] = useState('')
  const [visualProducts, setVisualProducts] = useState<CatalogProduct[]>([])
  const trimmedQuery = query.trim()
  const catalogCount = loading ? '—' : productCount ? productCount.toLocaleString('ko-KR') : '—'

  useEffect(() => {
    const controller = new AbortController()
    let active = true

    fetchCatalog(controller.signal)
      .then((products) => {
        if (active) setVisualProducts(pickVisualProducts(products))
      })
      .catch(() => {
        // The Home remains usable even if the optional specimen preview cannot load.
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [])

  const specimen = visualProducts[0] ?? null

  const specimenEvidence = useMemo(() => {
    if (!specimen) return []

    const rows: Array<{ state: 'confirmed' | 'unknown' | 'reviewed'; labelText: string; value: string }> = []
    if (specimen.confirmed_present_ingredient_terms.length > 0) {
      rows.push({
        state: 'confirmed',
        labelText: '확인된 원료',
        value: compact(specimen.confirmed_present_ingredient_terms, INGREDIENT_LABELS),
      })
    }
    if (specimen.reviewed_not_found_ingredient_terms.length > 0) {
      rows.push({
        state: 'reviewed',
        labelText: '검토 근거에서 찾지 못함',
        value: compact(specimen.reviewed_not_found_ingredient_terms, INGREDIENT_LABELS, 1),
      })
    }
    if (specimen.insufficient_evidence_ingredient_terms.length > 0) {
      rows.push({
        state: 'unknown',
        labelText: '판단 근거 부족',
        value: compact(specimen.insufficient_evidence_ingredient_terms, INGREDIENT_LABELS, 1),
      })
    }
    if (rows.length < 3) {
      rows.push({
        state: specimen.has_nutrition_details ? 'confirmed' : 'unknown',
        labelText: '영양 정보',
        value: specimen.has_nutrition_details ? '영양성분 패널 확인' : '현재 공개 정보에서 미확인',
      })
    }
    return rows.slice(0, 3)
  }, [specimen])

  function submitLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!trimmedQuery) return
    onStart('lookup', trimmedQuery)
  }

  return (
    <div className="home-shell home-tool-shell">
      <header className="home-header">
        <div className="home-header-inner">
          <div className="home-brand">
            <strong className="home-logo">FELINE ARCHIVE</strong>
            <span>사료 리서치 아카이브</span>
          </div>
          <nav className="home-nav" aria-label="탐색 방법">
            <button type="button" onClick={() => onStart('lookup')}>제품 직접 찾기</button>
            <button type="button" onClick={() => onStart('switch')}>현재 사료에서 바꾸기</button>
            <button type="button" onClick={() => onStart('explore')}>조건으로 찾아보기</button>
          </nav>
        </div>
      </header>

      <main className="home-main home-tool-main">
        <section className="home-tool-grid">
          <div className="home-tool-entry">
            <div className="home-tool-heading">
              <span className="home-tool-kicker"><i aria-hidden="true" /> 제품 데이터 직접 탐색</span>
              <h1>사료를 직접 확인하고 비교해보세요.</h1>
              <p>추천 점수나 순위 대신, 확인된 정보와 미확인 상태를 구분해 보여드립니다.</p>
            </div>

            <section className="home-tool-search-panel" aria-label="제품 직접 찾기">
              <div className="home-tool-search-heading">
                <span>제품 직접 찾기</span>
                <strong>알고 있는 제품이나 브랜드부터 시작하세요.</strong>
              </div>
              <form className="home-tool-search" onSubmit={submitLookup}>
                <span className="home-tool-search-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <circle cx="11" cy="11" r="6.5" />
                    <path d="m16 16 4 4" />
                  </svg>
                </span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="브랜드 또는 제품명 검색"
                  aria-label="브랜드 또는 제품명 검색"
                />
                <button type="submit" disabled={!trimmedQuery}>제품 보기 →</button>
              </form>
              <div className="home-tool-search-meta">
                <span>현재 확인된 제품 {catalogCount}개</span>
                <span>제품 · 배합 · 규격을 구분해 표시</span>
              </div>
            </section>

            <div className="home-tool-paths" aria-label="다른 탐색 방법">
              <article className="home-tool-path">
                <div className="home-tool-path-visual" aria-hidden="true">
                  {visualProducts[1] ? <ProductImage product={visualProducts[1]} className="home-tool-mini-product" /> : <span className="home-tool-mini-empty">01</span>}
                  <span className="home-tool-path-arrow">→</span>
                  {visualProducts[2] ? <ProductImage product={visualProducts[2]} className="home-tool-mini-product" /> : <span className="home-tool-mini-empty">02</span>}
                </div>
                <div>
                  <span>현재 제품을 기준점으로</span>
                  <h2>현재 사료에서 바꾸기</h2>
                  <p>지금 먹이는 제품과 규격을 정하고, 바꿀 것과 유지할 것을 직접 선택합니다.</p>
                </div>
                <button type="button" onClick={() => onStart('switch')}>현재 사료로 시작하기 →</button>
              </article>

              <article className="home-tool-path">
                <div className="home-tool-filter-preview" aria-hidden="true">
                  <span>형태</span><span>대상</span><span>기능</span><span>레시피</span>
                </div>
                <div>
                  <span>원하는 조건에서 시작</span>
                  <h2>조건으로 찾아보기</h2>
                  <p>확인 가능한 조건을 직접 조합하고, 후보와 미확인 정보를 함께 살펴봅니다.</p>
                </div>
                <button type="button" onClick={() => onStart('explore')}>조건 설정하기 →</button>
              </article>
            </div>
          </div>

          <aside className="home-specimen" aria-label="제품 분석 예시">
            <div className="home-specimen-topline">
              <div>
                <span>제품 분석 예시</span>
                <strong>실제 제품을 이런 단위로 살펴봅니다.</strong>
              </div>
              <small>추천 · 순위 아님</small>
            </div>

            {specimen ? (
              <>
                <section className="home-specimen-identity">
                  <ProductImage product={specimen} className="home-specimen-image" />
                  <div>
                    <span>{specimen.brand}</span>
                    <h2>{specimen.canonical_name}</h2>
                    <p>
                      {specimen.feed_type ?? '형태 미확인'} ·{' '}
                      {specimen.life_stage ? label(specimen.life_stage, LIFE_STAGE_LABELS) : '생애주기 미확인'} ·{' '}
                      {specimen.representative_package_size_text ?? '대표 규격 미확인'}
                    </p>
                  </div>
                </section>

                <section className="home-specimen-facts">
                  <div><span>공식 대상</span><strong>{compact(specimen.official_targets, TARGET_LABELS)}</strong></div>
                  <div><span>레시피 계열</span><strong>{compact(specimen.recipe_families, RECIPE_FAMILY_LABELS)}</strong></div>
                  <div><span>제조국</span><strong>{specimen.manufacturing_country_codes.join(' · ') || '미확인'}</strong></div>
                  <div><span>현재 확인 시장</span><strong>{specimen.current_market_country_codes.join(' · ') || '미확인'}</strong></div>
                </section>

                <section className="home-specimen-evidence">
                  <div className="home-specimen-section-title">
                    <span>확인 범위</span>
                    <small>없음과 미확인을 구분합니다.</small>
                  </div>
                  <div className="home-specimen-evidence-list">
                    {specimenEvidence.map((row) => (
                      <EvidenceRow key={`${row.labelText}-${row.value}`} {...row} />
                    ))}
                  </div>
                </section>

                <section className="home-specimen-coverage">
                  <div>
                    <span>원재료</span>
                    <strong>{specimen.has_full_ingredient_declaration ? '전체 표기 확인' : specimen.has_ingredient_details ? '일부 정보 확인' : '미확인'}</strong>
                  </div>
                  <div>
                    <span>영양</span>
                    <strong>{specimen.has_nutrition_details ? '패널 확인' : '미확인'}</strong>
                  </div>
                  <div>
                    <span>판매 규격</span>
                    <strong>{specimen.variant_count ? `${specimen.variant_count}개 확인` : '미확인'}</strong>
                  </div>
                </section>

                <button
                  className="home-specimen-action"
                  type="button"
                  onClick={() => onStart('lookup', specimen.canonical_name)}
                >
                  이 제품 정보 살펴보기 →
                </button>
              </>
            ) : (
              <div className="home-specimen-empty">
                <span>제품 분석 예시를 불러오는 중입니다.</span>
              </div>
            )}
          </aside>
        </section>

        <section className="home-tool-principles" aria-label="Catfood 데이터 원칙">
          <div><span>01</span><strong>확인과 미확인을 구분</strong><p>확인되지 않은 값을 없음으로 바꾸지 않습니다.</p></div>
          <div><span>02</span><strong>조건을 몰래 완화하지 않음</strong><p>결과를 늘리기 위해 사용자가 정한 조건을 바꾸지 않습니다.</p></div>
          <div><span>03</span><strong>점수로 대신 결정하지 않음</strong><p>제품의 우열보다 확인된 사실과 차이를 보여줍니다.</p></div>
        </section>
      </main>
    </div>
  )
}
