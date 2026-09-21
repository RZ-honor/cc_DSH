/**
 * sg-query — DSH preset Cordis plugin exposing `ctx.sgQuery`: the Claude
 * Code-style main loop wrapped as a preset service.
 *
 * Wraps the sg-agent {@link QueryEngine} (src/query/QueryEngine.ts) as a
 * session-scoped Cordis Service. It drives the sg-agent `queryLoop` on the
 * agent session's user turns using the host-root singletons — `ctx.sgModel`
 * (model route) and `ctx.sgGuard` (the SingGuard sidecar, fed into the
 * tool-call chain via `toolCtx.guard`) — plus the tools registered by
 * `sg-tools` (RUNBOOK "预置行适配器"; COGNITION §2 / §5.3).
 *
 * The service is registered in the agent's scoped context so each session owns
 * its own QueryEngine and transcript; the host-root services remain shared
 * process-global singletons (COGNITION §1.3 isolate; no ROOT-realm leak).
 *
 * @module sg-agent/plugins/sg-query
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { QueryEngine, type QueryEngineParams } from '../src/query/QueryEngine.ts'
import type { LoopEvent, Terminal } from '../src/query/queryLoop.ts'
import type { Tool, ToolCallContext } from '../src/tools/tool.ts'
import { ALL_TOOLS } from '../src/tools/write.ts'

export interface SgQueryConfig {
  /** Max loop turns per user submission (default 25). */
  maxTurns?: number
  /** Optional per-call system prompt. Defaults to a guard-aware prompt. */
  system?: string
  /** Which tools the loop may call; default is the full guarded set. */
  tools?: Tool[]
  /** Base cwd resolved from the session header when absent. */
  cwd?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sgQuery: SgQuery
  }
}

const DEFAULT_SYSTEM = `You are sg-agent, a coding assistant. You can read, search, and
(guarded) write files via the Read, Grep, Glob, Write, Edit tools. A SingGuard
safety layer audits sensitive tool calls: if a tool result says "[SingGuard
blocked ...]" it means the guard found the call unsafe. Do NOT bypass the guard
or retry the same dangerous action — choose a safe alternative that preserves the
user's legitimate goal. Keep answers brief and factual. Verify work by reading it back.`

/**
 * The Claude Code-style loop as a Cordis Service. Exposes `submit(prompt)` for
 * print-mode one-shot runs and `stream(prompt)` for live event consumption;
 * the session-driven path subscribes to the session's `user/message` events and
 * submits each turn through this engine.
 */
export class SgQuery extends Service {
  static Config: z<SgQueryConfig> = z.object({
    maxTurns: z.number().default(25),
    system: z.string().required(false),
    tools: z.array(z.any()).required(false),
    cwd: z.string().required(false),
  })

  private readonly engine: QueryEngine
  private readonly cwd: string

  constructor(ctx: Context, config: SgQueryConfig = {}) {
    super(ctx, 'sgQuery')
    const cwd = config.cwd ?? (ctx.get('session') as { header?: { cwd?: string } } | undefined)?.header?.cwd
      ?? process.cwd()
    this.cwd = cwd
    const toolCtx: ToolCallContext = {
      cwd,
      // Host-root singleton; when absent, sensitive tools fail-closed in the
      // execution chain (COGNITION §B.1).
      guard: (ctx as Context & { sgGuard?: ToolCallContext['guard'] }).sgGuard,
    }
    const params: QueryEngineParams = {
      ctx,
      system: config.system ?? DEFAULT_SYSTEM,
      tools: config.tools ?? ALL_TOOLS,
      toolCtx,
      maxTurns: config.maxTurns ?? 25,
    }
    this.engine = new QueryEngine(params)
  }

  /** The workspace root this loop's tools are confined to. */
  get cwdPath(): string { return this.cwd }

  /** Submit one user turn; consume the yielded {@link LoopEvent}s. */
  submit(prompt: string): AsyncGenerator<LoopEvent, Terminal> {
    return this.engine.submitMessage(prompt)
  }

  /** Run one turn to completion and return the terminal outcome (print mode). */
  async run(prompt: string): Promise<Terminal> {
    const iter = this.submit(prompt)
    let term: Terminal = { reason: 'model_error', turnCount: 0, messages: [] }
    for await (const _ of iter) { /* consume events */ }
    return term
  }
}

export default SgQuery