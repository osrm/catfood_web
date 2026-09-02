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

  function submitCurrentFood(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!trimmedQuery) return
    onStart('switch', trimmedQuery)
  }

  function openProductLookup() {
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
            <h1>현재 먹이는 사료에서,<br />다음 선택을 시작하세요.</h1>
            <p>지금 사료를 기준으로 다른 제품을 탐색합니다.</p>
          </div>

          <section className="home-current-start" aria-label="현재 사료에서 시작하기">
            <div className="home-current-heading">
              <strong>현재 먹이는 사료</strong>
              <small>브랜드 또는 제품명을 검색하세요.</small>
            </div>

            <form className="home-search" onSubmit={submitCurrentFood}>
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
                aria-label="현재 먹이는 사료 검색"
              />
              <button type="submit" disabled={!trimmedQuery}>현재 사료로 시작</button>
            </form>

            <div className="home-alternate-actions" aria-label="다른 탐색 방법">
              <span>현재 사료 없이 탐색</span>
              <div>
                <button type="button" onClick={openProductLookup} disabled={!trimmedQuery}>
                  제품 정보만 보기
                </button>
                <button type="button" onClick={() => onStart('explore')}>
                  조건으로 찾기 <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
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
