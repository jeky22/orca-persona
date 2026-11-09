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
  private generation = 0
  private seq = 0
  private committedSeq = 0
  private pending: Promise<WorkspaceEntry[]> | null = null

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
    this.generation++
    this.pending = null
  }

  private async load(force: boolean): Promise<WorkspaceEntry[]> {
    if (!force && this.loadedAt !== null && this.now() - this.loadedAt < this.ttlMs) return this.entries
    if (!force && this.pending) return this.pending
    const generation = this.generation
    const seq = ++this.seq
    const p = this.list().then((result) => {
      // Commit only if no invalidate() happened and no newer load has already committed.
      if (generation === this.generation && seq > this.committedSeq) {
        this.committedSeq = seq
        this.entries = result.workspaces
        this.lastTruncated = result.truncated
        this.loadedAt = this.now()
      }
      return result.workspaces
    })
    this.pending = p
    const clear = () => {
      if (this.pending === p) this.pending = null
    }
    p.then(clear, clear)
    return p
  }
}
