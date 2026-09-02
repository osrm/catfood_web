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
        <section className="home-core">
          <div className="home-intro">
            <h1>사료를 고르기 전에,<br />먼저 확인하세요.</h1>
            <p>한국에서 판매되는 고양이 사료를 확인된 제품 정보로 탐색합니다.</p>
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

          <section className="home-entry" aria-label="사료 탐색 시작">
            <button className="home-explore" type="button" onClick={() => onStart('explore')}>
              <span className="home-explore-copy">
                <strong>조건으로 사료 찾기</strong>
                <small>형태 · 공식 대상 · 기능 · 레시피</small>
              </span>
              <span className="home-action-arrow" aria-hidden="true">→</span>
            </button>

            <button className="home-switch-link" type="button" onClick={() => onStart('switch')}>
              <span>
                <strong>현재 사료를 기준으로 시작하기</strong>
                <small>현재 제품을 기준점으로 탐색합니다.</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </section>

          <section className="home-data-signal" aria-label="데이터 기준 요약">
            <div className="home-catalog-signal">
              <strong>{catalogCount}</strong>
              <span>PRODUCTS</span>
              <small>현재 확인 제품</small>
            </div>

            <div className="home-data-principles">
              <div>
                <strong>한국 현재 판매 기준</strong>
                <small>현재 유통 제품 범위를 구분합니다.</small>
              </div>
              <div>
                <strong>확인 / 미확인 구분</strong>
                <small>미확인을 없음으로 처리하지 않습니다.</small>
              </div>
            </div>
          </section>
        </section>
      </main>
    </div>
  )
}
