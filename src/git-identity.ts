import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitIdentity } from './types'

export type GitApplyResult = 'applied' | 'skipped-existing' | 'skipped-not-git' | 'failed'

const run = promisify(execFile)
const TIMEOUT_MS = 1500

type GitFailure = { code?: number | string; stderr?: string; message?: string }

function git(repoPath: string, args: string[]) {
  return run('git', ['-C', repoPath, 'config', '--local', ...args], { timeout: TIMEOUT_MS })
}

// Never overwrite an existing user.email: a wrong commit identity is worse than none.
export async function applyGitIdentity(
  repoPath: string,
  identity: GitIdentity,
  log: (m: string) => void,
): Promise<GitApplyResult> {
  try {
    await git(repoPath, ['--get', 'user.email'])
    return 'skipped-existing'
  } catch (e) {
    const err = e as GitFailure
    if (err.code === 128) return 'skipped-not-git'
    if (err.code !== 1) return fail(log, repoPath, err)
  }
  try {
    await git(repoPath, ['user.name', identity.name])
    await git(repoPath, ['user.email', identity.email])
    return 'applied'
  } catch (e) {
    return fail(log, repoPath, e as GitFailure)
  }
}

function fail(log: (m: string) => void, repoPath: string, err: GitFailure): GitApplyResult {
  const detail = (err.stderr || err.message || String(err.code)).trim()
  log(`깃 아이디 설정 실패 (${repoPath}): ${detail}`)
  return 'failed'
}
