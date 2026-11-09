import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import type { PersonaOverview } from './panel-contract'
import * as panel from './panel'

function overview(extra: Partial<PersonaOverview> = {}): PersonaOverview {
  return {
    current: 'work',
    lastApply: { persona: 'work', ok: true },
    focus: { displayName: 'Review screenshot', branch: 'jechan-lee/review-screenshot' },
    personasDir: '/Users/me/.orca/personas',
    accounts: {
      claude: {
        accounts: [
          { id: 'a1', email: 'work@example.com' },
          { id: 'a2', email: 'me@example.com' }
        ],
        activeAccountId: 'a1'
      },
      codex: { accounts: [], activeAccountId: null }
    },
    accountsError: null,
    groups: [
      {
        name: 'personal',
        match: ['~/side/**'],
        git: { name: 'me', email: 'me@example.com' },
        accounts: { claude: 'system' },
        hasBody: false,
        workspaces: []
      },
      {
        name: 'work',
        match: ['~/workspace/**'],
        git: { name: 'Work Me', email: 'work@example.com' },
        accounts: { claude: 'work@example.com' },
        hasBody: true,
        workspaces: [
          { id: 'w1', name: 'repo', branch: 'main', path: '/Users/me/workspace/repo', kind: 'worktree' }
        ]
      }
    ],
    unmatched: [{ id: 'w9', name: 'free', branch: 'main', path: '/elsewhere/free', kind: 'worktree' }],
    remote: [],
    truncated: false,
    workspacesError: null,
    issues: [],
    ...extra
  }
}

test('패널: 그룹·현재 상태·미매칭을 그린다', async () => {
  const host = mockHost({ requests: { 'persona.overview': overview() } })
  const t = await mount(panel, { host })
  await t.settled()
  assert.deepEqual(t.errors, [])
  assert.ok(t.find({ type: 'Card', label: 'work' }))
  assert.ok(t.find({ type: 'Card', label: 'personal' }))
  assert.ok(t.find({ type: 'Card', label: '페르소나 없음' }))
  assert.ok(t.find({ type: 'ListItem', label: 'repo' }))
  assert.ok(t.find({ text: /work@example\.com/ }))
  assert.ok(t.find({ type: 'Badge', text: '적용 중' }))
  await t.unmount()
})

test('패널: 파싱 오류와 적용 실패를 경고로 보여준다', async () => {
  const host = mockHost({
    requests: {
      'persona.overview': overview({
        lastApply: { persona: 'personal', ok: false, reason: '등록되지 않은 계정' },
        issues: [{ file: 'broken.md', message: '첫 줄이 ---가 아님' }]
      })
    }
  })
  const t = await mount(panel, { host })
  await t.settled()
  const summary = t.summary().join('\n')
  assert.ok(summary.includes('무시된 페르소나 파일'))
  assert.ok(t.find({ text: /broken\.md/ }))
  assert.ok(t.find({ text: /등록되지 않은 계정/ }))
  await t.unmount()
})

test('패널: overview 실패 시 오류와 다시 시도 버튼', async () => {
  let calls = 0
  const host = mockHost({
    requests: {
      'persona.overview': () => {
        calls += 1
        if (calls === 1) throw hostError('unavailable', '워커가 내려감')
        return overview()
      }
    }
  })
  const t = await mount(panel, { host })
  await t.settled()
  assert.ok(t.find({ type: 'Callout' }))
  await t.press({ type: 'Button', text: '다시 시도' })
  await t.settled()
  assert.ok(t.find({ type: 'Card', label: 'work' }))
  await t.unmount()
})

test('패널: 페르소나가 없으면 안내만 보여준다', async () => {
  const host = mockHost({
    requests: { 'persona.overview': overview({ current: null, lastApply: null, groups: [], unmatched: [] }) }
  })
  const t = await mount(panel, { host })
  await t.settled()
  assert.ok(t.find({ type: 'EmptyState' }))
  await t.unmount()
})
