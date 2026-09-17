import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { js, launch, network, sleep } from './detail-tab-scroll-qa-helpers.mjs'

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
  if (mode === 'explore') { url.searchParams.set('applied', '1'); url.searchParams.set('feed', '건식') }
  url.searchParams.set('compare', PRODUCTS.map((product) => product.id).join(','))
  url.searchParams.set('compareOpen', '1')
  return url.href
}
async function waitCompare(c) {
  await c.wait(`document.querySelector('.compare-stage')`, 'compare stage', 30000)
  for (const product of PRODUCTS) await c.wait(`[...document.querySelectorAll('.compare-product-copy strong')].some(n=>n.textContent.trim()===${js(product.name)})`, `product ${product.name}`, 30000)
  await c.wait(`document.querySelectorAll('.compare-product-head').length===2`, 'two compare heads', 30000)
  await sleep(250)
}
async function metrics(c) {
  return c.eval(`(()=>{
    const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim(), rect=(n)=>{if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    const wrap=document.querySelector('.compare-table-wrap'), table=document.querySelector('.compare-table'), wr=wrap.getBoundingClientRect()
    const sections=[...table.querySelectorAll(':scope > .compare-section-row')], rows=[...table.querySelectorAll(':scope > .compare-row')]
    const rowByLabel=(label)=>rows.find(n=>norm(n.querySelector('.compare-row-label')?.textContent)===label)||null, cellTexts=(row)=>row?[...row.children].slice(1).map(n=>norm(n.textContent)):[]
    const relation=rowByLabel('선택한 조건과 비교'), first=rowByLabel('사료 형태'), last=rowByLabel('제조국'), overview={}
    for(const row of rows){const label=norm(row.querySelector('.compare-row-label')?.textContent);if(label)overview[label]=cellTexts(row)}
    return {
      viewport:{width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth,docHeight:document.documentElement.scrollHeight},
      table:{wrapClientWidth:wrap.clientWidth,wrapScrollWidth:wrap.scrollWidth,overflowX:getComputedStyle(wrap).overflowX,tableWidth:table.getBoundingClientRect().width,horizontalTravel:wrap.scrollWidth-wrap.clientWidth},
      products:[...document.querySelectorAll('.compare-product-head')].map(n=>{const r=n.getBoundingClientRect(),left=Math.max(r.left,wr.left),right=Math.min(r.right,wr.right);return{brand:norm(n.querySelector('.compare-product-copy>span')?.textContent),name:norm(n.querySelector('.compare-product-copy strong')?.textContent),sale:norm(n.querySelector('.compare-product-copy small')?.textContent),image:n.querySelector('img')?.src??null,detail:norm(n.querySelector('.compare-detail-link')?.textContent),remove:n.querySelector('.compare-remove')?.getAttribute('aria-label')??null,rect:rect(n),visibleWidthAtStart:Math.max(0,right-left),detailRect:rect(n.querySelector('.compare-detail-link')),removeRect:rect(n.querySelector('.compare-remove'))}}),
      sectionTitles:sections.map(n=>norm(n.querySelector('strong')?.textContent)), relationText:relation?norm(relation.textContent):null, overview,
      firstFactTop:first?.getBoundingClientRect().top??null,lastFactBottom:last?.getBoundingClientRect().bottom??null,overviewFactSpan:first&&last?last.getBoundingClientRect().bottom-first.getBoundingClientRect().top:null,
    }
  })()`)
}
async function verifyNetwork(c, label) {
  const net=await network(c); assert.equal(net.sentAnalytics.length,0,`${label}: analytics escaped blocker`); assert.equal(net.sentWrites.length,0,`${label}: write escaped blocker`)
  const supabase=c.requests.filter((item)=>item.url.includes('gnosbstdatkytsyxuapt.supabase.co')); assert.deepEqual(supabase.filter((item)=>!['GET','HEAD','OPTIONS'].includes(item.method)),[],`${label}: non-read Supabase request`); assert.deepEqual(net.publicResponses.filter((item)=>item.status>=400),[],`${label}: public API error`)
  return{publicReads:net.publicReads,methods:[...new Set(supabase.map((item)=>item.method))],blocked:net.blocked}
}
async function stop(launched,c){c?.close();try{launched.proc?.kill('SIGTERM')}catch{}await sleep(250);try{if(launched.proc?.exitCode==null)launched.proc.kill('SIGKILL')}catch{}}
async function capture(mode,width,height) {
  const launched=await launch(width,height,true),c=launched.c
  try {
    await c.nav(compareUrl(mode));await waitCompare(c);const result=await metrics(c)
    assert.deepEqual(result.products.map(({brand,name})=>({brand,name})),PRODUCTS.map(({brand,name})=>({brand,name})),`${mode}-${width}: order changed`)
    for(const [label,values] of Object.entries(EXPECTED_BASIC))assert.deepEqual(result.overview[label],values,`${mode}-${width}: ${label} changed`)
    assert.ok(result.table.horizontalTravel>0,`${mode}-${width}: expected current horizontal compare travel`)
    if(mode==='lookup')assert.equal(result.sectionTitles[0],'제품 기본 정보');else{assert.equal(result.sectionTitles[0],'선택한 조건과 비교');assert.ok(result.relationText?.includes('확인됨')&&result.relationText?.includes('건식'))}
    await c.shot(`${OUT}/current-${mode}-${width}x${height}.png`)
    return{...result,network:await verifyNetwork(c,`${mode}-${width}`),url:compareUrl(mode),chrome:launched.version}
  }finally{await stop(launched,c)}
}
const report={mergeSha:MERGE_SHA,origin:ORIGIN,products:PRODUCTS,captures:{}}
for(const vp of[{width:360,height:844},{width:390,height:900}])for(const mode of['lookup','explore'])report.captures[`${mode}-${vp.width}x${vp.height}`]=await capture(mode,vp.width,vp.height)
writeFileSync(`${OUT}/current-layout-report.json`,JSON.stringify(report,null,2))
console.log('TWO_PRODUCT_CURRENT_LAYOUT_CAPTURE_PASS')
for(const[key,v]of Object.entries(report.captures))console.log(key,JSON.stringify({table:v.table,products:v.products.map(p=>({brand:p.brand,name:p.name,sale:p.sale,visibleWidthAtStart:p.visibleWidthAtStart})),firstFactTop:v.firstFactTop,docHeight:v.viewport.docHeight,relationText:v.relationText}))
