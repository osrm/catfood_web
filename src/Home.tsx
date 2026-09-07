import { useState, type FormEvent } from 'react'
import { isDemoPreview } from './preview-mode'

type HomeMode = 'switch' | 'explore' | 'lookup'

type DemoRecall = {
  date: string
  source: string
  title: string
  scope: string
  detail: string
}

const DEMO_RECALLS: DemoRecall[] = [
  {
    date: '2026.08.28',
    source: 'DEMO · 공식 기관 공지 예시',
    title: '가상 브랜드 A · 치킨 레시피 일부 lot 자발적 리콜',
    scope: '대상: 1.8kg · LOT A2607 · 미국 일부 유통',
    detail: '공식 공지의 제품명·규격·lot·유통 범위를 기준으로 해당 여부를 식별합니다.',
  },
  {
    date: '2026.08.12',
    source: 'DEMO · 제조사 공지 예시',
    title: '가상 브랜드 B · 습식 제품 특정 생산분 안전 공지',
    scope: '대상: 85g × 12 · BEST BY 2027-04 · 한국 유통 여부 미확인',
    detail: '해외 공지가 있어도 국내 유통과 동일 제품인지 확인되지 않으면 그대로 구분해 표시합니다.',
  },
]

const GUIDES = [
  {
    number: '01',
    title: '제품 · 배합 · 규격은 왜 나눠 보나요?',
    text: '규격은 용량과 포장 단위입니다. 실제 레시피 차이가 확인될 때만 배합을 따로 구분합니다.',
    tag: 'Catfood 사용법',
  },
  {
    number: '02',
    title: '‘미확인’은 ‘없음’과 어떻게 다른가요?',
    text: '현재 자료에서 확인하지 못했다는 뜻이지, 실제로 없다는 뜻은 아닙니다.',
    tag: '데이터 읽기',
  },
  {
    number: '03',
    title: '원재료 포함 여부는 어떻게 읽나요?',
    text: '확인됨, 검토한 자료에서 찾지 못함, 판단할 근거가 부족함을 구분해 표시합니다.',
    tag: '원재료',
  },
  {
    number: '04',
    title: '건식과 습식 영양 정보는 어떻게 비교하나요?',
    text: '수분 함량과 표시 방식이 달라 숫자 하나만으로 단순 비교하지 않습니다.',
    tag: '영양 정보',
  },
]

