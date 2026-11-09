import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { OrcaWorkerApi, PluginEvents } from 'orca/worker'
import { AccountSelector } from './accounts'
import { expandHome } from './glob'
import { applyGitIdentity } from './git-identity'
import { defaultInstructionTargets, type InstructionTargets } from './instructions'
import { createRpcCall, defaultUserDataPath, readRuntimeMetadata, type RpcCall } from './orca-rpc'
import { PersonaStore, readRepoOverride } from './persona-store'
import type { OverviewGroup, OverviewWorkspace, PersonaDraft, PersonaOverview } from './panel-contract'
import { isPersonaParseError, parsePersonaFile } from './persona-file'
import { failureReason, PersonaSwitcher, type SwitchOutcome } from './switch'
import type { AgentId } from './types'
import { isRemoteHost, WorkspaceIndex, type HostList } from './workspaces'

export type WorkerDeps = {
  home: string
  personasDir: (settingValue: string) => string
  rpc: RpcCall
  applyGit: typeof applyGitIdentity
  targets: InstructionTargets
  /** agent.launch.before 전체 기한(ms). 테스트용; 기본 LAUNCH_HOOK_DEADLINE_MS. */
  launchDeadlineMs?: number
}

/** Orca 훅 예산은 2초이고 시간 초과 시 통과될 수 있으므로(설계 6절) 그보다 먼저 스스로 거부한다. */
export const LAUNCH_HOOK_DEADLINE_MS = 1700
const MIN_STAGE_TIMEOUT_MS = 100
const LAUNCH_DEADLINE_REASON =
  '페르소나 적용이 1.7초 안에 끝나지 않아 실행을 거부했습니다 (Orca 런타임이 느리거나 응답하지 않음).'

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

    let currentDir = ''
    const makeStore = async () => {
      currentDir = personasDir(String((await orca.settings.get('personasDir')) ?? ''))
      return new PersonaStore({ dir: currentDir, home, log })
    }
    let store = await makeStore()
    orca.settings.onDidChange(async () => {
      try {
        store = await makeStore()
      } catch (e) {
        log(`personasDir 설정을 다시 읽지 못해 기존 설정을 유지함: ${failureReason(e)}`)
      }
    })

    const index = new WorkspaceIndex(
      () => orca.host.call('workspace.list') as ReturnType<HostList>
    )
    const selector = new AccountSelector(rpc)
    const switcher = new PersonaSwitcher({ accounts: selector, targets, log })

    let lastFocus: { displayName: string; branch: string } | null = null
    let lastApply: PersonaOverview['lastApply'] = null
    const recordOutcome = (outcome: SwitchOutcome): void => {
      lastApply =
        outcome.kind === 'applied'
          ? { persona: outcome.persona, ok: true }
          : { persona: outcome.persona, ok: false, reason: outcome.reason }
      orca.panels.post('persona.changed', { current: switcher.current })
    }

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
    orca.commands.register('persona.applyGit', async () => {
      try {
        const list = (await orca.host.call('workspace.list')) as Awaited<ReturnType<HostList>>
        let applied = 0
        let skipped = 0
        let noPersona = 0
        let remote = 0
        // 같은 저장소 설정에 대한 쓰기가 겹치지 않도록 순차 처리한다.
        for (const ws of list.workspaces) {
          if (isRemoteHost(ws.hostId)) {
            remote++
            continue
          }
          const git = store.resolve(ws.path)?.git
          if (!git) {
            noPersona++
            continue
          }
          const result = await applyGit(ws.path, git, log)
          if (result === 'applied') {
            applied++
          } else {
            skipped++
            log(`깃 아이디 적용 건너뜀 ${ws.path}: ${result}`)
          }
        }
        const summary = `applied ${applied}, skipped ${skipped}, no persona ${noPersona}, remote ${remote}`
        return list.truncated ? `${summary} (truncated)` : summary
      } catch (e) {
        const reason = failureReason(e)
        log(`깃 아이디 일괄 적용 실패: ${reason}`)
        return `failed: ${reason}`
      }
    })

    // 패널(보기 전용)이 그리는 전체 그림. 실패해도 되는 조회들은 각자 오류 필드로 돌려준다.
    orca.panels.handle('persona.overview', async (): Promise<PersonaOverview> => {
      const personas = store.load()
      const groups: OverviewGroup[] = personas.map((p) => ({
        name: p.name,
        match: p.match,
        git: p.git ?? null,
        accounts: {
          ...(p.accounts.claude !== undefined ? { claude: p.accounts.claude } : {}),
          ...(p.accounts.codex !== undefined ? { codex: p.accounts.codex } : {})
        },
        hasBody: p.body.length > 0,
        workspaces: []
      }))
      const byName = new Map(groups.map((g) => [g.name, g]))
      const unmatched: OverviewWorkspace[] = []
      const remote: OverviewWorkspace[] = []
      let truncated = false
      let workspacesError: string | null = null
      try {
        const list = (await orca.host.call('workspace.list')) as Awaited<ReturnType<HostList>>
        truncated = list.truncated
        for (const ws of list.workspaces) {
          const entry: OverviewWorkspace = {
            id: ws.id,
            name: ws.name,
            branch: ws.branch,
            path: ws.path,
            kind: ws.kind,
            override: null
          }
          if (isRemoteHost(ws.hostId)) {
            remote.push(entry)
            continue
          }
          entry.override = readRepoOverride(ws.path)
          const persona = store.resolve(ws.path)
          const group = persona ? byName.get(persona.name) : undefined
          if (group) group.workspaces.push(entry)
          else unmatched.push(entry)
        }
      } catch (e) {
        workspacesError = failureReason(e)
      }
      let accounts: PersonaOverview['accounts'] = null
      let accountsError: string | null = null
      try {
        const snap = await selector.snapshot(true)
        accounts = { claude: snap.claude, codex: snap.codex }
      } catch (e) {
        accountsError = failureReason(e)
      }
      return {
        current: switcher.current,
        lastApply,
        focus: lastFocus,
        personasDir: currentDir,
        accounts,
        accountsError,
        groups,
        unmatched,
        remote,
        truncated,
        workspacesError,
        issues: store.issues
      }
    })

    // 패널 편집: 폼 → .md 저장. 파서를 되돌려 돌려(라운드트립) 검증하므로 규칙이 한 곳에만 산다.
    const validName = (name: unknown): name is string =>
      typeof name === 'string' && name.length > 0 && name.length <= 64 && !/[\\/]/.test(name) && !name.startsWith('.')
    const quoteValue = (v: string): string => {
      if (/["\n\r]/.test(v)) throw new Error('값에 따옴표나 줄바꿈은 쓸 수 없습니다.')
      return /#/.test(v) || v !== v.trim() ? `"${v}"` : v
    }
    const personaFile = (name: string) => path.join(currentDir, `${name}.md`)

    orca.panels.handle('persona.save', async (input) => {
      const draft = (input ?? {}) as PersonaDraft
      if (!validName(draft.name)) throw new Error('이름은 경로 구분자 없이 1~64자여야 하고 .으로 시작할 수 없습니다.')
      const match = Array.isArray(draft.match) ? draft.match.map((g) => String(g).trim()).filter((g) => g !== '') : []
      const lines = ['---', 'match:']
      for (const g of match) lines.push(`  - ${quoteValue(g)}`)
      const git = draft.git ?? null
      if (git !== null) {
        if (typeof git.name !== 'string' || git.name.trim() === '' || typeof git.email !== 'string' || git.email.trim() === '')
          throw new Error('git은 name과 email이 모두 필요합니다 (안 쓰려면 둘 다 비우세요).')
        lines.push('git:', `  name: ${quoteValue(git.name.trim())}`, `  email: ${quoteValue(git.email.trim())}`)
      }
      const agents = (['claude', 'codex'] as const).flatMap((a) => {
        const v = draft.accounts?.[a]
        if (v === undefined) return []
        if (typeof v !== 'string' || v.trim() === '') throw new Error(`${a} 계정 값이 비어 있습니다 (안 쓰려면 키를 빼세요).`)
        return [[a, v.trim()] as const]
      })
      if (agents.length > 0) {
        lines.push('accounts:')
        for (const [a, v] of agents) lines.push(`  ${a}: ${quoteValue(v)}`)
      }
      lines.push('---')
      const body = store.load().find((p) => p.name === draft.name)?.body ?? ''
      const text = lines.join('\n') + '\n' + (body === '' ? '' : `\n${body}\n`)
      const parsed = parsePersonaFile(draft.name, personaFile(draft.name), text)
      if (isPersonaParseError(parsed)) throw new Error(parsed.message)
      fs.mkdirSync(currentDir, { recursive: true })
      const tmp = personaFile(draft.name) + '.tmp'
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, personaFile(draft.name))
      log(`페르소나 ${draft.name} 저장`)
      orca.panels.post('persona.changed', { current: switcher.current })
      return { ok: true } as const
    })

    orca.panels.handle('persona.delete', async (input) => {
      const name = (input as { name?: unknown } | undefined)?.name
      if (!validName(name)) throw new Error('지울 페르소나 이름이 올바르지 않습니다.')
      try {
        fs.unlinkSync(personaFile(name))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`페르소나 ${name}가 없습니다.`)
        throw e
      }
      log(`페르소나 ${name} 삭제`)
      orca.panels.post('persona.changed', { current: switcher.current })
      return { ok: true } as const
    })

    // 레포 루트 .orca-persona 토글: 경로 규칙보다 우선하는 수동 지정 (설계 7.3).
    orca.panels.handle('persona.assign', async (input) => {
      const { workspaceId, persona } = (input ?? {}) as { workspaceId?: unknown; persona?: unknown }
      if (typeof workspaceId !== 'string' || workspaceId === '') throw new Error('워크스페이스 id가 없습니다.')
      if (persona !== null && !validName(persona)) throw new Error('페르소나 이름이 올바르지 않습니다.')
      const ws = await index.byId(workspaceId)
      if (!ws) throw new Error('워크스페이스를 찾지 못했습니다.')
      if (isRemoteHost(ws.hostId)) throw new Error('원격 워크스페이스에는 지정하지 않습니다.')
      if (persona !== null && !store.load().some((p) => p.name === persona))
        throw new Error(`페르소나 ${persona}가 없습니다.`)
      const marker = path.join(ws.path, '.orca-persona')
      if (persona === null) {
        try {
          fs.unlinkSync(marker)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      } else {
        fs.writeFileSync(marker, `${persona}\n`)
      }
      log(`워크스페이스 ${ws.name} 수동 지정: ${persona ?? '해제'}`)
      orca.panels.post('persona.changed', { current: switcher.current })
      return { ok: true } as const
    })

    orca.hooks.on('workspace.create.after', async (event) => {
      const persona = store.resolve(event.path)
      if (!persona?.git) return undefined
      const result = await applyGit(event.path, persona.git, log)
      log(`깃 아이디 적용 ${event.path}: ${result}`)
      return undefined
    })

    const launchDeadlineMs = deps.launchDeadlineMs ?? LAUNCH_HOOK_DEADLINE_MS
    type LaunchVerdict = 'pass' | 'continue' | { deny: string }

    const launchBody = async (agent: AgentId, workspaceId: string, deadlineAt: number): Promise<LaunchVerdict> => {
      const remaining = () => Math.max(MIN_STAGE_TIMEOUT_MS, deadlineAt - Date.now())
      let ws
      try {
        ws = await index.byId(workspaceId)
      } catch (e) {
        return { deny: failureReason(e) }
      }
      if (!ws) {
        log(`워크스페이스 ${workspaceId}를 찾지 못해 페르소나를 적용하지 않음`)
        return 'pass'
      }
      if (isRemoteHost(ws.hostId)) {
        log(`원격 워크스페이스 ${ws.name}(${ws.hostId})는 페르소나를 적용하지 않음`)
        return 'pass'
      }
      const persona = store.resolve(ws.path)
      if (!persona) return 'pass'
      try {
        const agents: AgentId[] = persona.accounts[agent] === undefined ? [] : [agent]
        const outcome = await switcher.apply(persona, agents, { fresh: true, timeoutMs: remaining() })
        recordOutcome(outcome)
        if (outcome.kind === 'failed') return { deny: outcome.reason }
      } catch (e) {
        return { deny: failureReason(e) }
      }
      await reportCurrent()
      return 'continue'
    }

    orca.hooks.on('agent.launch.before', async (event, next) => {
      const agent = event.agent
      if (!isAgent(agent) || event.workspaceId === null) return undefined
      const deadlineAt = Date.now() + launchDeadlineMs
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<LaunchVerdict>((resolve) => {
        timer = setTimeout(() => {
          log(`워크스페이스 ${event.workspaceId}의 ${agent} 실행 거부: ${LAUNCH_DEADLINE_REASON}`)
          resolve({ deny: LAUNCH_DEADLINE_REASON })
        }, launchDeadlineMs)
      })
      let verdict: LaunchVerdict
      try {
        verdict = await Promise.race([launchBody(agent, event.workspaceId, deadlineAt), deadline])
      } finally {
        clearTimeout(timer)
      }
      if (verdict === 'pass') return undefined
      if (verdict === 'continue') return next(event)
      return verdict
    })

    type FocusPayload = PluginEvents['workspace.changed']
    const applyFocus = async (payload: FocusPayload): Promise<void> => {
      const ctx = payload.context
      lastFocus = ctx ? { displayName: ctx.displayName, branch: ctx.branch } : null
      if (!ctx) return
      let name: string | null = null
      try {
        const ws = await index.byNameAndBranch(ctx.displayName, ctx.branch)
        if (!ws) {
          log(`워크스페이스 ${ctx.displayName} (${ctx.branch})를 하나로 특정하지 못해 페르소나를 적용하지 않음`)
          return
        }
        if (isRemoteHost(ws.hostId)) return
        const persona = store.resolve(ws.path)
        if (!persona) return
        name = persona.name
        const outcome = await switcher.apply(persona)
        recordOutcome(outcome)
        if (outcome.kind === 'failed') {
          log(`페르소나 ${persona.name} 적용 실패: ${outcome.reason}`)
          await setStatus(`persona: ${persona.name} ⚠`)
          return
        }
        log(`페르소나 ${persona.name} 적용`)
        await reportCurrent()
      } catch (e) {
        log(`페르소나 ${name ?? '?'} 적용 실패: ${failureReason(e)}`)
        await setStatus(`persona: ${name ?? '?'} ⚠`)
      }
    }

    // 포커스 경로 디바운스(설계 8절): 처리 중에 온 이벤트는 마지막 하나만 남겨 처리 뒤에 적용한다.
    let focusRunning = false
    let pendingFocus: FocusPayload | null = null
    orca.events.on('workspace.changed', async (payload) => {
      if (focusRunning) {
        pendingFocus = payload
        return
      }
      focusRunning = true
      try {
        let next: FocusPayload | null = payload
        while (next !== null) {
          pendingFocus = null
          await applyFocus(next)
          next = pendingFocus
        }
      } finally {
        focusRunning = false
      }
    })

    orca.events.on('workspace.created', () => index.invalidate())
    orca.events.on('workspace.removed', () => index.invalidate())
  }
}

export default createActivate({})
