import { useState, type FormEvent } from 'react'
import { isDemoPreview } from './demo-preview'

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
    text: '같은 제품명이라도 포장 규격이나 판매 시점에 따라 확인되는 배합 정보가 다를 수 있습니다.',
    tag: 'Catfood 사용법',
  },
  {
    number: '02',
    title: '‘미확인’은 ‘없음’과 어떻게 다른가요?',
    text: '근거에서 확인하지 못한 것과 실제로 존재하지 않는 것은 같은 의미가 아닙니다.',
    tag: '데이터 읽기',
  },
  {
    number: '03',
    title: '원재료 포함 여부는 어떻게 읽나요?',
    text: '직접 확인된 원료, 검토 근거에서 찾지 못한 원료, 판단 근거가 부족한 원료를 구분합니다.',
    tag: '원재료',
  },
  {
    number: '04',
    title: '건식과 습식 영양 정보는 무엇부터 봐야 하나요?',
    text: '표기 방식과 수분 함량이 다르기 때문에 숫자 하나만으로 단순 비교하지 않는 것이 중요합니다.',
    tag: '영양 정보',
  },
]

const GLOSSARY = [
  {
    term: 'Product · 제품',
    definition: '브랜드와 제품명으로 식별되는 판매 제품의 기본 단위입니다.',
  },
  {
    term: 'Formula · 배합',
    definition: '원재료와 영양 정보가 연결되는 실제 레시피·배합 단위입니다. 같은 제품 안에서도 세대나 시장에 따라 달라질 수 있습니다.',
  },
  {
    term: 'SKU · 규격',
    definition: '중량, 포장 묶음처럼 실제 판매되는 규격 단위입니다. Catfood는 제품과 규격을 같은 것으로 취급하지 않습니다.',
  },
  {
    term: '확인됨',
    definition: '현재 검토한 근거에서 해당 사실을 직접 확인한 상태입니다.',
  },
  {
    term: '검토 근거에서 찾지 못함',
    definition: '확인한 원재료 표기 등에서 해당 항목을 찾지 못한 상태입니다. 모든 가능성을 부정한다는 뜻은 아닙니다.',
  },
  {
    term: '미확인 · 근거 부족',
    definition: '현재 공개된 근거만으로는 존재 여부나 상태를 판단하기 어려운 경우입니다.',
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
            <span>사료 사실 검증 및 비교 아카이브</span>
          </div>
          <nav className="home-nav" aria-label="탐색 방법">
            <button type="button" onClick={() => onStart('lookup')}>제품 검색</button>
            <button type="button" onClick={() => onStart('switch')}>사료 전환</button>
            <button type="button" onClick={() => onStart('explore')}>조건 탐색</button>
          </nav>
        </div>
      </header>

      <main className="home-main home-knowledge-main">
        <section className="home-start">
          <div className="home-start-copy">
            <span className="home-start-kicker"><i aria-hidden="true" /> 사료 데이터 아카이브</span>
            <h1>마케팅 문구 대신 제조사 공시 사실과 배합 근거를 기록합니다.</h1>
            <p>
              특정 사료를 추천하거나 순위를 매기지 않습니다. 보호자가 확인된 사실과 아직 확인되지 않은 정보를 구분해 스스로 비교하고 선택할 수 있도록 돕습니다.
            </p>
          </div>

          <section className="home-search-console" aria-label="제품 직접 찾기">
            <div className="home-search-console-copy">
              <span>직접 검색</span>
              <strong>알고 있는 브랜드나 제품명부터 시작하세요.</strong>
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
                <span>현재 제품을 기준점으로</span>
                <h2>현재 사료에서 바꾸기</h2>
                <p>지금 먹이는 제품과 규격을 정하고, 무엇을 바꾸고 무엇을 유지할지 직접 선택합니다.</p>
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
                <p>사료 형태, 공식 대상, 부가 기능, 레시피처럼 확인 가능한 조건으로 후보를 좁혀봅니다.</p>
              </div>
              <div className="home-start-path-flow is-filters" aria-hidden="true">
                <span>형태</span><span>생애주기</span><span>대상</span><span>레시피</span>
              </div>
              <button type="button" onClick={() => onStart('explore')}>조건 설정하기 →</button>
            </article>
          </div>
        </section>

        <section className="home-section home-safety" aria-labelledby="home-safety-title">
          <div className="home-section-heading">
            <div>
              <span>SAFETY &amp; NOTICES</span>
              <h2 id="home-safety-title">공식 리콜 및 생산분 안전 공지</h2>
            </div>
            <p>공식 기관·제조사 공지에서 제품명, 규격, lot, 유통 범위를 확인해 해당 여부를 구분하는 영역입니다.</p>
          </div>

          {demo ? (
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
          ) : (
            <div className="home-safety-empty">
              <div>
                <span>공식 리콜 데이터 연결 전</span>
                <strong>현재는 공지 형식과 데이터 기준을 설계 중입니다.</strong>
              </div>
              <p>연결 후에는 특정 브랜드의 위험도를 판단하지 않고, 공식 공지 사실과 식별 정보를 그대로 구분해 제공합니다.</p>
            </div>
          )}
        </section>

        <section className="home-section home-guides" aria-labelledby="home-guides-title">
          <div className="home-section-heading">
            <div>
              <span>DATA READING PRINCIPLES</span>
              <h2 id="home-guides-title">사료 데이터를 읽는 4가지 기준</h2>
            </div>
            <p>Catfood의 데이터를 더 잘 읽고, 제품을 스스로 비교하기 위한 짧은 가이드입니다.</p>
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
            <p>제품 상세와 비교 화면에서 반복해서 만나게 되는 핵심 용어부터 정리합니다.</p>
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
          <div><span>01</span><strong>확인과 미확인을 구분</strong><p>확인되지 않은 값을 없음으로 바꾸지 않습니다.</p></div>
          <div><span>02</span><strong>조건을 몰래 완화하지 않음</strong><p>결과를 늘리기 위해 사용자가 정한 조건을 임의로 바꾸지 않습니다.</p></div>
          <div><span>03</span><strong>점수로 대신 결정하지 않음</strong><p>제품의 우열보다 확인된 사실과 차이를 보여줍니다.</p></div>
        </section>
      </main>
    </div>
  )
}
