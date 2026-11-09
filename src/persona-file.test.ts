import { assert, test } from 'orca/testing'
import { isPersonaParseError, parsePersonaFile } from './persona-file'

const workMd = `---
match:
  - ~/workspace/**
git:
  name: Jechan Lee
  email: jechan.lee@gwanaklab.co.kr
accounts:
  claude: jechan.lee@gwanaklab.co.kr   # orca account add 로 등록한 계정의 이메일
  codex: jechan.lee@gwanaklab.co.kr
---

사내 코드베이스다. 커밋 메시지는 한국어로 쓴다.
PR 본문에 Jira 키를 반드시 넣는다.
`

const expected = {
  name: 'work',
  sourcePath: '/p/work.md',
  match: ['~/workspace/**'],
  git: { name: 'Jechan Lee', email: 'jechan.lee@gwanaklab.co.kr' },
  accounts: { claude: 'jechan.lee@gwanaklab.co.kr', codex: 'jechan.lee@gwanaklab.co.kr' },
  body: '사내 코드베이스다. 커밋 메시지는 한국어로 쓴다.\nPR 본문에 Jira 키를 반드시 넣는다.',
}

test('parses the full work.md example', () => {
  assert.deepEqual(parsePersonaFile('work', '/p/work.md', workMd), expected)
})

test('CRLF and a leading BOM parse identically', () => {
  const text = '﻿' + workMd.replace(/\n/g, '\r\n')
  assert.deepEqual(parsePersonaFile('work', '/p/work.md', text), expected)
})

test('missing match is an error mentioning match', () => {
  const r = parsePersonaFile('x', '/p/x.md', '---\ngit:\n  name: A\n  email: a@b.c\n---\n')
  assert.equal(isPersonaParseError(r), true)
  if (isPersonaParseError(r)) assert.ok(r.message.includes('match'))
})

test('accounts only (no git) is valid', () => {
  const r = parsePersonaFile('x', '/p/x.md', '---\nmatch:\n  - ~/a/**\naccounts:\n  claude: system\n---\n')
  assert.equal(isPersonaParseError(r), false)
  if (!isPersonaParseError(r)) {
    assert.equal(r.accounts.claude, 'system')
    assert.equal(r.git, undefined)
  }
})

test('unknown top-level key is an error mentioning the key', () => {
  const r = parsePersonaFile('x', '/p/x.md', '---\nmatch:\n  - ~/a/**\nfoo: 1\n---\n')
  assert.equal(isPersonaParseError(r), true)
  if (isPersonaParseError(r)) assert.ok(r.message.includes('foo'))
})

test('no frontmatter is an error', () => {
  assert.equal(isPersonaParseError(parsePersonaFile('x', '/p/x.md', '그냥 본문\n')), true)
})

test('file ending at the closing --- has an empty body', () => {
  const r = parsePersonaFile('x', '/p/x.md', '---\nmatch:\n  - ~/a/**\naccounts:\n  codex: system\n---')
  assert.equal(isPersonaParseError(r), false)
  if (!isPersonaParseError(r)) assert.equal(r.body, '')
})

test('git only is valid with or without a bare accounts:', () => {
  for (const extra of ['', 'accounts:\n']) {
    const r = parsePersonaFile('x', '/p/x.md', `---\nmatch:\n  - ~/a/**\ngit:\n  name: A\n  email: a@b.c\n${extra}---\n`)
    assert.equal(isPersonaParseError(r), false)
    if (!isPersonaParseError(r)) assert.deepEqual(r.accounts, {})
  }
})

test('empty account value is an error naming the key', () => {
  for (const v of ['', ' ""']) {
    const r = parsePersonaFile('x', '/p/x.md', `---\nmatch:\n  - ~/a/**\naccounts:\n  claude:${v}\n---\n`)
    assert.equal(isPersonaParseError(r), true)
    if (isPersonaParseError(r)) assert.ok(r.message.includes('claude'))
  }
})

test('quoted values keep # inside quotes and drop a trailing comment', () => {
  const r = parsePersonaFile('x', '/p/x.md', '---\nmatch:\n  - "~/a # b/**"   # c\ngit:\n  name: \'A # B\' # note\n  email: a@b.c\n---\n')
  assert.equal(isPersonaParseError(r), false)
  if (!isPersonaParseError(r)) {
    assert.deepEqual(r.match, ['~/a # b/**'])
    assert.equal(r.git?.name, 'A # B')
  }
})
