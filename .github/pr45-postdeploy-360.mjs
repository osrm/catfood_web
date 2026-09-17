import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cleanup, js, launch, network, sleep } from './detail-tab-scroll-qa-helpers.mjs'

const ORIGIN = 'https://osrm.github.io/catfood_web/'
const OUT = 'qa-artifacts/pr45-postdeploy-360'
const MERGE_SHA = '3d3a90a46f0ae9400179158dc67e21ee8b5d5e92'
const PRODUCTS = [
  { id: 'product_d99406c26240b263', brand: 'AATU', name: '연어' },
  { id: 'product_31bc515d78d43d5d', brand: 'GO! SOLUTIONS', name: '카니보 치킨&칠면조&오리' },
]
const EXPECTED_BASIC = {
  '사료 형태': ['건식', '건식'],
  '대상 연령': ['전연령', '전연령'],
  '제품 표기 대상': ['확인된 값 없음', '확인된 값 없음'],
  '제품 특징': ['확인된 값 없음', '확인된 값 없음'],
}
mkdirSync(OUT, { recursive: true })

function compareUrl(mode) {
  const url = new URL(ORIGIN)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('mode', mode)
  if (mode === 'explore') {
    url.searchParams.set('applied', '1')
    url.searchParams.set('feed', '건식')
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
  await c.wait(`document.querySelectorAll('.compare-product-head').length===2`, 'two compare heads', 30000)
  await sleep(250)
}

async function metrics(c) {
  return c.eval(`(()=>{
    const table=document.querySelector('.compare-table')
    const sections=[...table.querySelectorAll(':scope > .compare-section-row')]
    const rows=[...table.querySelectorAll(':scope > .compare-row')]
    const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim()
    const rowByLabel=(label)=>rows.find(n=>norm(n.querySelector('.compare-row-label')?.textContent)===label)||null
    const cellTexts=(row)=>row?[...row.children].slice(1).map(n=>norm(n.textContent)):[]
    const relation=rowByLabel('선택한 조건과 비교')
    const basic={}
    for(const label of ${JSON.stringify(Object.keys(EXPECTED_BASIC))}){
      const row=rowByLabel(label)
      basic[label]=cellTexts(row)
    }
    return {
      viewport:{width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth},
      products:[...document.querySelectorAll('.compare-product-head')].map(n=>({brand:norm(n.querySelector('.compare-product-copy>span')?.textContent),name:norm(n.querySelector('.compare-product-copy strong')?.textContent)})),
      sectionTitles:sections.map(n=>norm(n.querySelector('strong')?.textContent)),
      relationText:relation?norm(relation.textContent):null,
      emptyRelationCopies:[...document.querySelectorAll('.compare-muted')].filter(n=>norm(n.textContent).includes('비교할 검색 조건 없음')).length,
      basic,
    }
  })()`)
}

async function verifyNetwork(c, label) {
  const net = await network(c)
  assert.equal(net.sentAnalytics.length, 0, `${label}: analytics request escaped blocker`)
  assert.equal(net.sentWrites.length, 0, `${label}: write request escaped blocker`)
  const supabase = c.requests.filter((item) => item.url.includes('gnosbstdatkytsyxuapt.supabase.co'))
  const nonRead = supabase.filter((item) => !['GET', 'HEAD', 'OPTIONS'].includes(item.method))
  assert.deepEqual(nonRead, [], `${label}: non-read Supabase request observed`)
  const badPublic = net.publicResponses.filter((item) => item.status >= 400)
  assert.deepEqual(badPublic, [], `${label}: public API error response`)
  return {
    publicReads: net.publicReads,
    methods: [...new Set(supabase.map((item) => item.method))],
    blocked: net.blocked,
  }
}

async function capture(mode, fileName) {
  const launched = await launch(360, 844, true)
  const c = launched.c
  try {
    await c.nav(compareUrl(mode))
    await waitCompare(c)
    const result = await metrics(c)
    assert.deepEqual(result.products, PRODUCTS.map(({ brand, name }) => ({ brand, name })), `${mode}: product order/identity changed`)
    for (const [label, values] of Object.entries(EXPECTED_BASIC)) {
      assert.deepEqual(result.basic[label], values, `${mode}: basic fact changed for ${label}`)
    }
    if (mode === 'lookup') {
      assert.equal(result.sectionTitles[0], '제품 기본 정보', 'LOOKUP: product basics are not first')
      assert.equal(result.sectionTitles.includes('선택한 조건과 비교'), false, 'LOOKUP: empty condition section still rendered')
      assert.equal(result.relationText, null, 'LOOKUP: empty condition row still rendered')
      assert.equal(result.emptyRelationCopies, 0, 'LOOKUP: empty relation copy still rendered')
    } else {
      assert.equal(result.sectionTitles[0], '선택한 조건과 비교', 'EXPLORE: condition section no longer first')
      assert.ok(result.relationText?.includes('확인됨'), `EXPLORE: confirmed relation missing: ${result.relationText}`)
      assert.ok(result.relationText?.includes('건식'), `EXPLORE: dry-food condition missing: ${result.relationText}`)
    }
    await c.shot(`${OUT}/${fileName}`)
    const net = await verifyNetwork(c, mode)
    return { ...result, network: net, chrome: launched.version, url: compareUrl(mode) }
  } finally {
    cleanup(launched.proc, launched.dir, c)
  }
}

const lookup = await capture('lookup', 'lookup-360x844.png')
const explore = await capture('explore', 'explore-dry-360x844.png')
const report = { mergeSha: MERGE_SHA, origin: ORIGIN, products: PRODUCTS, lookup, explore }
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log('PR45_POSTDEPLOY_360_PASS')
console.log(JSON.stringify({
  lookup: { sections: lookup.sectionTitles, products: lookup.products, basic: lookup.basic, network: lookup.network },
  explore: { sections: explore.sectionTitles, relationText: explore.relationText, network: explore.network },
}, null, 2))
