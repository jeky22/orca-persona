import { assert, test } from 'orca/testing'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BEGIN, END, defaultInstructionTargets, replaceMarkedSection, syncInstructionFiles } from './instructions'

const sec = (name: string, body: string) => `${BEGIN(name)}\n${body}\n${END}\n`

function tmpHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instructions-'))
  const home = fs.realpathSync(root)
  return { home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('replaceMarkedSection: 파일이 없으면 구간만', () => {
  assert.equal(replaceMarkedSection(null, 'work', '규칙'), sec('work', '규칙'))
})

test('replaceMarkedSection: 구간이 없으면 끝에 빈 줄 하나 띄우고 붙인다', () => {
  assert.equal(replaceMarkedSection('# 내 메모\n', 'work', '규칙'), `# 내 메모\n\n${sec('work', '규칙')}`)
})

test('replaceMarkedSection: 기존 구간을 제자리에서 교체하고 앞뒤는 그대로', () => {
  const before = '# 앞 텍스트\r\n  들여쓰기\t\n\n'
  const after = '\n뒤 텍스트 (개행 없음)'
  const out = replaceMarkedSection(before + sec('personal', '옛 규칙\n여러 줄') + after, 'work', '규칙')
  assert.equal(out, before + sec('work', '규칙') + after)
})

test('replaceMarkedSection: body가 빈 문자열이면 구간과 앞 빈 줄 하나를 제거', () => {
  assert.equal(replaceMarkedSection('앞\n\n' + sec('work', '규칙') + '뒤\n', 'work', ''), '앞\n뒤\n')
  assert.equal(replaceMarkedSection('앞\n' + sec('work', '규칙'), 'work', ''), '앞\n')
  assert.equal(replaceMarkedSection(sec('work', '규칙'), 'work', ''), null)
  assert.equal(replaceMarkedSection(null, 'work', ''), null)
})

test('replaceMarkedSection: 끝에 개행 없는 파일', () => {
  assert.equal(replaceMarkedSection('abc', 'work', '규칙'), `abc\n\n${sec('work', '규칙')}`)
})

test('replaceMarkedSection: end 없는 begin은 구간으로 보지 않고 아무것도 지우지 않는다', () => {
  const logs: string[] = []
  const src = `앞\n${BEGIN('x')}\n사용자가 쓴 것\n`
  assert.equal(replaceMarkedSection(src, 'work', '규칙', (m) => logs.push(m)), `${src}\n${sec('work', '규칙')}`)
  assert.ok(logs.length === 1)
})

test('defaultInstructionTargets', () => {
  assert.deepEqual(defaultInstructionTargets('/h'), {
    claudeMd: path.join('/h', '.claude', 'CLAUDE.md'),
    codexAgentsMd: path.join('/h', '.codex', 'AGENTS.md'),
  })
})

test('syncInstructionFiles: 심볼릭 링크는 링크로 남고 대상 파일에 쓴다', async () => {
  const t = tmpHome()
  try {
    const targets = defaultInstructionTargets(t.home)
    fs.mkdirSync(path.dirname(targets.claudeMd), { recursive: true })
    const real = path.join(t.home, 'real.md')
    fs.writeFileSync(real, '# dotfiles\n')
    fs.symlinkSync(real, targets.claudeMd)
    await syncInstructionFiles(targets, 'work', '규칙', () => {})
    assert.ok(fs.lstatSync(targets.claudeMd).isSymbolicLink())
    assert.equal(fs.readFileSync(real, 'utf8'), `# dotfiles\n\n${sec('work', '규칙')}`)
    assert.equal(fs.readFileSync(targets.codexAgentsMd, 'utf8'), sec('work', '규칙'))
    assert.deepEqual(fs.readdirSync(t.home).filter((f) => f.endsWith('.tmp')), [])
  } finally { t.cleanup() }
})

test('syncInstructionFiles: 같은 내용이면 두 번째는 쓰지 않는다', async () => {
  const t = tmpHome()
  try {
    const targets = defaultInstructionTargets(t.home)
    await syncInstructionFiles(targets, 'work', '규칙', () => {})
    const past = new Date('2020-01-01T00:00:00Z')
    fs.utimesSync(targets.claudeMd, past, past)
    fs.utimesSync(targets.codexAgentsMd, past, past)
    await syncInstructionFiles(targets, 'work', '규칙', () => {})
    assert.equal(fs.statSync(targets.claudeMd).mtimeMs, past.getTime())
    assert.equal(fs.statSync(targets.codexAgentsMd).mtimeMs, past.getTime())
  } finally { t.cleanup() }
})

test('syncInstructionFiles: 부모 디렉터리가 없으면 만든다', async () => {
  const t = tmpHome()
  try {
    const targets = defaultInstructionTargets(t.home)
    assert.ok(!fs.existsSync(path.dirname(targets.codexAgentsMd)))
    await syncInstructionFiles(targets, 'work', '규칙', () => {})
    assert.equal(fs.readFileSync(targets.codexAgentsMd, 'utf8'), sec('work', '규칙'))
  } finally { t.cleanup() }
})

test('syncInstructionFiles: 구간 제거로 빈 파일이 되면 빈 파일로 쓴다', async () => {
  const t = tmpHome()
  try {
    const targets = defaultInstructionTargets(t.home)
    await syncInstructionFiles(targets, 'work', '규칙', () => {})
    await syncInstructionFiles(targets, 'work', '', () => {})
    assert.equal(fs.readFileSync(targets.claudeMd, 'utf8'), '')
    // 파일이 원래 없으면 body가 비어도 만들지 않는다
    const t2 = tmpHome()
    try {
      const tg = defaultInstructionTargets(t2.home)
      await syncInstructionFiles(tg, 'work', '', () => {})
      assert.ok(!fs.existsSync(tg.claudeMd))
    } finally { t2.cleanup() }
  } finally { t.cleanup() }
})

test('replaceMarkedSection: 짝 없는 begin이 있어도 두 번 호출해 사용자 텍스트를 지우지 않는다', () => {
  const user = `앞\n${BEGIN('x')}\n사용자가 쓴 것\n`
  const once = replaceMarkedSection(user, 'work', '규칙')!
  assert.equal(once, `${user}\n${sec('work', '규칙')}`)
  assert.equal(replaceMarkedSection(once, 'work', '규칙'), once)
  assert.equal(replaceMarkedSection(once, 'work', '새 규칙'), `${user}\n${sec('work', '새 규칙')}`)
})

test('replaceMarkedSection: CRLF 파일은 제자리 교체되고 중복되지 않으며 제거도 된다', () => {
  const crlf = (b: string) => `${BEGIN('personal')}\r\n${b}\r\n${END}\r\n`
  const src = '앞\r\n\r\n' + crlf('옛') + '뒤\r\n'
  const out = replaceMarkedSection(src, 'work', '규칙')!
  assert.equal(out, `앞\r\n\r\n${BEGIN('work')}\r\n규칙\r\n${END}\r\n뒤\r\n`)
  assert.equal(replaceMarkedSection(out, 'work', '규칙'), out)
  assert.equal(replaceMarkedSection(out, 'work', ''), '앞\r\n뒤\r\n')
})

test('syncInstructionFiles: 끊어진 심볼릭 링크도 링크로 남고 대상에 쓴다', async () => {
  const t = tmpHome()
  try {
    const targets = defaultInstructionTargets(t.home)
    fs.mkdirSync(path.dirname(targets.claudeMd), { recursive: true })
    const real = path.join(t.home, 'dotfiles', 'sub', 'real.md')
    fs.symlinkSync(real, targets.claudeMd)
    await syncInstructionFiles(targets, 'work', '규칙', () => {})
    assert.ok(fs.lstatSync(targets.claudeMd).isSymbolicLink())
    assert.equal(fs.readFileSync(real, 'utf8'), sec('work', '규칙'))
  } finally { t.cleanup() }
})
