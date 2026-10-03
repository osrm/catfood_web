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
  {
    number: '01',
    title: '제품 · 배합 · 규격은 왜 나눠 보나요?',
    text: '규격은 용량과 포장 단위입니다. 실제 레시피 차이가 확인될 때만 배합을 따로 구분합니다.',
    tag: 'Catfood 사용법',
  },
  {
    number: '02',
    title: '‘미확인’은 ‘없음’과 어떻게 다른가요?',
    text: '‘미확인’과 ‘없음’은 다르게 표시합니다. 뜻은 아래 용어집에서 확인할 수 있습니다.',
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
  products = [],
  loading,
  error,
  onRetryCatalog,
  onStart,
}: {
  productCount: number
  products?: CatalogProduct[]
  loading: boolean
  error: boolean
  onRetryCatalog: () => void
  onStart: (mode: HomeMode, query?: string) => void
}) {
  const [query, setQuery] = useState('')
  const [infoOpen, setInfoOpen] = useState(false)
  const infoTriggerRef = useRef<HTMLButtonElement | null>(null)
  const infoHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const trimmedQuery = query.trim()
  const catalogCount = productCount ? productCount.toLocaleString('ko-KR') : '—'
  const demo = isDemoPreview()
  const examples = products.filter((product, index, all) => product.display_image_url && all.findIndex((other) => other.display_image_url && other.brand === product.brand) === index).slice(0, 2)

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
    <div className="home-shell home-knowledge-shell">
      <SiteHeader className="home-header" onModeChange={(mode) => onStart(mode)} status={<div className={error ? 'home-catalog-status is-error' : 'home-catalog-status'} aria-live="polite">{loading ? '제품 목록 불러오는 중' : error ? '제품 목록 조회 실패' : <>현재 확인된 제품 <strong>{catalogCount}개</strong></>}</div>} />
      <main className="home-main home-knowledge-main">
        <section className="home-start">
          <div className="home-start-copy">
            <h1>고양이 사료 찾기</h1>
            {error ? <div className="home-catalog-error" role="alert"><div><strong>제품 목록을 불러오지 못했습니다.</strong><span>잠시 후 다시 시도해 주세요.</span></div><button type="button" onClick={onRetryCatalog}>다시 시도</button></div> : null}
            <section className="home-entry-lookup" aria-labelledby="home-lookup-title">
              <h2 id="home-lookup-title" className="visually-hidden">브랜드·제품명 검색</h2>
              <form className="home-entry-search" onSubmit={submitLookup}>
                <label className="home-entry-search-field"><span className="home-entry-search-icon" aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="브랜드 또는 제품명" aria-label="브랜드 또는 제품명 검색" /></label>
                <button className="home-entry-search-submit" type="submit" disabled={!trimmedQuery}>검색</button>
              </form>
              <div className="home-brand-shortcuts"><span>브랜드로 찾기</span>{['AATU', 'GO! SOLUTIONS', '로얄캐닌'].map((brand) => <button className="home-brand-shortcut" type="button" key={brand} onClick={() => onStart('lookup', brand)}>{brand}</button>)}</div>
            </section>
          </div>
          <section className="home-entry-board" aria-label="CATFOOD 시작 방법"><div className="home-entry-routes">
            <article className="home-entry-route"><div><h2>새 사료를 찾는다면</h2><p>사료 형태·연령과 원하는 조건으로.</p></div><button type="button" onClick={() => onStart('explore')} aria-label="조건 고르기 →">조건 고르기 →</button></article>
            <article className="home-entry-route"><div><h2>먹이는 사료를 바꾸려면</h2><p>유지할 점과 바꿀 점을 기준으로.</p></div><button type="button" onClick={() => onStart('switch')}>먹이는 사료 찾기 →</button></article>
          </div></section>
          {examples.length > 0 ? <aside className="home-product-example" aria-label="제품 예시">
            <span>제품 예시</span><div className="home-example-products">{examples.map((product) => <button type="button" key={product.product_id} onClick={() => onStart('lookup', product.brand + ' ' + product.canonical_name)} aria-label={product.brand + ' ' + product.canonical_name + ' 찾기'}><img src={product.display_image_url!} alt="" /><span>{product.brand}</span><strong>{product.canonical_name}</strong></button>)}</div>
          </aside> : null}
          <section className="home-reading-note" aria-label="정보 안내"><button ref={infoTriggerRef} type="button" aria-expanded={infoOpen} aria-controls="home-info-panel" onClick={showReadingGuide}>정보 안내 →</button></section>
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

        <section id="home-info-panel" className="home-info-panel" aria-labelledby="home-info-title" hidden={!infoOpen}>
          <div className="home-section-heading home-info-heading">
            <div>
              <span>정보</span>
              <h2 id="home-info-title" ref={infoHeadingRef} tabIndex={-1}>정보 안내</h2>
            </div>
            <button className="home-info-close" type="button" onClick={closeReadingGuide}>정보 안내 닫기</button>
          </div>

          <section className="home-section home-guides" aria-labelledby="home-guides-title">
            <div className="home-section-heading">
              <div>
                <span>읽는 법</span>
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
