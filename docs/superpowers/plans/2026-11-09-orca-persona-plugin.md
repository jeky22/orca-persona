# Orca Persona 플러그인 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 경로로 묶음(페르소나)을 판정해, 워크스페이스 생성 시 깃 아이디를 쓰고, 에이전트 실행·프로젝트 포커스 시 Orca의 활성 Claude/Codex 계정과 전역 지시문을 그 페르소나 것으로 바꾸는 Orca `trusted-worker` 플러그인.

**Architecture:** 워커 하나(`src/worker.ts`)가 훅 2개(`workspace.create.after`, `agent.launch.before`)와 이벤트 3개(`workspace.changed`, `workspace.created`, `workspace.removed`)를 받는다. 페르소나는 `~/.orca/personas/*.md`에서 읽어 glob으로 경로에 맞춘다. 계정 전환은 env 주입이 아니라 Orca 런타임 RPC(`accounts.selectClaude/selectCodex`)를 로컬 소켓으로 직접 호출한다. 지시문은 `~/.claude/CLAUDE.md`·`~/.codex/AGENTS.md`의 마커 구간만 교체한다. 외부 의존성 0 (frontmatter·glob은 직접 파싱).

**Tech Stack:** TypeScript (Orca가 로드 시 트랜스파일, 빌드 없음), Node 20+ 내장 모듈(`node:fs`, `node:net`, `node:child_process`, `node:path`, `node:os`), 테스트는 `orca plugin test`(node:test + `orca/testing`의 `mountWorker`/`mockHost`).

**Spec:** `docs/superpowers/specs/2026-11-06-orca-group-persona-design.md`

## Global Constraints

- `engines.orca`: `>=1.4.248`. 사용자가 Orca를 직접 올린다 (현재 1.4.247). 실기 검증(Task 13)은 그 뒤에만 가능하다. 단위 테스트(`orca plugin test`)는 1.4.247에서도 돈다.
- 훅 하나당 2초. `agent.launch.before`는 `"onError": "deny"` (실패 조건: 엉뚱한 계정으로 뜨느니 거부).
- 페르소나를 못 찾으면 **아무것도 하지 않는다**. 로그만 남긴다.
- 깃: `git config --local`, 이미 `user.email`이 있으면 건드리지 않는다.
- 지시문: 마커 `<!-- orca-persona:begin <name> -->` … `<!-- orca-persona:end -->` 밖은 절대 건드리지 않는다. 원자적 쓰기(임시 파일 → rename).
- 원격 호스트 워크스페이스(`workspace.list`의 `hostId !== null`)는 두 경로 모두 손대지 않는다.
- 포커스 경로에서 이름+브랜치가 0개 또는 2개 이상 맞으면 손대지 않는다.
- 페르소나가 적은 계정 이메일이 `accounts.list`에 없으면 `agent.launch.before`는 거부한다. 이유 문구에 `orca account add --agent <agent>`를 넣는다.
- 외부 npm 의존성 없음. `node:` 내장만.
- macOS·Linux·Windows. 경로는 `node:path`, 매칭 전에 구분자를 `/`로 통일.
- 런타임 RPC 프레임: 요청 한 줄 JSON `{ id, authToken, method, params }` + `\n`, 응답 `{ id, ok, result | error, _meta }`, 중간에 `{ "_keepalive": true }`가 올 수 있다. 메타데이터는 `<userData>/orca-runtime.json` (`ORCA_USER_DATA_PATH` 우선; macOS `~/Library/Application Support/orca`, Linux `$XDG_CONFIG_HOME/orca` 또는 `~/.config/orca`, Windows `%APPDATA%\orca`), `transports[]`에서 `kind: "unix"` 또는 `"named-pipe"`의 `endpoint`, `authToken`.
- 커밋 메시지는 한국어, 끝에 `Co-Authored-By: Claude <noreply@anthropic.com>`.

## Review Focus

1. **CRLF·BOM이 있는 페르소나 파일** (Windows 편집기) → 정상 파싱되어야 한다. 테스트: Task 3.
2. **macOS `/var` vs `/private/var`, 끝 슬래시, 심볼릭 링크 경로** → 원본 경로와 `realpath` 둘 다 매칭해 본다. 테스트: Task 4.
3. **`~/.claude/CLAUDE.md`가 심볼릭 링크** (dotfiles 관리) → rename으로 링크를 일반 파일로 바꾸면 안 된다. 링크 대상에 쓴다. 테스트: Task 6.
4. **`accounts.list`가 `needsSignIn: true`인 계정을 줄 때** → 선택하면 Orca가 throw한다. 미리 거부하고 이유에 "다시 로그인"을 넣는다. 테스트: Task 8.
5. **`agent.launch.before`의 `workspaceId`가 null(플로팅 터미널)이거나 원격 호스트** → 통과. 테스트: Task 11.

---

## 파일 구조

```
orca-plugin.json              매니페스트
tsconfig.json                 템플릿 그대로 (타입은 orca plugin types로 생성, 1.4.248+)
README.md                     설치·페르소나 파일 문법·동작 설명
src/types.ts                  Persona, AgentId, 공용 타입
src/glob.ts                   ~ 확장 + glob → RegExp
src/persona-file.ts           .md 한 장 파싱 (frontmatter 제한 문법 + 본문)
src/persona-store.ts          디렉터리 로드(mtime 캐시) + 경로 → 페르소나 판정
src/git-identity.ts           git config --local 쓰기
src/instructions.ts           마커 구간 교체 + 원자적 쓰기
src/orca-rpc.ts               orca-runtime.json 읽기 + 소켓 RPC 한 번 호출
src/accounts.ts               accounts.list 캐시, 이메일→id, ensureSelected
src/workspaces.ts             workspace.list 캐시, id/이름+브랜치 조회
src/switch.ts                 "페르소나 적용" = 지시문 동기화 → 계정 선택, 중복 적용 생략
src/worker.ts                 activate: 훅·이벤트·커맨드·상태바 배선 (의존성 주입 가능)
src/*.test.ts                 각 모듈 옆
```

