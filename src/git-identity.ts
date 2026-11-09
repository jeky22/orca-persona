import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitIdentity } from './types'

export type GitApplyResult = 'applied' | 'skipped-existing' | 'skipped-not-git' | 'failed'

const run = promisify(execFile)
const TIMEOUT_MS = 1500

type GitFailure = { code?: number | string; stderr?: string; message?: string }

// Runs `git -C <repo> config --local <args>`; the seam lets tests inject failures.
export type GitRunner = (args: string[]) => Promise<{ stdout: string }>

function realRunner(repoPath: string): GitRunner {
  return (args) => run('git', ['-C', repoPath, 'config', '--local', ...args], { timeout: TIMEOUT_MS })
}

// Never overwrite an existing user.email: a wrong commit identity is worse than none.
export async function applyGitIdentity(
  repoPath: string,
  identity: GitIdentity,
  log: (m: string) => void,
  runner?: GitRunner,
): Promise<GitApplyResult> {
  const git = runner ?? realRunner(repoPath)
  try {
    await git(['--get', 'user.email'])
    return 'skipped-existing'
  } catch (e) {
    const err = e as GitFailure
    if (err.code === 128) return 'skipped-not-git'
    if (err.code !== 1) return fail(log, repoPath, err)
  }
  let previousName: string | undefined
  try {
    previousName = (await git(['--get', 'user.name'])).stdout.replace(/\r?\n$/, '')
  } catch (e) {
    if ((e as GitFailure).code !== 1) return fail(log, repoPath, e as GitFailure)
  }
  let nameWritten = false
  try {
    nameWritten = true
    await git(['user.name', identity.name])
    await git(['user.email', identity.email])
    return 'applied'
  } catch (e) {
    if (nameWritten) {
      // Roll back so we never leave a mixed identity (our name + global email).
      try {
        await (previousName === undefined
          ? git(['--unset', 'user.name'])
          : git(['user.name', previousName]))
      } catch {
        // best effort
      }
    }
    return fail(log, repoPath, e as GitFailure)
  }
}

function fail(log: (m: string) => void, repoPath: string, err: GitFailure): GitApplyResult {
  const detail = (err.stderr || err.message || String(err.code)).trim()
  log(`깃 아이디 설정 실패 (${repoPath}): ${detail}`)
  return 'failed'
}
