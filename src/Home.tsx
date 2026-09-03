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

      <main className="home-main">
        <section className="home-research-intro">
          <span className="home-kicker">확인된 사실 · 비교 · 직접 판단</span>
          <h1>확인된 정보와 차이를 보고,<br />다음 선택을 직접 판단하세요.</h1>
          <p>
            추천 점수나 순위 대신 제품의 확인된 사실과 미확인 상태를 구분해 보여드립니다.
            필요한 만큼 비교하고, 더 깊은 정보까지 직접 확인할 수 있습니다.
          </p>

          <div className="home-lookup-hero">
            <div className="home-lookup-copy">
              <span>제품 직접 찾기</span>
              <strong>알고 있는 사료부터 확인해보세요.</strong>
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
              <button type="submit" disabled={!trimmedQuery}>제품 보기 →</button>
            </form>
          </div>
        </section>

        <section className="home-pathways" aria-label="사료 탐색 방법">
          <article className="home-pathway home-pathway-switch">
            <div className="home-pathway-index">01</div>
            <div className="home-pathway-copy">
              <span>현재 제품을 기준점으로</span>
              <h2>현재 사료에서 바꾸기</h2>
              <p>지금 먹이는 제품과 규격을 정하고, 무엇을 바꾸고 무엇을 유지할지 직접 선택합니다.</p>
            </div>
            <button type="button" onClick={() => onStart('switch')}>현재 사료로 시작하기 →</button>
          </article>

          <article className="home-pathway">
            <div className="home-pathway-index">02</div>
            <div className="home-pathway-copy">
              <span>원하는 조건에서 시작</span>
              <h2>조건으로 찾아보기</h2>
              <p>사료 형태, 공식 대상, 부가 기능, 레시피처럼 확인 가능한 조건으로 후보를 좁혀봅니다.</p>
            </div>
            <button type="button" onClick={() => onStart('explore')}>조건 설정하기 →</button>
          </article>
        </section>

        <section className="home-principles" aria-label="Catfood 탐색 원칙">
          <div className="home-principles-heading">
            <span>탐색 원칙</span>
            <h2>정보를 대신 판단하지 않고,<br />판단할 수 있게 정리합니다.</h2>
            <p>현재 확인된 제품 {catalogCount}개를 같은 원칙으로 다룹니다.</p>
          </div>
          <div className="home-principle-list">
            <div>
              <span>01</span>
              <strong>확인과 미확인을 구분</strong>
              <p>확인되지 않은 값을 없음이나 부적합으로 바꾸지 않습니다.</p>
            </div>
            <div>
              <span>02</span>
              <strong>조건을 몰래 완화하지 않음</strong>
              <p>결과를 늘리기 위해 사용자가 정한 조건을 임의로 바꾸지 않습니다.</p>
            </div>
            <div>
              <span>03</span>
              <strong>점수와 순위로 대신 결정하지 않음</strong>
              <p>제품의 우열을 하나의 점수로 만들지 않고 확인된 차이를 보여줍니다.</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
