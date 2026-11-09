import * as fs from 'node:fs'
import * as path from 'node:path'

export const BEGIN = (name: string) => `<!-- orca-persona:begin ${name} -->`
export const END = '<!-- orca-persona:end -->'

const BEGIN_PREFIX = '<!-- orca-persona:begin'

/** 첫 begin 줄부터 그 뒤 첫 end 줄(개행 포함)까지의 [start, end) 오프셋. end 없는 begin은 null. */
function findSection(content: string, log?: (m: string) => void): { start: number; end: number } | null {
  let pos = 0
  let start = -1
  while (pos < content.length) {
    const nl = content.indexOf('\n', pos)
    const next = nl === -1 ? content.length : nl + 1
    let line = content.slice(pos, nl === -1 ? content.length : nl)
    if (line.endsWith('\r')) line = line.slice(0, -1) // CRLF 파일
    if (line.startsWith(BEGIN_PREFIX)) {
      // 짝 없는 begin 뒤에 또 begin이 나오면 앞의 것은 그냥 사용자 텍스트로 두고 여기서 다시 시작한다.
      start = pos
    } else if (start !== -1 && line === END) {
      return { start, end: next }
    }
    pos = next
  }
  if (start !== -1) log?.('orca-persona 시작 마커에 짝이 되는 끝 마커가 없어 구간을 무시하고 끝에 덧붙입니다')
  return null
}

/**
 * content가 null이면 파일 없음. body가 ''이면 구간을 제거한다.
 * 결과가 ''이면 null("쓸 것 없음"). 마커 바깥 텍스트는 바이트 단위로 보존한다.
 */
export function replaceMarkedSection(
  content: string | null,
  name: string,
  body: string,
  log?: (m: string) => void,
): string | null {
  // 파일이 CRLF를 쓰면 블록도 CRLF로 써서 일관성을 유지한다.
  const found = content === null ? null : findSection(content, log)
  // 기존 구간이 있으면 그 구간의 줄바꿈을, 없으면 파일 전체의 줄바꿈을 따른다.
  const probe = content === null ? '' : found ? content.slice(found.start, found.end) : content
  const eol = probe.includes('\r\n') ? '\r\n' : '\n'
  const block = [BEGIN(name), ...body.split(/\r?\n/), END].join(eol) + eol
  let result: string
  if (content !== null && found) {
    let before = content.slice(0, found.start)
    const after = content.slice(found.end)
    if (body === '') {
      if (before.endsWith(eol + eol)) before = before.slice(0, -eol.length)
      result = before + after
    } else {
      result = before + block + after
    }
  } else if (body === '') {
    result = content ?? ''
  } else if (content === null || content === '') {
    result = block
  } else {
    const gap = !content.endsWith('\n') ? eol + eol : content.endsWith(eol + eol) ? '' : eol
    result = content + gap + block
  }
  return result === '' ? null : result
}

export type InstructionTargets = { claudeMd: string; codexAgentsMd: string }

export function defaultInstructionTargets(home: string): InstructionTargets {
  return {
    claudeMd: path.join(home, '.claude', 'CLAUDE.md'),
    codexAgentsMd: path.join(home, '.codex', 'AGENTS.md'),
  }
}

function syncOne(target: string, name: string, body: string, log: (m: string) => void): void {
  // 심볼릭 링크(dotfiles)면 링크 자체를 바꾸지 않고 가리키는 실제 파일에 쓴다.
  let resolved = target
  let current: string | null = null
  try {
    resolved = fs.realpathSync(target)
    current = fs.readFileSync(resolved, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    // 끊어진 심볼릭 링크: 링크는 그대로 두고 링크가 가리키는 경로에 새로 만든다.
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      resolved = path.resolve(path.dirname(target), fs.readlinkSync(target))
    }
  }
  const next = replaceMarkedSection(current, name, body, log)
  // null이면 파일이 없을 때는 만들 것이 없고, 파일이 있으면 구간 제거로 비게 된 것이므로 빈 내용을 쓴다.
  const text = next ?? (current === null ? null : '')
  if (text === null || text === current) return
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const tmp = `${resolved}.orca-persona.tmp`
  try {
    fs.writeFileSync(tmp, text)
    try { fs.chmodSync(tmp, fs.statSync(resolved).mode & 0o7777) } catch { /* 새 파일 */ }
    fs.renameSync(tmp, resolved)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 무시 */ }
    throw e
  }
}

/** 두 파일 모두 갱신. 내용이 바뀌지 않으면 쓰지 않는다. 심볼릭 링크면 대상에 쓴다. 임시 파일 → rename. */
export async function syncInstructionFiles(
  targets: InstructionTargets,
  name: string,
  body: string,
  log: (m: string) => void,
): Promise<void> {
  syncOne(targets.claudeMd, name, body, log)
  syncOne(targets.codexAgentsMd, name, body, log)
}
