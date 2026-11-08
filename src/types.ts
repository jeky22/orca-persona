export type AgentId = 'claude' | 'codex'
export type GitIdentity = { name: string; email: string }
export type Persona = {
  name: string // 파일명에서 .md를 뗀 것
  sourcePath: string
  match: string[] // glob, 원문 그대로
  git?: GitIdentity
  accounts: Partial<Record<AgentId, string>> // 이메일 또는 'system'
  body: string // frontmatter 뒤 본문, trim
}
