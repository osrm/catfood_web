# Catfood Web

Catfood의 **public frontend repository**다. 사용자에게 배포되는 React/Vite UI의 source of truth이며, private core repository인 `osrm/catfood`의 데이터·research·Supabase 구현과 분리해서 운영한다.

현재 milestone은 **Stage 6 — UI 구현**이다. 현재 구현은 Supabase의 curated browser-facing read model을 읽는 General Screener V0와 기본 inspector다.

## Repository boundary

- `osrm/catfood`: private core — data, research/strategy/internal docs, Supabase schema/migrations, normalization, internal scripts, evidence/provenance
- `osrm/catfood_web`: public frontend — React/Vite UI, frontend build, GitHub Pages preview, 이후 Vercel production 배포

이 repository는 private `catfood`를 build-time/runtime에 직접 읽지 않는다. 브라우저는 Supabase의 공개 `api` read model만 사용한다. `service_role`, secret key, private repository token, raw private data와 internal evidence는 넣지 않는다.

## Local development

Node.js 22.12 이상을 사용한다.

```bash
cp .env.example .env.local
npm ci
npm run dev
```

`.env.example`에는 브라우저 공개용 Supabase URL과 `sb_publishable_...` key가 들어 있다. 이 publishable key는 공개 client용이며 `service_role`/secret key와 다르다. `.env.local`에는 필요할 때 로컬 override만 두고 commit하지 않는다.

`VITE_DECISION_INTAKE_ENABLED`의 기본값은 `false`다. 사용자 안내, 보존기간과 production endpoint가 승인·배포되기 전에는 이 값을 켜지 않는다.

## Current API contract

- read model: `api.effective_product_catalog_summary`
- catalog database에는 read-only 요청만 수행하며 browser direct INSERT/RPC는 하지 않는다.
- 최대 1000행을 읽고 브라우저에서 현재 검색 조건을 적용한다.
- 빈 normalized array나 미확인 상태를 `없음`으로 추론하지 않는다.
- `official_target`: 복수 선택 OR
- `feature`: 복수 선택 AND
- `recipe_family`: 복수 선택 OR
- `recipe_detail`: 복수 선택 OR
- Grain-Free: 명시적 positive claim만 충족
- 결과 0건이어도 조건을 자동 완화하지 않는다.

선택적으로 활성화되는 decision intake는 범용 clickstream이 아니다. SWITCH/EXPLORE 결과 생성 시 최초 40개 presentation과 명시적인 상세 열기·비교 추가만 Edge Function으로 보고한다. LOOKUP은 수집하지 않으며 intake 실패가 제품 탐색 UI를 막지 않는다.

현재 UI는 제품에 저장된 canonical `life_stage`를 그대로 사용하며 사용자 나이에서 생애주기를 추론하지 않는다.

## Build and preview

```bash
npm run build
npm run preview
```

Vite는 상대 asset base를 사용해 GitHub Pages project site와 root 배포 양쪽에서 정적 asset 경로가 동작하도록 구성한다.

GitHub Pages preview:

https://osrm.github.io/catfood_web/

Pages workflow는 이 public repository만 checkout/build하며 private `catfood` 접근 token을 사용하지 않는다. 배포에 필요한 Supabase client 설정도 브라우저 공개용 URL과 publishable key만 사용한다.

향후 production 배포는 이 repository를 Vercel에 직접 연결하는 방향을 사용한다.
