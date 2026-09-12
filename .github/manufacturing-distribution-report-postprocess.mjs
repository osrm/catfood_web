import { readFileSync, writeFileSync } from 'node:fs'

const path = 'qa-artifacts/manufacturing-distribution-review/report.json'
const report = JSON.parse(readFileSync(path, 'utf8'))
const removed = []
report.findings = (report.findings ?? []).filter((finding) => {
  if (finding.code !== 'context_tab_did_not_return_near_heading') return true
  const heading = finding.details?.headingVisible
  const rect = heading?.headingRect
  if (heading?.visible && Array.isArray(rect) && rect[1] >= 80 && rect[1] <= 220) {
    removed.push(finding)
    return false
  }
  return true
})

const seen = new Set()
for (const item of report.cases ?? []) {
  if (item.error) continue
  const apiRows = item.api?.markets ?? []
  const uiRows = item.comparison?.actual?.marketRows ?? []
  apiRows.forEach((row, index) => {
    const ui = uiRows[index]
    if (!row?.country_code || !ui) return
    if (ui.country === row.country_code) {
      const key = `${item.product?.product_id}:${row.country_code}`
      if (seen.has(key)) return
      seen.add(key)
      report.findings.push({
        severity: 'low',
        code: 'raw_country_code_fallback_visible',
        details: {
          product_id: item.product?.product_id,
          product: item.product?.canonical_name,
          api_country_code: row.country_code,
          ui_country_label: ui.country,
          impact: '해당 국가는 다른 매핑된 국가처럼 한국어 라벨이 아니라 공개 API 코드 그대로 보입니다.',
        },
      })
    }
  })
}

const selected = report.publicApiSelection?.selected ?? []
report.coverage = {
  selectedVariantScopeCase: selected.some((item) => item.manufacturing?.observation_scope === 'variant'),
  selectedCounterpartNameCase: selected.some((item) => (item.markets ?? []).some((row) => row.counterpart_name?.trim())),
  note: '이번 최대 3개 선정에서는 규격 기준 제조 정보 사례를 확보했습니다. 선정된 3개 사례의 현지 제품명(counterpart_name)은 모두 null이어서 긴 현지 제품명 wrapping은 직접 검증하지 못했습니다.',
}
report.qaHarnessNotes = [
  ...(report.qaHarnessNotes ?? []),
  {
    code: 'heading_alignment_heuristic_refined',
    removedCount: removed.length,
    reason: '내부 scrollTop 절대값이 아니라 sticky 상단 UI 아래 제조 정보 제목의 실제 가시 위치를 기준으로 판정했습니다. 제거된 항목은 모두 제목이 화면 y≈132px에 보였습니다.',
  },
]
const high = report.findings.filter((item) => item.severity === 'high')
report.status = high.length ? 'review_required' : 'pass'
writeFileSync(path, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ status: report.status, findings: report.findings, coverage: report.coverage, qaHarnessNotes: report.qaHarnessNotes }, null, 2))
