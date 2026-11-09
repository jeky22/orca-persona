import {
  AccountNeedsSignInError,
  AmbiguousAccountError,
  UnregisteredAccountError,
  type AccountSelector,
  type EnsureResult
} from './accounts'
import { syncInstructionFiles, type InstructionTargets } from './instructions'
import { RpcCallError, RpcUnavailableError } from './orca-rpc'
import type { AgentId, Persona } from './types'

export type SwitchDeps = {
  accounts: AccountSelector
  targets: InstructionTargets
  log: (m: string) => void
}

export type SwitchOutcome =
  | { kind: 'applied'; persona: string; accounts: Partial<Record<AgentId, EnsureResult>> }
  | { kind: 'failed'; persona: string; agent: AgentId; reason: string }

const AGENT_ORDER: AgentId[] = ['claude', 'codex']

export class PersonaSwitcher {
  private _current: string | null = null
  /** apply 본문을 겹치지 않게 잇는 체인. 앞선 호출의 실패는 삼켜 다음 호출을 막지 않는다. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private deps: SwitchDeps) {}

  /** 마지막으로 성공 적용된 페르소나 이름. */
  get current(): string | null {
    return this._current
  }

  /**
   * 지시문 동기화 → agents(기본: persona.accounts에 있는 것) 각각 ensureSelected. 첫 실패에서 멈춘다.
   * 호출은 직렬화된다: 앞선 apply가 끝난 뒤에 본문이 시작된다 (계정과 지시문이 어긋나지 않도록).
   */
  apply(persona: Persona, agents?: AgentId[], opts?: { fresh?: boolean; timeoutMs?: number }): Promise<SwitchOutcome> {
    const run = this.chain.then(() => this.applyNow(persona, agents, opts))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async applyNow(
    persona: Persona,
    agents?: AgentId[],
    opts?: { fresh?: boolean; timeoutMs?: number }
  ): Promise<SwitchOutcome> {
    await syncInstructionFiles(this.deps.targets, persona.name, persona.body, this.deps.log)
    const list = agents ?? AGENT_ORDER.filter((a) => persona.accounts[a] !== undefined)
    const accounts: Partial<Record<AgentId, EnsureResult>> = {}
    for (const agent of list) {
      const email = persona.accounts[agent]
      if (email === undefined) continue
      try {
        accounts[agent] = await this.deps.accounts.ensureSelected(agent, email, {
          fresh: opts?.fresh,
          timeoutMs: opts?.timeoutMs
        })
      } catch (e) {
        const reason = failureReason(e)
        this.deps.log(`persona ${persona.name}: ${reason}`)
        return { kind: 'failed', persona: persona.name, agent, reason }
      }
    }
    this._current = persona.name
    return { kind: 'applied', persona: persona.name, accounts }
  }
}

export function failureReason(e: unknown): string {
  if (e instanceof UnregisteredAccountError) {
    return `${e.agent} 계정 ${e.email}이(가) Orca에 등록돼 있지 않습니다. orca account add --agent ${e.agent} 로 등록하세요.`
  }
  if (e instanceof AmbiguousAccountError) {
    return `${e.agent} 계정 ${e.email}이(가) Orca에 둘 이상 등록돼 있어(${e.ids.join(', ')}) 고를 수 없습니다. 페르소나에 계정을 하나만 남기거나 Orca에서 중복 계정을 정리하세요.`
  }
  if (e instanceof AccountNeedsSignInError) {
    return `${e.agent} 계정 ${e.email}의 로그인이 만료됐습니다. Orca 설정에서 다시 로그인하세요.`
  }
  if (e instanceof RpcUnavailableError) {
    return 'Orca 런타임에 연결할 수 없어 계정을 바꾸지 못했습니다 (orca account select를 쓸 수 없음).'
  }
  if (e instanceof RpcCallError) {
    return `Orca 계정 선택 요청이 실패했습니다 (${e.code}): ${e.message}`
  }
  return e instanceof Error ? e.message : String(e)
}
