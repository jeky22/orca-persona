# 인계 — Orca Persona 플러그인

이 작업은 원래 `snu_ahcc` 세션에서 조사·설계만 하고 넘어왔다. 코드는 아직
한 줄도 없다.

## 지금까지

사용자는 회사 일과 개인 일을 한 Orca에서 같이 한다. 프로젝트 9개가 평평하게
나열돼 있고, 묶음별로 깃 아이디와 에이전트 계정이 따라오게 하고 싶어 한다.

- **설계 문서**: `docs/superpowers/specs/2026-11-06-orca-group-persona-design.md`
  (조사 결과, upstream 현황, 결정 사항, 소스에서 확인한 제약까지 전부 들어 있다)
- 코어 기여 대신 **플러그인**으로 가기로 결정됨. 이유는 문서 9절.
- 설계 초안에 대한 빌더 검토를 한 번 받았고, 틀린 부분 두 군데를
  Orca 공개 소스에서 확인해 문서에 반영했다 (7.5, 7.7).

## 사용자 결정 (2026-11-06~09, 모두 반영됨)

1. 계정은 Orca `account add`로 관리한다. 플러그인은 env를 주입하지 않고
   Orca의 계정 선택(`accounts.selectClaude/selectCodex` RPC)을 대신 눌러준다.
   "마지막으로 누른 프로젝트"가 전역 계정을 끌고 다닌다. → 문서 7.5~7.6
2. resume은 포커스 경로(`workspace.changed`)가 덮는다. → 문서 7.7
3. 지시문은 전역 `~/.claude/CLAUDE.md` · `~/.codex/AGENTS.md`의 마커 구간
   교체로 전달한다. 관리 계정 홈에 쓰는 1차 안은 Orca가 덮어써서 불가. → 문서 7.10

설계자가 정한 것: 미등록 이메일이면 실행 거부 (7.6), `--local` 깃 설정 (7.8),
이름+브랜치 중복 시 포커스 경로 무시 (7.4).

## 선행 조건

- Orca를 **1.4.248 이상**으로 올려야 한다. 훅이 전부 그때부터다.
  ~~현재 설치본 1.4.247, 최신 1.4.250.~~ → 1.4.254로 올라가 실기 검증 완료 (아래).

## 현재 상태

코드 완료, **실기 검증 완료** (2026-11-09, Orca 1.4.254). `orca plugin test .` 112개 통과.
실기에서 버그 2건을 찾아 고쳤다 (아래 체크리스트 4번). resume만 직접 실측을 못 해
수동 확인 1건이 남아 있다 (6번).

- `src/persona-file.ts`: 페르소나 .md 제한 문법 파서
- `src/glob.ts`: match glob, `~` 확장
- `src/persona-store.ts`: 디렉터리 로드·캐시, 가장 긴 패턴 선택, `.orca-persona` 예외
- `src/git-identity.ts`: `git config --local` 적용 (기존 user.email 있으면 건너뜀)
- `src/instructions.ts`: 전역 CLAUDE.md/AGENTS.md 마커 구간 교체
- `src/orca-rpc.ts`: Orca 런타임 소켓 RPC 클라이언트
- `src/accounts.ts`: 이메일→id 매핑, 계정 선택
- `src/workspaces.ts`: workspace.list 색인 (id, 이름+브랜치)
- `src/switch.ts`: 지시문 + 계정 적용, 실패 메시지
- `src/worker.ts`: 훅·이벤트·커맨드·상태바 배선

## 실기 검증 결과 (2026-11-09, Orca 1.4.254, macOS)

- [x] `orca --version` 1.4.254 (≥1.4.248)
- [x] 페르소나 작성: `~/.orca/personas/work.md`(`~/workspace/**` + 회사 레포의 워크트리 경로 `~/orca/workspaces/{orca,worldcup-korea}/**`), `personal.md`(`~/side/**`, `~/orca/projects/**`, `~/orca/workspaces/RESUME/**`). Claude 관리 계정은 없어서 `orca account add --agent claude`로 등록 (회사 이메일, id `cd76b5e6…`). **주의: 메인 워크트리가 아닌 워크트리는 `~/orca/workspaces/<repo>/` 아래라 `~/workspace/**`만으로는 안 덮인다.**
- [x] 로드: fingerprint approve 후 `orca plugin list`에 `local.orca-persona 0.1.0 running` ✔
- [x] 훅 검증 — **실기에서만 드러나는 버그 2건을 찾아 수정** (`fix` 커밋):
  1. **id 형식 어긋남.** `agent.launch.before`의 `workspaceId`는 `<repoId>::<경로>` 원형인데 플러그인 `workspace.list`의 `id`는 `identity:wt2:local:<instanceId>` 형식 (asar 소스 `plugin-host-api`에서 확인: `id: e.identity ? \`identity:${key}\` : e.id`). byId가 영원히 못 찾아 **모든 실행이 페르소나 없이 통과**되고 있었다. → id가 안 맞으면 `::` 뒤 경로가 정확히 하나에 맞을 때 그 항목을 쓰는 폴백 추가.
  2. **로컬 hostId는 null이 아니라 'local'.** `workspace.list[].hostId`가 로컬 워크스페이스에서 문자열 `"local"`로 와서 (소스 `LOCAL_EXECUTION_HOST_ID='local'`) 전부 원격으로 오판하고 통과시켰다. → null과 'local'을 로컬로 취급.
  수정 후 dev hook과 실제 `orca agent launch` 모두: `continue` + `activeAccountId`가 회사 계정 ✔. 스폰된 claude 프로세스의 `CLAUDE_CONFIG_DIR`이 관리 홈(`…/orca/claude-profiles/<id>/home`)인 것까지 확인 — **훅 안에서 바꾼 선택이 그 실행에 반영된다** (설계 7.6의 추정 실증).
