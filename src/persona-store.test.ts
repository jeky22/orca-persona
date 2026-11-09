import { assert, test } from 'orca/testing'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PersonaStore, pickByLongestMatch, readRepoOverride } from './persona-store'

function persona(match: string[], extra = ''): string {
  return `---\nmatch:\n${match.map((m) => `  - ${m}`).join('\n')}\ngit:\n  name: X\n  email: x@example.com\n${extra}---\nbody\n`
}

function setup(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-store-'))
  const home = fs.realpathSync(root)
  const dir = path.join(home, 'personas')
  fs.mkdirSync(dir)
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  const logs: string[] = []
  const store = new PersonaStore({ dir, home, log: (m) => logs.push(m) })
  return { home, dir, logs, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const base = {
  'work.md': persona(['~/workspace/**']),
  'personal.md': persona(['~/side/**']),
  'broken.md': 'no frontmatter here\n',
}

test('load: 이름 정렬, 파싱 실패는 log에 남기고 건너뜀', () => {
  const t = setup(base)
  try {
    assert.deepEqual(t.store.load().map((p) => p.name), ['personal', 'work'])
    assert.ok(t.logs.some((l) => l.includes('broken.md')))
  } finally { t.cleanup() }
})

test('resolve: 경로 매칭과 불일치 null', () => {
  const t = setup(base)
  try {
    assert.equal(t.store.resolve(path.join(t.home, 'workspace/glab-server'))?.name, 'work')
    assert.equal(t.store.resolve(path.join(t.home, 'side/orca-persona'))?.name, 'personal')
    assert.equal(t.store.resolve('/tmp/elsewhere'), null)
  } finally { t.cleanup() }
})

test('resolve: 가장 긴 패턴이 이긴다', () => {
  const t = setup({ 'work.md': persona(['~/workspace/**']), 'third.md': persona(['~/workspace/glab/**']) })
  try {
    assert.equal(t.store.resolve(path.join(t.home, 'workspace/glab/x'))?.name, 'third')
  } finally { t.cleanup() }
})

test('resolve: 같은 패턴 동률이면 null + log에 두 이름', () => {
  const t = setup({ 'tie-one.md': persona(['~/workspace/**']), 'tie-two.md': persona(['~/workspace/**']) })
  try {
    assert.equal(t.store.resolve(path.join(t.home, 'workspace/x')), null)
    assert.ok(t.logs.some((l) => l.includes('tie-one') && l.includes('tie-two')))
  } finally { t.cleanup() }
})

test('resolve: .orca-persona 오버라이드가 우선', () => {
  const t = setup(base)
  try {
    const ws = path.join(t.home, 'workspace/proj')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, '.orca-persona'), 'personal\n')
    assert.equal(readRepoOverride(ws), 'personal')
    assert.equal(t.store.resolve(ws)?.name, 'personal')
    assert.equal(readRepoOverride(path.join(t.home, 'nope')), null)
  } finally { t.cleanup() }
})

test('resolve: 없는 페르소나를 가리키는 .orca-persona는 log 후 경로 규칙 사용', () => {
  const t = setup(base)
  try {
    const ws = path.join(t.home, 'workspace/proj')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, '.orca-persona'), 'ghost\n')
    assert.equal(t.store.resolve(ws)?.name, 'work')
    assert.ok(t.logs.some((l) => l.includes('ghost')))
  } finally { t.cleanup() }
})

test('resolve: 심볼릭 링크는 realpath로 판정', () => {
  const t = setup(base)
  try {
    const target = path.join(t.home, 'workspace/repo')
    fs.mkdirSync(target, { recursive: true })
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-link-'))
    try {
      const link = path.join(linkDir, 'link')
      fs.symlinkSync(target, link)
      assert.equal(t.store.resolve(link)?.name, 'work')
    } finally { fs.rmSync(linkDir, { recursive: true, force: true }) }
  } finally { t.cleanup() }
})

test('load: 변경 없으면 같은 배열(캐시), 변경되면 다시 읽음', () => {
  const t = setup(base)
  try {
    const a = t.store.load()
    assert.equal(t.store.load(), a)
    const f = path.join(t.dir, 'work.md')
    fs.writeFileSync(f, persona(['~/other/**']))
    const future = new Date(Date.now() + 10_000)
    fs.utimesSync(f, future, future)
    const b = t.store.load()
    assert.notEqual(b, a)
    assert.deepEqual(b.find((p) => p.name === 'work')?.match, ['~/other/**'])
  } finally { t.cleanup() }
})

test('load: dir이 없으면 []', () => {
  const store = new PersonaStore({ dir: '/nonexistent-persona-dir-xyz', home: '/h', log: () => {} })
  assert.deepEqual(store.load(), [])
  assert.equal(pickByLongestMatch([], '/a', '/h'), null)
})

test('issues: 파싱 실패가 파일명과 함께 남고, 캐시 히트에도 유지되고, 고치면 사라진다', () => {
  const t = setup(base)
  try {
    t.store.load()
    assert.deepEqual(t.store.issues.map((i) => i.file), ['broken.md'])
    assert.ok(t.store.issues[0].message.length > 0)
    t.store.load() // 캐시 히트
    assert.deepEqual(t.store.issues.map((i) => i.file), ['broken.md'])
    const f = path.join(t.dir, 'broken.md')
    fs.writeFileSync(f, persona(['~/fixed/**']))
    const future = new Date(Date.now() + 10_000)
    fs.utimesSync(f, future, future)
    t.store.load()
    assert.deepEqual(t.store.issues, [])
  } finally { t.cleanup() }
})

test('issues: dir이 없으면 []', () => {
  const store = new PersonaStore({ dir: '/nonexistent-persona-dir-xyz', home: '/h', log: () => {} })
  store.load()
  assert.deepEqual(store.issues, [])
})
