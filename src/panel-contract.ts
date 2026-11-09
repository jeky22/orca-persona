import type { GitIdentity } from './types'

/** 패널 ↔ 워커 계약. 양쪽이 같은 타입을 쓰도록 여기에만 선언한다. */

export type OverviewWorkspace = {
  id: string
  name: string
  branch: string | null
  path: string
  kind: 'worktree' | 'folder'
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
  }
  interface PluginPanelEvents {
    'persona.changed': { current: string | null }
  }
}
