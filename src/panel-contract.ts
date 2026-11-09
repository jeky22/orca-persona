import type { GitIdentity } from './types'

/** 패널 ↔ 워커 계약. 양쪽이 같은 타입을 쓰도록 여기에만 선언한다. */

export type OverviewWorkspace = {
  id: string
  name: string
  branch: string | null
  path: string
  kind: 'worktree' | 'folder'
  /** 레포 루트 .orca-persona가 가리키는 이름 (수동 지정). 없으면 null. */
  override: string | null
}

/** 패널 편집 폼이 저장하는 내용. 본문(지시문)은 파일에 있던 것을 보존한다. */
export type PersonaDraft = {
  name: string
  match: string[]
  git: GitIdentity | null
  accounts: { claude?: string; codex?: string }
}

export type OverviewGroup = {
  name: string
  match: string[]
  git: GitIdentity | null
  accounts: { claude?: string; codex?: string }
  hasBody: boolean
  workspaces: OverviewWorkspace[]
}

export type OverviewAgentAccounts = {
  accounts: { id: string; email: string | null }[]
  activeAccountId: string | null
}

export type PersonaOverview = {
  /** 마지막으로 성공 적용된 페르소나. */
  current: string | null
  /** 마지막 적용 시도와 결과 (성공·실패 모두). */
  lastApply: { persona: string; ok: boolean; reason?: string } | null
  /** 마지막 workspace.changed의 포커스 컨텍스트. */
  focus: { displayName: string; branch: string } | null
  personasDir: string
  accounts: { claude: OverviewAgentAccounts; codex: OverviewAgentAccounts } | null
  accountsError: string | null
  groups: OverviewGroup[]
  unmatched: OverviewWorkspace[]
  remote: OverviewWorkspace[]
  truncated: boolean
  workspacesError: string | null
  issues: { file: string; message: string }[]
}

declare module 'orca' {
  interface PluginRequests {
    'persona.overview': { output: PersonaOverview }
    'persona.save': { input: PersonaDraft; output: { ok: true } }
    'persona.delete': { input: { name: string }; output: { ok: true } }
    /** persona가 null이면 수동 지정을 지우고 경로 규칙으로 돌아간다. */
    'persona.assign': { input: { workspaceId: string; persona: string | null }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    'persona.changed': { current: string | null }
  }
}
