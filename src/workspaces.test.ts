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
