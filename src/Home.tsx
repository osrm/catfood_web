import { useState, type FormEvent } from 'react'

type HomeMode = 'switch' | 'explore' | 'lookup'

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
  const trimmedQuery = query.trim()
  const catalogCount = loading ? '—' : productCount ? productCount.toLocaleString('ko-KR') : '—'

  function submitLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!trimmedQuery) return
    onStart('lookup', trimmedQuery)
  }

  return (
    <div className="home-shell">
      <header className="home-header">
        <div className="home-header-inner">
          <strong className="home-logo">FELINE ARCHIVE</strong>
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero-wide">
          <h1>지금 먹이는 사료를 기준으로,<br />다음 사료를 찾아보세요.</h1>
          <p>현재 제품을 기준점으로 다른 사료의 차이를 탐색합니다.</p>
        </section>

        <section className="home-primary-entry" aria-label="현재 사료에서 시작하기">
          <div className="home-primary-copy">
            <strong>현재 사료에서 시작하기</strong>
            <p>지금 먹이는 제품을 기준점으로 다른 사료를 탐색합니다.</p>
          </div>
          <button type="button" onClick={() => onStart('switch')}>
            현재 사료로 시작하기 <span aria-hidden="true">→</span>
          </button>
        </section>

        <section className="home-secondary-grid" aria-label="다른 탐색 방법">
          <div className="home-lookup-entry">
            <div className="home-secondary-copy">
              <strong>제품 정보 찾기</strong>
              <p>브랜드 또는 제품명을 알고 있다면 바로 확인합니다.</p>
            </div>

            <form className="home-search" onSubmit={submitLookup}>
              <span className="home-search-icon" aria-hidden="true">
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
              <button type="submit" disabled={!trimmedQuery}>검색</button>
            </form>
          </div>

          <button className="home-explore-entry" type="button" onClick={() => onStart('explore')}>
            <span className="home-secondary-copy">
              <strong>조건으로 사료 찾기</strong>
              <p>형태 · 공식 대상 · 기능 · 레시피로 전체 제품을 탐색합니다.</p>
            </span>
            <span className="home-explore-arrow" aria-hidden="true">→</span>
          </button>
        </section>

        <section className="home-data-strip" aria-label="데이터 기준 요약">
          <div className="home-data-cell home-data-count">
            <span>CATALOG</span>
            <strong>{catalogCount} <small>PRODUCTS</small></strong>
            <p>현재 확인 제품</p>
          </div>
          <div className="home-data-cell">
            <span>MARKET</span>
            <strong>한국 현재 판매 기준</strong>
            <p>현재 유통 제품 범위를 구분합니다.</p>
          </div>
          <div className="home-data-cell">
            <span>DATA STATE</span>
            <strong>확인 / 미확인 구분</strong>
            <p>미확인을 없음으로 처리하지 않습니다.</p>
          </div>
          <div className="home-data-cell">
            <span>SEARCH</span>
            <strong>조건 자동 완화 없음</strong>
            <p>결과가 없어도 선택 조건을 바꾸지 않습니다.</p>
          </div>
        </section>
      </main>
    </div>
  )
}
