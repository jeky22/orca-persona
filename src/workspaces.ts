export type WorkspaceEntry = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

export type HostList = () => Promise<{ workspaces: WorkspaceEntry[]; truncated: boolean }>

export class WorkspaceIndex {
  private entries: WorkspaceEntry[] = []
  private loadedAt: number | null = null
  private readonly ttlMs: number
  private readonly now: () => number
  private lastTruncated = false

  constructor(
    private readonly list: HostList,
    opts: { ttlMs?: number; now?: () => number } = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 30_000
    this.now = opts.now ?? Date.now
  }

  /** Whether the last workspace.list result was truncated (false before any load). */
  get truncated(): boolean {
    return this.lastTruncated
  }

  async byId(id: string): Promise<WorkspaceEntry | null> {
    const hit = (await this.load(false)).find((w) => w.id === id)
    if (hit) return hit
    return (await this.load(true)).find((w) => w.id === id) ?? null
  }

  /** Exactly one match → it; zero or several → null. An empty branch means "no branch" (folder). */
  async byNameAndBranch(name: string, branch: string): Promise<WorkspaceEntry | null> {
    const matches = (await this.load(false)).filter((w) =>
      branch === '' ? w.name === name && (w.branch === null || w.branch === '') : w.name === name && w.branch === branch
    )
    return matches.length === 1 ? matches[0] : null
  }

  invalidate(): void {
    this.loadedAt = null
  }

  private async load(force: boolean): Promise<WorkspaceEntry[]> {
    if (!force && this.loadedAt !== null && this.now() - this.loadedAt < this.ttlMs) return this.entries
    const result = await this.list()
    this.entries = result.workspaces
    this.lastTruncated = result.truncated
    this.loadedAt = this.now()
    return this.entries
  }
}
