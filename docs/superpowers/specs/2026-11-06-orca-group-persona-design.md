# Orca Persona — 묶음 단위로 깃 아이디와 에이전트 계정을 가르는 플러그인

작성일: 2026-11-06 (2차 개정: 같은 날, 사용자 결정 반영)
상태: 설계 완료 (2차 빌더 검토 반영, 사용자 결정 3건 반영) · 다음 단계: 구현 계획

## 0. 2차 개정에서 바뀐 것

1차 설계의 미결 2건을 사용자가 결정했고, 그 과정에서 1차 설계의 핵심 가정
하나가 소스에서 틀린 것으로 확인됐다.

- **계정을 env로 주입하지 않는다.** 1.4.247 소스를 보면 `agent.launch.before`
  훅은 Orca가 계정 env를 만들기 **전에** 돈다. Orca에 관리 계정이 선택돼
  있으면 Orca 값이 플러그인 값을 덮는다 (1차 문서 7.5의 "플러그인이 이긴다"는
  반대). 어느 쪽이 이기든 둘이 싸우는 구조라 env 주입은 버린다.
- **대신 플러그인이 Orca의 계정 선택을 대신 눌러준다.** 계정은 Orca 자체
  기능(`orca account add`)으로 등록하고, 플러그인은 "지금 이 계정을 써라"를
  Orca에 요청한다. Orca UI·사용량 미터·실제 세션이 항상 일치한다.
- **"마지막으로 누른 프로젝트"를 따라 전역 계정이 바뀐다.** 사용자가 직접
  제안한 모델이다. 이것이 resume 문제(1차 미결 2번)도 덮는다.
- 페르소나 디렉터리(`work/.claude`, `work/.codex`)가 없어진다. 페르소나는
  `.md` 파일 하나다.
- **지시문은 전역 `~/.claude/CLAUDE.md` · `~/.codex/AGENTS.md`의 마커 구간을
  교체하는 방식으로 전달한다.** 2차 빌더 검토에서 "관리 계정 홈의 CLAUDE.md에
  쓴다"가 불가능한 것으로 확인됐다 (7.10). 사용자가 전역 교체를 골랐다.

## 1. 왜 만드나

한 사람이 회사 일과 개인 일을 한 Orca에서 같이 한다. 지금 프로젝트 목록은
평평하다. 예를 들어 이런 상태다.

```
GLAB-FE · glab-server · glab-web · gwanak-web-dev · snu_ahcc · srd   ← 회사 (~/workspace)
glab(ochung) · private-sogae · soi-saju                              ← 개인 (~/side, ~/orca/projects)
```

개인 프로젝트 `glab`이 회사 `glab-server`·`glab-web` 사이에 끼어 있다. 이름까지
겹쳐서 눈으로 안 갈라진다.

더 큰 문제는 **정체성이 따라오지 않는다**는 것이다. 회사 레포에 개인 이메일로
커밋이 찍히거나, 개인 사이드 프로젝트를 회사 Claude 구독으로 돌리게 된다.
지금은 워크트리를 만들 때마다 `git config`를 손으로 맞추고 에이전트 계정을
눈치껏 바꾸는 수밖에 없다.

원하는 것은 간단하다. **회사/개인 두 묶음에 한 번씩만 설정해두면, 그 묶음의
프로젝트에서 워크스페이스를 만들거나 에이전트를 띄우거나 프로젝트를 클릭할 때
깃 아이디와 에이전트 계정이 알아서 따라오는 것.**

## 2. 이미 있는 것과 없는 것

### Orca에 있는 것 (1.4.247 설치본과 upstream main 소스에서 확인)

