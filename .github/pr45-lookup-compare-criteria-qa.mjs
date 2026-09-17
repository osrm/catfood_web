import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cleanup, js, launch, network, sleep } from './detail-tab-scroll-qa-helpers.mjs'

const BASE_URL = process.env.BASE_URL
const CANDIDATE_URL = process.env.CANDIDATE_URL
const OUT = 'qa-artifacts/pr45-lookup-compare-criteria'
const PRODUCTS = [
  { id: 'product_d99406c26240b263', brand: 'AATU', name: '연어' },
  { id: 'product_31bc515d78d43d5d', brand: 'GO! SOLUTIONS', name: '카니보 치킨&칠면조&오리' },
]
assert.ok(BASE_URL && CANDIDATE_URL)
mkdirSync(OUT, { recursive: true })

function compareUrl(origin, mode = 'lookup', withCondition = false) {
  const url = new URL(origin)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', mode)
  if (mode === 'explore') {
    url.searchParams.set('applied', '1')
    if (withCondition) url.searchParams.set('feed', '건식')
  }
  url.searchParams.set('compare', PRODUCTS.map((product) => product.id).join(','))
  url.searchParams.set('compareOpen', '1')
  return url.href
}

async function waitCompare(c) {
  await c.wait(`document.querySelector('.compare-stage')`, 'compare stage', 30000)
  for (const product of PRODUCTS) {
    await c.wait(`[...document.querySelectorAll('.compare-product-copy strong')].some(n=>n.textContent.trim()===${js(product.name)})`, `product ${product.name}`, 30000)
  }
  await c.wait(`document.querySelectorAll('.compare-product-head').length===2`, 'two compare product heads', 30000)
  await sleep(250)
}

async function metrics(c) {
  return c.eval(`(()=>{
    const rect=(n)=>{if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    const table=document.querySelector('.compare-table')
    const sections=[...table.querySelectorAll(':scope > .compare-section-row')]
    const rows=[...table.querySelectorAll(':scope > .compare-row')]
    const section=(text)=>sections.find(n=>(n.textContent||'').includes(text))||null
    const row=(text)=>rows.find(n=>n.querySelector('.compare-row-label')?.textContent.trim()===text)||null
    const basics=section('제품 기본 정보')
    const firstFact=row('사료 형태')
    const relation=section('선택한 조건과 비교')
    const relationRow=row('선택한 조건과 비교')
    return {
      viewport:{width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth},
      products:[...document.querySelectorAll('.compare-product-head')].map(n=>({brand:n.querySelector('.compare-product-copy>span')?.textContent.trim()??null,name:n.querySelector('.compare-product-copy strong')?.textContent.trim()??null})),
      sectionTitles:sections.map(n=>(n.querySelector('strong')?.textContent||'').trim()),
      relationSection:rect(relation),
      relationRow:rect(relationRow),
      relationText:relationRow?.textContent.replace(/\\s+/g,' ').trim()??null,
      emptyRelationCopies:[...document.querySelectorAll('.compare-muted')].filter(n=>n.textContent.includes('비교할 검색 조건 없음')).length,
      basics:rect(basics),
      firstFact:rect(firstFact),
      firstFactText:firstFact?.textContent.replace(/\\s+/g,' ').trim()??null,
    }
  })()`)
}

