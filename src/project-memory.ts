/**
 * ProjectMemory — framework-agnostic, workspace-keyed fact store.
 *
 * The Layer-4 project memory (COGNITION §5): merges/dedupes/expires/ranks
 * facts recorded across all sessions of one workspace. Queried ON DEMAND by
 * `recall_memory` (never scanned into every prompt — see COGNITION §5
 * "不扫摘要的理由"). Facts arrive two ways: explicit `record_memory` calls
 * (model-driven, works now) and the session-projection auto-extraction (Layer
 * 3, registered in the queryLoop phase when there are events to fold).
 *
 * Pure TS (no cordis) so it is unit-testable and wrappable by the Service.
 *
 * NOTE: `workspaceRegistry` was listed in COGNITION §5 as a DSH primitive but
 * does NOT exist in the harness — sg-memory owns workspace keying itself,
 * keyed by the workspace path string the caller (the memory tools / session)
 * supplies.
 */

/** Fact categories the store accepts (mirrors COGNITION §5 session-memory). */
export type FactType = 'decision' | 'constraint' | 'task-state' | 'verified-fact' | 'failure-lesson'

export interface MemoryFact {
  /** Stable id = hash(workspace|type|content) — same content re-recorded dedupes. */
  id: string
  workspace: string
  type: FactType
  content: string
  /** Origin session id (for provenance / evidence fallback). */
  sourceSession?: string
  /** Origin event seq within that session. */
  sourceEventSeq?: number
  /** ms epoch — recency ranking + ttl expiry. */
  recordedAt: number
  /** Optional time-to-live; facts past `recordedAt + ttlMs` are expired on read. */
  ttlMs?: number
}

export interface RecallQuery {
  /** Keyword relevance term; empty = pure recency ranking. */
  text?: string
  /** Restrict to these fact types. */
  types?: FactType[]
  /** Max facts returned (default 8 — bounded result tokens). */
  limit?: number
}

export interface RecordResult {
  stored: boolean
  id: string
  reason?: 'duplicate' | 'too-long' | 'full'
}

const DEFAULT_LIMIT = 8
const MAX_CONTENT_CHARS = 2000
const MAX_FACTS_PER_WORKSPACE = 500

/** djb2 string hash — stable, no Bun-specific API. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export class ProjectMemory {
  private readonly byWorkspace = new Map<string, MemoryFact[]>()

  /** Record a fact; dedupes by content within the workspace. */
  record(fact: Omit<MemoryFact, 'id' | 'recordedAt'> & { recordedAt?: number; id?: string }): RecordResult {
    const content = fact.content.trim()
    if (!content) return { stored: false, id: '', reason: 'too-long' }
    if (content.length > MAX_CONTENT_CHARS) return { stored: false, id: '', reason: 'too-long' }
    const workspace = fact.workspace
    const id = hash(`${workspace}|${fact.type}|${content}`)
    const list = this.byWorkspace.get(workspace) ?? []
    if (list.some((f) => f.id === id)) return { stored: false, id, reason: 'duplicate' }
    if (list.length >= MAX_FACTS_PER_WORKSPACE) {
      // Evict the oldest to make room (FIFO by recordedAt).
      list.sort((a, b) => a.recordedAt - b.recordedAt)
      list.shift()
    }
    const stored: MemoryFact = {
      ...fact,
      content,
      id,
      recordedAt: fact.recordedAt ?? Date.now(),
    }
    list.push(stored)
    this.byWorkspace.set(workspace, list)
    return { stored: true, id }
  }

  /** Recall ranked facts for a workspace (recency + keyword relevance). */
  recall(workspace: string, query: RecallQuery = {}): MemoryFact[] {
    const list = this._live(workspace)
    let filtered = list
    if (query.types && query.types.length) filtered = filtered.filter((f) => query.types!.includes(f.type))
    const terms = query.text?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []
    const scored = filtered.map((f) => ({ f, score: this._rank(f, terms) }))
    scored.sort((a, b) => b.score - a.score)
    const limit = query.limit ?? DEFAULT_LIMIT
    return scored.slice(0, limit).map((s) => s.f)
  }

  /** List all live facts for a workspace (no ranking, no injection — `view_memory`). */
  view(workspace: string): MemoryFact[] {
    return this._live(workspace)
  }

  /** Drop a fact by id (e.g. an outdated constraint superseded by a newer one). */
  forget(workspace: string, id: string): boolean {
    const list = this.byWorkspace.get(workspace)
    if (!list) return false
    const i = list.findIndex((f) => f.id === id)
    if (i < 0) return false
    list.splice(i, 1)
    return true
  }

  /** Live (non-expired) facts for a workspace, pruning expired ones as a side effect. */
  private _live(workspace: string): MemoryFact[] {
    const list = this.byWorkspace.get(workspace)
    if (!list) return []
    const now = Date.now()
    const live = list.filter((f) => f.ttlMs === undefined || f.recordedAt + f.ttlMs > now)
    if (live.length !== list.length) this.byWorkspace.set(workspace, live)
    return live
  }

  /** Recency (dominant) + simple keyword-overlap relevance. */
  private _rank(f: MemoryFact, terms: string[]): number {
    let score = f.recordedAt / 1e12 // recency in ~0-10 range (epoch ms / 1e12)
    if (terms.length) {
      const c = f.content.toLowerCase()
      let hits = 0
      for (const t of terms) if (c.includes(t)) hits += 1
      score += (hits / terms.length) * 5 // relevance up to +5
    }
    return score
  }
}
