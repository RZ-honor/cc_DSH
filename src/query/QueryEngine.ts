/**
 * QueryEngine — owns one conversation + one submitted user turn (Claude Code
 * runtime mirror, COGNITION §1.1 / §9).
 *
 * Honors invariant #1: the accepted user message is persisted to the in-memory
 * transcript BEFORE the first LLM request, so an interrupted session is
 * resumable from the user message. (Real JSONL persistence comes with DSH
 * session integration; the transcript seam is here now.)
 *
 * Framework-agnostic (takes a Context that provides ctx.sgModel); the cordis
 * sg-query preset wrapper comes when mounting into a DSH profile.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type AssistantMessage, type Message, type ToolSchema } from '@deepseek-ai/dsh-llm'

import { queryLoop, type LoopEvent, type Terminal } from './queryLoop.ts'
import { executeTools } from '../tools/execution.ts'
import { toToolSchema, type Tool, type ToolCallContext } from '../tools/tool.ts'

export interface QueryEngineParams {
  ctx: Context
  system: string
  /** sg-agent tools; converted to ToolSchema for the model and executed via
   * executeTools on tool_use (Phase D). Omit for text-only loops. */
  tools?: Tool[]
  /** Cwd handed to every tool's `call` (path resolution + sandbox). */
  toolCtx?: ToolCallContext
  maxTurns?: number
  /** Override the default executeTools-based Phase D executor. */
  onToolUse?: (assistant: AssistantMessage) => Promise<Message[]>
}

export class QueryEngine {
  private messages: Message[] = []
  /** Invariant #1 seam: accepted user messages persisted before first LLM call. */
  readonly transcript: Message[] = []
  private readonly params: QueryEngineParams

  constructor(params: QueryEngineParams) {
    this.params = params
  }

  /** Submit one user turn; yields loop events, returns the terminal outcome. */
  async *submitMessage(prompt: string): AsyncGenerator<LoopEvent, Terminal> {
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })
    // Invariant #1: persist the accepted user message BEFORE the first LLM
    // request — if the process is killed before the API responds, the turn is
    // still resumable from this user message.
    this.transcript.push(userMsg)
    this.messages = [...this.messages, userMsg]

    const tools = this.params.tools
    const toolCtx = this.params.toolCtx
    const onToolUse = this.params.onToolUse
      ?? (tools && toolCtx
        ? (assistant: AssistantMessage) => executeTools(assistant, tools, toolCtx)
        : undefined)

    const term: Terminal = yield* queryLoop({
      ctx: this.params.ctx,
      messages: this.messages,
      system: this.params.system,
      tools: tools?.map(toToolSchema),
      maxTurns: this.params.maxTurns,
      onToolUse,
    })
    // Sync the engine's conversation to the loop's final messages so the next
    // submitMessage continues from the real tail (assistant + tool results).
    this.messages = term.messages
    this.transcript.push(...term.messages.slice(this.transcript.length))
    return term
  }

  /** Current conversation (for inspection / persistence). */
  getMessages(): Message[] { return this.messages }
}
