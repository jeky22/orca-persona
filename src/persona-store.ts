import * as fs from 'node:fs'
import * as path from 'node:path'
import { expandHome, globMatches } from './glob'
import { isPersonaParseError, parsePersonaFile } from './persona-file'
import type { Persona } from './types'

export type PersonaStoreOptions = { dir: string; home: string; log: (m: string) => void }

type Pick = { kind: 'none' } | { kind: 'one'; persona: Persona } | { kind: 'tie'; a: Persona; b: Persona }

function pick(personas: Persona[], p: string, home: string): Pick {
  let bestLen = -1
  let best: Persona[] = []
  for (const persona of personas) {
    for (const pattern of persona.match) {
      if (!globMatches(pattern, p, home)) continue
      const len = expandHome(pattern, home).length
      if (len > bestLen) {
        bestLen = len
        best = [persona]
      } else if (len === bestLen && !best.includes(persona)) {
        best.push(persona)
      }
    }
  }
  if (best.length === 0) return { kind: 'none' }
  if (best.length === 1) return { kind: 'one', persona: best[0] }
  return { kind: 'tie', a: best[0], b: best[1] }
}

/** 매칭되는 패턴 중 가장 긴 것을 가진 페르소나. 없거나 동률이면 null. */
export function pickByLongestMatch(personas: Persona[], p: string, home: string): Persona | null {
  const r = pick(personas, p, home)
  return r.kind === 'one' ? r.persona : null
}

/** <ws>/.orca-persona 첫 줄(trim). 없거나 비어 있으면 null. */
export function readRepoOverride(workspacePath: string): string | null {
  try {
    const first = fs.readFileSync(path.join(workspacePath, '.orca-persona'), 'utf8').split(/\r?\n/)[0].trim()
    return first === '' ? null : first
  } catch {
    return null
  }
}

export class PersonaStore {
  private cacheKey: string | null = null
  private cached: Persona[] = []

  constructor(private readonly opts: PersonaStoreOptions) {}

  load(): Persona[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.opts.dir).filter((n) => n.endsWith('.md')).sort()
    } catch {
      this.cacheKey = null
      this.cached = []
      return this.cached
    }
    const stamped: { file: string; full: string; mtime: number }[] = []
    for (const file of names) {
      const full = path.join(this.opts.dir, file)
      try {
        stamped.push({ file, full, mtime: fs.statSync(full).mtimeMs })
      } catch {
        // 읽는 사이 사라진 파일은 건너뛴다
      }
    }
    const key = stamped.map((s) => `${s.file}:${s.mtime}`).join('|')
    if (key === this.cacheKey) return this.cached

    const personas: Persona[] = []
    for (const s of stamped) {
      try {
        const result = parsePersonaFile(s.file.slice(0, -'.md'.length), s.full, fs.readFileSync(s.full, 'utf8'))
        if (isPersonaParseError(result)) this.opts.log(`페르소나 파일 ${s.file} 파싱 실패: ${result.message}`)
        else personas.push(result)
      } catch (e) {
        this.opts.log(`페르소나 파일 ${s.file} 읽기 실패: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    personas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    this.cacheKey = key
    this.cached = personas
    return personas
  }

  resolve(workspacePath: string): Persona | null {
    const personas = this.load()
    const override = readRepoOverride(workspacePath)
    if (override) {
      const hit = personas.find((p) => p.name === override)
      if (hit) return hit
    }
    const candidates = [workspacePath]
    try {
      const real = fs.realpathSync(workspacePath)
      if (real !== workspacePath) candidates.push(real)
    } catch {
      // 존재하지 않는 경로는 realpath 판정을 생략
    }
    for (const c of candidates) {
      const r = pick(personas, c, this.opts.home)
      if (r.kind === 'one') return r.persona
      if (r.kind === 'tie') {
        this.opts.log(`페르소나 ${r.a.name}와 ${r.b.name}의 패턴이 동률이라 ${c}에 적용할 페르소나를 정할 수 없음`)
        return null
      }
    }
    return null
  }
}