async function verifyNetwork(c, label) {
  const net = await network(c)
  assert.equal(net.sentAnalytics.length, 0, `${label}: analytics escaped blocker`)
  assert.equal(net.sentWrites.length, 0, `${label}: write request observed`)
  const nonRead = c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co') && !['GET', 'HEAD', 'OPTIONS'].includes(item.method))
  assert.deepEqual(nonRead, [], `${label}: non-read Supabase request`)
  const badPublic = net.publicResponses.filter((item) => item.status >= 400)
  assert.deepEqual(badPublic, [], `${label}: public API error response`)
  return {
    publicReads: net.publicReads,
    methods: [...new Set(c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co')).map((item) => item.method))],
    blocked: net.blocked,
  }
}

async function captureLookup(origin, label, width, height, mobile) {
  const launched = await launch(width, height, mobile)
  const c = launched.c
  try {
    await c.nav(compareUrl(origin, 'lookup'))
    await waitCompare(c)
    const result = await metrics(c)
    assert.deepEqual(result.products.map((item) => item.name), PRODUCTS.map((item) => item.name), `${label}: product order changed`)
    assert.ok(result.basics && result.firstFact, `${label}: basic product facts missing`)
    await c.shot(`${OUT}/${label}-${width}x${height}.png`)
    const net = await verifyNetwork(c, `${label}-${width}`)
    return { ...result, network: net, chrome: launched.version }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

async function verifyConditionedExplore(origin) {
  const launched = await launch(360, 844, true)
  const c = launched.c
  try {
    await c.nav(compareUrl(origin, 'explore', true))
    await waitCompare(c)
    const result = await metrics(c)
    assert.ok(result.relationSection && result.relationRow, 'condition-bearing EXPLORE relation section disappeared')
    assert.ok(result.relationText?.includes('확인됨'), `EXPLORE confirmed relation missing: ${result.relationText}`)
    assert.ok(result.relationText?.includes('건식'), `EXPLORE selected condition missing: ${result.relationText}`)
    const net = await verifyNetwork(c, 'candidate-explore')
    return { ...result, network: net, chrome: launched.version }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

const report = { baseSha: '8391c76965b8ec94ce25856dad611c7b0f306aac', candidateSha: '5f7b84a1165330564af77164b804c568b46f3471', products: PRODUCTS, lookups: {}, conditionedExplore: null }
for (const viewport of [
  { width: 360, height: 844, mobile: true },
  { width: 1280, height: 900, mobile: false },
]) {
  const key = `${viewport.width}x${viewport.height}`
  const base = await captureLookup(BASE_URL, 'base', viewport.width, viewport.height, viewport.mobile)
  const candidate = await captureLookup(CANDIDATE_URL, 'candidate', viewport.width, viewport.height, viewport.mobile)
  assert.ok(base.relationSection && base.relationRow, `${key}: baseline empty relation section missing unexpectedly`)
  assert.ok(base.emptyRelationCopies >= 2, `${key}: baseline empty relation copy missing`)
  assert.equal(candidate.relationSection, null, `${key}: candidate still renders empty relation section`)
  assert.equal(candidate.relationRow, null, `${key}: candidate still renders empty relation row`)
  assert.equal(candidate.emptyRelationCopies, 0, `${key}: candidate still renders empty relation copy`)
  assert.equal(candidate.sectionTitles[0], '제품 기본 정보', `${key}: product basics are not the first overview section`)
  assert.ok(candidate.basics.top < base.basics.top, `${key}: product basics did not move earlier`)
  assert.ok(candidate.firstFact.top < base.firstFact.top, `${key}: first product fact did not move earlier`)
  report.lookups[key] = { base, candidate, basicTopChange: candidate.basics.top - base.basics.top, firstFactTopChange: candidate.firstFact.top - base.firstFact.top }
}
report.conditionedExplore = await verifyConditionedExplore(CANDIDATE_URL)
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log('PR45_LOOKUP_COMPARE_CRITERIA_PASS')
console.log(JSON.stringify({
  lookup360: { baseSections: report.lookups['360x844'].base.sectionTitles, candidateSections: report.lookups['360x844'].candidate.sectionTitles, basicTopChange: report.lookups['360x844'].basicTopChange },
  lookup1280: { baseSections: report.lookups['1280x900'].base.sectionTitles, candidateSections: report.lookups['1280x900'].candidate.sectionTitles, basicTopChange: report.lookups['1280x900'].basicTopChange },
  conditionedExplore: { relationText: report.conditionedExplore.relationText },
}, null, 2))
