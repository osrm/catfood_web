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

  function submitLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!trimmedQuery) return
    onStart('lookup', trimmedQuery)
  }

  return (
    <div className="home-shell">
      <header className="home-header">
        <div className="home-header-inner">
          <div className="home-brand">
            <strong className="home-logo">FELINE ARCHIVE</strong>
            <span>CAT FOOD DATABASE</span>
          </div>
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <div className="home-intro">
            <span className="home-eyebrow">KOREA CAT FOOD CATALOG</span>
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
        </section>

        <section className="home-start" aria-label="사료 탐색 시작">
          <button className="home-explore" type="button" onClick={() => onStart('explore')}>
            <span className="home-explore-copy">
              <span className="home-action-kicker">EXPLORE</span>
              <strong>조건으로 사료 찾기</strong>
              <small>형태 · 공식 대상 · 기능 · 레시피</small>
            </span>
            <span className="home-action-arrow" aria-hidden="true">→</span>
          </button>

          <div className="home-switch">
            <div className="home-switch-copy">
              <strong>현재 먹이는 사료가 있나요?</strong>
              <span>현재 제품을 기준으로 탐색을 시작합니다.</span>
            </div>
            <button type="button" onClick={() => onStart('switch')}>
              현재 사료를 기준으로 시작하기
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>

        <section className="home-data-summary" aria-label="데이터 기준 요약">
          <div className="home-data-item">
            <span>CATALOG</span>
            <strong>{loading ? '—' : productCount ? `${productCount}개` : '—'}</strong>
            <small>현재 확인 제품</small>
          </div>
          <div className="home-data-item">
            <span>MARKET</span>
            <strong>한국 판매</strong>
            <small>현재 유통 제품 기준</small>
          </div>
          <div className="home-data-item">
            <span>DATA STATE</span>
            <strong>확인 / 미확인</strong>
            <small>미확인을 없음으로 처리하지 않음</small>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <span>확인된 제품 정보와 차이를 보여줍니다.</span>
      </footer>
    </div>
  )
}