---

### Task 1: 매니페스트와 워커 뼈대

**Files:**
- Create: `orca-plugin.json`, `tsconfig.json`, `.gitignore`, `src/worker.ts`, `src/types.ts`, `src/worker.test.ts`

**Interfaces:**
- Produces: `src/types.ts`
  ```ts
  export type AgentId = 'claude' | 'codex'
  export type GitIdentity = { name: string; email: string }
  export type Persona = {
    name: string            // 파일명에서 .md를 뗀 것
    sourcePath: string
    match: string[]         // glob, 원문 그대로
    git?: GitIdentity
    accounts: Partial<Record<AgentId, string>>  // 이메일 또는 'system'
    body: string            // frontmatter 뒤 본문, trim
  }
  ```
- Produces: `src/worker.ts`의 `export default function activate(orca: OrcaWorkerApi): void`

- [ ] **Step 1: 매니페스트 작성** — `orca-plugin.json`:
  ```json
  {
    "manifestVersion": 2,
    "id": "orca-persona",
    "name": "Orca Persona",
    "version": "0.1.0",
    "description": "경로 묶음별로 깃 아이디, Claude/Codex 계정, 지시문을 따라오게 한다.",
    "engines": { "orca": ">=1.4.248" },
    "execution": "trusted-worker",
    "pluginApi": 1,
    "main": "src/worker.ts",
    "capabilities": [{ "kind": "workspace:read" }, { "kind": "settings:own" }],
    "contributes": {
      "hooks": [
        { "event": "workspace.create.after" },
        { "event": "agent.launch.before", "onError": "deny" }
      ],
      "events": [{ "on": "workspace.changed" }, { "on": "workspace.created" }, { "on": "workspace.removed" }],
      "commands": [
        { "id": "persona.applyGit", "title": "Persona: 기존 워크스페이스에 깃 아이디 일괄 적용" },
        { "id": "persona.status", "title": "Persona: 현재 페르소나 보기" }
      ],
      "settings": [
        { "key": "personasDir", "title": "페르소나 디렉터리", "type": "string", "default": "", "placeholder": "~/.orca/personas" }
      ],
      "statusBarItems": [{ "id": "persona", "text": "persona: —", "command": "persona.status" }]
    }
  }
  ```
  `tsconfig.json`과 `.gitignore`는 `/tmp/persona-probe`(훅 템플릿 스캐폴드)의 것을 복사한다. 없으면 `orca plugin create /tmp/persona-probe --template hook`으로 다시 만든다.
- [ ] **Step 2: 실패하는 테스트** — `src/worker.test.ts`:
  ```ts
  import { assert, mountWorker, test } from 'orca/testing'
  import * as main from './worker'
  test('activate registers both commands and passes an unrelated launch', async () => {
    const worker = await mountWorker(main)
    assert.equal(await worker.command('persona.status'), 'persona: —')
    const decision = await worker.hooks.fire('agent.launch.before',
      { agent: 'gemini', workspaceId: null, workspaceKind: null, command: 'gemini', env: {} })
    assert.equal(decision.kind, 'continue')
    await worker.deactivate()
  })
  ```
- [ ] **Step 3: 실패 확인** — Run: `orca plugin test .` Expected: FAIL (`./worker` 없음)
- [ ] **Step 4: 구현** — `src/worker.ts`: `activate`가 `persona.status`(지금은 `'persona: —'` 반환)와 `persona.applyGit`(지금은 `'not implemented'`)를 등록하고, `agent.launch.before`·`workspace.create.after`에 아무것도 안 하는 핸들러(`return undefined`)를 단다. `src/types.ts`는 위 Interfaces대로.
- [ ] **Step 5: 통과 확인** — Run: `orca plugin test . && orca plugin validate .` Expected: 1 pass, `orca-plugin.json: ok`
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: 플러그인 매니페스트와 워커 뼈대"`

---

### Task 2: glob 매칭

**Files:**
- Create: `src/glob.ts`, `src/glob.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function normalizePath(p: string): string          // 백슬래시→/, 끝 슬래시 제거(루트 제외), 드라이브 문자 소문자
  export function expandHome(pattern: string, home: string): string   // 앞의 '~' 또는 '~/'만
  export function globToRegExp(pattern: string, home: string): RegExp // ** = 0개 이상 세그먼트, * = 세그먼트 안, ? = 한 글자
  export function globMatches(pattern: string, path: string, home: string): boolean
  ```

