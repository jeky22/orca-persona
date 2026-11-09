import { assert, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyGitIdentity } from './git-identity'

const id = { name: 'Work Me', email: 'work@example.com' }

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-identity-')))
}

test('applyGitIdentity: 비어 있는 저장소에는 로컬 config에 쓴다', async () => {
  const dir = tmp()
  try {
    execFileSync('git', ['init', '-q', dir])
    const logs: string[] = []
    assert.equal(await applyGitIdentity(dir, id, (m) => logs.push(m)), 'applied')
    assert.equal(git(dir, 'config', '--local', 'user.email'), id.email)
    assert.equal(git(dir, 'config', '--local', 'user.name'), id.name)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('applyGitIdentity: 이미 user.email이 있으면 건드리지 않는다', async () => {
  const dir = tmp()
  try {
    execFileSync('git', ['init', '-q', dir])
    git(dir, 'config', '--local', 'user.email', 'other@x')
    assert.equal(await applyGitIdentity(dir, id, () => {}), 'skipped-existing')
    assert.equal(git(dir, 'config', '--local', 'user.email'), 'other@x')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('applyGitIdentity: 깃 저장소가 아니면 건너뛴다', async () => {
  const dir = tmp()
  try {
    assert.equal(await applyGitIdentity(dir, id, () => {}), 'skipped-not-git')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('applyGitIdentity: 링크드 워크트리에 쓰면 메인 저장소에서도 읽힌다', async () => {
  const main = tmp()
  const wt = path.join(tmp(), 'wt')
  try {
    execFileSync('git', ['init', '-q', main])
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt')
    assert.equal(await applyGitIdentity(wt, id, () => {}), 'applied')
    assert.equal(git(wt, 'config', '--local', 'user.email'), id.email)
    assert.equal(git(main, 'config', '--local', 'user.email'), id.email)
  } finally {
    fs.rmSync(main, { recursive: true, force: true })
    fs.rmSync(path.dirname(wt), { recursive: true, force: true })
  }
})
