import { useEffect, useRef, useState, type FormEvent } from 'react'
import SiteHeader from './SiteHeader'
import type { CatalogProduct } from './api'
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
  { number: '01', tag: '열량', title: '열량 단위가 다르면?', example: '3,480 kcal/kg = 348 kcal/100g', text: 'kcal/kg는 1kg, kcal/100g는 100g에 들어 있는 열량입니다. kg 기준 값을 10으로 나누면 100g 기준이 됩니다. 표시 단위를 맞춘 환산이며, 더 높은 값이 더 좋은 사료라는 뜻은 아닙니다.' },
  { number: '02', tag: '영양 표기', title: '‘이상’과 ‘이하’는 어떻게 읽나요?', example: '조단백질 30% 이상 ≠ 정확히 30%', text: '‘이상’은 최소값, ‘이하’는 최대값으로 읽습니다. 실제 함량이나 평균값으로 단정할 수 없으므로 숫자와 함께 붙은 표현도 확인하세요.' },
  { number: '03', tag: '원재료', title: '오리 레시피면 오리만 들어 있나요?', example: '레시피 이름 ≠ 전체 원재료', text: '레시피 이름과 실제 원재료 목록은 다릅니다. 피하고 싶은 원료가 있다면 이름만으로 판단하지 말고 원재료 목록을 확인하세요. 자료에서 찾지 못했다는 것도 실제로 없다는 보장은 아닙니다.' },
  { number: '04', tag: '확인 상태', title: '‘미확인’이라고 나오면?', example: '미확인 ≠ 없음', text: '현재 자료로 판단할 수 없다는 뜻입니다. 성분이 없거나 제품이 조건에 맞지 않는다고 단정하지 않습니다. 원문과 확인된 범위는 제품 상세에서 살펴볼 수 있습니다.' },
]