- [ ] **Step 1: 실패하는 테스트** — `src/glob.test.ts` (home = `/Users/me`):
  - `globMatches('~/workspace/**', '/Users/me/workspace/glab-server', home)` → true
  - `globMatches('~/workspace/**', '/Users/me/workspace', home)` → true (`**`는 0개 세그먼트도)
  - `globMatches('~/workspace/**', '/Users/me/workspaces/x', home)` → false
  - `globMatches('~/side/*', '/Users/me/side/a/b', home)` → false
  - `globMatches('C:/Users/me/work/**', 'c:\\Users\\me\\work\\repo', 'C:/Users/me')` → true
  - `globMatches('~/w/**', '/Users/me/w/repo/', home)` → true (끝 슬래시)
  - `globToRegExp('~/a.b/**', home).test('/Users/me/aXb/z')` → false (점은 리터럴)
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL (모듈 없음)
- [ ] **Step 3: 구현** — `src/glob.ts`. 정규식 특수문자는 모두 이스케이프하고 `**/`→`(?:[^/]+/)*`, `**`(끝)→`.*`, `*`→`[^/]*`, `?`→`[^/]`. 대소문자: Windows 드라이브 문자만 소문자화, 나머지는 그대로.
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -am "feat: glob 매칭"` (새 파일은 add)

---

### Task 3: 페르소나 파일 파싱

**Files:**
- Create: `src/persona-file.ts`, `src/persona-file.test.ts`

**Interfaces:**
- Consumes: `Persona`, `AgentId` (Task 1)
- Produces:
  ```ts
  export type PersonaParseError = { name: string; sourcePath: string; message: string }
  export function parsePersonaFile(name: string, sourcePath: string, text: string): Persona | PersonaParseError
  export function isPersonaParseError(x: Persona | PersonaParseError): x is PersonaParseError
  ```
  frontmatter 문법은 제한된 YAML 부분집합이다 (README에 그대로 적는다):
  - 파일은 `---` 줄로 시작하고 두 번째 `---` 줄에서 frontmatter가 끝난다. 그 뒤 전부가 본문.
  - 최상위 키: `match`, `git`, `accounts`. 모르는 키는 에러.
  - `match:` 다음 줄들 `  - <glob>` (2칸 들여쓰기, 1개 이상).
  - `git:` 다음 `  name: <text>`, `  email: <text>` (둘 다 필수).
  - `accounts:` 다음 `  claude: <email|system>`, `  codex: <email|system>` (0개 이상).
  - 값의 앞뒤 공백 제거, 따옴표(`"…"`/`'…'`)로 감싼 값은 벗긴다. `#`으로 시작하는 줄과 빈 줄은 무시. 줄 끝 ` # 주석`은 따옴표 밖에서만 제거.
  - `git`과 `accounts`가 둘 다 없으면 에러 ("아무것도 하지 않는 페르소나").

- [ ] **Step 1: 실패하는 테스트** — `src/persona-file.test.ts`:
  - 설계 문서 7.2의 `work.md` 예시 전체 텍스트 → `{ name: 'work', match: ['~/workspace/**'], git: { name: 'Jechan Lee', email: 'jechan.lee@gwanaklab.co.kr' }, accounts: { claude: 'jechan.lee@gwanaklab.co.kr', codex: 'jechan.lee@gwanaklab.co.kr' }, body: '사내 코드베이스다. 커밋 메시지는 한국어로 쓴다.\nPR 본문에 Jira 키를 반드시 넣는다.' }`
  - 같은 텍스트를 `\r\n`으로 바꾸고 앞에 `\uFEFF`(BOM)를 붙여도 같은 결과 (Review Focus 1)
  - `match` 없음 → 에러 메시지에 `match` 포함
  - `accounts:\n  claude: system` 만 있고 git 없음 → 정상, `accounts.claude === 'system'`
  - 모르는 최상위 키 `foo: 1` → 에러 메시지에 `foo`
  - frontmatter 없이 본문만 → 에러
  - 본문이 없는 파일(두 번째 `---`로 끝) → `body === ''`
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/persona-file.ts`. 줄 단위 상태 기계 (현재 섹션: none|match|git|accounts). 들여쓰기 판정은 "공백 2칸 이상이면 하위".
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: 페르소나 .md 파싱"`

---

### Task 4: 페르소나 저장소와 경로 판정

**Files:**
- Create: `src/persona-store.ts`, `src/persona-store.test.ts`

**Interfaces:**
- Consumes: Task 2 `globMatches`, `normalizePath`; Task 3 `parsePersonaFile`
- Produces:
  ```ts
  export type PersonaStoreOptions = { dir: string; home: string; log: (m: string) => void }
  export class PersonaStore {
    constructor(opts: PersonaStoreOptions)
    /** dir의 *.md를 읽는다. 파일 목록과 mtime이 같으면 캐시. 파싱 실패는 log에 남기고 건너뛴다. dir이 없으면 []. */
    load(): Persona[]
    /** workspacePath에 맞는 페르소나. 없으면 null. */
    resolve(workspacePath: string): Persona | null
  }
  export function pickByLongestMatch(personas: Persona[], path: string, home: string): Persona | null
  export function readRepoOverride(workspacePath: string): string | null  // <ws>/.orca-persona 첫 줄 trim, 없으면 null
  ```
  `resolve` 규칙: ① `.orca-persona`가 있고 그 이름의 페르소나가 있으면 그것 ② 아니면 `pickByLongestMatch`를 `workspacePath`와 `realpathSync(workspacePath)`(실패하면 생략) 각각에 적용, 먼저 맞는 쪽 ③ 가장 긴 패턴이 **둘 이상 동률**이면 null + log.

