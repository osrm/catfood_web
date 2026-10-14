# CATFOOD UI reference principles

이 문서는 Stage 6 UI를 구현할 때 외부 서비스를 그대로 복제하지 않고, 각 화면이 잘해야 할 일을 어떤 인터랙션 원칙으로 가져올지 정리한 frontend 구현 기준이다.

제품 의미와 검색 상태의 source of truth는 private core의 활성 UX/taxonomy 문서다. 이 문서는 그 의미를 시각 구조와 인터랙션으로 번역하며, 현재 backend/API가 제공하지 않는 기능을 완성된 것처럼 약속하지 않는다.

구현 현황 확인: 2026-10-11. 이 문서의 레퍼런스 해석은 화면별 원칙이며, 현재 제공하는 기능과 상태 계약은 [문서 안내](README.md)의 기능별 문서 및 실제 source를 함께 확인한다. 이후 변경은 해당 기능 문서의 계약을 기준으로 대조한다.

## Product direction

CATFOOD는 쇼핑몰, 랭킹, 귀여운 반려동물 앱, 전문가 전용 분석 도구가 아니다. 일반 소비자가 제품을 선택하기 전에 **정확한 제품 정체성, 확인된 사실, 자기 기준과의 관계, 후보 간 차이와 근거**를 이해할 수 있는 제품 의사결정 도구를 지향한다.

현재 frontend는 고양이 사료만 다룬다. 다만 시각 언어와 인터랙션은 특정 펫 장식에 의존하지 않고, 제품 데이터를 탐색·비교하는 명확한 문법을 우선한다.

- 그래픽은 제품을 평가하지 않고 사실을 이해시키는 데 사용한다.
- 제품 이미지는 정확한 식별과 실물감, 관심 형성을 함께 돕는다. 제품 사진을 반드시 작은 썸네일로 제한하지 않는다. 사진의 강조가 추천·품질 우열을 암시하지 않게 한다.
- unknown / 미확인 상태를 false나 없음으로 바꾸지 않는다.
- 점수, 순위, best, 적합도, 좋음/나쁨 색상 의미를 임의로 만들지 않는다.
- 정보가 많아도 한 번에 모두 노출하지 않고, 사용자의 현재 작업에 필요한 깊이부터 보여준다.
- 사용자가 두 페이지를 왕복하며 값을 기억하지 않아도 비교할 수 있게 한다.
- 기능의 시각적 강조는 현재 API 연결성과 실제 동작 범위를 과장하지 않는다.

## Visual direction revision — 2026-10-13

사실을 중립적으로 다루는 것과 화면을 극도로 중립적으로 만드는 것은 다르다. 근거 없는 추천·품질 판정을 만들지 않으면서도 사진, 타이포그래피, 색, 대비와 편집 구성에는 뚜렷한 태도를 가질 수 있다. 사용자는 자료 열람만이 아니라 자신의 선택을 설명할 수 있는 도움을 받아야 한다.

현재 구현의 흰 배경·단일 폰트·녹색 행동색은 변경할 수 없는 브랜드 규칙이 아니다. 기능 회귀/overflow/노출 행 수의 성공을 디자인의 완성으로 판정하지 않는다. 다음 시각 작업은 [공식 화면 재검토와 다음 디자인 기준](reference-reassessment-20261013.md)을 함께 읽는다. 그 문서는 다음 디자인을 위한 기준이며 아직 적용된 화면이나 사람 검증 결과를 뜻하지 않는다.

## Core interaction grammar

CATFOOD UI는 다음 흐름을 기본 문법으로 본다.

```text
FIND
제품을 찾는다
  ->
DEFINE WHAT MATTERS
이번 선택에서 중요한 기준을 정한다
  ->
INSPECT
확인된 제품 사실과 상태를 본다
  ->
COMPARE
후보의 차이를 같은 질문 아래 비교한다
  ->
VERIFY
필요하면 근거와 확인 상태까지 내려간다
  ->
DECIDE
최종 판단은 사용자가 한다
```

현재 사료를 기준으로 무엇을 바꾸고 유지할지 정하는 SWITCH가 핵심 의사결정 흐름이다. 비교는 후보의 변화와 유지 여부를 검토하는 수단이다. EXPLORE와 LOOKUP도 독립 진입으로 유지한다.

## Information layers

화면에서 서로 다른 의미를 한 덩어리로 섞지 않는다.