const GLOSSARY = [
  {
    term: '제품',
    definition: '브랜드와 제품명으로 구분되는 하나의 판매 제품입니다.',
  },
  {
    term: '배합',
    definition: '원재료와 영양 정보가 연결되는 실제 레시피입니다. 같은 제품도 시기나 시장에 따라 달라질 수 있습니다.',
  },
  {
    term: '판매 규격',
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
  error,
  onRetryCatalog,
  onStart,
  switchProgress,
  onRestartSwitch,
}: {
  productCount: number
  products?: CatalogProduct[]
  loading: boolean
  error: boolean
  onRetryCatalog: () => void
  onStart: (mode: HomeMode, query?: string) => void
  switchProgress?: string | null
  onRestartSwitch?: () => void
}) {
  const [query, setQuery] = useState('')
  const [infoOpen, setInfoOpen] = useState(false)
  const infoTriggerRef = useRef<HTMLButtonElement | null>(null)
  const infoHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const trimmedQuery = query.trim()
  const catalogCount = productCount ? productCount.toLocaleString('ko-KR') : '—'
  const demo = isDemoPreview()


  function submitLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!trimmedQuery) return
    onStart('lookup', trimmedQuery)
  }

  useEffect(() => {
    if (!infoOpen) return
    const heading = infoHeadingRef.current
    if (!heading) return
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    heading.focus({ preventScroll: true })
    heading.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  }, [infoOpen])

  function showReadingGuide() {
    if (infoOpen) {
      const heading = infoHeadingRef.current
      if (!heading) return
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      heading.focus({ preventScroll: true })
      heading.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
      return
    }
    setInfoOpen(true)
  }

  function closeReadingGuide() {
    setInfoOpen(false)
    window.setTimeout(() => infoTriggerRef.current?.focus(), 0)
  }

  return (
    <div className="home-shell home-knowledge-shell discovery-home">
      <SiteHeader className="home-header" onModeChange={(mode) => onStart(mode)} status={<div className={error ? 'home-catalog-status is-error' : 'home-catalog-status'} aria-live="polite">{loading ? '제품 목록 불러오는 중' : error ? '제품 목록 조회 실패' : <>현재 확인된 제품 <strong>{catalogCount}개</strong></>}</div>} />
      <main className="home-main home-knowledge-main">
        <section className="home-start">
          <div className="home-start-copy">
            <h1>어떤 사료를 찾으세요?</h1>
            {error ? <div className="home-catalog-error" role="alert"><div><strong>제품 목록을 불러오지 못했습니다.</strong><span>잠시 후 다시 시도해 주세요.</span></div><button type="button" onClick={onRetryCatalog}>다시 시도</button></div> : null}
          </div>
          <section className="home-entry-board" aria-label="현재 사료에서 다음 후보 찾기">
            <article className="home-entry-route">
              <span className="home-route-kicker">현재 사료에서 시작하기</span>
              <h2>먹이는 사료를 바꾸고 싶다면</h2>
              <p>유지할 점과 바꿀 점을 정하고,<br className="home-route-break" /> 다음 후보를 찾아보세요.</p>
              <ol className="home-switch-steps" aria-label="후보를 찾는 순서"><li>먹이는 사료</li><li>바꿀 점과 유지할 점</li><li>다음 후보</li></ol>
              {switchProgress ? <div className="home-switch-resume"><p className="home-switch-progress">{switchProgress}</p><div className="home-switch-actions"><button type="button" onClick={() => onStart('switch')}>이어서 찾기 →</button><button type="button" onClick={onRestartSwitch}>새로 찾기</button></div></div> : <button className="home-switch-start" type="button" onClick={() => onStart('switch')}>먹이는 사료 찾기 →</button>}
            </article>
          </section>
          <section className="home-entry-lookup" aria-labelledby="home-lookup-title">
            <h2 id="home-lookup-title">제품 정보부터 보고 싶다면</h2>
            <form className="home-entry-search" onSubmit={submitLookup}>
              <label className="home-entry-search-field"><span className="home-entry-search-icon" aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="브랜드 또는 제품명" aria-label="브랜드 또는 제품명 검색" /></label>
              <button className="home-entry-search-submit" type="submit" disabled={!trimmedQuery}>검색</button>
            </form>
            <div className="home-brand-shortcuts"><span>브랜드로 찾기</span>{['AATU', 'GO! SOLUTIONS', '로얄캐닌'].map((brand) => <button className="home-brand-shortcut" type="button" key={brand} onClick={() => onStart('lookup', brand)}>{brand}</button>)}</div>
            <div className="home-explore-route"><p>제품을 정하지 않았다면<br />사료 형태·연령·원료 조건으로 찾아보세요.</p><button type="button" onClick={() => onStart('explore')} aria-label="조건 고르기 →">조건 고르기 →</button></div>
          </section>
        </section>

        <section className="home-section home-guides" aria-labelledby="home-guides-title">
          <div className="home-section-heading"><h2 id="home-guides-title">사료 정보를 읽는 법</h2><p>숫자와 이름에서 놓치기 쉬운 것들.</p></div>
          <div className="home-guide-grid">
            {GUIDES.map((guide) => <details className="home-guide" key={guide.number}>
              <summary><span className="home-guide-top"><small>{guide.tag}</small><b aria-hidden="true">+</b></span><h3>{guide.title}</h3><span className="home-guide-example">{guide.example}</span></summary>
              <p>{guide.text}</p>
            </details>)}
          </div>
        </section>

        <section className="home-section home-official-safety" aria-labelledby="home-official-safety-title">
          <div className="home-section-heading"><h2 id="home-official-safety-title">리콜·안전 공지 확인</h2><p>공식 기관 원문</p></div>
          <div className="home-official-safety-body">
            <div><p>공지의 제품명뿐 아니라<br />포장에 적힌 생산번호와 기한도 함께 확인하세요.</p><details className="home-safety-help"><summary>내 사료와 같은 생산분인지 확인하려면</summary><p>포장에 적힌 LOT(생산번호), 소비기한과 용량을 공지의 대상과 대조하세요. 해외 공지가 한국에서 판매되는 제품에도 적용되는지는 별도로 확인해야 합니다.</p></details></div>
            <nav className="home-official-links" aria-label="공식 리콜 및 안전 공지 출처">
              <a href="https://www.fda.gov/animal-veterinary/safety-health/recalls-withdrawals" target="_blank" rel="noopener noreferrer"><span>미국 FDA<small>미국 · 동물용 제품 리콜 목록</small></span><span aria-hidden="true">↗</span><span className="visually-hidden">새 탭에서 열기</span></a>
              <a href="https://www.mafra.go.kr/home/5108/subview.do" target="_blank" rel="noopener noreferrer"><span>농림축산식품부<small>한국 · 공지·공고</small></span><span aria-hidden="true">↗</span><span className="visually-hidden">새 탭에서 열기</span></a>
            </nav>
          </div>
          <p className="home-safety-scope">외부 공식 사이트로 이동합니다. 이 화면은 리콜 목록을 자동 수집하거나 내 제품의 해당 여부를 판정하지 않습니다.</p>
        </section>

        {demo ? (
          <section className="home-section home-safety" aria-labelledby="home-safety-title">
            <div className="home-section-heading">
              <div>
                <span>안전 공지</span>
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

        <section className="home-reading-note" aria-label="정보 안내"><button ref={infoTriggerRef} type="button" aria-expanded={infoOpen} aria-controls="home-info-panel" onClick={showReadingGuide}>정보 안내 →</button><p>용어와 정보 표시 원칙</p></section>

        <section id="home-info-panel" className="home-info-panel" aria-labelledby="home-info-title" hidden={!infoOpen}>
          <div className="home-section-heading home-info-heading">
            <div>
              <span>정보</span>
              <h2 id="home-info-title" ref={infoHeadingRef} tabIndex={-1}>정보 안내</h2>
            </div>
            <button className="home-info-close" type="button" onClick={closeReadingGuide}>정보 안내 닫기</button>
          </div>

          <section className="home-section home-glossary" aria-labelledby="home-glossary-title">
            <div className="home-section-heading">
              <div>
                <span>용어</span>
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

          <section className="home-home-principles" aria-label="CATFOOD 정보 표시 원칙">
            <div><span>01</span><strong>확인과 미확인을 구분</strong><p>확인되지 않은 값을 ‘없음’으로 바꾸지 않습니다.</p></div>
            <div><span>02</span><strong>선택한 조건을 그대로 적용</strong><p>선택한 조건을 자동으로 바꾸거나 완화하지 않습니다.</p></div>
            <div><span>03</span><strong>점수로 대신 결정하지 않음</strong><p>순위 대신 확인된 사실과 차이를 보여줍니다.</p></div>
          </section>
        </section>
      </main>
    </div>
  )
}