- [ ] **Step 1: 실패하는 테스트** — 임시 디렉터리에 `work.md`, `personal.md`, `broken.md`(frontmatter 없음)를 쓰고:
  - `load().map(p => p.name)` → `['personal', 'work']` (정렬된 이름), log에 `broken.md` 포함
  - `resolve('/Users/me/workspace/glab-server')` → `work`
  - `resolve('/Users/me/side/orca-persona')` → `personal`
  - `resolve('/tmp/elsewhere')` → null
  - `match`가 `~/workspace/**`인 work와 `~/workspace/glab/**`인 third가 있을 때 `/Users/me/workspace/glab/x` → `third` (더 긴 패턴)
  - 두 페르소나가 같은 패턴 `~/workspace/**` → null (동률)
  - 워크스페이스 디렉터리에 `.orca-persona` 내용 `personal\n` → work 경로여도 `personal`
  - 심볼릭 링크 `/tmp/link → <home>/workspace/repo` 경로로 resolve → `work` (Review Focus 2)
  - 파일을 수정하지 않고 `load()` 두 번 → 두 번째는 파일을 다시 읽지 않는다 (readFileSync 호출 수 또는 반환 배열 동일 참조로 확인)
  - dir이 존재하지 않음 → `[]`, 예외 없음
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/persona-store.ts`. 캐시 키는 `파일명:mtimeMs`를 이어 붙인 문자열.
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: 페르소나 저장소와 경로 판정"`

---

### Task 5: 깃 아이디 쓰기

**Files:**
- Create: `src/git-identity.ts`, `src/git-identity.test.ts`

**Interfaces:**
- Consumes: `GitIdentity` (Task 1)
- Produces:
  ```ts
  export type GitApplyResult = 'applied' | 'skipped-existing' | 'skipped-not-git' | 'failed'
  export async function applyGitIdentity(repoPath: string, git: GitIdentity, log: (m: string) => void): Promise<GitApplyResult>
  ```
  `git -C <repoPath> config --local --get user.email` 종료코드 0이면 `skipped-existing`; 128(깃 저장소 아님)이면 `skipped-not-git`; 1(값 없음)이면 `user.name`, `user.email`을 `--local`로 설정 후 `applied`. 그 외 실패는 `failed` + log. `execFile`(셸 없음) 사용, 타임아웃 1500ms.

- [ ] **Step 1: 실패하는 테스트** — 임시 폴더에 `git init`한 저장소로:
  - 비어 있는 저장소 → `applied`, 이후 `git config --local user.email` 출력이 설정한 값
  - 이미 `user.email`이 `other@x`인 저장소 → `skipped-existing`, 값이 그대로 `other@x`
  - 깃 저장소가 아닌 빈 폴더 → `skipped-not-git`
  - `git worktree add`로 만든 링크드 워크트리 경로 → `applied`이고, 메인 저장소에서도 같은 값이 읽힌다 (설계 7.8의 "공용 config"가 맞는 동작임을 고정)
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/git-identity.ts`
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: 워크스페이스에 깃 아이디 쓰기"`

---

### Task 6: 지시문 마커 구간 교체

**Files:**
- Create: `src/instructions.ts`, `src/instructions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const BEGIN = (name: string) => `<!-- orca-persona:begin ${name} -->`
  export const END = '<!-- orca-persona:end -->'
  /** content가 null이면 파일 없음. body가 ''이면 구간을 제거한다. 결과가 ''이면 null(파일을 비운다는 뜻이 아니라 "쓸 것 없음"). */
  export function replaceMarkedSection(content: string | null, name: string, body: string): string | null
  export type InstructionTargets = { claudeMd: string; codexAgentsMd: string }  // 절대 경로
  export function defaultInstructionTargets(home: string): InstructionTargets   // ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md
  /** 두 파일 모두 갱신. 내용이 바뀌지 않으면 쓰지 않는다. 심볼릭 링크면 대상에 쓴다. 임시 파일 → rename. 부모 디렉터리가 없으면 만든다. */
  export async function syncInstructionFiles(targets: InstructionTargets, name: string, body: string, log: (m: string) => void): Promise<void>
  ```
  구간 위치 규칙: 기존 마커가 있으면 그 자리에 교체(begin의 이름이 달라도 하나의 구간으로 본다: `orca-persona:begin` 접두로 찾는다). 없으면 파일 끝에 빈 줄 하나 띄우고 붙인다. 구간 형식은 `BEGIN\n<body>\nEND\n`.

- [ ] **Step 1: 실패하는 테스트**:
  - `replaceMarkedSection(null, 'work', '규칙')` → `'<!-- orca-persona:begin work -->\n규칙\n<!-- orca-persona:end -->\n'`
  - `replaceMarkedSection('# 내 메모\n', 'work', '규칙')` → `'# 내 메모\n\n<!-- orca-persona:begin work -->\n규칙\n<!-- orca-persona:end -->\n'`
  - 기존에 `personal` 구간이 가운데 있고 앞뒤에 사용자 텍스트 → `work` 구간으로 바뀌고 앞뒤 텍스트는 바이트 단위로 동일
  - `body === ''` → 구간 제거, 앞뒤 텍스트만 남음(구간 앞 빈 줄 하나까지 제거)
  - 끝에 개행 없는 사용자 파일 `'abc'` → `'abc\n\n<!-- … -->\n'`
  - `syncInstructionFiles`: 임시 home에 `CLAUDE.md`가 `real.md`로 가는 심볼릭 링크 → 호출 후에도 `lstat`이 심볼릭 링크이고 `real.md`에 구간이 있다 (Review Focus 3)
  - `syncInstructionFiles`: 같은 내용으로 두 번 호출 → 두 번째는 mtime이 변하지 않는다
  - 부모 디렉터리 `~/.codex`가 없음 → 만들어지고 `AGENTS.md`가 생긴다
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/instructions.ts`
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: 전역 CLAUDE.md/AGENTS.md 마커 구간 교체"`

