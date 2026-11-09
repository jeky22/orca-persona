import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Field,
  Heading,
  IconButton,
  Input,
  KeyValue,
  List,
  ListItem,
  on,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  type KeyValueItem,
  type OrcaNode,
  type PanelContext
} from 'orca'
import type { OverviewAgentAccounts, OverviewGroup, OverviewWorkspace, PersonaOverview } from './panel-contract'

const overview = atom<PersonaOverview | null>(null)
const loadError = atom<string | null>(null)
const loading = atom(false)

/** 편집 폼. original이 null이면 새 페르소나. */
type EditState = {
  original: string | null
  name: string
  match: string
  gitName: string
  gitEmail: string
  claude: string
  codex: string
}
const editing = atom<EditState | null>(null)
const assigning = atom<{ workspace: OverviewWorkspace; choice: string } | null>(null)
const confirmDelete = atom<string | null>(null)
const actionError = atom<string | null>(null)
const actionBusy = atom(false)

async function refresh(): Promise<void> {
  set(loading, true)
  try {
    const o = await plugin.request('persona.overview')
    set(overview, o)
    set(loadError, null)
  } catch (e) {
    set(loadError, e instanceof Error ? e.message : String(e))
  } finally {
    set(loading, false)
  }
}

/** 변경 요청 하나를 실행하고 성공하면 overview를 다시 읽는다. */
async function act(run: () => Promise<unknown>, after?: () => void): Promise<void> {
  set(actionBusy, true)
  set(actionError, null)
  try {
    await run()
    after?.()
    await refresh()
  } catch (e) {
    set(actionError, e instanceof Error ? e.message : String(e))
  } finally {
    set(actionBusy, false)
  }
}

export function setup(ctx: PanelContext): void {
  // 포커스가 바뀌거나 워커가 페르소나를 적용·저장할 때마다 다시 그린다.
  ctx.subscriptions.push(on('workspace.changed', () => void refresh()))
  ctx.subscriptions.push(plugin.on('persona.changed', () => void refresh()))
  void refresh()
}

function activeEmail(agent: OverviewAgentAccounts): string {
  if (agent.activeAccountId === null) return '시스템 기본'
  const hit = agent.accounts.find((a) => a.id === agent.activeAccountId)
  return hit?.email ?? agent.activeAccountId
}

function startCreate(): void {
  set(actionError, null)
  set(assigning, null)
  set(editing, { original: null, name: '', match: '', gitName: '', gitEmail: '', claude: '', codex: '' })
}

function startEdit(g: OverviewGroup): void {
  set(actionError, null)
  set(assigning, null)
  set(editing, {
    original: g.name,
    name: g.name,
    match: g.match.join('\n'),
    gitName: g.git?.name ?? '',
    gitEmail: g.git?.email ?? '',
    claude: g.accounts.claude ?? '',
    codex: g.accounts.codex ?? ''
  })
}

function submitEdit(form: EditState): void {
  const git =
    form.gitName.trim() === '' && form.gitEmail.trim() === ''
      ? null
      : { name: form.gitName.trim(), email: form.gitEmail.trim() }
  void act(
    () =>
      plugin.request('persona.save', {
        name: form.name.trim(),
        match: form.match.split('\n').map((g) => g.trim()).filter((g) => g !== ''),
        git,
        accounts: {
          ...(form.claude.trim() !== '' ? { claude: form.claude.trim() } : {}),
          ...(form.codex.trim() !== '' ? { codex: form.codex.trim() } : {})
        }
      }),
    () => set(editing, null)
  )
}

function editForm(form: EditState, busy: boolean): OrcaNode {
  const patch = (p: Partial<EditState>) => set(editing, { ...form, ...p })
  return (
    <Card title={form.original === null ? '새 페르소나' : `편집: ${form.original}`}>
      <Stack gap="sm">
        <Input
          label="이름 (파일명)"
          value={form.name}
          disabled={form.original !== null}
          placeholder="work"
          onChange={(v) => patch({ name: v })}
        />
        <Field label="match" description="줄마다 glob 하나. ~는 홈 디렉터리.">
          <Textarea
            label="match"
            labelHidden
            rows={3}
            value={form.match}
            placeholder={'~/workspace/**\n~/orca/workspaces/foo/**'}
            onChange={(v) => patch({ match: v })}
          />
        </Field>
        <Row gap="sm">
          <Input label="git name" value={form.gitName} placeholder="비우면 깃 설정 안 함" onChange={(v) => patch({ gitName: v })} />
          <Input label="git email" value={form.gitEmail} placeholder="you@example.com" onChange={(v) => patch({ gitEmail: v })} />
        </Row>
        <Input
          label="claude 계정"
          value={form.claude}
          placeholder="등록한 이메일 또는 system (비우면 건드리지 않음)"
          onChange={(v) => patch({ claude: v })}
        />
        <Input
          label="codex 계정"
          value={form.codex}
          placeholder="등록한 이메일 또는 system (비우면 건드리지 않음)"
          onChange={(v) => patch({ codex: v })}
        />
        <Row gap="sm" justify="end">
          <Button variant="ghost" onPress={() => set(editing, null)} disabled={busy}>
            취소
          </Button>
          <Button tone="accent" onPress={() => submitEdit(form)} disabled={busy}>
            저장
          </Button>
        </Row>
      </Stack>
    </Card>
  )
}

