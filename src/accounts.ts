import type { AgentId } from './types'
import type { RpcCall } from './orca-rpc'

type AccountEntry = { id: string; email: string | null; needsSignIn?: boolean }
type AgentAccounts = { accounts: AccountEntry[]; activeAccountId: string | null }

export type AccountSnapshot = {
  claude: AgentAccounts
  codex: AgentAccounts
}

export class UnregisteredAccountError extends Error {
  constructor(public agent: AgentId, public email: string) {
    super(`Orca에 등록되지 않은 ${agent} 계정: ${email}`)
    this.name = 'UnregisteredAccountError'
  }
}

export class AccountNeedsSignInError extends Error {
  constructor(public agent: AgentId, public email: string) {
    super(`${agent} 계정 ${email}은(는) 다시 로그인해야 합니다`)
    this.name = 'AccountNeedsSignInError'
  }
}

export type EnsureResult = 'already-active' | 'selected'

const norm = (s: string) => s.trim().toLowerCase()

function parseAgent(raw: unknown): AgentAccounts {
  const r = (raw ?? {}) as { accounts?: unknown; activeAccountId?: unknown }
  const accounts: AccountEntry[] = []
  if (Array.isArray(r.accounts)) {
    for (const a of r.accounts) {
      if (!a || typeof a !== 'object' || typeof a.id !== 'string') continue
      const entry: AccountEntry = { id: a.id, email: typeof a.email === 'string' ? a.email : null }
      if (typeof a.needsSignIn === 'boolean') entry.needsSignIn = a.needsSignIn
      accounts.push(entry)
    }
  }
  return { accounts, activeAccountId: typeof r.activeAccountId === 'string' ? r.activeAccountId : null }
}

export class AccountSelector {
  private cache: { at: number; snap: AccountSnapshot } | null = null
  private ttlMs: number

  constructor(private call: RpcCall, opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 30_000
  }

  async snapshot(force = false, timeoutMs?: number): Promise<AccountSnapshot> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.snap
    const raw = (await this.call('accounts.list', { refreshUsage: false }, timeoutMs)) as { claude?: unknown; codex?: unknown } | null
    const snap: AccountSnapshot = { claude: parseAgent(raw?.claude), codex: parseAgent(raw?.codex) }
    this.cache = { at: Date.now(), snap }
    return snap
  }

  async ensureSelected(
    agent: AgentId,
    email: string,
    opts?: { fresh?: boolean; timeoutMs?: number }
  ): Promise<EnsureResult> {
    const snap = await this.snapshot(opts?.fresh === true, opts?.timeoutMs)
    const state = snap[agent]
    const wanted = norm(email)
    let accountId: string | null = null
    if (wanted !== 'system') {
      const match = state.accounts.find((a) => a.email !== null && norm(a.email) === wanted)
      if (!match) throw new UnregisteredAccountError(agent, email)
      if (match.needsSignIn) throw new AccountNeedsSignInError(agent, email)
      accountId = match.id
    }
    if (state.activeAccountId === accountId) return 'already-active'
    await this.call(agent === 'claude' ? 'accounts.selectClaude' : 'accounts.selectCodex', { accountId }, opts?.timeoutMs)
    state.activeAccountId = accountId
    return 'selected'
  }
}