---

### Task 7: Orca 런타임 RPC 클라이언트

**Files:**
- Create: `src/orca-rpc.ts`, `src/orca-rpc.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RuntimeMetadata = { endpoint: string; authToken: string }
  export function defaultUserDataPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string
  /** orca-runtime.json을 읽어 unix/named-pipe 엔드포인트를 고른다. 없거나 깨졌으면 throw RpcUnavailableError. */
  export function readRuntimeMetadata(userDataPath: string): RuntimeMetadata
  export class RpcUnavailableError extends Error { code = 'runtime_unavailable' }
  export class RpcCallError extends Error { constructor(public code: string, message: string) }
  export type RpcCall = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>
  /** 연결 → 한 줄 요청 → 응답 한 프레임(keepalive 무시) → 끝. 기본 timeout 1500ms. */
  export function createRpcCall(metadata: () => RuntimeMetadata): RpcCall
  ```

- [ ] **Step 1: 실패하는 테스트** — 테스트 안에서 `node:net`으로 임시 유닉스 소켓 서버(Windows면 `\\.\pipe\orca-persona-test-<pid>`)를 띄우고 `orca-runtime.json`을 임시 userData에 쓴 뒤:
  - 서버가 요청 줄을 파싱해 `{ id, authToken, method, params }`를 받았는지 단언하고 `{"_keepalive":true}\n` 다음 `{ id, ok: true, result: { hello: 1 }, _meta: { runtimeId: 'r' } }\n`을 보낸다 → `call('x.y', { a: 1 })`가 `{ hello: 1 }`로 resolve, 서버가 받은 `authToken`이 파일의 값과 같다
  - 서버가 `{ id, ok: false, error: { code: 'nope', message: 'no' } }` → `RpcCallError` reject, `code === 'nope'`
  - 서버가 응답 없이 연결을 닫음 → reject (`runtime_unavailable`)
  - `readRuntimeMetadata`에 파일 없음 → `RpcUnavailableError`
  - `defaultUserDataPath('darwin', {}, '/Users/me')` → `/Users/me/Library/Application Support/orca`; `('linux', { XDG_CONFIG_HOME: '/x' }, …)` → `/x/orca`; `('linux', {}, '/home/me')` → `/home/me/.config/orca`; `('win32', { APPDATA: 'C:\\A' }, …)` → `C:\\A\\orca`; `ORCA_USER_DATA_PATH`가 있으면 그것
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/orca-rpc.ts`. 요청 id는 `randomUUID()`. 응답은 `\n` 단위로 쪼개고 `_keepalive`는 타이머만 refresh. 같은 id의 첫 비-keepalive 프레임으로 settle 후 `socket.end()`.
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: Orca 런타임 RPC 클라이언트"`

---

### Task 8: 계정 선택

**Files:**
- Create: `src/accounts.ts`, `src/accounts.test.ts`

**Interfaces:**
- Consumes: Task 7 `RpcCall`, `RpcCallError`
- Produces:
  ```ts
  export type AccountSnapshot = {
    claude: { accounts: { id: string; email: string | null; needsSignIn?: boolean }[]; activeAccountId: string | null }
    codex:  { accounts: { id: string; email: string | null; needsSignIn?: boolean }[]; activeAccountId: string | null }
  }
  export class UnregisteredAccountError extends Error { constructor(public agent: AgentId, public email: string) }
  export class AccountNeedsSignInError extends Error { constructor(public agent: AgentId, public email: string) }
  export type EnsureResult = 'already-active' | 'selected'
  export class AccountSelector {
    constructor(call: RpcCall, opts?: { ttlMs?: number })   // 기본 ttl 30_000
    /** accounts.list { refreshUsage: false } 를 ttl 동안 캐시 */
    snapshot(force?: boolean): Promise<AccountSnapshot>
    /** email이 'system'이면 accountId null로 선택(관리 계정 해제). 이미 활성이면 RPC를 부르지 않는다. 선택 후 캐시의 activeAccountId를 갱신한다. */
    ensureSelected(agent: AgentId, email: string): Promise<EnsureResult>
  }
  ```
  메서드: claude → `accounts.selectClaude { accountId }`, codex → `accounts.selectCodex { accountId }`. 이메일 비교는 trim + 소문자.

- [ ] **Step 1: 실패하는 테스트** — `call`을 가짜 함수(호출 기록 배열)로 주입:
  - snapshot에 claude `[{ id: 'a1', email: 'Work@X' }]`, active `null`; `ensureSelected('claude', 'work@x')` → `'selected'`, 기록에 `['accounts.list', …]`, `['accounts.selectClaude', { accountId: 'a1' }]`
  - 바로 다시 `ensureSelected('claude', 'work@x')` → `'already-active'`, 추가 RPC 없음
  - 등록되지 않은 `'nobody@x'` → `UnregisteredAccountError` reject, `agent === 'claude'`
  - `needsSignIn: true`인 계정 → `AccountNeedsSignInError` reject, select RPC 호출 없음 (Review Focus 4)
  - `ensureSelected('codex', 'system')` (active가 `'c9'`) → `accounts.selectCodex { accountId: null }` 호출, `'selected'`
  - `ensureSelected('codex', 'system')` (active가 이미 null) → `'already-active'`
  - ttl 안에서 두 번 snapshot → `accounts.list` 1회; `snapshot(true)` → 2회
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/accounts.ts`
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: Orca 관리 계정 선택"`

