/**
 * queryLoop — the sg-agent main loop (Claude Code runtime mirror).
 *
 * Minimal print-mode v1: stream → assemble → terminate on no-tool (Phase C).
 * The Phase D tool-execution seam (`onToolUse`) is in place for read-only
 * tools (step 2) but unused when no tools are configured.
 *
 * Two cross-cutting invariants from COGNITION §1.1 are honored:
 *  (1) the accepted user message is persisted before the first LLM request
 *      (handled by QueryEngine, not here);
 *  (2) every loop continuation reassigns a FRESH State object with a
 *      `transition` reason — the loop never mutates `state` in place.
 *
 * Yields stream chunks live (for print-mode rendering) + completed assistant
 * messages + tool results. Returns a Terminal with the final messages so the
 * QueryEngine can sync its conversation for the next submitMessage.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createAssistantMessage,
  type AssistantMessage,
  type Message,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'

export type LoopEvent =
  | { type: 'chunk'; chunk: StreamChunk }
  | { type: 'assistant'; message: AssistantMessage }
  | { type: 'tool_results'; messages: Message[] }
  | { type: 'error'; error: Error; phase: 'stream' | 'tools' }

export type TerminalReason = 'completed' | 'max_turns' | 'model_error' | 'tool_error' | 'no_executor'

export interface Terminal {
  reason: TerminalReason
  turnCount: number
  /** Final conversation (for the QueryEngine to persist across submitMessage). */
  messages: Message[]
}

/** Invariant #2: a fresh State object per continuation, never mutated in place. */
interface LoopState {
  messages: Message[]
  turnCount: number
  transition: 'init' | 'next_turn' | undefined
}

export interface QueryLoopParams {
  ctx: Context
  messages: Message[]
  system: string
  tools?: ToolSchema[]
  maxTurns?: number
  /** Phase D tool executor (step 2). Omitted => terminate after the first
   * assistant message whose content has no tool calls. */
  onToolUse?: (assistant: AssistantMessage) => Promise<Message[]>
}

/**
 * The `while(true)` model/tool loop. An async generator: `for await` its
 * yielded events, or `yield*` it from another generator to receive its
 * {@link Terminal} return value.
 */
export async function* queryLoop(params: QueryLoopParams): AsyncGenerator<LoopEvent, Terminal> {
  let state: LoopState = { messages: params.messages, turnCount: 1, transition: 'init' }
  const maxTurns = params.maxTurns ?? 10

  while (true) {
    // --- Phase B: call model + stream -------------------------------------
    const assembler = new BlockAssembler()
    let streamErr: Error | undefined
    try {
      for await (const chunk of params.ctx.sgModel.stream({
        messages: state.messages,
        system: params.system,
        tools: params.tools,
      })) {
        assembler.push(chunk)
        yield { type: 'chunk', chunk }
      }
    } catch (e) {
      streamErr = e instanceof Error ? e : new Error(String(e))
    }
    if (streamErr) {
      yield { type: 'error', error: streamErr, phase: 'stream' }
      return { reason: 'model_error', turnCount: state.turnCount, messages: state.messages }
    }

    const blocks = assembler.blocks()
    const assistant = createAssistantMessage({
      content: blocks,
      source: { provider: params.ctx.sgModel.primaryProvider, model: params.ctx.sgModel.primaryModel },
    })
    yield { type: 'assistant', message: assistant }

    // --- Phase C/D: tool_use? ---------------------------------------------
    // v1 heuristic: any non-text block counts as a tool call. (No reasoning
    // blocks in v1 since reasoningEffort is unset.) Refined in step 2.
    const hasToolUse = blocks.some((b) => b.type !== 'text')
    const withAssistant: Message[] = [...state.messages, assistant]

    if (!hasToolUse) {
      return { reason: 'completed', turnCount: state.turnCount, messages: withAssistant }
    }
    if (!params.onToolUse) {
      yield {
        type: 'error',
        error: new Error('model emitted tool calls but no onToolUse executor configured'),
        phase: 'tools',
      }
      return { reason: 'no_executor', turnCount: state.turnCount, messages: withAssistant }
    }

    let toolResults: Message[]
    try {
      toolResults = await params.onToolUse!(assistant)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      yield { type: 'error', error: err, phase: 'tools' }
      return { reason: 'tool_error', turnCount: state.turnCount, messages: withAssistant }
    }
    yield { type: 'tool_results', messages: toolResults }

    // --- continue (invariant #2: fresh State) ----------------------------
    const nextTurn = state.turnCount + 1
    if (nextTurn > maxTurns) {
      return { reason: 'max_turns', turnCount: nextTurn, messages: [...withAssistant, ...toolResults] }
    }
    state = {
      messages: [...withAssistant, ...toolResults],
      turnCount: nextTurn,
      transition: 'next_turn',
    }
  }
}
