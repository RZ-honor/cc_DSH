/**
 * executeTools — the checkPermissionsAndCallTool chain (COGNITION §1.1 / §9,
 * mirror of toolExecution.ts) with the SingGuard double-gate inserted.
 *
 * Chain: lookup → JSON.parse(args) → parseArgs (validate) →
 *   [sensitive tools] query-side gate → [write tools] response-side gate →
 *   call → createToolResultMessage.
 *
 * - Read-only tools (`isReadOnly(input)===true`) skip the gates (they only read).
 * - Sensitive tools (default — `isReadOnly` false) run the query-side gate on
 *   `auditText(input)` BEFORE execution; write tools with `sensitiveContent`
 *   additionally run the response-side gate on the exact content/patch BEFORE
 *   the file changes. A block or review verdict yields an is_error tool_result
 *   and the tool is NOT called — the loop self-heals next turn (COGNITION §4).
 * - If the guard is absent, sensitive tools fail-closed (block) per §B.1.
 *
 * The sidecar's classify() runs the hardcoded rules FIRST (unbypassable) then
 * the SingGuard heads; a dead sidecar process yields the TS-side fail-closed
 * verdict from GuardClient. So hardcoded-unbypassability + sidecar-down
 * fail-closed are both covered without TS-side rule duplication.
 */
import {
  createToolResultMessage,
  type AssistantMessage,
  type ContentBlock,
  type Message,
  type ToolCallBlock,
} from '@deepseek-ai/dsh-llm'

import type { GuardVerdict, Task } from '../types.ts'
import type { Tool, ToolCallContext } from './tool.ts'
import { isTrustedReadOnlyTool } from './read-only.ts'

const textBlock = (text: string): ContentBlock => ({ type: 'text', text })

function errorResult(callId: ToolCallBlock['id'], message: string): Message {
  return createToolResultMessage({ callId, content: [textBlock(message)], isError: true })
}

/** Build the model-visible block message for a guard denial (COGNITION §4). */
function denialMessage(toolName: string, verdict: GuardVerdict, side: 'query' | 'response'): string {
  const top = [...verdict.risks].sort((a, b) => b.probability - a.probability)[0]
  const hc = verdict.hardcoded ? `hardcoded rule "${verdict.hardcoded.rule_id}"` : null
  const cause = hc ?? (top ? `${top.domain}=${(top.probability * 100).toFixed(1)}%` : 'guard verdict')
  const tag = verdict.verdict === 'review'
    ? `[needs manual approval — SingGuard ${side}-side review on ${toolName}]`
    : `[SingGuard blocked this ${toolName} call (${side}-side)]`
  const analysis = verdict.analysis ? ` ${verdict.analysis}` : ''
  return `${tag} ${cause}.${analysis} Do not bypass the guard. Use a safe alternative that preserves the user's legitimate goal.`
}

/** Run one gate; returns undefined to proceed, or a denial message to block. */
async function runGate(
  guard: NonNullable<ToolCallContext['guard']>,
  toolName: string,
  task: Task,
  text: string,
  cwd: string,
  side: 'query' | 'response',
): Promise<string | undefined> {
  let verdict: GuardVerdict
  try {
    verdict = await guard.classify({ task, text, audit: { tool: toolName, cwd, operation: side } })
  } catch (e) {
    // Guard threw (shouldn't — GuardClient fail-closes — but be safe).
    return `[SingGuard] guard error on ${toolName} (${side}) — fail-closed (details redacted).`
  }
  if (verdict.verdict === 'block' || verdict.verdict === 'review') {
    return denialMessage(toolName, verdict, side)
  }
  return undefined
}

/**
 * Execute every tool call in an assistant message, returning the tool-result
 * messages to append to the conversation (one per call, in order).
 */
export async function executeTools(
  assistant: AssistantMessage,
  tools: Tool[],
  ctx: ToolCallContext,
): Promise<Message[]> {
  const calls = assistant.content.filter((b): b is ToolCallBlock => b.type === 'tool-call')
  const results: Message[] = []

  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.name)
    if (!tool) {
      results.push(errorResult(call.id, `unknown tool: ${call.name}`))
      continue
    }

    let raw: unknown
    try {
      raw = JSON.parse(call.arguments)
    } catch {
      results.push(errorResult(call.id, `invalid JSON arguments: ${call.arguments}`))
      continue
    }

    const parsed = tool.parseArgs(raw)
    if (!parsed.ok) {
      results.push(errorResult(call.id, parsed.error))
      continue
    }
    const input = parsed.value

    const isReadOnly = isTrustedReadOnlyTool(tool)
    // Read-only phase also enforces: only read-only tools run until write tools
    // are gated+added. (Redundant once guard gates gate writes, but kept as a
    // belt-and-suspenders fail-closed for the read-only delivery phase.)
    if (!isReadOnly) {
      const guard = ctx.guard
      if (!guard) {
        results.push(errorResult(call.id,
          `tool ${call.name} is sensitive but no guard is configured; fail-closed (COGNITION §B.1)`))
        continue
      }
      // Query-side gate (before execution).
      const auditText = tool.auditText ? tool.auditText(input) : JSON.stringify(input)
      const blocked = await runGate(guard, call.name, 'query', auditText, ctx.cwd, 'query')
      if (blocked) { results.push(errorResult(call.id, blocked)); continue }
      // Response-side gate (write tools: exact content before file change).
      if (tool.sensitiveContent) {
        const rBlocked = await runGate(guard, call.name, 'response', tool.sensitiveContent(input), ctx.cwd, 'response')
        if (rBlocked) { results.push(errorResult(call.id, rBlocked)); continue }
      }
    }

    try {
      const r = await tool.call(input, ctx)
      results.push(createToolResultMessage({
        callId: call.id,
        content: r.content,
        isError: r.isError ?? false,
      }))
    } catch (e) {
      results.push(errorResult(call.id, `tool ${call.name} failed (details redacted)`))
    }
  }

  return results
}