function assignCard(target: { workspace: OverviewWorkspace; choice: string }, groups: OverviewGroup[], busy: boolean): OrcaNode {
  const ws = target.workspace
  return (
    <Card title={`지정: ${ws.name}`} description={ws.path}>
      <Stack gap="sm">
        <Select
          label="페르소나"
          value={target.choice}
          options={[
            { value: '__auto__', label: '자동 (경로 규칙)' },
            ...groups.map((g) => ({ value: g.name, label: g.name }))
          ]}
          onChange={(v) => set(assigning, { workspace: ws, choice: v })}
        />
        <Text muted size="xs">
          지정은 레포 루트의 .orca-persona 파일로 기록되고 경로 규칙보다 우선합니다.
        </Text>
        <Row gap="sm" justify="end">
          <Button variant="ghost" onPress={() => set(assigning, null)} disabled={busy}>
            취소
          </Button>
          <Button
            tone="accent"
            disabled={busy}
            onPress={() =>
              void act(
                () =>
                  plugin.request('persona.assign', {
                    workspaceId: ws.id,
                    persona: target.choice === '__auto__' ? null : target.choice
                  }),
                () => set(assigning, null)
              )
            }
          >
            적용
          </Button>
        </Row>
      </Stack>
    </Card>
  )
}

function workspaceItem(ws: OverviewWorkspace): OrcaNode {
  const assigned = ws.override !== null ? ` · 지정: ${ws.override}` : ''
  return (
    <ListItem
      key={ws.id}
      title={ws.name}
      description={`${ws.branch === null ? '' : `${ws.branch} · `}${ws.path}${assigned}`}
      icon={ws.kind === 'folder' ? 'folder' : 'branch'}
      onPress={() => {
        set(actionError, null)
        set(editing, null)
        set(assigning, { workspace: ws, choice: ws.override ?? '__auto__' })
      }}
    />
  )
}

function workspaceList(items: OverviewWorkspace[]): OrcaNode {
  if (items.length === 0) {
    return (
      <Text muted size="sm">
        매칭된 워크스페이스 없음
      </Text>
    )
  }
  return <List>{items.map(workspaceItem)}</List>
}

function groupCard(g: OverviewGroup, current: string | null, pendingDelete: string | null, busy: boolean): OrcaNode {
  return (
    <Card key={g.name} title={g.name} description={g.match.join('   ')}>
      <Stack gap="sm">
        <Row gap="xs" wrap>
          {g.git !== null && <Badge tone="neutral">git: {g.git.email}</Badge>}
          {g.accounts.claude !== undefined && <Badge tone="accent">claude: {g.accounts.claude}</Badge>}
          {g.accounts.codex !== undefined && <Badge tone="accent">codex: {g.accounts.codex}</Badge>}
          {g.hasBody && <Badge tone="neutral">지시문</Badge>}
          {current === g.name && <Badge tone="success">적용 중</Badge>}
        </Row>
        {workspaceList(g.workspaces)}
        <Row gap="xs" justify="end">
          <IconButton icon="edit" label={`${g.name} 편집`} size="xs" variant="ghost" disabled={busy} onPress={() => startEdit(g)} />
          {pendingDelete === g.name ? (
            <Button size="xs" tone="danger" disabled={busy} onPress={() => void act(() => plugin.request('persona.delete', { name: g.name }), () => set(confirmDelete, null))}>
              삭제 확인
            </Button>
          ) : (
            <IconButton icon="delete" label={`${g.name} 삭제`} size="xs" variant="ghost" tone="danger" disabled={busy} onPress={() => set(confirmDelete, g.name)} />
          )}
        </Row>
      </Stack>
    </Card>
  )
}

