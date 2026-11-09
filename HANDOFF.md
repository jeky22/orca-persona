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
  현재 설치본 1.4.247, 최신 1.4.250.

## 현재 상태

코드 완료. `orca plugin test .` 107개 통과. README.md 작성됨.

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

## 실기 검증 대기

설치된 Orca가 1.4.247이다. 훅은 **1.4.248 이상**에서만 되므로 실기 검증을 못 했다. Orca를 올린 뒤 아래를 진행한다.

- [ ] `orca --version`이 1.4.248 이상인지 확인
- [ ] 실제 페르소나 작성: `~/.orca/personas/work.md`(match `~/workspace/**`), `personal.md`(match `~/side/**`, `~/orca/projects/**`). 계정 이메일은 `orca account list --json`의 `claude.accounts[].email`과 일치시킨다. 계정이 없으면 `orca account add --agent claude`부터
- [ ] 로드: `orca plugin dev load .` → 출력의 fingerprint로 `orca plugin dev load . --approve <fingerprint>`; `orca plugin list`에서 `orca-persona` enabled
- [ ] 훅 검증: `orca plugin dev hook . agent.launch.before --data '{"agent":"claude","workspaceId":"<회사 워크스페이스 id>","workspaceKind":"worktree","command":"claude","env":{}}'` → `continue`, 그리고 `orca account list --json`의 `claude.activeAccountId`가 회사 계정 id. `workspaceId`는 `orca worktree list --json`(또는 `orca plugin dev request`로 `workspace.list`)에서 얻는다
- [ ] 포커스 검증: 사이드바에서 개인 프로젝트 클릭 → 활성 id가 개인 계정으로 바뀌고 상태바가 `persona: personal`. 회사 클릭 → 반대로. `cat ~/.claude/CLAUDE.md`에 마커 구간이 교체돼 있다
- [ ] resume 검증 (설계 7.7의 추정): 회사 워크스페이스에서 Claude 세션을 열고 닫은 뒤, 개인 프로젝트 클릭 → 다시 회사 프로젝트 클릭 → 그 세션을 resume → `/status`(또는 `claude` 상단 계정 표시)가 회사 계정인지 확인. 결과를 README "알려진 한계"에 사실대로 기록
- [ ] 지시문 보존 검증 (설계 7.10): 계정을 바꾼 뒤 `cat "$(ls -d ~/Library/Application\ Support/orca/profiles/*/claude-profiles/*/home | head -1)/CLAUDE.md"`가 `@~/.claude/CLAUDE.md` 스텁인지, 전역 파일의 마커 밖 내용이 그대로인지 확인
- [ ] 로그 확인: `orca plugin logs orca-persona`에 2초 초과 경고가 없는지
- [ ] 워크트리 워크스페이스(폴더만이 아니라)에서 `workspace.changed`의 `context.displayName`이 `workspace.list[].name`과 같은지 확인
- [ ] 브랜치 형식이 양쪽에서 같은지 확인 (`context.branch`와 `workspace.list[].branch`가 둘 다 `main`인지, 한쪽이 `refs/heads/main`인지)
- [ ] `system` 값 페르소나로 `accounts.selectClaude { accountId: null }`이 실제로 관리 계정 선택을 해제하는지 확인
- [ ] `accounts.list` 응답 형태가 `{ claude: { accounts: [{ id, email, needsSignIn }], activeAccountId } }`인지 확인 (`orca account list --json`과 비교)
- [ ] `onError: "deny"`인 훅이 시간 초과되면 거부인지 통과인지 확인: 일부러 2초 넘게 걸리는 dev 훅을 띄워 본다 (플러그인은 1.7초에 스스로 거부하지만 Orca 쪽 동작을 README에 적는다)
- [ ] 1.4.248 이상에서 `orca plugin validate .` 통과
- [ ] 검증 결과를 README(알려진 한계의 "실기 검증" 항목 포함)와 이 문서에 반영하고 커밋: `docs: README와 실기 검증 결과`

## 사용자 결정 필요 (선택)

upstream에 `orca account select --agent claude|codex` CLI를 추가하는 PR을 낼지. 런타임 메서드가 이미 있어 CLI 핸들러 몇 줄이다. 머지되면 플러그인이 사설 소켓 RPC 대신 CLI 호출로 갈아탈 수 있다 (설계 7.6). 낼지 말지, 시점은 실기 검증 뒤로 할지 정해 달라.