const GLOSSARY = [
  {
    term: 'Product · 제품',
    definition: '브랜드와 제품명으로 구분되는 하나의 판매 제품입니다.',
  },
  {
    term: 'Formula · 배합',
    definition: '원재료와 영양 정보가 연결되는 실제 레시피입니다. 같은 제품도 시기나 시장에 따라 달라질 수 있습니다.',
  },
  {
    term: 'SKU · 규격',
    definition: '중량이나 묶음 수처럼 실제로 판매되는 용량·포장 단위입니다.',
  },
  {
    term: '확인됨',
    definition: '현재 검토한 자료에서 해당 사실을 직접 확인한 상태입니다.',
  },
  {
    term: '검토 근거에서 찾지 못함',
    definition: '검토한 원재료 표기 등에서 해당 항목을 찾지 못한 상태입니다. 실제로 없다는 보장은 아닙니다.',
  },
  {
    term: '미확인 · 근거 부족',
    definition: '현재 공개된 자료만으로는 판단하기 어려운 상태입니다.',
  },
]

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
  const demo = isDemoPreview()

  function submitLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!trimmedQuery) return
    onStart('lookup', trimmedQuery)
  }

  return (
    <div className="home-shell home-knowledge-shell">
      <header className="home-header">
        <div className="home-header-inner">
          <div className="home-brand">
            <strong className="home-logo">CATFOOD</strong>
            <span>고양이 사료 탐색·비교</span>
          </div>
          <nav className="home-nav" aria-label="탐색 방법">
            <button type="button" onClick={() => onStart('lookup')}>제품 찾기</button>
            <button type="button" onClick={() => onStart('switch')}>사료 바꾸기</button>
            <button type="button" onClick={() => onStart('explore')}>조건으로 찾기</button>
          </nav>
        </div>
      </header>

      <main className="home-main home-knowledge-main">
        <section className="home-start">
          <div className="home-start-copy">
            <span className="home-start-kicker"><i aria-hidden="true" /> 사료 탐색과 비교</span>
            <h1>고양이 사료를 찾고, 비교하고, 바꿔보세요.</h1>
            <p>
              제품명을 직접 찾거나, 지금 먹는 사료에서 바꾸거나, 원하는 조건으로 후보를 좁혀볼 수 있습니다.
            </p>
          </div>

          <section className="home-search-console" aria-label="제품 직접 찾기">
            <div className="home-search-console-copy">
              <span>제품 바로 찾기</span>
              <strong>알고 있는 브랜드나 제품명으로 찾아보세요.</strong>
              <small>현재 확인된 제품 {catalogCount}개</small>
            </div>
            <form className="home-search-console-form" onSubmit={submitLookup}>
              <span className="home-search-console-icon" aria-hidden="true">
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

          <div className="home-start-paths" aria-label="다른 탐색 방법">
            <article className="home-start-path">
              <div className="home-start-path-index">01 / SWITCH</div>
              <div className="home-start-path-copy">
                <span>지금 먹는 사료에서 시작</span>
                <h2>현재 사료에서 바꾸기</h2>
                <p>지금 먹이는 제품과 규격을 고르고, 바꿀 것과 유지할 것을 정합니다.</p>
              </div>
              <div className="home-start-path-flow" aria-hidden="true">
                <span>현재 사료</span><b>→</b><span>바꿀 것</span><b>+</b><span>유지할 것</span>
              </div>
              <button type="button" onClick={() => onStart('switch')}>현재 사료로 시작하기 →</button>
            </article>

            <article className="home-start-path">
              <div className="home-start-path-index">02 / EXPLORE</div>
              <div className="home-start-path-copy">
                <span>원하는 조건에서 시작</span>
                <h2>조건으로 찾아보기</h2>
                <p>형태·생애주기·대상·기능·레시피를 골라 후보를 좁힙니다.</p>
              </div>
              <div className="home-start-path-flow is-filters" aria-hidden="true">
                <span>형태</span><span>생애주기</span><span>대상</span><span>레시피</span>
              </div>
              <button type="button" onClick={() => onStart('explore')}>조건 고르기 →</button>
            </article>
          </div>
        </section>

        {demo ? (
          <section className="home-section home-safety" aria-labelledby="home-safety-title">
            <div className="home-section-heading">
              <div>
                <span>SAFETY &amp; NOTICES</span>
                <h2 id="home-safety-title">공식 리콜 및 생산분 안전 공지</h2>
              </div>
              <p>공식 공지의 제품명, 규격, lot, 유통 범위를 확인해 해당 여부를 구분합니다.</p>
            </div>

            <div className="home-safety-list">
              {DEMO_RECALLS.map((notice) => (
                <article className="home-safety-item" key={`${notice.date}-${notice.title}`}>
                  <div className="home-safety-meta"><time>{notice.date}</time><span>{notice.source}</span></div>
                  <h3>{notice.title}</h3>
                  <strong>{notice.scope}</strong>
                  <p>{notice.detail}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section className="home-section home-guides" aria-labelledby="home-guides-title">
          <div className="home-section-heading">
            <div>
              <span>HOW TO READ</span>
              <h2 id="home-guides-title">비교할 때 알아두면 좋은 4가지</h2>
            </div>
            <p>제품 정보를 읽을 때 헷갈리기 쉬운 기준만 짧게 정리했습니다.</p>
          </div>

          <div className="home-guide-grid">
            {GUIDES.map((guide) => (
              <article className="home-guide" key={guide.number}>
                <div className="home-guide-top"><span>{guide.number}</span><small>{guide.tag}</small></div>
                <h3>{guide.title}</h3>
                <p>{guide.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="home-section home-glossary" aria-labelledby="home-glossary-title">
          <div className="home-section-heading">
            <div>
              <span>GLOSSARY</span>
              <h2 id="home-glossary-title">용어집</h2>
            </div>
            <p>제품 상세와 비교 화면에서 자주 쓰는 용어입니다.</p>
          </div>

          <div className="home-glossary-grid">
            {GLOSSARY.map((item) => (
              <details className="home-glossary-item" key={item.term}>
                <summary><span>{item.term}</span><b aria-hidden="true">+</b></summary>
                <p>{item.definition}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="home-home-principles" aria-label="Catfood 데이터 원칙">
          <div><span>01</span><strong>확인과 미확인을 구분</strong><p>확인하지 못한 값을 ‘없음’으로 바꾸지 않습니다.</p></div>
          <div><span>02</span><strong>선택한 조건을 그대로 적용</strong><p>결과를 늘리기 위해 조건을 임의로 완화하지 않습니다.</p></div>
          <div><span>03</span><strong>점수로 대신 결정하지 않음</strong><p>순위를 매기기보다 확인된 사실과 차이를 보여줍니다.</p></div>
        </section>
      </main>
    </div>
  )
}