| Layer | 질문 | CATFOOD 예 |
| --- | --- | --- |
| **IDENTITY** | 정확히 어떤 제품·버전·규격인가? | Product → Formula → SKU |
| **FACTS** | 무엇을 확인할 수 있는가? | 원재료, 영양, 열량, 제조국, 공식 대상 |
| **RELATION** | 사용자 기준과 어떤 관계인가? | confirmed match / conflict / unknown |
| **EVALUATION** | 일정한 방법론으로 평가한 결과가 있는가? | 현재는 원칙적으로 없음 |
| **EVIDENCE** | 왜 이 정보를 믿을 수 있는가? | 출처, 시장, 확인 상태, reviewed evidence |

특히 `FACT`와 `EVALUATION`을 구분한다.

```text
공식적으로 중성화묘 대상이라고 표시됨
= FACT

중성화묘에게 더 좋은 제품이다
= EVALUATION
```

현재 데이터에서 임의의 품질·영양·적합도 점수를 만들지 않는다. 향후 평가를 도입하려면 같은 카테고리 안에서 설명 가능한 방법론과 비교 가능성이 먼저 있어야 한다.

## Trust reference model — Consumer Reports / Which? / RTINGS

이 서비스들을 시각적으로 복제하지 않는다. 참고하는 것은 다음 신뢰 구조다.

- 판매보다 소비자 판단을 우선하는 독립적 태도
- 같은 질문 아래 제품을 비교할 수 있게 만드는 일관성
- 방법론과 데이터 상태 자체가 신뢰의 일부가 되는 구조
- 제품 상세에서 필요할 때 근거까지 추적할 수 있는 구조

현재 CATFOOD는 자체 실험실 시험기관이 아니므로 Consumer Reports나 RTINGS식 rating, winner, best 판정을 UI에 흉내 내지 않는다.

## Screen reference map

### Home — orientation before density

Home은 현재 사료에서 다음 후보를 찾는 출발점이다. 메인 문구는 `어떤 사료를 찾으세요?`로 유지한다. 현재 사료 진입을 우선하고 제품 직접 검색·조건 탐색도 바로 접근할 수 있게 한다. 데이터 읽기 주제는 발견하기 쉬운 기본 콘텐츠로 두며, 리콜·안전 정보는 실제 제공 범위와 공식 원문 접근을 구분한다. 긴 마케팅 landing page나 데이터 dashboard로 만들지 않는다.

가져올 점:
- 브랜드/제품 직접 검색과 탐색 시작이 즉시 보여야 한다.
- 현재 지원하는 기능만 명확하게 보여준다.
- 핵심 신뢰 메시지는 추상적인 자화자찬보다 실제 데이터 구조를 짧게 설명한다.
- 3-pane workspace는 사용자가 탐색을 시작한 뒤에만 필요할 수 있다.

피할 점:
- 큰 빈 hero와 장식 이미지
- 미래 기능을 현재 기능처럼 동등하게 강조
- 펫샵·쇼핑몰·귀여운 앱의 시각 문법

### Results / Explore — Redfin + Google Flights

가져올 점:
- Redfin처럼 브라우저 전체 폭을 작업 공간으로 사용한다.
- 검색 조건, 결과, 선택 제품이 같은 맥락 안에서 이어지게 한다.
- Google Flights처럼 기본 조건을 먼저 보여주고, 관련 조건을 선택했을 때만 contextual refine을 연다.
- 결과 0건이어도 조건을 자동 완화하지 않는다.
- 이름을 알고 찾는 결과는 빠르게 훑는 목록이 적합할 수 있다. 제품을 발견하는 장면은 사진 중심 구성도 검토한다. 모든 화면을 같은 촘촘한 기록 목록으로 고정하지 않는다.
- 사용자가 선택한 조건에 대한 제품의 `match / conflict / unknown` 관계를 가능한 범위에서 결과에 노출한다.

패널 수와 배치는 장기 고정 규칙이 아니다. 제품 quick view는 필요한 작업에서 열리며 결과 탐색과 비교 맥락을 유지한다.

### Product detail — structured consumer database

