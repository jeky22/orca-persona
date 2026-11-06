# Orca Persona — 묶음 단위로 깃 아이디와 에이전트 계정을 가르는 플러그인

작성일: 2026-11-06
상태: 설계 (빌더 검토 반영됨 · 미결 2건)

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
프로젝트에서 워크스페이스를 만들거나 에이전트를 띄울 때 깃 아이디와 에이전트
계정이 알아서 따라오는 것.**

## 2. 이미 있는 것과 없는 것

### Orca에 있는 것

- **묶음(project groups)은 이미 있다.** 1.4.247 빌드에 `projectGroups`,
  `projectGroupId`, `projectGroupOrder`가 들어 있다. 다만 지금은 사이드바
  폴더일 뿐 아무것도 물려주지 않는다 (upstream #12538이 "currently only
  sidebar containers"라고 표현한다).
- **계정은 여러 개 등록할 수 있다.** `orca account add --agent claude|codex|opencode|devin`.
- **Orca 자신이 `CLAUDE_CONFIG_DIR`(30곳)·`CODEX_HOME`(69곳)으로 계정을 가른다.**
  `codex-pane-accounts.json`에 pane 단위 Codex 계정이 이미 저장되고 있고,
  `claude-observed-config-dirs.json`은 관찰된 config dir을 기록한다.

### 없는 것

- **`orca account select`는 opencode·devin만 된다.** Claude·Codex는 고를 CLI 수단이 없다.
- **`worktree create`·`agent launch` 어디에도 계정 인자가 없다.**
- **깃 커밋 아이덴티티를 설정하는 코드가 프로덕션 경로에 없다.** 코드베이스의
  `gitIdentity`는 워크스페이스 표시 이름(`WorkspaceGitIdentity`)이고,
  `git config user.email`은 CI 스크립트·픽스처에만 나온다.
- **묶음에 아무것도 달 수 없다.** 지시문도, 계정도, 깃 아이디도.

### upstream 현황 (2026-11-06)

| 이슈/PR | 내용 | 상태 |
|---|---|---|
| #12538 | 묶음을 에이전트 surface로 (지시문·메모리·그룹채팅) | 열림. **메인테이너 코멘트 없음.** 작성자가 ①② 작업 중, ③④는 코어냐 익스텐션이냐 미결 |
| PR #25466 | 묶음에 폴더(`~/Orca/groups`)와 멤버 env var | **draft.** "방향 합의되면 ready" |
| #13612 | 프로젝트별 깃 아이덴티티 | **완료로 닫힘. 그러나 Part B(커밋 아이덴티티) 미구현.** 머지된 PR #13664는 gh 계정만 묶음 |
| #37318, #30567, #23227, #9496 | 프로젝트/워크트리별 Claude·Codex 계정 | 전부 열림, PR 없음 |

**아무도 "묶음에 한 번 걸면 멤버가 물려받는다"를 제안하지 않았다.** 기존 요청은
전부 프로젝트 단위 아니면 워크트리 단위다. #37318 작성자조차 레포 4개짜리
묶음을 예로 들면서 결국 레포마다 걸자고 한다.

## 3. 목표

1. 묶음을 **한 번** 정의하면 그 묶음의 모든 워크스페이스가 깃 아이디를 물려받는다.
2. 같은 묶음의 모든 에이전트 실행이 그 묶음의 Claude·Codex 계정으로 뜬다.
3. 묶음별 지시문(말투·규칙)이 에이전트에 전달된다.
4. 묶음 정의가 **사람이 읽고 손으로 고칠 수 있는 .md 파일**이다. GUI 전용 설정이 아니다.
5. 다른 사람도 설치해 쓸 수 있게 카탈로그에 올린다.

## 4. 목표가 아닌 것

- Orca 사이드바의 묶음 UI를 바꾸는 것. 손대지 않는다.
- 묶음 채팅·묶음 메모리 (#12538의 ③④). 범위 밖이다.
- SSH·원격 호스트의 push 인증. #13612이 명시적으로 범위 밖으로 둔 것과 같다.
- 비밀번호·토큰 관리. 계정 로그인은 각 에이전트 CLI가 자기 방식대로 한다.
- Orca 코어 포크.

## 5. 실패 조건 (이게 일어나면 기능이 동작해도 실패다)

- **엉뚱한 아이디로 커밋이 찍히는 것.** 틀리게 설정하느니 아무것도 안 하는 게 낫다.
  묶음을 못 찾으면 손대지 않고 넘어간다.
- **Orca가 보여주는 계정과 실제 세션 계정이 어긋나는 것.** Orca는 이미
  `codex-pane-accounts.json`으로 pane 계정을 관리한다. 플러그인이 그 위에
  덮어쓰면 UI와 사용량 미터가 거짓말을 하게 된다.
- **에이전트 실행이 느려지거나 막히는 것.** 훅은 2초 예산이다.
- **설정이 어디 있는지 모르게 되는 것.** .md 하나만 보면 다 알 수 있어야 한다.

## 6. 제약

- **훅은 `engines.orca >= 1.4.248`.** 현재 설치본이 1.4.247이라 업데이트가 선행된다
  (최신 1.4.250, 2026-11-05).
- **훅 하나당 2초.** 초과하면 Orca가 통과로 간주하고 넘어간다.
- **`workspace.create.after`는 관찰 전용.** Orca가 기다려주지 않는다.
- **macOS·Linux·Windows 모두 동작해야 한다.** 경로는 Node `path`로 다룬다.
- **플러그인은 Orca의 묶음을 읽을 수 없다.** 호스트 API에 projectGroup 관련
  항목이 없다 (`workspace.readContext`, `workspace.list`가 전부).

## 7. 결정한 것

아래는 전부 설계자(나)의 판단이다. 사용자가 고른 것이 아니다.

### 7.1 묶음은 플러그인이 직접 갖는다

Orca 사이드바 묶음에 기대지 않는다. 호스트 API로 읽을 방법이 없고,
`orca-data.json`을 직접 읽는 것은 앱 사설 상태라 OS마다 경로가 다르고 언제든
깨진다.

대신 **.md 파일이 자기 소속 경로를 직접 선언한다.** 부수 효과로 사이드바
묶음을 안 만들어도 동작하고, 나중에 PR #25466이 머지돼 묶음 API가 생기면
그때 소속 판정만 갈아끼우면 된다.

### 7.2 페르소나 한 벌 = .md 하나 + 디렉터리 하나

```
~/.orca/personas/
  work.md              ← 선언. frontmatter + 지시문
  work/.claude/        ← CLAUDE_CONFIG_DIR. 여기서 claude login
  work/.codex/         ← CODEX_HOME. 여기서 codex login
  personal.md
  personal/.claude/
  personal/.codex/
```

`work.md`는 이렇게 생겼다.

```markdown
---
match:
  - ~/workspace/**
git:
  name: Jechan Lee
  email: jechan.lee@gwanaklab.co.kr
agents:
  claude: work        # ~/.orca/personas/work/.claude 를 가리킨다
  codex: work
---

사내 코드베이스다. 커밋 메시지는 한국어로 쓴다.
PR 본문에 Jira 키를 반드시 넣는다.
```

`CLAUDE_CONFIG_DIR`이 **자격증명과 사용자 레벨 `CLAUDE.md`를 둘 다** 담는다는
점을 이용한다. 레버 하나로 계정과 지시문이 같이 따라온다. 플러그인은
`work.md`의 본문을 `work/.claude/CLAUDE.md`로 동기화한다. 선언은 한 군데,
에이전트는 평소대로 읽는다.

기본 위치 `~/.orca/personas`는 플러그인 설정(`contributes.settings`)으로 바꿀 수 있다.

### 7.3 소속 판정은 경로로

`match`의 glob을 워크스페이스 경로에 맞춘다. 여러 개가 맞으면 **가장 긴
(구체적인) 패턴이 이긴다.** 아무것도 안 맞으면 아무것도 하지 않는다 — 실패
조건 1번을 지키기 위해 침묵이 기본값이다.

레포별 예외는 레포 자체 `.orca-persona` 파일로 덮어쓸 수 있게 한다
(한 줄, 페르소나 이름만).

### 7.4 훅 두 개

| 훅 | 받는 것 | 하는 일 |
|---|---|---|
| `workspace.create.after` | `{ workspaceId, kind, path, branch }` | `path`에서 페르소나를 찾아 `git config --local user.name/user.email` 기록 |
| `agent.launch.before` | `{ agent, workspaceId, command, env }` | 페르소나의 `CLAUDE_CONFIG_DIR`·`CODEX_HOME`을 `env`에 추가 |

`workspace.create.after`에는 `projectId`가 없고 `path`가 있다. 경로 기반 판정을
고른 이유 중 하나다 — `.before`와 상태를 주고받을 필요가 없다.

### 7.5 Orca 계정과 싸우지 않는다 — **구현 불가. 미결 1번 참고**

원래 "`CLAUDE_CONFIG_DIR`·`CODEX_HOME`이 이미 들어 있으면 손대지 않는다"로
설계했으나, 소스를 확인한 결과 **불가능하다.**

`src/main/ipc/pty/spawn-agent-launch-plugin-hook.ts`:

```ts
// 훅에 넘기는 env는 빈 객체다. Orca가 정한 값이 아니다.
{ agent, workspaceId, workspaceKind, terminalId?, command, env: {} }

// 그리고 플러그인이 돌려준 값이 Orca 것을 덮는다.
const env = addedKeys.length > 0 ? { ...args.env, ...decided.env } : undefined
```

플러그인은 **Orca가 무엇을 정했는지 볼 수 없고, 무엇을 쓰든 이긴다.**
양보할 방법이 없으므로 미결 1번의 답에 따라 둘 중 하나를 택해야 한다.

상태바도 쓸 수 없다. 이 빌드의 worker 호스트 API에 statusBar 항목이 없다
(`notifications.show`가 전부).

### 7.6 만드는 방법

- `orca plugin create ~/side/orca-persona --template hook` → `trusted-worker` 등급
- TypeScript. 테스트는 `orca plugin test`
- 배포는 `orca plugin release-entry`로 `stablyai/orca-community-plugins` 카탈로그에
  PR. 현재 카탈로그 48개 중 훅을 쓰는 건 2개뿐이다.

### 7.7 소스에서 확인된 추가 제약 (2026-11-06, v1.4.250 기준)

- **resume·restore는 훅을 타지 않는다.** 같은 파일의 가드:
  `isRestoreSpawnIntent(args.spawnIntent) || args.resumeOrigin !== undefined ||
  args.resumeProviderSession !== undefined` → 조기 반환. 주석도 "Restores and
  resumes are not launches". 즉 **페르소나는 새 실행에만 걸린다.** 미결 2번.
- **`agent.launch.before`에는 경로가 없다.** `{agent, workspaceId, workspaceKind,
  terminalId?, command, env}`뿐이다. `workspace.list`가
  `{id, kind, name, path, branch, hostId}`를 주므로 `workspaceId → path`는
  풀 수 있다. 캐시해서 2초 예산 안에 끝낸다.
- **원격 호스트에서는 손을 뗀다.** `workspace.list`의 `hostId`가 null이 아니면
  로컬 `git config`도 로컬 config dir도 의미가 없다.
- **`workspace.create.before`에는 `projectId`가 있다** (`.after`에는 없고 `path`가 있다).
  경로 매칭을 고른 이유는 여전히 유효하지만, 나중에 프로젝트 id 기반으로
  옮길 여지는 있다.

### 7.8 깃 설정은 `--local`로 충분하다

빌더가 "링크된 워크트리에서 `git config --local`은 공용 레포 config를 건드려
형제 워크트리까지 바뀐다"고 지적했다. 사실이지만 **이 기능에서는 그게 맞는
동작이다.** 페르소나는 묶음(=레포 집합) 단위다. 회사 레포의 모든 워크트리는
회사 아이디를 써야 한다. `extensions.worktreeConfig`를 켤 이유가 없다.

다만 **이미 `user.email`이 레포에 설정돼 있으면 건드리지 않는다** (실패 조건 1).

### 7.9 기존 워크스페이스 일괄 적용

훅은 생성·실행 시점에만 돈다. 설치 당일에는 이미 있는 9개 프로젝트와 그
워크트리들에 아무 일도 일어나지 않는다 — 정작 불편을 겪던 대상이 그대로다.
**일괄 적용 커맨드를 넣는다.** 이미 설정된 아이디는 건너뛴다.

### 7.10 `CLAUDE.md`는 구분자로 감싼 영역만 소유한다

`<persona>/.claude/CLAUDE.md`는 Claude Code 자신이 쓰는 사용자 메모리 파일이다
(`#` 추가, `/init`). 통째로 덮어쓰면 사용자·에이전트가 넣은 내용이 조용히
사라진다. 플러그인은 마커로 감싼 구간만 갱신하고 나머지는 보존한다.

### 7.11 페르소나가 없으면 아무것도 하지 않는다

카탈로그에서 설치했는데 페르소나 파일이 하나도 없으면 조용히 통과한다.
설정 마법사도 알림도 띄우지 않는다.

## 미결 — 사용자 결정 필요

### 미결 1. 계정 관리를 누가 하나

현재 `orca account list`는 전부 비어 있고 `claude-observed-config-dirs.json`에도
`~/.claude` 하나뿐이다. **회사·개인을 한 계정으로 쓰고 있다.**

- ⒜ 앞으로 Orca `account add`로 관리할 거라면, 플러그인이 env를 덮으므로
  Orca UI·사용량 미터와 실제 세션이 어긋난다 (실패 조건 2 위반).
- ⒝ 계정 관리를 플러그인에 맡기면 충돌이 없다.

답에 따라 계정 기능을 넣을지 말지가 갈린다.

### 미결 2. 새 실행에만 걸려도 되는가

resume은 훅을 타지 않는다. 워크스페이스를 다시 열어 세션이 이어지면 페르소나가
적용되지 않는다. 허용 가능한 범위인지, 아니면 다른 수단이 필요한지.

## 8. 빌더에게 남기는 것

- `match` glob 문법 (`~` 확장, `**`, Windows 경로 구분자 처리)
- 상태바 표시의 정확한 문구와 갱신 시점
- `work.md` → `work/.claude/CLAUDE.md` 동기화 시점 (실행 때마다? 파일 변경 감시?)
- 페르소나 파일이 잘못됐을 때(frontmatter 파싱 실패 등)의 처리 — 조용히
  넘어가되 로그에 남기는 쪽을 권한다
- 테스트 구성. 최소한 경로 매칭 우선순위와 "이미 env가 있으면 건드리지 않음"은
  회귀 테스트가 있어야 한다

## 9. 이 다음

플러그인이 실제로 돌면, 그것이 upstream에 가져갈 근거가 된다.

- #12538에서 lafraia가 11/1에 던진 **"이거 코어 말고 익스텐션으로 되는 거
  아니냐"는 질문에 아직 아무도 답하지 않았다.** 돌아가는 익스텐션이 그 답이다.
- #13612 Part B(프로젝트별 깃 커밋 아이덴티티)는 스펙이 이미 쓰여 있고,
  메인테이너가 Part A를 머지했고, 열린 PR이 없다. 코어 기여를 한다면 여기가
  가장 깨끗한 자리다.
