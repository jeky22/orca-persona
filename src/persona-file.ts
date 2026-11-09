import type { AgentId, GitIdentity, Persona } from './types'

export type PersonaParseError = { name: string; sourcePath: string; message: string }

export function isPersonaParseError(x: Persona | PersonaParseError): x is PersonaParseError {
  return 'message' in x
}

type Section = 'none' | 'match' | 'git' | 'accounts'

const AGENT_IDS: readonly AgentId[] = ['claude', 'codex']

class LineError extends Error {}

/** Strips surrounding quotes and a trailing ` # comment` (only outside quotes). */
function parseValue(raw: string): string {
  const s = raw.trim()
  const quote = s[0]
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, 1)
    if (end === -1) throw new LineError(`닫히지 않은 따옴표: ${raw}`)
    const rest = s.slice(end + 1).trim()
    if (rest !== '' && !rest.startsWith('#')) throw new LineError(`따옴표 뒤에 불필요한 내용: ${raw}`)
    return s.slice(1, end)
  }
  const comment = s.search(/\s#/)
  return (comment === -1 ? s : s.slice(0, comment)).trim()
}

export function parsePersonaFile(name: string, sourcePath: string, text: string): Persona | PersonaParseError {
  const fail = (message: string): PersonaParseError => ({ name, sourcePath, message })

  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)
  if (lines[0].trimEnd() !== '---') return fail('frontmatter가 없습니다 (첫 줄이 --- 이어야 함)')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return fail('frontmatter를 닫는 --- 줄이 없습니다')
  const body = lines.slice(end + 1).join('\n').trim()

  const match: string[] = []
  const gitFields: Partial<GitIdentity> = {}
  const accounts: Partial<Record<AgentId, string>> = {}
  let section: Section = 'none'
  let sawGit = false
  let sawMatch = false

  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const lineNo = i + 1
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    try {
      if (!/^ {2,}/.test(line)) {
        const m = /^([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(trimmed)
        if (!m) throw new LineError(`최상위 키는 "키:" 형태여야 합니다: ${trimmed}`)
        const key = m[1]
        if (key === 'match') sawMatch = true
        else if (key === 'git') sawGit = true
        else if (key !== 'accounts') throw new LineError(`알 수 없는 최상위 키: ${key}`)
        section = key
        continue
      }
      if (section === 'none') throw new LineError(`들여쓴 줄이 어느 키에도 속하지 않습니다: ${trimmed}`)
      if (section === 'match') {
        const m = /^-\s+(.*)$/.exec(trimmed)
        if (!m) throw new LineError(`match 항목은 "- <glob>" 형태여야 합니다: ${trimmed}`)
        const glob = parseValue(m[1])
        if (glob === '') throw new LineError('빈 glob')
        match.push(glob)
        continue
      }
      const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(trimmed)
      if (!m) throw new LineError(`"키: 값" 형태여야 합니다: ${trimmed}`)
      const key = m[1]
      const value = parseValue(m[2])
      if (section === 'git') {
        if (key !== 'name' && key !== 'email') throw new LineError(`git의 알 수 없는 키: ${key}`)
        gitFields[key] = value
      } else {
        if (!AGENT_IDS.includes(key as AgentId)) throw new LineError(`accounts의 알 수 없는 에이전트: ${key}`)
        if (value === '') throw new LineError(`accounts.${key}의 값이 비어 있습니다`)
        accounts[key as AgentId] = value
      }
    } catch (e) {
      if (e instanceof LineError) return fail(`${lineNo}번째 줄: ${e.message}`)
      throw e
    }
  }

  if (!sawMatch || match.length === 0) return fail('match에 glob이 1개 이상 필요합니다')
  let git: GitIdentity | undefined
  if (sawGit) {
    if (!gitFields.name || !gitFields.email) return fail('git에는 name과 email이 모두 필요합니다')
    git = { name: gitFields.name, email: gitFields.email }
  }
  const hasAccounts = Object.keys(accounts).length > 0
  if (!git && !hasAccounts) return fail('git과 accounts가 모두 없는 페르소나는 아무것도 하지 않습니다')

  const persona: Persona = { name, sourcePath, match, accounts, body }
  if (git) persona.git = git
  return persona
}
