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
          <h1>고양이 사료를 근거로 찾습니다.</h1>
          <p>제품을 찾고, 현재 사료에서 바꾸고, 필요한 조건으로 탐색합니다.</p>
        </section>

        <section className="home-tool" aria-label="사료 탐색 시작">
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
            <button type="submit">검색</button>
          </form>

          <div className="home-workflows">
            <button className="home-workflow home-workflow-primary" type="button" onClick={() => onStart('switch')}>
              <span className="home-workflow-symbol" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M4 8h13" />
                  <path d="m14 5 3 3-3 3" />
                  <path d="M20 16H7" />
                  <path d="m10 13-3 3 3 3" />
                </svg>
              </span>
              <span className="home-workflow-copy">
                <strong>현재 사료에서 바꾸기</strong>
                <small>현재 제품을 기준으로 바꿀 조건과 유지할 조건을 정합니다.</small>
              </span>
            </button>

            <button className="home-workflow" type="button" onClick={() => onStart('explore')}>
              <span className="home-workflow-symbol" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M4 7h10" />
                  <path d="M18 7h2" />
                  <circle cx="16" cy="7" r="2" />
                  <path d="M4 12h3" />
                  <path d="M11 12h9" />
                  <circle cx="9" cy="12" r="2" />
                  <path d="M4 17h8" />
                  <path d="M16 17h4" />
                  <circle cx="14" cy="17" r="2" />
                </svg>
              </span>
              <span className="home-workflow-copy">
                <strong>조건으로 찾기</strong>
                <small>필요한 조건으로 전체 제품을 탐색합니다.</small>
              </span>
            </button>
          </div>

          <div className="home-condition-row" aria-label="탐색 가능한 조건">
            <span className="home-condition-label">탐색 기준</span>
            <div className="home-condition-list">
              <button type="button" onClick={() => onStart('explore')}>형태</button>
              <button type="button" onClick={() => onStart('explore')}>연령</button>
              <button type="button" onClick={() => onStart('explore')}>생활·관리</button>
              <button type="button" onClick={() => onStart('explore')}>원재료</button>
            </div>
          </div>
        </section>

        <section className="home-trust" aria-label="데이터 기준 요약">
          <div>
            <strong>{loading ? '한국 현재 판매 제품 데이터 확인 중' : `${productCount || '—'}개 제품 · 한국 현재 판매 제품 기준`}</strong>
          </div>
          <div>
            <strong>확인된 사실과 미확인 상태를 구분</strong>
          </div>
          <div>
            <strong>결과가 없어도 조건 자동 완화 없음</strong>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <div className="home-footer-brand">
          <strong>CATFOOD</strong>
          <span>고양이 사료 정보 탐색 도구</span>
        </div>
        <div>
          <button type="button">리콜 기록</button>
          <button type="button">데이터 읽기</button>
          <button type="button">데이터 기준</button>
        </div>
      </footer>
    </div>
  )
}
