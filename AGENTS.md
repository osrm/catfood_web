# Catfood Web 작업 원칙

Role: Catfood의 public frontend를 구현하고 배포한다. 이 저장소는 사용자에게 제공되는 React/Vite 웹 UI의 source of truth다.

## Repository Boundary

- private core repository는 `osrm/catfood`다.
- frontend는 `catfood` repository를 build-time/runtime에 직접 읽지 않는다.
- 필요한 제품 데이터는 Supabase의 공개용 `api` schema/read model을 통해 조회한다.
- Supabase `service_role` key, secret key, private repository token, raw private data, internal research/evidence와 비공개 provenance/workflow 데이터를 이 저장소에 넣지 않는다.
- 브라우저 공개를 전제로 설계된 Supabase publishable key만 frontend에서 사용한다.

## Implementation

- 현재 milestone과 UI 의미는 private core의 활성 제품/UI 기준에서 채택되어 이 저장소에 반영된 구현 계약을 따른다.
- 기존 React/Vite 구조로 목적을 달성할 수 있으면 재사용한다.
- 실제 요구가 없는 abstraction, state machine, workflow, validator, 테스트 framework를 추가하지 않는다.
- 검색 결과를 만들기 위해 확인되지 않은 제품 사실을 추론하거나 `unknown`을 `false`/`없음`으로 바꾸지 않는다.
- 추천·품질·적합도 점수를 임의로 만들지 않는다.

## Build / Deploy

- GitHub Pages는 Stage 6 개발 중 preview 용도다.
- production 배포는 필요 시 Vercel로 연결할 수 있다.
- Pages workflow는 이 public repository만 사용하며 private `catfood` 접근 credential을 요구하지 않는다.
- `.env.local`과 secret은 commit하지 않는다. 공개 가능한 변수 예시는 `.env.example`에만 둔다.

## Validation

- frontend 변경 후 영향 범위에 맞는 typecheck/build를 실제로 실행한다.
- Pages 관련 변경이면 project-site base/asset 경로를 확인한다.
- 문서만 수정했으면 관련 링크와 역할 경계의 충돌을 확인한다.
- 실행하지 않은 검증을 완료했다고 표현하지 않는다.
