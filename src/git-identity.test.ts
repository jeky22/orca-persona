import { assert, test } from 'orca/testing'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyGitIdentity, type GitRunner } from './git-identity'

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

const execFileAsync = promisify(execFile)

// Same rejection shape as production (promisified execFile); only the user.email write is intercepted.
function failingEmailRunner(repo: string, calls: string[][]): GitRunner {
  return async (args) => {
    calls.push(args)
    if (args[0] === 'user.email') throw Object.assign(new Error('boom'), { code: 255, stderr: 'cannot write' })
    return execFileAsync('git', ['-C', repo, 'config', '--local', ...args])
  }
}

function nameExit(repo: string): number {
  try {
    execFileSync('git', ['-C', repo, 'config', '--local', '--get', 'user.name'], { stdio: 'pipe' })
    return 0
  } catch (e) {
    return (e as { status: number }).status
  }
}

test('applyGitIdentity: email 쓰기가 실패하면 방금 쓴 user.name을 되돌린다', async () => {
  const dir = tmp()
  try {
    execFileSync('git', ['init', '-q', dir])
    const logs: string[] = []
    const calls: string[][] = []
    assert.equal(await applyGitIdentity(dir, id, (m) => logs.push(m), failingEmailRunner(dir, calls)), 'failed')
    assert.deepEqual(calls, [
      ['--get', 'user.email'],
      ['--get', 'user.name'],
      ['user.name', id.name],
      ['user.email', id.email],
      ['--unset', 'user.name'],
    ])
    assert.equal(nameExit(dir), 1)
    assert.equal(logs.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('applyGitIdentity: email 쓰기가 실패하면 기존 user.name 값을 복원한다', async () => {
  const dir = tmp()
  try {
    execFileSync('git', ['init', '-q', dir])
    git(dir, 'config', '--local', 'user.name', 'Old Name')
    const logs: string[] = []
    const calls: string[][] = []
    assert.equal(await applyGitIdentity(dir, id, (m) => logs.push(m), failingEmailRunner(dir, calls)), 'failed')
    assert.deepEqual(calls.slice(2), [
      ['user.name', id.name],
      ['user.email', id.email],
      ['user.name', 'Old Name'],
    ])
    assert.equal(git(dir, 'config', '--local', 'user.name'), 'Old Name')
    assert.equal(logs.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
