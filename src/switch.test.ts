import { assert, test } from 'orca/testing'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AccountSelector } from './accounts'
import { BEGIN, defaultInstructionTargets } from './instructions'
import { PersonaSwitcher } from './switch'
import type { Persona } from './types'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-'))
  const home = fs.realpathSync(root)
  const targets = defaultInstructionTargets(home)
  const calls: [string, unknown][] = []
  const call = async (method: string, params: unknown) => {
    calls.push([method, params])
    if (method === 'accounts.list') {
      return {
        claude: { accounts: [{ id: 'a1', email: 'work@x' }], activeAccountId: null },
        codex: { accounts: [{ id: 'c1', email: 'work@x' }], activeAccountId: null },
        opencode: {}
      }
    }
    return {}
  }
  const logs: string[] = []
  const sw = new PersonaSwitcher({ accounts: new AccountSelector(call), targets, log: (m) => logs.push(m) })
  return { targets, calls, logs, sw, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const persona = (name: string, accounts: Persona['accounts'], body = '규칙'): Persona => ({
  name,
  sourcePath: `/p/${name}.md`,
  match: [],
  accounts,
  body
})
const work = persona('work', { claude: 'work@x', codex: 'work@x' })
const methods = (calls: [string, unknown][]) => calls.map((c) => c[0])

test('apply: 지시문 동기화 후 두 계정 select, current 갱신', async () => {
  const t = setup()
  try {
    const out = await t.sw.apply(work)
    assert.deepEqual(out, { kind: 'applied', persona: 'work', accounts: { claude: 'selected', codex: 'selected' } })
    for (const f of [t.targets.claudeMd, t.targets.codexAgentsMd]) {
      const text = fs.readFileSync(f, 'utf8')
      assert.ok(text.includes(BEGIN('work')) && text.includes('규칙'))
    }
    assert.deepEqual(t.calls, [
      ['accounts.list', { refreshUsage: false }],
      ['accounts.selectClaude', { accountId: 'a1' }],
      ['accounts.selectCodex', { accountId: 'c1' }]
    ])
    assert.equal(t.sw.current, 'work')
  } finally {
    t.cleanup()
  }
})

test('apply: 같은 페르소나 재적용은 select 0회, mtime 불변', async () => {
  const t = setup()
  try {
    await t.sw.apply(work)
    const past = new Date('2020-01-01T00:00:00Z')
    fs.utimesSync(t.targets.claudeMd, past, past)
    fs.utimesSync(t.targets.codexAgentsMd, past, past)
    const before = t.calls.length
    const out = await t.sw.apply(work)
    assert.equal(out.kind, 'applied')
    assert.equal(t.calls.length, before)
    assert.equal(fs.statSync(t.targets.claudeMd).mtimeMs, past.getTime())
    assert.equal(fs.statSync(t.targets.codexAgentsMd).mtimeMs, past.getTime())
  } finally {
    t.cleanup()
  }
})

test('apply: claude만 있는 페르소나는 codex RPC 호출 없음', async () => {
  const t = setup()
  try {
    const out = await t.sw.apply(persona('solo', { claude: 'work@x' }))
    assert.deepEqual(out, { kind: 'applied', persona: 'solo', accounts: { claude: 'selected' } })
    assert.deepEqual(methods(t.calls), ['accounts.list', 'accounts.selectClaude'])
  } finally {
    t.cleanup()
  }
})

test('apply: 미등록 이메일은 failed, 지시문은 갱신, current 유지', async () => {
  const t = setup()
  try {
    await t.sw.apply(work)
    const out = await t.sw.apply(persona('bad', { claude: 'nobody@x' }, '새 규칙'))
    assert.equal(out.kind, 'failed')
    if (out.kind === 'failed') {
      assert.equal(out.agent, 'claude')
      assert.ok(out.reason.includes('orca account add --agent claude'))
    }
    assert.ok(fs.readFileSync(t.targets.claudeMd, 'utf8').includes(BEGIN('bad')))
    assert.ok(fs.readFileSync(t.targets.codexAgentsMd, 'utf8').includes('새 규칙'))
    assert.equal(t.sw.current, 'work')
    assert.equal(t.logs.length, 1)
  } finally {
    t.cleanup()
  }
})

test('apply: agents 지정 시 나머지는 건드리지 않음', async () => {
  const t = setup()
  try {
    const out = await t.sw.apply(work, ['claude'])
    assert.deepEqual(out, { kind: 'applied', persona: 'work', accounts: { claude: 'selected' } })
    assert.deepEqual(methods(t.calls), ['accounts.list', 'accounts.selectClaude'])
  } finally {
    t.cleanup()
  }
})

test('apply: agents가 빈 배열이면 지시문만 동기화', async () => {
  const t = setup()
  try {
    const out = await t.sw.apply(work, [])
    assert.deepEqual(out, { kind: 'applied', persona: 'work', accounts: {} })
    assert.deepEqual(t.calls, [])
    assert.ok(fs.readFileSync(t.targets.claudeMd, 'utf8').includes(BEGIN('work')))
    assert.equal(t.sw.current, 'work')
  } finally {
    t.cleanup()
  }
})

test('apply: fresh 옵션은 accounts.list를 다시 호출', async () => {
  const t = setup()
  try {
    await t.sw.apply(work, ['claude'])
    const out = await t.sw.apply(work, ['claude'], { fresh: true })
    assert.equal(out.kind, 'applied')
    assert.deepEqual(t.calls, [
      ['accounts.list', { refreshUsage: false }],
      ['accounts.selectClaude', { accountId: 'a1' }],
      ['accounts.list', { refreshUsage: false }],
      ['accounts.selectClaude', { accountId: 'a1' }]
    ])
  } finally {
    t.cleanup()
  }
})