---

### Task 9: 워크스페이스 색인

**Files:**
- Create: `src/workspaces.ts`, `src/workspaces.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WorkspaceEntry = { id: string; kind: 'worktree' | 'folder'; name: string; path: string; branch: string | null; hostId: string | null }
  export type HostList = () => Promise<{ workspaces: WorkspaceEntry[]; truncated: boolean }>  // orca.host.call('workspace.list') 래퍼
  export class WorkspaceIndex {
    constructor(list: HostList, opts?: { ttlMs?: number })   // 기본 30_000
    byId(id: string): Promise<WorkspaceEntry | null>         // 캐시에 없으면 force refresh 한 번 더
    /** 정확히 하나면 그것, 0개 또는 2개 이상이면 null. branch가 null인 쪽(folder)은 displayName만으로 비교. */
    byNameAndBranch(name: string, branch: string): Promise<WorkspaceEntry | null>
    invalidate(): void
  }
  ```
  `workspace.changed`의 `context.branch`는 플러그인에 짧은 이름(`main`)으로 오고 `workspace.list`의 `branch`도 같은 형식이다. 비교는 문자열 동등.

- [ ] **Step 1: 실패하는 테스트** — 가짜 `list`:
  - 두 항목 `{id:'w1', name:'glab-server', branch:'main', path:'/Users/me/workspace/glab-server', hostId:null}`, `{id:'w2', name:'glab', branch:'main', path:'/Users/me/side/glab', hostId:null}`: `byId('w2')` → path가 `/Users/me/side/glab`
  - `byNameAndBranch('glab', 'main')` → `w2`; `('glab', 'dev')` → null
  - 같은 이름+브랜치 항목이 둘 → null
  - `byId('w3')` 캐시 미스 → `list`가 한 번 더 호출되고, 두 번째 응답에 있으면 그것
  - ttl 안 두 번 `byId` → `list` 1회; `invalidate()` 후 → 다시 호출
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/workspaces.ts`
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: workspace.list 색인"`

---

### Task 10: 페르소나 적용(스위치)

**Files:**
- Create: `src/switch.ts`, `src/switch.test.ts`

**Interfaces:**
- Consumes: Task 6 `syncInstructionFiles`, `InstructionTargets`; Task 8 `AccountSelector`
- Produces:
  ```ts
  export type SwitchDeps = {
    accounts: AccountSelector
    targets: InstructionTargets
    log: (m: string) => void
  }
  export type SwitchOutcome =
    | { kind: 'applied'; persona: string; accounts: Partial<Record<AgentId, EnsureResult>> }
    | { kind: 'failed'; persona: string; agent: AgentId; reason: string }   // 계정 단계 실패. 지시문은 이미 동기화됨
  export class PersonaSwitcher {
    constructor(deps: SwitchDeps)
    /** 순서: 지시문 동기화 → agents(지정 안 하면 persona.accounts의 키 전부) 각각 ensureSelected. 첫 실패에서 멈춘다. */
    apply(persona: Persona, agents?: AgentId[]): Promise<SwitchOutcome>
    /** 마지막으로 성공 적용된 페르소나 이름. 상태바용. */
    readonly current: string | null
  }
  export function failureReason(e: unknown): string
  ```
  `failureReason`: `UnregisteredAccountError` → `` `${agent} 계정 ${email}이(가) Orca에 등록돼 있지 않습니다. orca account add --agent ${agent} 로 등록하세요.` ``; `AccountNeedsSignInError` → `` `${agent} 계정 ${email}의 로그인이 만료됐습니다. Orca 설정에서 다시 로그인하세요.` ``; `RpcUnavailableError` → `'Orca 런타임에 연결할 수 없어 계정을 바꾸지 못했습니다 (orca account select를 쓸 수 없음).'`; 그 외 → `String(e.message)`.

- [ ] **Step 1: 실패하는 테스트** — 임시 home + 가짜 RPC `call`:
  - work 페르소나(claude·codex 이메일, body '규칙') `apply` → `kind: 'applied'`, `CLAUDE.md`와 `AGENTS.md`에 구간, 가짜 call에 `selectClaude`·`selectCodex` 각 1회, `current === 'work'`
  - 다시 같은 페르소나 `apply` → `applied`이고 추가 select 호출 0회, 파일 mtime 불변
  - accounts에 claude만 있는 페르소나 → codex 관련 RPC 호출 없음
  - 미등록 이메일 → `kind: 'failed'`, `reason`에 `orca account add --agent claude` 포함, 지시문 파일은 이미 갱신돼 있음, `current`는 이전 값 유지
  - `apply(persona, ['claude'])` → codex는 건드리지 않음
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/switch.ts`
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: 페르소나 적용(지시문 + 계정)"`

---

### Task 11: 워커 배선 — 훅·이벤트·상태바

**Files:**
- Modify: `src/worker.ts`, `src/worker.test.ts`