- [x] 포커스 검증: `orca worktree activate`로 실측. 회사 워크트리(lungfish) → `persona: work` 상태바 + 회사 계정, 개인 워크트리(daggertooth) → personal + 계정 해제, 마커 구간 교체 ✔. 단 **displayName "main"+브랜치 main인 메인 워크트리가 3개라 그 셋은 포커스 경로가 설계대로 무시**한다(로그만 남음). 여러 레포를 main으로 쓰는 실사용에선 포커스 경로가 메인 워크트리에 거의 안 걸린다는 뜻 — README 알려진 한계에 기록.
- [ ] **resume 검증 — 직접 실측 못 함 (수동 확인 1분 필요).** GUI 자동화(`orca computer`)로 탭 전환까지는 됐으나 클릭 이벤트가 Orca UI의 버튼에 전달되지 않아 resume 버튼을 누를 수 없었다. 간접 근거는 강하다: ① resume·restore는 훅을 안 탄다(1.4.254 asar에서 재확인, `resumeOrigin`/`resumeProviderSession`이 있으면 훅 스킵). ② 에이전트 env는 **스폰 시점의 전역 선택 계정**으로 계산된다 — 실측 4회(선택 전 실행 `~/.claude`, 선택 후 실행 관리 홈). resume도 같은 스폰 파이프라인이라 현재 선택을 쓸 것으로 보인다. **수동 확인**: 회사 워크스페이스에서 Claude 세션을 닫고, 개인 → 회사 클릭 후 그 세션 resume → `/status`의 계정이 회사인지.
- [x] 지시문 보존: 마커 밖 머리말·꼬리말 보존 ✔. 본문 비우면 구간 제거 ✔. 관리 계정 홈 `CLAUDE.md`는 `@~/.claude/CLAUDE.md` 스텁 ✔. **관리 홈 실제 경로는 `~/Library/Application Support/orca/claude-profiles/<계정id>/home`** (이 문서의 이전 추정 `orca/profiles/*/claude-profiles/*`가 아니라).
- [x] 로그: 정상 동작 중 2초 초과 경고·예외 0건. (단 하나의 warn은 아래 타임아웃 실측에서 일부러 만든 것)
- [x] 워크트리에서 `context.displayName` == `workspace.list[].name` ✔ (lungfish "Review screenshot", daggertooth 실측; 소스에서도 양쪽 다 worktree의 displayName을 쓴다)
- [x] 브랜치 형식 동일 ✔ — 양쪽 다 `refs/heads/` 없는 bare 이름. `workspace.list`가 `refs/heads/`를 벗겨서 준다(소스 확인). 워크트리 CLI(`orca worktree list`)만 `refs/heads/main` 형식이니 헷갈리지 말 것. 슬래시 든 브랜치(`jechan-lee/review-screenshot`)로도 매칭 실측.
- [x] `system` → `accounts.selectClaude { accountId: null }` → `activeAccountId` null ✔ (실측)
- [x] `accounts.list` 형태 ✔ `{ claude: { accounts: [{ id, email, … }], activeAccountId } }`. **`needsSignIn` 필드는 정상 로그인 계정의 응답에 없다** — 코드는 optional로 다루므로 호환. 만료 시 이 필드가 생기는지는 미확인(만료 계정을 만들 수 없었음).
- [x] 훅 2초 초과 시 Orca 동작: **`onError: "deny"`면 거부, 아니면 건너뛰고 통과** (asar `plugin-hook-chain.js`의 `runPluginHookChain`에서 확인; 타임아웃·예외·크래시·이상 응답 모두 "실패"로 간주). 실측: 핸들러에 3초 지연 → 2.0초에 "timed out after 2000ms" **거부** ✔. 1.8초 지연 → 플러그인이 1.7초에 자기 메시지로 먼저 거부 ✔ (이쪽이 사유가 명확).
- [x] `orca plugin validate .` 통과, `orca plugin test .` 112개 통과 (실기에서 찾은 버그의 회귀 테스트 5개 추가), `tsc --noEmit` 클린 (`@types/node` devDependency 추가)
- [x] 문서 반영 커밋

### 검증 중 알게 된 것 (추가)

- **`orca account select --agent claude --account <id|email|system>` CLI가 1.4.254에 이미 있다.** 설계 7.6에서 upstream PR로 내려던 바로 그 명령. PR은 불필요해졌고, 플러그인이 사설 소켓 RPC 대신 CLI 호출로 갈아탈 수 있는 조건이 갖춰졌다 (전환은 아직 안 함 — RPC 쪽이 이미 검증됐고 CLI 호출은 프로세스 스폰 비용이 있다).
- `orca worktree activate --worktree <selector>`가 사이드바 클릭과 같은 포커스 이벤트를 일으킨다 — 포커스 경로를 CLI로 검증할 때 유용.
- dev hook으로 실기 재현 시 `workspaceId`는 반드시 `<repoId>::<경로>` 원형(실제 훅이 주는 형식)으로 넣어야 한다. `orca worktree list --json`의 `id` 필드가 그 형식이다.

## 사용자 결정 필요 (선택)

~~upstream에 `orca account select` CLI를 추가하는 PR을 낼지.~~ → **1.4.254에 이미 들어왔다.**
남은 결정: ① 플러그인을 사설 RPC에서 `orca account select` CLI 호출로 전환할지(선택, 급하지 않음),
② resume 수동 확인(위 체크리스트 유일한 미완 항목) 결과 반영.
