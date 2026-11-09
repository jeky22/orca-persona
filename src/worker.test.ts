import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { defaultInstructionTargets } from './instructions'
import { RpcUnavailableError } from './orca-rpc'
import type { GitIdentity } from './types'
import { createActivate } from './worker'

const persona = (match: string, claude: string, git = true) =>
  `---\nmatch:\n  - ${match}\n${git ? 'git:\n  name: Work Me\n  email: work@example.com\n' : ''}accounts:\n  claude: ${claude}\n---\n규칙\n`

type Opts = {
  personal?: string
  seedPersonas?: boolean
  rpcError?: Error
  listError?: boolean
  extraWorkspaces?: Record<string, unknown>[]
  gitResults?: Record<string, 'applied' | 'skipped-existing' | 'skipped-not-git' | 'failed'>
  truncated?: boolean
}

async function setup(opts: Opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-'))
  const home = fs.realpathSync(root)
  const dir = path.join(home, '.orca', 'personas')
  if (opts.seedPersonas !== false) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'work.md'), persona(`${home}/workspace/**`, 'work@x'))
    fs.writeFileSync(path.join(dir, 'personal.md'), persona(`${home}/side/**`, opts.personal ?? 'me@x', false))
  }
  const rpcCalls: [string, unknown][] = []
  let active: string | null = null
  const rpc = async (method: string, params: unknown) => {
    rpcCalls.push([method, params])
    if (opts.rpcError) throw opts.rpcError
    if (method === 'accounts.list') {
      return {
        claude: { accounts: [{ id: 'a1', email: 'work@x' }, { id: 'a2', email: 'me@x' }], activeAccountId: active },
        codex: { accounts: [], activeAccountId: null }
      }
    }
    if (method === 'accounts.selectClaude') active = (params as { accountId: string }).accountId
    return {}
  }
  const gitCalls: [string, GitIdentity][] = []
  const applyGit = async (repo: string, git: GitIdentity) => {
    gitCalls.push([repo, git])
    return opts.gitResults?.[path.relative(home, repo)] ?? ('applied' as const)
  }
  const workspaces = [
    { id: 'w1', kind: 'worktree', name: 'repo', path: `${home}/workspace/repo`, branch: 'main', hostId: null },
    { id: 'w2', kind: 'worktree', name: 'x', path: `${home}/side/x`, branch: 'main', hostId: null },
    { id: 'w3', kind: 'worktree', name: 'r', path: `${home}/workspace/r`, branch: 'main', hostId: 'ssh-1' },
    ...(opts.extraWorkspaces ?? []).map((w) =>
      typeof w.path === 'string' ? { ...w, path: w.path.replace('__HOME__', home) } : w
    )
  ]
  const host = mockHost({
    results: {
      'workspace.list': opts.listError
        ? () => {
            throw hostError('boom', 'list failed')
          }
        : { workspaces, truncated: opts.truncated ?? false },
      'statusBar.update': {}
    }
  })
  const worker = await mountWorker(
    {
      default: createActivate({
        home,
        rpc,
        applyGit,
        targets: defaultInstructionTargets(home)
      })
    },
    { host }
  )
  const selects = () => rpcCalls.filter((c) => c[0] === 'accounts.selectClaude')
  const statusTexts = () => host.callsOf('statusBar.update').map((c) => (c as unknown as { text: string }).text)
  return {
    home,
    worker,
    host,
    rpcCalls,
    gitCalls,
    selects,
    statusTexts,
    cleanup: async () => {
      await worker.deactivate()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

const launch = (agent: string, workspaceId: string | null) => ({
  agent,
  workspaceId,
  workspaceKind: workspaceId === null ? null : 'worktree',
  command: agent,
  env: {}
})
const focus = (displayName: string) => ({ context: { branch: 'main', displayName, terminals: [] } })

test('깃: 매칭되는 경로에만 applyGit', async () => {
  const t = await setup()
  try {
    await t.worker.hooks.fire('workspace.create.after',
      { workspaceId: 'w1', kind: 'worktree', path: `${t.home}/workspace/repo`, branch: 'main' })
    assert.equal(t.gitCalls.length, 1)
    assert.deepEqual(t.gitCalls[0][1], { name: 'Work Me', email: 'work@example.com' })
    await t.worker.hooks.fire('workspace.create.after',
      { workspaceId: 'w9', kind: 'worktree', path: '/tmp/none', branch: 'main' })
    assert.equal(t.gitCalls.length, 1)
  } finally { await t.cleanup() }
})

test('실행, 정상: 계정 select, env 불변, 상태바', async () => {
  const t = await setup()
  try {
    const d = await t.worker.hooks.fire('agent.launch.before', launch('claude', 'w1'))
    assert.equal(d.kind, 'continue')
    if (d.kind === 'continue') assert.deepEqual(d.event.env, {})
    assert.deepEqual(t.rpcCalls, [
      ['accounts.list', { refreshUsage: false }],
      ['accounts.selectClaude', { accountId: 'a1' }]
    ])
    assert.equal(t.statusTexts().at(-1), 'persona: work')
  } finally { await t.cleanup() }
})

test('실행, 미등록: deny', async () => {
  const t = await setup({ personal: 'ghost@x' })
  try {
    const d = await t.worker.hooks.fire('agent.launch.before', launch('claude', 'w2'))
    assert.equal(d.kind, 'deny')
    if (d.kind === 'deny') assert.ok(d.reason.includes('orca account add --agent claude'))
  } finally { await t.cleanup() }
})

test('실행, 원격: 통과', async () => {
  const t = await setup()
  try {
    const d = await t.worker.hooks.fire('agent.launch.before', launch('claude', 'w3'))
    assert.equal(d.kind, 'continue')
    assert.equal(t.selects().length, 0)
  } finally { await t.cleanup() }
})

test('실행, 플로팅: 통과', async () => {
  const t = await setup()
  try {
    const d = await t.worker.hooks.fire('agent.launch.before', launch('claude', null))
    assert.equal(d.kind, 'continue')
    assert.equal(t.rpcCalls.length, 0)
  } finally { await t.cleanup() }
})

test('실행, 다른 에이전트: 통과', async () => {
  const t = await setup()
  try {
    const d = await t.worker.hooks.fire('agent.launch.before', launch('gemini', 'w1'))
    assert.equal(d.kind, 'continue')
    assert.equal(t.rpcCalls.length, 0)
  } finally { await t.cleanup() }
})

test('실행, 해당 에이전트 계정 없음: 지시문만 적용하고 통과', async () => {
  const t = await setup()
  try {
    const d = await t.worker.hooks.fire('agent.launch.before', launch('codex', 'w1'))
    assert.equal(d.kind, 'continue')
    assert.equal(t.selects().length, 0)
    assert.ok(fs.readFileSync(defaultInstructionTargets(t.home).claudeMd, 'utf8').includes('규칙'))
  } finally { await t.cleanup() }
})

test('포커스: 워크스페이스 이동마다 계정 전환', async () => {
  const t = await setup()
  try {
    await t.worker.emit('workspace.changed', focus('repo'))
    await t.worker.emit('workspace.changed', focus('x'))
    await t.worker.emit('workspace.changed', focus('repo'))
    assert.deepEqual(t.selects().map((c) => c[1]),
      [{ accountId: 'a1' }, { accountId: 'a2' }, { accountId: 'a1' }])
    assert.deepEqual(t.statusTexts(), ['persona: work', 'persona: personal', 'persona: work'])
  } finally { await t.cleanup() }
})

test('포커스, 중복 이름: 무시하고 log', async () => {
  const t = await setup({
    extraWorkspaces: [{ id: 'w4', kind: 'worktree', name: 'repo', path: '/elsewhere/repo', branch: 'main', hostId: null }]
  })
  try {
    await t.worker.emit('workspace.changed', focus('repo'))
    assert.equal(t.rpcCalls.length, 0)
    assert.ok(t.worker.logs.some((l) => l.includes('워크스페이스 repo (main)를 하나로 특정하지 못해')))
  } finally { await t.cleanup() }
})

test('포커스, 동일 페르소나 재진입: select 1회, 상태바 1회', async () => {
  const t = await setup()
  try {
    await t.worker.emit('workspace.changed', focus('repo'))
    await t.worker.emit('workspace.changed', focus('repo'))
    assert.equal(t.selects().length, 1)
    assert.equal(t.statusTexts().length, 1)
  } finally { await t.cleanup() }
})

test('RPC 불가: launch deny', async () => {
  const t = await setup({ rpcError: new RpcUnavailableError('no runtime') })
  try {
    const d = await t.worker.hooks.fire('agent.launch.before', launch('claude', 'w1'))
    assert.equal(d.kind, 'deny')
    if (d.kind === 'deny') assert.ok(d.reason.includes('orca account select'))
  } finally { await t.cleanup() }
})

test('페르소나 없음: 모두 통과, RPC 0회', async () => {
  const t = await setup({ seedPersonas: false })
  try {
    const d = await t.worker.hooks.fire('agent.launch.before', launch('claude', 'w1'))
    assert.equal(d.kind, 'continue')
    await t.worker.emit('workspace.changed', focus('repo'))
    assert.equal(t.rpcCalls.length, 0)
    assert.equal(await t.worker.command('persona.status'), 'persona: —')
  } finally { await t.cleanup() }
})

test('실행: fresh로 캐시된 스냅샷 뒤에도 accounts.list를 다시 호출', async () => {
  const t = await setup()
  try {
    await t.worker.emit('workspace.changed', focus('repo'))
    const before = t.rpcCalls.filter((c) => c[0] === 'accounts.list').length
    assert.equal(before, 1)
    const d = await t.worker.hooks.fire('agent.launch.before', launch('claude', 'w1'))
    assert.equal(d.kind, 'continue')
    assert.equal(t.rpcCalls.filter((c) => c[0] === 'accounts.list').length, 2)
  } finally { await t.cleanup() }
})

test('포커스: 캐시 창 안에서는 accounts.list를 다시 부르지 않음', async () => {
  const t = await setup()
  try {
    await t.worker.emit('workspace.changed', focus('repo'))
    await t.worker.emit('workspace.changed', focus('x'))
    assert.equal(t.rpcCalls.filter((c) => c[0] === 'accounts.list').length, 1)
    assert.equal(t.selects().length, 2)
  } finally { await t.cleanup() }
})

test('포커스, 원격 워크스페이스: 무시', async () => {
  const t = await setup()
  try {
    await t.worker.emit('workspace.changed', focus('r'))
    assert.equal(t.rpcCalls.length, 0)
  } finally { await t.cleanup() }
})

test('workspace.list 실패: launch는 deny, 포커스는 log와 경고 상태바', async () => {
  const t = await setup({ listError: true })
  try {
    const d = await t.worker.hooks.fire('agent.launch.before', launch('claude', 'w1'))
    assert.equal(d.kind, 'deny')
    await t.worker.emit('workspace.changed', focus('repo'))
    assert.ok(t.worker.logs.some((l) => l.includes('페르소나 ? 적용 실패')))
    assert.equal(t.statusTexts().at(-1), 'persona: ? ⚠')
    assert.equal(t.rpcCalls.length, 0)
  } finally { await t.cleanup() }
})

test('일괄 적용: applied/skipped/no persona/remote 집계, 대상 아닌 항목은 건드리지 않음', async () => {
  const t = await setup({
    extraWorkspaces: [
      { id: 'w4', kind: 'worktree', name: 'repo4', path: '__HOME__/workspace/repo4', branch: 'main', hostId: null }
    ],
    gitResults: { 'workspace/repo4': 'skipped-existing' }
  })
  try {
    const r = await t.worker.command('persona.applyGit')
    assert.equal(r, 'applied 1, skipped 1, no persona 1, remote 1')
    assert.deepEqual(t.gitCalls.map((c) => c[0]).sort(),
      [`${t.home}/workspace/repo`, `${t.home}/workspace/repo4`])
  } finally { await t.cleanup() }
})

test('일괄 적용, truncated: 결과에 (truncated) 덧붙임', async () => {
  const t = await setup({ truncated: true })
  try {
    assert.equal(await t.worker.command('persona.applyGit'), 'applied 1, skipped 0, no persona 1, remote 1 (truncated)')
  } finally { await t.cleanup() }
})
