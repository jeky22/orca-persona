import * as os from 'node:os'
import * as path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { AccountSelector } from './accounts'
import { expandHome } from './glob'
import { applyGitIdentity } from './git-identity'
import { defaultInstructionTargets, type InstructionTargets } from './instructions'
import { createRpcCall, defaultUserDataPath, readRuntimeMetadata, type RpcCall } from './orca-rpc'
import { PersonaStore } from './persona-store'
import { failureReason, PersonaSwitcher } from './switch'
import type { AgentId } from './types'
import { WorkspaceIndex, type HostList } from './workspaces'

export type WorkerDeps = {
  home: string
  personasDir: (settingValue: string) => string
  rpc: RpcCall
  applyGit: typeof applyGitIdentity
  targets: InstructionTargets
}

const isAgent = (a: unknown): a is AgentId => a === 'claude' || a === 'codex'

export function createActivate(deps: Partial<WorkerDeps>): (orca: OrcaWorkerApi) => Promise<void> {
  return async (orca) => {
    const home = deps.home ?? os.homedir()
    const personasDir =
      deps.personasDir ?? ((v: string) => (v === '' ? path.join(home, '.orca', 'personas') : expandHome(v, home)))
    const rpc =
      deps.rpc ??
      createRpcCall(() => readRuntimeMetadata(defaultUserDataPath(process.platform, process.env, home)))
    const applyGit = deps.applyGit ?? applyGitIdentity
    const targets = deps.targets ?? defaultInstructionTargets(home)
    const log = (m: string) => orca.log(m)

    const makeStore = async () =>
      new PersonaStore({ dir: personasDir(String((await orca.settings.get('personasDir')) ?? '')), home, log })
    let store = await makeStore()
    orca.settings.onDidChange(async () => {
      store = await makeStore()
    })

    const index = new WorkspaceIndex(
      () => orca.host.call('workspace.list') as ReturnType<HostList>
    )
    const switcher = new PersonaSwitcher({ accounts: new AccountSelector(rpc), targets, log })

    let lastStatus: string | null = null
    const setStatus = async (text: string): Promise<void> => {
      if (text === lastStatus) return
      lastStatus = text
      if (!orca.host.has('statusBar.update')) return
      try {
        await orca.host.call('statusBar.update', { id: 'persona', text })
      } catch (e) {
        log(`상태바 갱신 실패: ${failureReason(e)}`)
      }
    }
    const reportCurrent = () => (switcher.current !== null ? setStatus(`persona: ${switcher.current}`) : undefined)

    orca.commands.register('persona.status', () => `persona: ${switcher.current ?? '—'}`)
    orca.commands.register('persona.applyGit', () => 'not implemented')

    orca.hooks.on('workspace.create.after', async (event) => {
      const persona = store.resolve(event.path)
      if (!persona?.git) return undefined
      const result = await applyGit(event.path, persona.git, log)
      log(`깃 아이디 적용 ${event.path}: ${result}`)
      return undefined
    })

    orca.hooks.on('agent.launch.before', async (event, next) => {
      const agent = event.agent
      if (!isAgent(agent) || event.workspaceId === null) return undefined
      const ws = await index.byId(event.workspaceId)
      if (!ws) {
        log(`워크스페이스 ${event.workspaceId}를 찾지 못해 페르소나를 적용하지 않음`)
        return undefined
      }
      if (ws.hostId !== null) {
        log(`원격 워크스페이스 ${ws.name}(${ws.hostId})는 페르소나를 적용하지 않음`)
        return undefined
      }
      const persona = store.resolve(ws.path)
      if (!persona) return undefined
      try {
        const agents: AgentId[] = persona.accounts[agent] === undefined ? [] : [agent]
        const outcome = await switcher.apply(persona, agents, { fresh: true })
        if (outcome.kind === 'failed') return { deny: outcome.reason }
      } catch (e) {
        return { deny: failureReason(e) }
      }
      await reportCurrent()
      return next(event)
    })

    orca.events.on('workspace.changed', async (payload) => {
      const ctx = payload.context
      if (!ctx) return
      const ws = await index.byNameAndBranch(ctx.displayName, ctx.branch)
      if (!ws) {
        log(`워크스페이스 ${ctx.displayName} (${ctx.branch})를 하나로 특정하지 못해 페르소나를 적용하지 않음`)
        return
      }
      if (ws.hostId !== null) return
      const persona = store.resolve(ws.path)
      if (!persona) return
      try {
        const outcome = await switcher.apply(persona)
        if (outcome.kind === 'failed') {
          log(`페르소나 ${persona.name} 적용 실패: ${outcome.reason}`)
          await setStatus(`persona: ${persona.name} ⚠`)
          return
        }
        log(`페르소나 ${persona.name} 적용`)
        await reportCurrent()
      } catch (e) {
        log(`페르소나 ${persona.name} 적용 실패: ${failureReason(e)}`)
        await setStatus(`persona: ${persona.name} ⚠`)
      }
    })

    orca.events.on('workspace.created', () => index.invalidate())
    orca.events.on('workspace.removed', () => index.invalidate())
  }
}

export default createActivate({})
