/**
 * sg-memory — DSH host-root Cordis plugin exposing ctx.sgMemory.
 *
 * Owns the Layer-4 project memory store (src/project-memory.ts): a
 * workspace-keyed fact store with record/recall/view/forget. Facts are keyed by
 * the workspace path string the caller supplies (the memory tools resolve it
 * from the session cwd). Mounts in the HOST ROOT composition (ROOT realm) so
 * the store is a process-global singleton shared across all sessions of the
 * same workspace — exactly where COGNITION §2 puts it.
 *
 * The Layer-3 session projection (auto-extracting facts from the event stream)
 * is registered in the queryLoop phase, when there are real SessionEvents to
 * fold and the projection can be tested end-to-end. `ctx.inject` on
 * `sessionProjections` is the registration seam; it is stubbed here so the
 * dependency is optional and the store works in compositions without the
 * projection registry loaded.
 *
 * @module sg-agent/plugins/sg-memory
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { ProjectMemory, type MemoryFact, type RecallQuery, type RecordResult, type FactType } from '../src/project-memory.ts'

export interface SgMemoryConfig {
  /** Max facts returned per recall (default 8 — bounded result tokens). */
  defaultLimit?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sgMemory: SgMemory
  }
}

export class SgMemory extends Service {
  static Config: z<SgMemoryConfig> = z.object({
    defaultLimit: z.number().default(8),
  })

  private readonly store = new ProjectMemory()

  constructor(ctx: Context, config: SgMemoryConfig = {}) {
    super(ctx, 'sgMemory')
    this.defaultLimit = config.defaultLimit ?? 8
    // Layer-3 seam (deferred): when the session-projection registry is present,
    // register the event-folding projection that auto-feeds this store. That
    // registration needs @deepseek-ai/dsh-session-projection + a real
    // ProjectionDefinition, and only fires on committed SessionEvents — so it
    // belongs in the queryLoop phase, where there are events to fold and the
    // projection can be tested end-to-end. Until then the store is fed by
    // explicit record_memory calls.
  }

  private readonly defaultLimit: number

  /** Record a fact (model-driven via the `record_memory` tool, or the projection). */
  record(fact: Omit<MemoryFact, 'id' | 'recordedAt'> & { recordedAt?: number; id?: string }): RecordResult {
    return this.store.record(fact)
  }

  /** Recall ranked facts for a workspace on demand (`recall_memory` tool). */
  recall(workspace: string, query: RecallQuery = {}): MemoryFact[] {
    return this.store.recall(workspace, { limit: query.limit ?? this.defaultLimit, ...query })
  }

  /** List facts without ranking or context injection (`view_memory` tool). */
  view(workspace: string): MemoryFact[] {
    return this.store.view(workspace)
  }

  /** Drop a superseded fact by id. */
  forget(workspace: string, id: string): boolean {
    return this.store.forget(workspace, id)
  }
}

export default SgMemory
export type { MemoryFact, RecallQuery, RecordResult, FactType }