**Interfaces:**
- Consumes: Task 4 `PersonaStore`; Task 5 `applyGitIdentity`; Task 7 `createRpcCall`, `readRuntimeMetadata`, `defaultUserDataPath`; Task 8 `AccountSelector`; Task 9 `WorkspaceIndex`; Task 10 `PersonaSwitcher`
- Produces:
  ```ts
  export type WorkerDeps = {
    home: string
    personasDir: (settingValue: string) => string     // ''이면 join(home, '.orca', 'personas'), '~'는 확장
    rpc: RpcCall
    applyGit: typeof applyGitIdentity
    targets: InstructionTargets
  }
  export function createActivate(deps: Partial<WorkerDeps>): (orca: OrcaWorkerApi) => Promise<void>
  export default createActivate({})   // 실제 Orca가 부르는 것
  ```
  동작:
  - `workspace.create.after`: `store.resolve(event.path)` → `git`이 있으면 `applyGit(event.path, git, log)`. 결과를 log. 반환 없음.
  - `agent.launch.before`: `event.agent`가 `claude`/`codex`가 아니거나 `workspaceId`가 null이면 통과. `index.byId(workspaceId)`가 null이거나 `hostId !== null`이면 통과(log). `store.resolve(ws.path)`가 null이거나 `persona.accounts[agent]`가 없으면 통과. 아니면 `switcher.apply(persona, [agent])`; `failed`면 `{ deny: reason }`, 아니면 `next(event)` (변경 없이).
  - `workspace.changed`: `context`가 null이면 무시. `index.byNameAndBranch(context.displayName, context.branch)` → null이면 log 후 무시; `hostId !== null`이면 무시; `store.resolve(path)` null이면 무시; 있으면 `switcher.apply(persona)` 후 결과를 log. 실패해도 거부할 대상이 없으므로 log + 상태바 텍스트 `persona: <name> ⚠`.
  - `workspace.created`/`workspace.removed`: `index.invalidate()`.
  - 상태바: `switcher.current`가 바뀔 때 `orca.host.call('statusBar.update', { id: 'persona', text: \`persona: ${name}\` })`. `orca.host.has('statusBar.update')`가 false면 건너뛴다.
  - `persona.status` 커맨드: `` `persona: ${switcher.current ?? '—'}` `` 반환.
  - 설정 `personasDir`: `orca.settings.get('personasDir')`를 activate 때 읽고 `orca.settings.onDidChange`에서 store를 새로 만든다.

- [ ] **Step 1: 실패하는 테스트** — `src/worker.test.ts` 전면 교체. 공통: 임시 home에 `.orca/personas/work.md`(match `<home>/workspace/**`, git, claude 이메일 `work@x`)와 `personal.md`(match `<home>/side/**`, claude `me@x`) 작성; `mockHost({ results: { 'workspace.list': { workspaces: [...], truncated: false }, 'statusBar.update': {} } })`; 가짜 `rpc`(accounts.list → work@x=a1, me@x=a2, active null; select → `{}`); 가짜 `applyGit`(호출 기록). `mountWorker({ default: createActivate(deps) }, { host })`.
  - **깃**: `fire('workspace.create.after', { workspaceId: 'w1', kind: 'worktree', path: '<home>/workspace/repo', branch: 'main' })` → `applyGit` 기록 1건, 인자 git이 work의 것. 경로가 `/tmp/none`이면 기록 0건.
  - **실행, 정상**: `fire('agent.launch.before', { agent: 'claude', workspaceId: 'w1', workspaceKind: 'worktree', command: 'claude', env: {} })` → `kind: 'continue'`, `event.env`가 `{}` 그대로(env 주입 없음), 가짜 rpc에 `selectClaude {accountId:'a1'}` 1회, `host.callsOf('statusBar.update')` 마지막 text `persona: work`
  - **실행, 미등록**: personal의 claude를 `ghost@x`로 바꾼 뒤 w2(`<home>/side/x`)로 fire → `kind: 'deny'`, `reason`에 `orca account add --agent claude`
  - **실행, 원격**: `hostId: 'ssh-1'`인 w3 → `continue`, select 호출 0회 (Review Focus 5)
  - **실행, 플로팅**: `workspaceId: null` → `continue`, RPC 호출 0회 (Review Focus 5)
  - **실행, 다른 에이전트**: `agent: 'gemini'` → `continue`, RPC 0회
  - **포커스**: `emit('workspace.changed', { context: { branch: 'main', displayName: 'repo', terminals: [] } })` → select `a1` 1회; 이어서 personal 워크스페이스로 emit → `selectClaude {accountId:'a2'}`; 다시 work로 → `a1`
  - **포커스, 중복 이름**: workspace.list에 이름+브랜치가 같은 항목 둘 → emit 후 RPC 0회, logs에 해당 이름 포함
  - **포커스, 동일 페르소나 재진입**: work로 두 번 emit → select 1회
  - **RPC 불가**: `rpc`가 `RpcUnavailableError`를 던짐 → launch fire는 `deny`, reason에 `orca account select`
  - **페르소나 없음 (설계 7.11)**: personas 디렉터리를 비우고(또는 지우고) 마운트 → launch fire `continue`, emit 후에도 RPC 0회, `persona.status`는 `persona: —`
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/worker.ts`. `createActivate`가 기본 deps를 채운다: `home = os.homedir()`, `rpc = createRpcCall(() => readRuntimeMetadata(defaultUserDataPath(process.platform, process.env, home)))`, `targets = defaultInstructionTargets(home)`.
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test . && orca plugin validate .` Expected: PASS, ok
- [ ] **Step 5: Commit** — `git commit -m "feat: 훅·이벤트·상태바 배선"`

---

### Task 12: 일괄 적용 커맨드

**Files:**
- Modify: `src/worker.ts`, `src/worker.test.ts`

**Interfaces:**
- Produces: 커맨드 `persona.applyGit` → 문자열 결과 `` `applied ${a}, skipped ${s}, no persona ${n}, remote ${r}` ``
  `workspace.list` 전체를 돌며 `hostId === null`인 항목마다 `store.resolve(path)` → git 있으면 `applyGit`. `truncated`가 true면 결과 끝에 ` (truncated)`.