가져올 점:
- IKEA처럼 숫자와 메타데이터를 가능한 경우 이해하기 쉬운 표현으로 바꾼다.
- Apple Health / Examine처럼 요약 → 상세 → 근거의 계층을 만든다.
- 패키지, 브랜드, 제품명, Formula, SKU를 먼저 명확히 식별한다.
- 영양은 단일 제품에서 높음/낮음을 평가하지 않는다. 숫자와 단위를 명확히 보여준다.
- 원재료 evidence는 CATFOOD의 핵심 상태 언어로 유지한다.
- 제품 사진·identity·핵심 데이터가 하나의 정보 위계를 만든다. 사진을 줄이고 작은 메타데이터를 늘리는 것이 기본 개선 방향은 아니다.

장기적으로 Product detail은 다음 구조를 자연스럽게 수용할 수 있어야 한다.

```text
OVERVIEW
IDENTITY / FORMULA / SKU
INGREDIENTS
NUTRITION
OFFICIAL TARGETS / FEATURES
MANUFACTURING / MARKET
DATA / EVIDENCE
```

현재 public API가 제공하지 않는 상세는 placeholder 데이터로 채우지 않는다.

### Compare — Apple Compare + GitHub Diff

가져올 점:
- Apple Compare처럼 제품 2~3개를 고정된 열로 식별한다.
- 모든 섹션에서 같은 제품 열 순서를 유지한다.
- GitHub Diff처럼 기본적으로 차이를 빠르게 찾을 수 있게 한다.
- 전체 보기와 차이만 보기를 전환할 수 있게 한다.
- 사용자가 현재 탐색에서 중요하게 둔 기준을 비교 상단에 우선 배치한다.
- 정확한 수치와 동일 항목의 비교에서는 table을 적극적으로 사용할 수 있다.
- 차이를 빨강/초록이나 better/worse로 표시하지 않는다. 중립적인 배경, 굵기, 위치로만 구분한다.
- 현재 사료는 기준 제품으로 시각적으로 고정하되 우월/열등 의미를 주지 않는다.

### Evidence — summary first, evidence on demand

모든 출처와 provenance를 첫 화면에 펼치지 않는다.

기본 흐름:

```text
사용자가 보는 값
  -> 현재 확인 상태
  -> 필요할 때 공개 가능한 근거 상세
```

신뢰를 `정확한 데이터`라는 문구만으로 주장하지 않는다. 제품 페이지에서 어떤 값이 확인됐고 무엇이 미확인인지 실제 상태로 보여주는 것이 우선이다.

## Decision-load rules

선택지가 많다는 이유만으로 임의의 상위 5개 제품만 보여주지 않는다. 사용자가 동시에 판단해야 하는 차원을 줄이는 것이 우선이다.

- 첫 진입에서 전체 taxonomy를 펼치지 않는다.
- 사용자가 선택한 맥락에 따라 추가 조건을 연다.
- 체중관리를 선택했을 때만 kcal/관련 refine을 여는 식의 contextual refine을 우선한다.
- 결과 화면에서 선택한 기준을 계속 보여줘 사용자가 기억에 의존하지 않게 한다.
- 모바일에서는 적용 조건 개수에서 전체 목록을 펼쳐 확인할 수 있게 한다. 숨은 가로 스크롤에만 의존하지 않으며, 목록을 열고 닫아도 조건·결과·비교 선택을 바꾸지 않는다.
- switching에서는 현재 제품을 기준점으로 계속 보존한다.

## Comparison normalization

사료 데이터는 제품마다 필드와 근거 수준이 다르므로 모든 값을 억지로 동일 스키마처럼 보이게 만들지 않는다. 비교 화면은 `값의 완전한 대칭`이 아니라 `같은 질문 아래 상태를 정렬`하는 것을 목표로 한다.

### 1. Common axes

대부분의 제품에서 안정적으로 비교 가능한 항목:
- 브랜드 / 제품명
- 형태
- 대상 연령
- 포장 / SKU
- 제조국
- 열량
- 조단백질 / 조지방 / 수분 등 기본 영양값

### 2. Conditional axes

제품별로 존재 여부가 다른 항목:
- 조섬유 / 조회분
- 칼슘 / 인
- 오메가 계열
- 기능성 성분
- 공식 대상 특성

값이 없으면 0이나 미포함으로 표현하지 않고 확인 상태를 그대로 보여준다.

### 3. Heterogeneous data

단순 표보다 별도 비교 문법이 필요한 항목:
- 전체 원재료
- 원료군 포함 여부
- 제품 버전 / 리뉴얼 세대
- 공식 target 문구

원재료는 원료별로 같은 질문을 만든 뒤 각 제품의 상태를 나란히 놓는다.

예:

