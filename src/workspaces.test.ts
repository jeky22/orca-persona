import { assert, test } from 'orca/testing'
import { WorkspaceIndex, type WorkspaceEntry } from './workspaces'

const w1: WorkspaceEntry = { id: 'w1', kind: 'worktree', name: 'glab-server', path: '/Users/me/workspace/glab-server', branch: 'main', hostId: null }
const w2: WorkspaceEntry = { id: 'w2', kind: 'worktree', name: 'glab', path: '/Users/me/side/glab', branch: 'main', hostId: null }

function fake(...responses: WorkspaceEntry[][]) {
  let calls = 0
  const list = async () => {
    const workspaces = responses[Math.min(calls, responses.length - 1)]
    calls++
    return { workspaces, truncated: false }
  }
  return { list, count: () => calls }
}

test('byId returns the matching entry', async () => {
  const f = fake([w1, w2])
  const idx = new WorkspaceIndex(f.list)
  assert.equal((await idx.byId('w2'))?.path, '/Users/me/side/glab')
})

test('byId는 id가 어긋나면 repoId::path의 경로로 다시 찾는다', async () => {
  // 실행 훅은 `<repoId>::<경로>`를 주지만 workspace.list의 id는 `identity:...`다 (1.4.254에서 확인).
  const a = { ...w1, id: 'identity:wt2:local:aaa' }
  const idx = new WorkspaceIndex(fake([a, w2]).list)
  assert.equal((await idx.byId('f689::/Users/me/workspace/glab-server'))?.id, 'identity:wt2:local:aaa')
})

test('byId 경로 폴백: 같은 경로가 여럿이면 특정하지 않는다', async () => {
  const a = { ...w1, id: 'i1' }
  const b = { ...w1, id: 'i2', hostId: 'ssh-1' }
  const idx = new WorkspaceIndex(fake([a, b]).list)
  assert.equal(await idx.byId('f689::/Users/me/workspace/glab-server'), null)
})

test('byId 경로 폴백: 정확한 id가 있으면 그쪽이 이긴다', async () => {
  const decoy = { ...w2, id: 'f689::/Users/me/workspace/glab-server' }
  const idx = new WorkspaceIndex(fake([w1, decoy]).list)
  assert.equal((await idx.byId('f689::/Users/me/workspace/glab-server'))?.path, '/Users/me/side/glab')
})

test('byNameAndBranch matches name and branch exactly', async () => {
  const idx = new WorkspaceIndex(fake([w1, w2]).list)
  assert.equal((await idx.byNameAndBranch('glab', 'main'))?.id, 'w2')
  assert.equal(await idx.byNameAndBranch('glab', 'dev'), null)
})

test('byNameAndBranch returns null when ambiguous', async () => {
  const idx = new WorkspaceIndex(fake([w2, { ...w2, id: 'w9', path: '/other' }]).list)
  assert.equal(await idx.byNameAndBranch('glab', 'main'), null)
})

test('byNameAndBranch with empty branch matches folder entries by name only', async () => {
  const folder: WorkspaceEntry = { id: 'f1', kind: 'folder', name: 'docs', path: '/d', branch: null, hostId: null }
  const wt: WorkspaceEntry = { ...w2, branch: 'glab/main' }
  const idx = new WorkspaceIndex(fake([folder, wt]).list)
  assert.equal((await idx.byNameAndBranch('docs', ''))?.id, 'f1')
  assert.equal(await idx.byNameAndBranch('glab', ''), null)
  assert.equal(await idx.byNameAndBranch('docs', 'main'), null)
})

test('byId cache miss forces exactly one more list call', async () => {
  const w3: WorkspaceEntry = { ...w1, id: 'w3' }
  const f = fake([w1, w2], [w1, w2, w3])
  const idx = new WorkspaceIndex(f.list)
  assert.equal((await idx.byId('w3'))?.id, 'w3')
  assert.equal(f.count(), 2)
  assert.equal(await idx.byId('nope'), null)
  assert.equal(f.count(), 3)
})

test('byNameAndBranch miss does not refresh', async () => {
  const f = fake([w1, w2])
  const idx = new WorkspaceIndex(f.list)
  assert.equal(await idx.byNameAndBranch('zzz', 'main'), null)
  assert.equal(f.count(), 1)
})

test('caches within ttl, refreshes after ttl and after invalidate', async () => {
  let t = 1000
  const f = fake([w1, w2])
  const idx = new WorkspaceIndex(f.list, { ttlMs: 100, now: () => t })
  await idx.byId('w1')
  await idx.byId('w2')
  assert.equal(f.count(), 1)
  t += 101
  await idx.byId('w1')
  assert.equal(f.count(), 2)
  idx.invalidate()
  await idx.byId('w1')
  assert.equal(f.count(), 3)
})

test('truncated reflects the last list result', async () => {
  const idx = new WorkspaceIndex(async () => ({ workspaces: [w1], truncated: true }))
  assert.equal(idx.truncated, false)
  await idx.byId('w1')
  assert.equal(idx.truncated, true)
})

function manual() {
  const resolvers: ((workspaces: WorkspaceEntry[]) => void)[] = []
  const list = () =>
    new Promise<{ workspaces: WorkspaceEntry[]; truncated: boolean }>((resolve) => {
      resolvers.push((workspaces) => resolve({ workspaces, truncated: false }))
    })
  return { list, resolvers }
}

test('invalidate during an in-flight load discards its result', async () => {
  const m = manual()
  const idx = new WorkspaceIndex(m.list)
  const first = idx.byId('w1')
  idx.invalidate()
  m.resolvers[0]([w1])
  assert.equal((await first)?.id, 'w1')
  const second = idx.byNameAndBranch('glab-server', 'main')
  assert.equal(m.resolvers.length, 2)
  m.resolvers[1]([w1, w2])
  assert.equal((await second)?.id, 'w1')
})

test('concurrent lookups on a cold cache share one list call', async () => {
  const m = manual()
  const idx = new WorkspaceIndex(m.list)
  const a = idx.byId('w1')
  const b = idx.byId('w2')
  assert.equal(m.resolvers.length, 1)
  m.resolvers[0]([w1, w2])
  assert.equal((await a)?.id, 'w1')
  assert.equal((await b)?.id, 'w2')
  assert.equal(m.resolvers.length, 1)
})

test('an older load resolving after a newer one does not overwrite it', async () => {
  const m = manual()
  const idx = new WorkspaceIndex(m.list)
  const warm = idx.byId('w1')
  m.resolvers[0]([w1])
  await warm
  const a = idx.byId('x') // miss -> forced load (list call 2)
  const b = idx.byId('y') // miss -> forced load (list call 3)
  await new Promise((r) => setImmediate(r))
  assert.equal(m.resolvers.length, 3)
  m.resolvers[2]([w1, w2]) // newer resolves first
  m.resolvers[1]([w1]) // older resolves last
  await Promise.all([a, b])
  assert.equal((await idx.byNameAndBranch('glab', 'main'))?.id, 'w2')
  assert.equal(m.resolvers.length, 3)
})
