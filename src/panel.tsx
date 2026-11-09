import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
  KeyValue,
  List,
  ListItem,
  on,
  plugin,
  read,
  Row,
  Separator,
  set,
  Spinner,
  Stack,
  Text,
  type KeyValueItem,
  type OrcaNode,
  type PanelContext
} from 'orca'
import type { OverviewAgentAccounts, OverviewWorkspace, PersonaOverview } from './panel-contract'

const overview = atom<PersonaOverview | null>(null)
const loadError = atom<string | null>(null)
const loading = atom(false)

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

export function setup(ctx: PanelContext): void {
  // 포커스가 바뀌거나 워커가 페르소나를 적용할 때마다 다시 그린다.
  ctx.subscriptions.push(on('workspace.changed', () => void refresh()))
  ctx.subscriptions.push(plugin.on('persona.changed', () => void refresh()))
  void refresh()
}

function activeEmail(agent: OverviewAgentAccounts): string {
  if (agent.activeAccountId === null) return '시스템 기본'
  const hit = agent.accounts.find((a) => a.id === agent.activeAccountId)
  return hit?.email ?? agent.activeAccountId
}

function workspaceItem(ws: OverviewWorkspace): OrcaNode {
  return (
    <ListItem
      key={ws.id}
      title={ws.name}
      description={ws.branch === null ? ws.path : `${ws.branch} · ${ws.path}`}
      icon={ws.kind === 'folder' ? 'folder' : 'branch'}
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

export default function Panel(): OrcaNode {
  const o = read(overview)
  const error = read(loadError)
  const busy = read(loading)

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
        <Button size="sm" variant="ghost" icon="refresh" onPress={() => void refresh()} disabled={busy}>
          새로 고침
        </Button>
      </Row>

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
          description={`${o.personasDir} 아래에 .md 파일을 만들면 여기에 묶음이 보입니다.`}
          icon="layers"
        />
      ) : (
        o.groups.map((g) => (
          <Card key={g.name} title={g.name} description={g.match.join('   ')}>
            <Stack gap="sm">
              <Row gap="xs" wrap>
                {g.git !== null && <Badge tone="neutral">git: {g.git.email}</Badge>}
                {g.accounts.claude !== undefined && <Badge tone="accent">claude: {g.accounts.claude}</Badge>}
                {g.accounts.codex !== undefined && <Badge tone="accent">codex: {g.accounts.codex}</Badge>}
                {g.hasBody && <Badge tone="neutral">지시문</Badge>}
                {o.current === g.name && <Badge tone="success">적용 중</Badge>}
              </Row>
              {workspaceList(g.workspaces)}
            </Stack>
          </Card>
        ))
      )}

      {o.unmatched.length > 0 && (
        <Card title="페르소나 없음" description="어느 match에도 걸리지 않는 워크스페이스 — 건드리지 않습니다.">
          {workspaceList(o.unmatched)}
        </Card>
      )}

      {o.remote.length > 0 && (
        <Card title="원격" description="원격 호스트 워크스페이스 — 건드리지 않습니다.">
          {workspaceList(o.remote)}
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
