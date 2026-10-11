# Frontend 문서 안내

2026-10-11 기준. 공개 frontend의 현재 구현 계약과 코드를 찾기 위한 목차다. 사용자에게 표시할 제품 사실이나 데이터 정확성 증거를 이 문서에서 만들지 않는다.

## 읽는 순서

| 문서 | 역할 |
| --- | --- |
| [저장소 README](../README.md) | 실행·빌드·배포, 공개 API 경계와 현재 검색 동작 |
| [UI reference principles](ui-reference-principles.md) | 화면별 정보 순서와 레퍼런스에서 채택한 인터랙션 원칙 |
| [Consumer design system](consumer-design-system.md) | 현재 공통 시각 구성과 비교의 읽기 방식 |
| [Brand search aliases](brand-search-aliases.md) | 한글·영문 브랜드 검색 별칭과 브랜드 identity 구분 |
| [원료 제외](explore-ingredient-exclusion.md) | 확인된 원료 제외, 미발견·근거 부족 유지와 비교 관계 |
| [복수 브랜드 좁히기](explore-brand-refinement.md) | OR 선택·URL·검색·비교 보존 |
| [열량 좁히기](explore-energy-refinement.md) | 맥락·단위 환산·자료 범위·지연 조회·미확인·intake 제한 |

기능 문서는 실제 구현 계약이며 UI 참고 문서가 허용하는 모든 아이디어의 구현 목록은 아니다. 날짜가 있는 조사·과거 시안·완료 보고를 새 작업 목록으로 자동 채택하지 않는다. 이후 동작이 바뀌면 해당 기능 문서와 이 목차의 설명을 함께 맞춘다. private core의 활성 제품 의미와 사용자 지시가 우선이며, private 연구·SQL·로그·토큰은 이 공개 저장소에 옮기지 않는다.

## 구현 위치

| 확인할 내용 | Source |
| --- | --- |
| 기본 조건 적용·추가 좁히기·결과·일반 비교 연결 | [App.tsx](../src/App.tsx) |
| 조건 평가·미확인·검색 별칭 | [search.ts](../src/search.ts) |
| 일반 탐색 URL·마지막 적용 조건·비교 상태 | [navigation-state.ts](../src/navigation-state.ts) |
| 열량 값·유효성·항목별 자료 범위·입력 UI | [energy-refine.tsx](../src/energy-refine.tsx), [nutrition-reading.ts](../src/nutrition-reading.ts) |
| 공개 read model helper·규격 페이지네이션 | [api.ts](../src/api.ts) |
| 비교 탭 지연 조회·모바일 pair·현재/후보 영양 | [CompareView.tsx](../src/CompareView.tsx) |
| 상세 개요·영양·원재료·제조/유통 | [ProductDetail.tsx](../src/ProductDetail.tsx) |
| SWITCH 현재 사료·사용 규격·후보·새 시작 | [SwitchFlow.tsx](../src/SwitchFlow.tsx) |

## 상태를 바꿀 때 확인할 경계

- 조건 편집 draft는 적용 전까지 마지막 적용 기준을 덮어쓰지 않는다.
- 같은 기본 조건 재적용은 추가 좁히기와 일반 비교를 보존한다. 실제 기본 조건 변경 후 적용은 추가 좁히기와 일반 비교를 초기화한다.
- 결과의 브랜드·레시피·열량 변경은 비교 목록을 유지한다. LOOKUP에서 수동 추가한 제품이 조건 밖이어도 자동 삭제하지 않고 관계를 표시한다.
- EXPLORE↔LOOKUP·상세/비교 왕복·URL/history 복원에서는 마지막 적용 기준을 유지한다. Home에서 새 일반 탐색을 시작하면 이전 일반 조건과 비교를 지운다.
- SWITCH의 현재 제품·규격·후보는 별도 session이다. 일반 조건을 섞거나 새로고침을 새 작업 시작으로 해석하지 않는다.
- 비교 탭의 추가 조회와 공통 카탈로그/판매 규격 조회는 구분한다. 열량 좁히기도 명시적 열기 또는 유효 URL 복원 전에는 추가 영양 조회를 하지 않는다.
- 미요청·로딩·오류·미확인은 서로 다른 상태다. 미확인, 검토 자료에서 미발견, 실제 원료 부재를 같은 뜻으로 바꾸지 않는다.

검증 결과에는 source SHA와 fixture / 공개 데이터 candidate / 실제 Pages를 구분해 남긴다. 화면·포커스·스크롤에 영향을 주는 변경은 실제 브라우저 증거가 필요하다. 문서 전용 정리는 관련 source와 상대 링크를 확인하며, 실행하지 않은 제품·브라우저 검증을 새로 완료했다고 기록하지 않는다.