| 원료 | 현재 사료 | 후보 A | 후보 B |
| --- | --- | --- | --- |
| 닭고기 | 포함 확인 | 검토한 자료에서 찾지 못함 | 확인 자료 부족 |
| 옥수수 | 포함 확인 | 포함 확인 | 검토한 자료에서 찾지 못함 |

`검토한 자료에서 찾지 못함`과 `확인 자료 부족`은 실제 미포함을 의미하지 않는다.

## Visual character

목표 감정은 `귀여운 반려동물 서비스`보다 **일반 소비자가 편하게 사용하는 전문 제품 데이터베이스**에 가깝다.

핵심 성격:
- neutral
- authoritative
- information-dense
- calm
- precise
- consumer-accessible

시각 규칙:
- 화면 전체를 적극적으로 사용하되 콘텐츠가 서로 멀어져 관계가 끊기지 않게 한다.
- 카드 수를 최소화하고, 섹션 관계는 여백·정렬·얇은 divider로 우선 표현한다.
- 그래픽 요소는 설명형이어야 하며 decoration만을 위해 추가하지 않는다.
- 단일 제품의 nutrition bar/range는 정상·좋음·나쁨을 암시할 수 있으므로 기본 사용하지 않는다.
- 비교 화면에서는 동일 항목의 값을 중립적으로 나란히 시각화할 수 있다.
- 제품명과 핵심 데이터는 일반 데스크톱에서 별도 확대 없이 읽을 수 있어야 한다.
- 정보 밀도를 작은 글씨로 해결하지 않는다.
- 고양이 일러스트, 발바닥, mascot을 핵심 브랜드 신뢰 장치로 사용하지 않는다.

## Design principles

1. **Facts before judgments**
2. **User criteria before rankings**
3. **Differences before full specifications**
4. **Unknown is a first-class state**
5. **Identity preserves Formula / SKU differences**
6. **Summary first, evidence on demand**
7. **Current product can be a baseline**
8. **Keep the interaction grammar simple even when the data is complex**

## Avoid

- AI SaaS식 card wall, 과도한 pill/chip, 빈 hero
- ecommerce식 가격/별점/추천 badge
- 펫샵·귀여운 반려동물 앱 느낌의 장식
- RTINGS식 과도한 전문 텍스트 밀도
- wiki/community 느낌의 무정형 정보 누적
- dashboard KPI 숫자 과장
- 근거 없는 평가 색상, 품질 점수, 추천 순위
- Product / Formula / SKU를 하나의 제품명으로 평탄화하는 UI
- `unknown`을 회색 처리만 하고 사실상 `없음`처럼 읽히게 하는 UI
- 아직 public API가 없는 상세 기능을 fake data로 완성해 보이는 UI

## Current implementation direction

- 현재 Stage 6 frontend는 공개 catalog와 상세 read model을 사용하는 HOME / EXPLORE / LOOKUP / SWITCH, 최대 5제품 비교와 제품 상세를 제공한다. 화면을 summary-only Inspector나 고정 3-pane prototype으로 가정하지 않는다.
- SWITCH의 현재 제품·사용 규격 선택, CHANGE / KEEP 흐름과 새 시작은 구현되어 있다. 일반 탐색 조건/비교와 SWITCH session을 섞지 않는다.
- 상세에는 개요·영양·원재료·제조/유통 탭이 있다. 실제 API로 확인한 자료만 표시하고 Product / Formula / SKU 및 항목별 보완 근거의 범위를 보존한다. 모든 포장이나 배합의 사실을 확인했다는 뜻은 아니다.
- 일반 탐색은 원료 제외, 복수 브랜드, 맥락에 따른 최대 열량 좁히기를 제공한다. 의미와 상태 보존은 [기능별 계약](README.md)을 따른다. 일반 영양 자유 range나 원료 부재·알레르기 안전 판정으로 확장하지 않는다.
- 비교 개요는 불필요한 상세 선조회를 하지 않는다. 영양·원재료 탭에서 필요한 자료를 읽으며, 같은 항목의 숫자와 단위·이상/이하·미확인을 유지한다.
- 현재 시각 구성은 [consumer design system](consumer-design-system.md)을 확인한다. 레퍼런스의 외형이나 옛 시안을 새로운 고정 테마로 취급하지 않는다.
- 미지원 API 기능을 placeholder 사실로 채우지 않는다. 새 기능은 현재 작업에서 확인된 사용자 문제와 자료 범위에 맞춰 별도로 결정한다.