- [ ] **Step 1: 실패하는 테스트** — Task 11 픽스처에 워크스페이스 4개(work 경로 2개 중 1개는 applyGit이 `skipped-existing`을 돌려주게, personal 경로지만 git 없는 페르소나 1개, 원격 1개): `worker.command('persona.applyGit')` → `'applied 1, skipped 1, no persona 1, remote 1'`
- [ ] **Step 2: 실패 확인** — Run: `orca plugin test .` Expected: FAIL
- [ ] **Step 3: 구현** — `src/worker.ts`의 `persona.applyGit` 핸들러
- [ ] **Step 4: 통과 확인** — Run: `orca plugin test .` Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: 기존 워크스페이스 깃 아이디 일괄 적용 커맨드"`

---

### Task 13: README와 실기 검증 (Orca ≥ 1.4.248 필요)

**Files:**
- Create: `README.md`
- Modify: `HANDOFF.md` (검증 결과 기록)

- [ ] **Step 1: README 작성** — 포함: 설치(`orca plugin dev load .` + `--approve`), 선행 작업(`orca account add --agent claude`, `--agent codex`를 페르소나 수만큼), 페르소나 파일 문법(Task 3의 제한 문법 그대로), 동작 3경로 표(설계 7.4), 실패 시 메시지 뜻, 알려진 한계(포커스 경로는 이름+브랜치 매칭, 전역 지시문 교체는 Orca 밖 claude에도 보임, resume은 포커스 경로에 의존).
- [ ] **Step 2: 버전 확인** — Run: `orca --version` Expected: `1.4.248` 이상. 아니면 이 태스크는 여기서 멈추고 HANDOFF.md에 "실기 검증 대기"라고 적는다.
- [ ] **Step 3: 실제 페르소나 작성** — `~/.orca/personas/work.md`(match `~/workspace/**`), `personal.md`(match `~/side/**`, `~/orca/projects/**`). 계정 이메일은 `orca account list --json`의 `claude.accounts[].email`과 일치시킨다. 계정이 아직 없으면 `orca account add --agent claude`를 먼저.
- [ ] **Step 4: 로드** — Run: `orca plugin dev load . ` → 출력의 fingerprint로 `orca plugin dev load . --approve <fingerprint>`; `orca plugin list` Expected: `orca-persona` enabled
- [ ] **Step 5: 훅 검증** — Run: `orca plugin dev hook . agent.launch.before --data '{"agent":"claude","workspaceId":"<회사 워크스페이스 id>","workspaceKind":"worktree","command":"claude","env":{}}'` Expected: `continue`; `orca account list --json`의 `claude.activeAccountId`가 회사 계정 id. `workspaceId`는 `orca worktree list --json`(또는 `orca plugin dev request`로 `workspace.list`)에서 얻는다.
- [ ] **Step 6: 포커스 검증** — 사이드바에서 개인 프로젝트 클릭 → `orca account list --json`의 활성 id가 개인 계정으로 바뀌고 상태바가 `persona: personal`. 회사 클릭 → 반대로. `cat ~/.claude/CLAUDE.md`에 마커 구간이 교체돼 있다.
- [ ] **Step 7: resume 검증 (설계 7.7의 추정)** — 회사 워크스페이스에서 Claude 세션을 하나 열고 닫은 뒤, 개인 프로젝트를 클릭하고 다시 회사 프로젝트를 클릭한 다음 그 세션을 resume → 세션 안에서 `/status`(또는 `claude` 상단의 계정 표시)가 회사 계정인지 확인. 결과를 README "알려진 한계"에 사실대로 적는다.
- [ ] **Step 8: 지시문 보존 검증 (설계 7.10)** — 계정을 바꾼 뒤 `cat "$(ls -d ~/Library/Application\ Support/orca/profiles/*/claude-profiles/*/home | head -1)/CLAUDE.md"`가 `@~/.claude/CLAUDE.md` 스텁인지, 그리고 전역 파일의 마커 밖 내용이 그대로인지 확인.
- [ ] **Step 9: 로그 확인** — Run: `orca plugin logs orca-persona` Expected: 2초 초과 경고 없음
- [ ] **Step 10: Commit** — `git add README.md HANDOFF.md && git commit -m "docs: README와 실기 검증 결과"`

---

### Task 14 (별도 저장소, 선택): upstream CLI PR

**Files:**
- stablyai/orca 포크의 `src/cli/handlers/account.ts`, `src/cli/handlers/data-account-commands.ts`(또는 새 파일), 해당 테스트, `docs/`의 CLI 레퍼런스

- [ ] **Step 1:** 포크·클론 후 `'account select'` 핸들러가 `--agent claude`면 `client.call('accounts.selectClaude', { accountId })`, `codex`면 `accounts.selectCodex`를 부르게 한다. `--account system`은 `accountId: null`. 출력은 기존 `formatAccountsBlock`.
- [ ] **Step 2:** 기존 `account select` 테스트 패턴을 따라 claude/codex 케이스 추가, 통과 확인.
- [ ] **Step 3:** PR 본문에 #37318·#30567을 참조하고 "runtime method already exists; CLI parity for claude/codex"로 설명. 끝에 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 4:** 머지되면 이 플러그인에 설정 `accountChannel: 'rpc' | 'cli'`를 추가하는 후속 태스크를 HANDOFF.md에 적는다 (지금은 만들지 않는다).
