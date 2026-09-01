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
          <h1>고양이 사료를<br />근거로 찾습니다.</h1>
          <p>제품을 찾고, 바꾸고, 조건으로 탐색합니다.</p>
        </section>

        <section className="home-utility" aria-label="사료 탐색 시작">
          <div className="home-search-column">
            <div className="home-utility-heading">
              <h2>제품 찾기</h2>
              <p>브랜드나 제품명을 알고 있다면 바로 확인합니다.</p>
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
          </div>

          <div className="home-workflows">
            <button className="home-workflow home-workflow-primary" type="button" onClick={() => onStart('switch')}>
              <span className="home-workflow-mark" aria-hidden="true">↔</span>
              <span className="home-workflow-copy">
                <strong>현재 사료에서 바꾸기</strong>
                <small>현재 제품을 기준으로 바꿀 조건과 유지할 조건을 정합니다.</small>
              </span>
            </button>

            <button className="home-workflow" type="button" onClick={() => onStart('explore')}>
              <span className="home-workflow-mark" aria-hidden="true">＋</span>
              <span className="home-workflow-copy">
                <strong>조건으로 찾기</strong>
                <small>필요한 조건으로 전체 제품을 탐색합니다.</small>
              </span>
            </button>
          </div>

          <div className="home-condition-row" aria-label="탐색 가능한 조건">
            <span className="home-condition-label">탐색할 수 있는 조건</span>
            <div className="home-condition-list">
              <span>형태</span>
              <span>연령</span>
              <span>생활 / 관리</span>
              <span>원재료</span>
            </div>
          </div>
        </section>

        <section className="home-trust" aria-label="데이터 기준 요약">
          <div>
            <span className="home-trust-kicker">제품 데이터</span>
            <strong>{loading ? '제품 데이터 확인 중' : `${productCount || '—'}개 제품 반영`}</strong>
          </div>
          <div>
            <span className="home-trust-kicker">대상</span>
            <strong>한국 현재 판매 제품 기준</strong>
          </div>
          <div>
            <span className="home-trust-kicker">표시 원칙</span>
            <strong>확인 사실과 미확인 상태를 구분</strong>
          </div>
          <div>
            <span className="home-trust-kicker">검색 원칙</span>
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