export default function Panel(): OrcaNode {
  const o = read(overview)
  const error = read(loadError)
  const busy = read(loading)
  const form = read(editing)
  const assignTarget = read(assigning)
  const pendingDelete = read(confirmDelete)
  const mutationError = read(actionError)
  const mutating = read(actionBusy)

  if (o === null) {
    return (
      <Stack gap="md">
        {error !== null ? (
          <Callout tone="danger" title="불러오지 못함">
            <Stack gap="sm">
              <Text size="sm">{error}</Text>
              <Button size="sm" onPress={() => void refresh()}>
                다시 시도
              </Button>
            </Stack>
          </Callout>
        ) : (
          <Spinner label="페르소나 상태 불러오는 중" />
        )}
      </Stack>
    )
  }

  const currentItems: KeyValueItem[] = [
    { label: '적용된 페르소나', value: o.current ?? '—', tone: o.current !== null ? 'accent' : 'neutral' },
    { label: '포커스', value: o.focus === null ? '—' : `${o.focus.displayName} (${o.focus.branch})` }
  ]
  if (o.accounts !== null) {
    currentItems.push(
      { label: 'Claude 계정', value: activeEmail(o.accounts.claude) },
      { label: 'Codex 계정', value: activeEmail(o.accounts.codex) }
    )
  }

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Persona</Heading>
        <Row gap="xs">
          <Button size="sm" variant="ghost" icon="add" onPress={startCreate} disabled={mutating}>
            새 페르소나
          </Button>
          <IconButton icon="refresh" label="새로 고침" size="sm" variant="ghost" onPress={() => void refresh()} disabled={busy} />
        </Row>
      </Row>

      {mutationError !== null && (
        <Callout tone="danger" title="실패">
          <Text size="sm">{mutationError}</Text>
        </Callout>
      )}

      {form !== null && editForm(form, mutating)}
      {assignTarget !== null && assignCard(assignTarget, o.groups, mutating)}

      <Card title="현재 상태">
        <Stack gap="sm">
          <KeyValue items={currentItems} />
          {o.accountsError !== null && (
            <Callout tone="warning" title="계정 조회 실패">
              <Text size="sm">{o.accountsError}</Text>
            </Callout>
          )}
          {o.lastApply !== null && !o.lastApply.ok && (
            <Callout tone="danger" title={`마지막 적용 실패: ${o.lastApply.persona}`}>
              <Text size="sm">{o.lastApply.reason ?? ''}</Text>
            </Callout>
          )}
        </Stack>
      </Card>

      {o.issues.length > 0 && (
        <Callout tone="warning" title="무시된 페르소나 파일">
          <Stack gap="xs">
            {o.issues.map((i) => (
              <Text key={i.file} size="sm">
                {i.file}: {i.message}
              </Text>
            ))}
          </Stack>
        </Callout>
      )}

      {o.workspacesError !== null && (
        <Callout tone="danger" title="워크스페이스 조회 실패">
          <Text size="sm">{o.workspacesError}</Text>
        </Callout>
      )}

      {o.groups.length === 0 ? (
        <EmptyState
          title="페르소나가 없습니다"
          description="새 페르소나 버튼으로 첫 묶음을 만들어 보세요."
          icon="layers"
        />
      ) : (
        o.groups.map((g) => groupCard(g, o.current, pendingDelete, mutating))
      )}

      {o.unmatched.length > 0 && (
        <Card title="페르소나 없음" description="어느 match에도 걸리지 않는 워크스페이스 — 행을 누르면 지정할 수 있습니다.">
          {workspaceList(o.unmatched)}
        </Card>
      )}

      {o.remote.length > 0 && (
        <Card title="원격" description="원격 호스트 워크스페이스 — 건드리지 않습니다.">
          <List>
            {o.remote.map((ws) => (
              <ListItem
                key={ws.id}
                title={ws.name}
                description={`${ws.branch === null ? '' : `${ws.branch} · `}${ws.path}`}
                icon={ws.kind === 'folder' ? 'folder' : 'branch'}
                disabled
              />
            ))}
          </List>
        </Card>
      )}

      {o.truncated && (
        <Text muted size="sm">
          워크스페이스 목록이 잘렸습니다. 일부는 표시되지 않습니다.
        </Text>
      )}

      <Separator />
      <Text muted size="xs">
        페르소나 파일: <Code>{o.personasDir}</Code>
      </Text>
    </Stack>
  )
}
