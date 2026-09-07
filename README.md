# Catfood Web

Catfood의 **public frontend repository**다. 사용자에게 배포되는 React/Vite UI의 source of truth이며, private core repository인 `osrm/catfood`의 데이터·research·Supabase 구현과 분리해서 운영한다.

현재 milestone은 **Stage 6 — UI 구현**이다. Supabase의 curated browser-facing read model을 읽는 SWITCH / EXPLORE / LOOKUP, 후보 Inspector, 최대 5개 제품 비교와 제품 상세를 구현한다.

## Repository boundary

- `osrm/catfood`: private core — data, research/strategy/internal docs, Supabase schema/migrations, normalization, internal scripts, evidence/provenance
- `osrm/catfood_web`: public frontend — React/Vite UI, frontend build, GitHub Pages preview, 이후 Vercel production 배포

이 repository는 private `catfood`를 build-time/runtime에 직접 읽지 않는다. 브라우저는 Supabase의 공개 `api` read model만 사용한다. `service_role`, secret key, private repository token, raw private data와 internal evidence는 넣지 않는다.

## Local development

개발·CI 검증 기준은 `.nvmrc`의 Node.js 22.23.2다. 지원 하한은 22.12지만 다른 버전의 동작을 모두 검증한 것은 아니다.

```bash
cp .env.example .env.local
npm ci
npm run dev
```

`.env.example`에는 브라우저 공개용 Supabase URL과 `sb_publishable_...` key가 들어 있다. 이 publishable key는 공개 client용이며 `service_role`/secret key와 다르다. `.env.local`에는 필요할 때 로컬 override만 두고 commit하지 않는다.

`VITE_DECISION_INTAKE_ENABLED`의 기본값은 `false`다. 사용자 안내, 보존기간과 production endpoint가 승인·배포되기 전에는 이 값을 켜지 않는다.

`?demo=1`, `?realpreview=1`, `?stresspreview=1`은 `npm run dev`에서만 검증용 데이터를 제공한다. 이 모드에서는 decision intake 설정이 켜져 있어도 수집하지 않는다. `npm run build` 결과에는 검증용 데이터 모듈이 포함되지 않으며 같은 query로 데이터를 전환할 수 없다.

## Current API contract

- read model: `api.effective_product_catalog_summary`
- catalog database에는 read-only 요청만 수행하며 browser direct INSERT/RPC는 하지 않는다.
- 최대 1000행을 읽고 브라우저에서 현재 검색 조건을 적용한다.
- 전체 판매 규격은 `api.switch_current_variant_options`를 1000행씩 나누어 조회한다. API의 응답 상한 때문에 더 큰 limit 한 번으로 전체를 읽었다고 간주하지 않는다. 중간 페이지 실패 시 부분 목록을 전체 규격처럼 표시하지 않고 대표 규격으로 fallback한다.
- 빈 normalized array나 미확인 상태를 `없음`으로 추론하지 않는다.
- `official_target`: 복수 선택 OR
- `feature`: 복수 선택 AND
- `recipe_family`: 복수 선택 OR
- `recipe_detail`: 복수 선택 OR
- Grain-Free: 명시적 positive claim만 충족
- 결과 0건이어도 조건을 자동 완화하지 않는다.

선택적으로 활성화되는 decision intake는 범용 clickstream이 아니다. SWITCH/EXPLORE 결과 생성 시 최초 40개 presentation과 명시적인 상세 열기·비교 추가만 Edge Function으로 보고한다. LOOKUP은 수집하지 않으며 intake 실패가 제품 탐색 UI를 막지 않는다.

SWITCH/EXPLORE는 최초 40개 이후에도 `제품 더 보기`로 40개씩 나머지 후보를 탐색·비교할 수 있다. 이후 후보는 V1 consideration 수집 대상에 포함하지 않는다. LOOKUP은 120개씩 표시한다. 조건을 다시 적용하면 표시 범위와 비교 선택을 초기화하고, 비교·상세에서 결과로 돌아올 때는 펼친 목록을 유지한다.

현재 UI는 제품에 저장된 canonical `life_stage`를 그대로 사용하며 사용자 나이에서 생애주기를 추론하지 않는다.

## Build and preview

```bash
npm test
npm run build
npm run preview
```

Vite는 상대 asset base를 사용해 GitHub Pages project site와 root 배포 양쪽에서 정적 asset 경로가 동작하도록 구성한다.

GitHub Pages preview:

https://osrm.github.io/catfood_web/

Pages workflow는 이 public repository만 checkout/build하며 private `catfood` 접근 token을 사용하지 않는다. 배포에 필요한 Supabase client 설정도 브라우저 공개용 URL과 publishable key만 사용한다.

향후 production 배포는 이 repository를 Vercel에 직접 연결하는 방향을 사용한다.

`npm test`는 Node 내장 테스트 러너와 jsdom에서 실제 React를 렌더링한다. 후보 더 보기, 비교·복귀·초기화, 최초 40개 수집 경계, 미확인 유지, LOOKUP, 검증용 데이터와 공개 번들의 분리를 검사한다. 운영 API 요청은 하지 않는다. 실제 브라우저의 레이아웃·포커스·스크롤 검수를 대체하지는 않는다. PR에서 테스트와 타입·빌드를 검사하고 Pages 배포 전에도 같은 테스트를 실행한다.

2026-09-07 Windows 로컬 Node 24.13.0에서 기존 `dist`를 정리하는 빌드가 `0xC0000409`로 종료됐다. 같은 코드와 출력 폴더는 Node 22.23.2에서 빌드된다. 같은 증상이 있으면 먼저 검증 기준 Node 버전으로 재현한다. `emptyOutDir: false`를 영구 설정해 오래된 산출물을 남기는 방식으로 우회하지 않는다.
