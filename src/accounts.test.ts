import { assert, test } from 'orca/testing'
import { AccountNeedsSignInError, AccountSelector, UnregisteredAccountError } from './accounts'

type Entry = { id: string; email: string | null; needsSignIn?: boolean }

function fake(claude: Entry[], codex: Entry[] = [], claudeActive: string | null = null, codexActive: string | null = null) {
  const calls: [string, unknown][] = []
  const call = async (method: string, params: unknown) => {
    calls.push([method, params])
    if (method === 'accounts.list') {
      return {
        claude: { accounts: claude, activeAccountId: claudeActive },
        codex: { accounts: codex, activeAccountId: codexActive },
        opencode: {}
      }
    }
    return {}
  }
  return { calls, call }
}

test('selects a matching account (case-insensitive) then reports already-active', async () => {
  const f = fake([{ id: 'a1', email: 'Work@X' }])
  const s = new AccountSelector(f.call)
  assert.equal(await s.ensureSelected('claude', 'work@x'), 'selected')
  assert.deepEqual(f.calls, [
    ['accounts.list', { refreshUsage: false }],
    ['accounts.selectClaude', { accountId: 'a1' }]
  ])
  assert.equal(await s.ensureSelected('claude', 'work@x'), 'already-active')
  assert.equal(f.calls.length, 2)
})

test('rejects an unregistered email', async () => {
  const f = fake([{ id: 'a1', email: 'work@x' }])
  const s = new AccountSelector(f.call)
  await assert.rejects(s.ensureSelected('claude', 'nobody@x'), (e: unknown) => {
    return e instanceof UnregisteredAccountError && e.agent === 'claude' && e.email === 'nobody@x'
  })
  assert.deepEqual(f.calls, [['accounts.list', { refreshUsage: false }]])
})

test('rejects needsSignIn accounts without calling select', async () => {
  const f = fake([{ id: 'a1', email: 'work@x', needsSignIn: true }])
  const s = new AccountSelector(f.call)
  await assert.rejects(s.ensureSelected('claude', 'work@x'), (e: unknown) => e instanceof AccountNeedsSignInError)
  assert.deepEqual(f.calls, [['accounts.list', { refreshUsage: false }]])
})

test('system selects null for codex when a managed account is active', async () => {
  const f = fake([], [{ id: 'c9', email: 'c@x' }], null, 'c9')
  const s = new AccountSelector(f.call)
  assert.equal(await s.ensureSelected('codex', 'system'), 'selected')
  assert.deepEqual(f.calls, [
    ['accounts.list', { refreshUsage: false }],
    ['accounts.selectCodex', { accountId: null }]
  ])
})

test('system is already-active when no managed account is active', async () => {
  const f = fake([], [{ id: 'c9', email: 'c@x' }], null, null)
  const s = new AccountSelector(f.call)
  assert.equal(await s.ensureSelected('codex', ' System '), 'already-active')
  assert.deepEqual(f.calls, [['accounts.list', { refreshUsage: false }]])
})

test('snapshot is cached within ttl and refreshed when forced', async () => {
  const f = fake([])
  const s = new AccountSelector(f.call)
  await s.snapshot()
  await s.snapshot()
  assert.equal(f.calls.filter(([m]) => m === 'accounts.list').length, 1)
  await s.snapshot(true)
  assert.equal(f.calls.filter(([m]) => m === 'accounts.list').length, 2)
})

test('snapshot parses defensively', async () => {
  const s = new AccountSelector(async () => ({ claude: { accounts: [{ id: 'a', email: null }] } }))
  assert.deepEqual(await s.snapshot(), {
    claude: { accounts: [{ id: 'a', email: null }], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null }
  })
})

test('fresh: true refreshes the snapshot and selects when active changed in the UI', async () => {
  const calls: [string, unknown][] = []
  let active = 'a1'
  const call = async (method: string, params: unknown) => {
    calls.push([method, params])
    if (method === 'accounts.list') {
      return { claude: { accounts: [{ id: 'a1', email: 'work@x' }, { id: 'a2', email: 'other@x' }], activeAccountId: active } }
    }
    return {}
  }
  const s = new AccountSelector(call)
  await s.snapshot()
  active = 'a2'
  calls.length = 0
  assert.equal(await s.ensureSelected('claude', 'work@x', { fresh: true }), 'selected')
  assert.deepEqual(calls, [
    ['accounts.list', { refreshUsage: false }],
    ['accounts.selectClaude', { accountId: 'a1' }]
  ])
})

test('without fresh the cached snapshot is used (already-active, no RPC)', async () => {
  const calls: [string, unknown][] = []
  let active = 'a1'
  const call = async (method: string, params: unknown) => {
    calls.push([method, params])
    return { claude: { accounts: [{ id: 'a1', email: 'work@x' }], activeAccountId: active } }
  }
  const s = new AccountSelector(call)
  await s.snapshot()
  active = 'a2'
  calls.length = 0
  assert.equal(await s.ensureSelected('claude', 'work@x'), 'already-active')
  assert.deepEqual(calls, [])
})

test('already-active but needsSignIn still throws without select', async () => {
  const f = fake([{ id: 'a1', email: 'work@x', needsSignIn: true }], [], 'a1')
  const s = new AccountSelector(f.call)
  await assert.rejects(s.ensureSelected('claude', 'work@x'), (e: unknown) => {
    return e instanceof AccountNeedsSignInError && e.agent === 'claude' && e.email === 'work@x'
  })
  assert.deepEqual(f.calls, [['accounts.list', { refreshUsage: false }]])
})