- **묶음(project groups)은 이미 있다.** 사이드바 폴더일 뿐 아무것도 물려주지
  않는다 (upstream #12538이 "currently only sidebar containers"라고 표현한다).
- **계정은 여러 개 등록할 수 있다.** `orca account add --agent claude|codex`.
  등록된 Claude 계정은 프로필 데이터 안 `claude-profiles/<accountId>`를
  `CLAUDE_CONFIG_DIR`로 쓴다. Codex도 같은 식으로 관리 홈을 갖는다.
- **계정 선택은 호스트 단위 전역이다.** 설정 `activeClaudeManagedAccountId`,
  `activeCodexManagedAccountId` 하나씩. 프로젝트·워크스페이스 단위 선택은 없다.
- **Claude 계정 선택은 "포인터 파일"로 전달된다.** Orca가 띄운 터미널에는
  `ORCA_CLAUDE_PROFILE_POINTER`가 있고, 셸 함수 `claude`가 **실행할 때마다**
  그 파일을 읽어 `CLAUDE_CONFIG_DIR`을 정한다 (`shared/claude-shell-function`).
  계정을 바꾸면 Orca가 포인터를 다시 쓴다. 즉 이미 열린 터미널도 다음 `claude`
  실행부터 새 선택을 따른다.
- **런타임 RPC에 선택 메서드가 있다.** `accounts.selectClaude { accountId }`,
  `accounts.selectCodex { accountId }`, `accounts.selectCodexForTarget`.
  CLI `orca account list --json`이 같은 RPC(`accounts.list`)로 계정 목록과
  활성 id를 준다.
- **플러그인 워커(`trusted-worker`)는 별도 Node 프로세스다.** `node:` 내장
  모듈을 그대로 쓴다. 네트워크 차단은 패널 프레임에만 해당한다.
- **플러그인 호스트 API에 `workspace.list`(1.3), `workspace.readContext`,
  이벤트 `workspace.changed`, `statusBar.update`(상태바 항목 갱신)가 있다.**

### 없는 것

- **CLI `orca account select`는 opencode·devin만 받는다.** Claude·Codex
  선택은 데스크톱 UI 아니면 런타임 RPC 직접 호출뿐이다. upstream main도 같다.
- **`workspace.changed` 이벤트에는 워크스페이스 id도 경로도 없다.**
  `{ branch, displayName, terminals }`뿐이다. upstream main도 같다.
- **깃 커밋 아이덴티티를 설정하는 코드가 프로덕션 경로에 없다.**
- **플러그인 호스트 API에 계정 관련 메서드가 없다.**

### upstream 현황 (2026-11-06)

| 이슈/PR | 내용 | 상태 |
|---|---|---|
| #12538 | 묶음을 에이전트 surface로 (지시문·메모리·그룹채팅) | 열림. 메인테이너 코멘트 없음 |
| PR #25466 | 묶음에 폴더(`~/Orca/groups`)와 멤버 env var | draft |
| #13612 | 프로젝트별 깃 아이덴티티 | 완료로 닫힘. Part B(커밋 아이덴티티) 미구현 |
| #37318, #30567, #23227, #9496 | 프로젝트/워크트리별 Claude·Codex 계정 | 전부 열림, PR 없음 |

## 3. 목표

1. 묶음을 **한 번** 정의하면 그 묶음의 모든 워크스페이스가 깃 아이디를 물려받는다.
2. 같은 묶음의 모든 에이전트 실행이 그 묶음의 Claude·Codex 계정으로 뜬다.
   **Orca가 보여주는 활성 계정과 실제 세션 계정이 항상 같다.**
3. 사이드바에서 프로젝트를 클릭하면 Orca의 활성 계정이 그 묶음 것으로 바뀐다.
4. 묶음별 지시문(말투·규칙)이 에이전트에 전달된다.
5. 묶음 정의가 **사람이 읽고 손으로 고칠 수 있는 .md 파일**이다.
6. 다른 사람도 설치해 쓸 수 있게 카탈로그에 올린다.

## 4. 목표가 아닌 것

- Orca 사이드바의 묶음 UI를 바꾸는 것.
- 묶음 채팅·묶음 메모리 (#12538의 ③④).
- SSH·원격 호스트의 push 인증과 계정.
- 비밀번호·토큰 관리. 로그인은 `orca account add`가 한다.
- Orca 코어 포크.

## 5. 실패 조건 (이게 일어나면 기능이 동작해도 실패다)

- **엉뚱한 아이디로 커밋이 찍히는 것.** 묶음을 못 찾으면 손대지 않고 넘어간다.
- **Orca가 보여주는 계정과 실제 세션 계정이 어긋나는 것.** 그래서 env를 만지지
  않고 Orca의 선택을 바꾼다.
- **엉뚱한 계정으로 에이전트가 뜨는 것.** 선택 요청이 실패하면 실행을 **거부**한다
  (틀린 계정으로 조용히 뜨는 것보다 낫다). 단 페르소나가 없는 경로는 통과.
- **에이전트 실행이 느려지는 것.** 훅은 2초 예산이다.
- **설정이 어디 있는지 모르게 되는 것.** .md 하나만 보면 다 알 수 있어야 한다.

## 6. 제약

- **훅은 `engines.orca >= 1.4.248`.** 사용자가 직접 업데이트한다 (현재 1.4.247,
  최신 1.4.250).
- **훅 하나당 2초.** 초과하면 Orca가 통과로 간주한다. 거부해야 하는 훅은
  `onError: deny`.
- **`workspace.create.after`는 관찰 전용.**
- **macOS·Linux·Windows 모두 동작해야 한다.** Windows는 런타임 소켓이
  named pipe다.
- **플러그인은 Orca의 묶음을 읽을 수 없다.** 호스트 API에 projectGroup이 없다.
- **포커스 이벤트에 id·경로가 없다.** 이름+브랜치로 찾아야 한다.

## 7. 결정한 것

7.1~7.3, 7.8~7.11은 설계자의 판단, 7.5~7.7은 사용자 결정을 반영한 것이다.

### 7.1 묶음은 플러그인이 직접 갖는다

Orca 사이드바 묶음에 기대지 않는다. **.md 파일이 자기 소속 경로를 직접
선언한다.** 나중에 묶음 API가 생기면 소속 판정만 갈아끼운다.

### 7.2 페르소나 한 벌 = .md 하나

```
~/.orca/personas/
  work.md
  personal.md
```

```markdown
---
match:
  - ~/workspace/**
git:
  name: Jechan Lee
  email: jechan.lee@gwanaklab.co.kr
accounts:
  claude: jechan.lee@gwanaklab.co.kr   # orca account add 로 등록한 계정의 이메일
  codex: jechan.lee@gwanaklab.co.kr
---

사내 코드베이스다. 커밋 메시지는 한국어로 쓴다.
PR 본문에 Jira 키를 반드시 넣는다.
```

`accounts.*`는 **Orca에 등록된 관리 계정의 이메일**이다. 플러그인은 등록된
계정 목록에서 이메일로 id를 찾는다. `system`이라고 쓰면 "시스템 기본 계정"
(관리 계정 선택 해제)이다. 키가 없으면 그 에이전트 계정은 건드리지 않는다.

기본 위치 `~/.orca/personas`는 플러그인 설정으로 바꿀 수 있다.

### 7.3 소속 판정은 경로로

`match`의 glob을 워크스페이스 경로에 맞춘다. 여러 개가 맞으면 **가장 긴
패턴이 이긴다.** 아무것도 안 맞으면 아무것도 하지 않는다.

레포별 예외는 레포 자체 `.orca-persona` 파일(한 줄, 페르소나 이름)로 덮어쓴다.

### 7.4 훅·이벤트 세 개

| 훅/이벤트 | 받는 것 | 하는 일 |
|---|---|---|
| `workspace.create.after` (훅) | `{ workspaceId, kind, path, branch }` | 페르소나를 찾아 `git config --local user.name/user.email` 기록 |
| `agent.launch.before` (훅) | `{ agent, workspaceId, ... }` | `workspace.list`로 경로를 풀고 → 페르소나 → **Orca에 계정 선택 요청** → 통과. 실패하면 거부 |
| `workspace.changed` (이벤트) | `{ context: { displayName, branch, terminals } }` | 포커스된 워크스페이스를 `workspace.list`에서 이름+브랜치로 찾아 → 페르소나 → Orca에 계정 선택 요청 |

`agent.launch.before`가 **정확한** 경로다 (workspaceId가 있다). 자동화·
오케스트레이션·CLI처럼 포커스와 무관하게 뜨는 실행도 여기서 맞춰진다.
`workspace.changed`는 **포커스를 따라가는** 경로다. resume, 이미 열린 터미널에서
`claude`를 치는 경우, 사용자가 Orca 설정창에서 보는 활성 계정을 덮는다.

이름+브랜치가 둘 이상 맞으면 포커스 경로는 손대지 않는다 (실행 경로는 여전히
정확하다). 원격 호스트(`hostId`가 null이 아님) 워크스페이스는 두 경로 모두
손대지 않는다.

### 7.5 계정은 Orca가 관리한다 — 사용자 결정 (1차 미결 1번)

플러그인은 **env를 주입하지 않는다.** `orca account add`로 등록된 계정을
`accounts.selectClaude` / `accounts.selectCodex`로 고른다. 근거는 0절.

Orca의 선택은 호스트 전역이다. 그래서 "마지막으로 누른 프로젝트"가 전역 계정을
끌고 다닌다. 사용자가 이 모델을 명시적으로 원했다. 동시에 다른 묶음의
워크스페이스에서 실행이 뜨면 `agent.launch.before`가 그 순간 다시 바꾼다.
이미 돌고 있는 세션은 영향을 받지 않는다 (`movesRunningSessions`는 쓰지 않는다).

### 7.6 Orca에 선택을 요청하는 방법

CLI에 없으므로 **런타임 RPC를 직접 호출한다.** CLI와 같은 통로다.

- 엔드포인트와 토큰: 사용자 데이터 경로의 `orca-runtime.json` (`transports[]`
  중 `unix` 또는 `named-pipe`, `authToken`). 플러그인 워커는 Node 프로세스라
  `node:net`으로 붙을 수 있다.
- 요청·응답 형식: `shared/runtime-rpc-envelope`와 `cli/runtime/transport`가
  기준이다. 빌더가 설치본 소스에서 정확한 프레임 형식을 확인한다.
- 이 통로는 Orca의 사설 프로토콜이다. **깨지면 거부가 아니라 통과**로 두면
  실패 조건 3을 어기므로, RPC가 안 되면 `agent.launch.before`는 거부하고
  이유에 "orca account select를 쓸 수 없다"를 적는다.
- 동시에 upstream에 **`orca account select --agent claude|codex`를 추가하는
  PR**을 낸다. 런타임 메서드가 이미 있어 CLI 핸들러 몇 줄이다. 머지되면
  플러그인은 CLI 호출로 갈아탄다 (설정으로 통로 선택).

계정 목록과 활성 id는 `accounts.list { refreshUsage: false }`로 읽는다. 이메일 → id
매핑은 캐시한다. 이미 활성인 계정이면 요청하지 않는다.

**페르소나가 적은 이메일이 `accounts.list`에 없으면 `agent.launch.before`는
거부한다** (설계자 판단, 5절과 일치). 이유에 `orca account add --agent <agent>`를
안내한다. 등록은 됐지만 로그인이 만료된 계정은 `selectClaude`가 스스로
throw하므로 같은 경로로 거부된다. 포커스 경로(`workspace.changed`)는 거부할
대상이 없으므로 로그만 남기고 상태바에 경고를 띄운다.

소스에서 확인된 사실 (빌더 검토):
- 프레임은 줄 단위 JSON. 요청 `{ id, authToken, method, params }`, 응답
  `{ id, ok, result | error, _meta }`. `{ _keepalive: true }` 프레임이 섞여 온다.
- `accounts.selectClaude/selectCodex`는 `accounts-admin` 권한이지만 로컬 소켓
  호출자는 `owner`라 허용된다.
- `selectClaude`는 포인터 파일 쓰기라 빠르다. 계정 홈 준비는 백그라운드다.
- `agent.launch.before`는 Orca의 계정 env 계산보다 앞에 돌므로, 훅 안에서 바꾼
  선택이 **그 실행에** 반영된다.

### 7.7 resume — 사용자 결정 (1차 미결 2번)

resume·restore는 훅을 타지 않는다 (upstream `spawn-agent-launch-plugin-hook.ts`
의 가드, 1.4.247 설치본도 동일). 1차 설계에서는 해결책이 없었다. 2차에서는
**포커스 경로가 덮는다**: resume을 하려면 그 워크스페이스를 눌러야 하고, 누르는
순간 전역 계정이 바뀐다. Orca가 resume 때도 현재 선택 계정을 쓰는지는
**추정**이며 구현 단계에서 확인한다. 아니라면 그 사실을 README에 적는다.

### 7.8 깃 설정은 `--local`로 충분하다

페르소나는 레포 집합 단위이므로 공용 레포 config가 바뀌는 것이 맞는 동작이다.
**이미 `user.email`이 레포에 설정돼 있으면 건드리지 않는다.**

### 7.9 기존 워크스페이스 일괄 적용

훅은 생성·실행 시점에만 돈다. **일괄 적용 커맨드**를 넣는다. 이미 설정된
아이디는 건너뛴다. 계정은 일괄 적용 대상이 아니다 (전역 선택이므로).

### 7.10 지시문은 전역 `CLAUDE.md` · `AGENTS.md`의 마커 구간을 교체한다 — 사용자 결정

1차 안("관리 계정 홈의 `CLAUDE.md`에 쓴다")은 **불가능하다.** Orca의 계정 홈
준비 워커(`claude-profile-setup-worker-entry`)가 사용자 `~/.claude/CLAUDE.md`가
있으면 `claude-profiles/<id>/home/CLAUDE.md`를 한 줄 스텁 `@~/.claude/CLAUDE.md`로
강제 동기화하고, 이 작업이 **계정을 선택할 때마다** 백그라운드로 돈다. Codex도
관리 홈의 `AGENTS.md`가 `~/.codex/AGENTS.md`에서 링크·복사된다.

뒤집어 보면 **모든 관리 계정이 전역 파일을 가져다 쓴다.** 그래서 전역 파일의
마커 구간을 페르소나가 바뀔 때마다 갈아끼운다.

```
~/.claude/CLAUDE.md
  (사용자 내용 그대로)
  <!-- orca-persona:begin work -->
  사내 코드베이스다. 커밋 메시지는 한국어로 쓴다. ...
  <!-- orca-persona:end -->
~/.codex/AGENTS.md   ← 같은 방식
```

- 마커 밖은 절대 건드리지 않는다. 파일이 없으면 만든다. 마커가 없으면 끝에 붙인다.
- 교체 시점은 계정 선택과 같다: 포커스 경로와 실행 경로 둘 다, 계정 선택 요청
  **직전**에. 그래서 "마지막으로 누른/띄운 프로젝트"가 계정과 지시문을 함께
  끌고 다닌다. 둘이 어긋나지 않는다.
- 페르소나 본문이 비어 있으면 마커 구간을 비운다 (지운다).
- Orca 밖에서 띄운 `claude`·`codex`도 같은 지시문을 본다. 사용자가 이를 알고 골랐다.
- 사용자 파일을 쓰는 것이므로 원자적으로 쓴다 (임시 파일 → rename).

### 7.11 페르소나가 없으면 아무것도 하지 않는다

페르소나 파일이 하나도 없으면 조용히 통과한다. 설정 마법사도 알림도 없다.

### 7.12 상태바에 현재 페르소나를 보여준다 (선택)

`contributes.statusBarItems` + `statusBar.update`가 있다. 포커스 경로가 바꿀
때마다 "persona: work" 식으로 갱신한다. 없어도 기능은 동작한다.

## 8. 빌더에게 남기는 것

- `match` glob 문법 (`~` 확장, `**`, Windows 경로 구분자)
- 런타임 RPC 프레임의 정확한 형식 (설치본 `cli/runtime/transport.js`를 읽을 것)
- `workspace.list` 결과 캐시 전략 (2초 예산, `workspace.created/removed`로 무효화)
- 포커스 경로의 디바운스 (터미널 열고 닫을 때마다 이벤트가 온다)
- 페르소나 파일이 잘못됐을 때(frontmatter 파싱 실패 등) 처리 — 조용히 넘어가되 로그
- 마커 구간 교체의 디바운스 (포커스 경로는 터미널 이벤트마다 올 수 있다; 같은
  페르소나면 쓰지 않는다)
- 테스트: 경로 매칭 우선순위, 이름+브랜치 중복 시 무시, 이미 `user.email`이
  있으면 건드리지 않음, RPC 실패·미등록 이메일 시 거부, 이미 활성이면 요청 안 함,
  마커 밖 내용 보존(마커 없음·마커 있음·파일 없음 세 경우)

## 9. 이 다음

- `orca account select --agent claude|codex` CLI PR (작음, 런타임 메서드 있음)
- `workspace.changed`에 `workspaceId` 추가 요청 (이름+브랜치 매칭을 없앨 수 있다)
- 플러그인이 실제로 돌면 #12538의 "익스텐션으로 되는 거 아니냐"에 대한 답이 된다
- #13612 Part B(프로젝트별 깃 커밋 아이덴티티) 코어 기여 자리
