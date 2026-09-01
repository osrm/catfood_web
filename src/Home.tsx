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

  function submitLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onStart('lookup', query.trim())
  }

  return (
    <div className="home-shell">
      <header className="home-header">
        <div className="home-header-inner">
          <strong className="home-logo">CATFOOD</strong>
          <nav className="home-nav" aria-label="주요 메뉴">
            <button type="button" onClick={() => onStart('lookup')}>사료 찾기</button>
            <button type="button" onClick={() => onStart('switch')}>사료 바꾸기</button>
            <button type="button" onClick={() => onStart('explore')}>조건 탐색</button>
            <span className="home-nav-divider" />
            <button type="button">리콜</button>
            <button type="button">데이터 기준</button>
          </nav>
        </div>
      </header>

      <main className="home-main">
        <section className="home-intro">
          <div className="home-eyebrow">고양이 사료 정보 탐색 도구</div>
          <h1>사료를 고를 때 필요한 건<br />확신이 아니라 근거입니다.</h1>
          <p>제품을 찾고, 바꾸고, 조건으로 탐색합니다.</p>
        </section>

        <section className="home-lookup" aria-labelledby="home-lookup-title">
          <div className="home-section-label">
            <span>01</span>
            <div>
              <h2 id="home-lookup-title">알고 있는 제품 찾기</h2>
              <p>브랜드나 제품명을 알고 있다면 바로 확인합니다.</p>
            </div>
          </div>
          <form className="home-search" onSubmit={submitLookup}>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="브랜드 또는 제품명 검색"
              aria-label="브랜드 또는 제품명 검색"
            />
            <button type="submit">검색</button>
          </form>
        </section>

        <section className="home-actions" aria-label="작업 시작">
          <button className="home-action home-action-primary" type="button" onClick={() => onStart('switch')}>
            <span className="home-action-no">02</span>
            <span className="home-action-copy">
              <strong>현재 사료에서 바꾸기</strong>
              <small>현재 제품을 먼저 정하고, 바꿀 조건과 유지할 조건을 나눠 봅니다.</small>
            </span>
            <span className="home-action-arrow">→</span>
          </button>

          <button className="home-action home-action-secondary" type="button" onClick={() => onStart('explore')}>
            <span className="home-action-no">03</span>
            <span className="home-action-copy">
              <strong>조건으로 찾기</strong>
              <small>필요한 조건으로 전체 제품을 탐색합니다.</small>
            </span>
            <span className="home-action-arrow">→</span>
          </button>
        </section>

        <section className="home-trust" aria-label="데이터 기준 요약">
          <div>
            <span className="home-trust-kicker">DATA SCOPE</span>
            <strong>{loading ? '제품 데이터 확인 중' : `${productCount || '—'}개 제품 불러옴`}</strong>
          </div>
          <div>
            <span className="home-trust-kicker">MARKET</span>
            <strong>한국 현재 판매 제품 기준</strong>
          </div>
          <div>
            <span className="home-trust-kicker">EVIDENCE</span>
            <strong>미확인 정보를 없음으로 바꾸지 않음</strong>
          </div>
          <div>
            <span className="home-trust-kicker">SEARCH</span>
            <strong>결과가 없어도 조건 자동 완화 없음</strong>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <span>CATFOOD</span>
        <div>
          <button type="button">리콜 기록</button>
          <button type="button">데이터 읽기</button>
          <button type="button">데이터 기준</button>
        </div>
      </footer>
    </div>
  )
}
