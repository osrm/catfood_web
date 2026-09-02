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
        <section className="home-hero-wide">
          <h1>지금 먹이는 사료를 기준으로,<br />다음 사료를 찾아보세요.</h1>
          <p>현재 제품을 기준점으로 다른 사료의 차이를 탐색합니다.</p>
        </section>

        <section className="home-primary-band" aria-label="현재 사료에서 시작하기">
          <div className="home-band-heading">
            <strong>현재 먹이는 사료</strong>
            <span>브랜드나 제품명을 알고 있다면 여기서 시작하세요.</span>
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
            <button className="home-primary-submit" type="submit" disabled={!trimmedQuery}>
              현재 사료로 시작
            </button>
            <button className="home-lookup-submit" type="button" disabled={!trimmedQuery} onClick={openProductLookup}>
              제품 정보 보기
            </button>
          </form>
        </section>

        <section className="home-secondary-band" aria-label="현재 사료 없이 탐색">
          <div>
            <span>현재 사료 없이 탐색</span>
            <strong>조건으로 사료 찾기</strong>
            <small>형태 · 공식 대상 · 기능 · 레시피를 기준으로 전체 제품을 탐색합니다.</small>
          </div>
          <button type="button" onClick={() => onStart('explore')}>
            조건으로 찾기 <span aria-hidden="true">→</span>
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
