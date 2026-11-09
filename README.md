# Orca Persona

경로 묶음(페르소나)별로 깃 아이디, Claude/Codex 계정, 지시문이 따라오게 하는 Orca 플러그인 (`trusted-worker`).

> 상태: 코드와 단위 테스트(98개)는 끝났고, **실기 검증은 아직 안 됐다** (설치된 Orca가 1.4.247이라 훅을 쓸 수 없음). "알려진 한계" 참고.

## 요구 사항

- Orca **1.4.248 이상** (훅이 그 버전부터)
- Claude / Codex CLI
- 페르소나가 쓸 계정을 Orca에 등록: 페르소나 수만큼
  ```
  orca account add --agent claude
  orca account add --agent codex
  ```

## 설치 (개발 로드)

```
orca plugin dev load .
orca plugin dev load . --approve <출력된 fingerprint>
orca plugin list          # orca-persona 가 enabled 인지 확인
```

## 페르소나 파일

위치는 `~/.orca/personas/*.md`. 플러그인 설정 `personasDir`로 바꿀 수 있다 (`~` 허용, 비워 두면 기본값). **파일명(확장자 제외)이 페르소나 이름**이다. 파일이 하나도 없으면 아무것도 하지 않는다.

`~/.orca/personas/work.md`:

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

### 문법

파서는 아래만 받는다. 그 밖의 것은 파싱 오류이며, 오류가 난 파일은 로그를 남기고 무시된다.

| 항목 | 규칙 |
|---|---|
| frontmatter | 첫 줄이 `---`, 닫는 `---` 줄이 있어야 한다. 그 아래 전부가 지시문 본문 |
| 최상위 키 | `match:`, `git:`, `accounts:` 만 (줄 끝에 값 없이 `키:`). 다른 키는 오류 |
| `match` | 필수, 1개 이상. 항목은 들여쓴 `  - <glob>` 형태 |
| `git` | 들여쓴 `  name: ...`, `  email: ...`. 둘 다 필요 |
| `accounts` | 들여쓴 `  claude: <이메일>`, `  codex: <이메일>`. 값은 비어 있으면 안 됨. 이메일 대신 `system`이라고 쓰면 관리 계정 선택 해제(시스템 기본 계정). 키를 빼면 그 에이전트 계정은 건드리지 않음 |
| 들여쓰기 | 공백 2칸 이상 |
| 주석 | `#`로 시작하는 줄, 값 뒤의 ` # 설명` |
| 따옴표 | 값과 glob에 `"..."` 또는 `'...'` 사용 가능 (따옴표 안의 `#`은 주석 아님) |
| 최소 조건 | `git`과 `accounts`가 모두 없으면 오류 |

소속 판정은 `match` glob을 워크스페이스 경로에 맞춰서 한다.

- 여러 페르소나가 맞으면 **가장 긴 패턴**이 이긴다. 동률이면 아무것도 하지 않고 로그만 남긴다.
- 레포별 예외: 레포 루트의 `.orca-persona` 파일 첫 줄에 페르소나 이름을 적으면 경로 규칙보다 우선한다. 그 이름의 페르소나가 없으면 로그를 남기고 경로 규칙을 쓴다.
- 원격 호스트 워크스페이스는 손대지 않는다.

## 동작 세 경로

| 훅/이벤트 | 하는 일 |
|---|---|
| `workspace.create.after` (훅) | 페르소나를 찾아 `git config --local user.name/user.email`을 기록한다. 레포에 이미 `user.email`이 있으면 건너뛴다 |
| `agent.launch.before` (훅) | 워크스페이스 id로 경로를 풀어 페르소나를 찾고, 지시문 구간을 교체한 뒤 Orca에 계정 선택을 요청하고 통과시킨다. 계정은 매번 새로 읽은 목록으로 판단하며, 이미 활성이면 요청하지 않는다. 아래 조건이면 **실행을 거부**한다: 페르소나의 이메일이 Orca에 등록돼 있지 않음 / 로그인 만료 / Orca 런타임 RPC 불가 / RPC 오류 / 워크스페이스 목록 조회 실패. 페르소나가 없거나 원격 워크스페이스거나 해당 에이전트 계정 키가 없으면 그대로 통과 |
| `workspace.changed` (이벤트) | 포커스된 워크스페이스를 이름+브랜치로 `workspace.list`에서 찾아 페르소나를 적용(지시문 + 계정)한다. 실패해도 거부할 대상이 없으므로 로그를 남기고 상태바에 `persona: <이름> ⚠`를 띄운다 |

`agent.launch.before`가 정확한 경로이고(workspaceId가 있음), `workspace.changed`는 포커스를 따라가는 경로다. 계정 선택은 호스트 전역이므로 "마지막으로 누른/띄운 프로젝트"가 계정과 지시문을 함께 끌고 다닌다. 이미 돌고 있는 세션에는 영향이 없다.

상태바는 `persona: <현재 페르소나>` (적용 전에는 `persona: —`)이고, 클릭하면 `persona.status`가 실행된다.

## 지시문

페르소나 본문은 전역 `~/.claude/CLAUDE.md`와 `~/.codex/AGENTS.md`의 마커 구간으로 들어간다.

```
(사용자 내용 그대로)
<!-- orca-persona:begin work -->
사내 코드베이스다. ...
<!-- orca-persona:end -->
```

- 마커 구간만 교체하고 나머지는 보존한다. 파일이 없으면 만들고, 마커가 없으면 끝에 붙인다.
- 본문이 비어 있으면 구간을 제거한다.
- Orca가 모든 관리 계정 홈에서 전역 파일을 가져다 쓰기 때문에 전역 파일을 쓴다.
- 교체 시점은 계정 선택 직전이다 (포커스 경로와 실행 경로 모두).

## 커맨드

- `persona.applyGit`: 이미 존재하는 워크스페이스에 깃 아이디를 일괄 적용한다. 이미 설정된 레포는 건너뛴다. 계정은 대상이 아니다. 결과는 한 줄로 나온다.
  ```
  applied 3, skipped 1, no persona 4, remote 0
  ```
  (목록이 잘렸으면 끝에 ` (truncated)`, 조회 자체가 실패하면 `failed: <이유>`)
- `persona.status`: `persona: <이름>` 또는 `persona: —`

## 실패 시 메시지 뜻

`agent.launch.before` 거부 이유와 로그에 나오는 메시지다.

| 메시지 | 상황 | 해결 |
|---|---|---|
| `<agent> 계정 <이메일>이(가) Orca에 등록돼 있지 않습니다. orca account add --agent <agent> 로 등록하세요.` | 페르소나 파일의 이메일이 Orca 계정 목록에 없음 (오타 포함) | 안내된 명령으로 계정을 등록하거나 파일의 이메일을 고친다 |
| `<agent> 계정 <이메일>의 로그인이 만료됐습니다. Orca 설정에서 다시 로그인하세요.` | 등록은 돼 있으나 로그인이 만료됨 | Orca 설정에서 다시 로그인 |
| `Orca 런타임에 연결할 수 없어 계정을 바꾸지 못했습니다 (orca account select를 쓸 수 없음).` | 사용자 데이터 경로의 런타임 소켓에 붙지 못함 (Orca 미실행, 사설 프로토콜 변경 등) | Orca가 떠 있는지 확인. 계속되면 이슈로 보고 |
| `Orca 계정 선택 요청이 실패했습니다 (<코드>): <메시지>` | 소켓에는 붙었으나 Orca가 요청을 오류로 응답 | 코드와 메시지를 확인. `orca plugin logs orca-persona` 참고 |

## 알려진 한계

- **실기 검증이 안 됐다.** 설치본이 1.4.247이라 훅이 없다. 1.4.248 이상에서 검증 예정이며 그때까지 동작은 단위 테스트로만 확인됐다.
- 포커스 경로는 이름+브랜치로 워크스페이스를 찾는다. 같은 이름+브랜치가 둘 이상이거나 원격 워크스페이스면 무시한다 (실행 경로는 workspaceId로 정확히 찾으므로 영향 없음).
- 전역 지시문 교체는 Orca 밖에서 띄운 `claude`/`codex`에도 보인다.
- resume은 훅을 타지 않아 포커스 경로에 의존한다. Orca가 resume 때 현재 선택 계정을 쓰는지는 **미검증**(추정)이다.
- 계정 선택은 Orca의 사설 런타임 소켓 RPC(`accounts.selectClaude`/`selectCodex`)를 쓴다. 이 프로토콜은 깨질 수 있고, 깨지면 실행을 통과시키지 않고 거부한다. CLI에 `orca account select --agent claude|codex`가 생기면 그쪽으로 교체할 예정이다.

## 개발

```
orca plugin test .
orca plugin validate .
```
