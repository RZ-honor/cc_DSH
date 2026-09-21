/**
 * sg-tools — DSH preset-row adapter: sg-agent tools into the DSH tools registry.
 *
 * Bridging contract (COGNITION §5.3 / RUNBOOK "预置行适配器"):
 * the sg-agent core defines its own {@link Tool} contract
 * (src/tools/tool.ts) with `parseArgs` + `call` returning content blocks and a
 * guarded execution chain (src/tools/execution.ts). DSH's `@deepseek-ai/dsh-tools`
 * registry consumes a different shape — a `ToolDefinition` whose `execute`
 * returns a canonical lossless-JSON value and whose `output.render` projects it
 * to the model-facing `ContentBlock[]`.
 *
 * This adapter maps each sg `Tool` to a `ToolDefinition` while KEEPING the
 * SingGuard double-gate: the query-side gate runs on `auditText(input)` before
 * the tool body, and the response-side gate runs on `sensitiveContent(input)`
 * (the exact content/patch) before the file changes — the same rules as
 * `executeTools` — so a guard block means the file/command is never touched.
 * The guard is the process-global `ctx.sgGuard` singleton (host root row) and
 * the cwd is read from the session header.
 *
 * Registered through the agent's scoped context (`agent.ctx`) so the tools
 * appear in the DSH tools registry for that session, shadowing any same-named
 * global tool and colliding with no other session (COGNITION §1.3 isolate).
 *
 * @module sg-agent/plugins/sg-tools
 */
import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { Tool, ToolCallContext, ToolResult } from '../src/tools/tool.ts'
import { READ_ONLY_TOOLS } from '../src/tools/read-only.ts'
import { WRITE_TOOLS } from '../src/tools/write.ts'
import type { ClassifyParams, GuardVerdict, Task } from '../src/types.ts'

export interface SgToolsConfig {
  /** Which tool groups to expose. Default exposes the full guarded set. */
  tools?: 'all' | 'read' | SgToolName[]
}

/** The set of sg-agent tools this plugin can register. */
export type SgToolName = 'Read' | 'Glob' | 'Grep' | 'Write' | 'Edit'

/** Every tool the adapter knows how to bridge. */
export const SG_TOOLS: Record<SgToolName, Tool> = {
  Read: READ_ONLY_TOOLS.find((t) => t.name === 'Read')!,
  Glob: READ_ONLY_TOOLS.find((t) => t.name === 'Glob')!,
  Grep: READ_ONLY_TOOLS.find((t) => t.name === 'Grep')!,
  Write: WRITE_TOOLS.find((t) => t.name === 'Write')!,
  Edit: WRITE_TOOLS.find((t) => t.name === 'Edit')!,
}

/** Canonical value a bridged sg tool returns; `render` projects it to blocks. */
export interface SgToolOutputValue {
  content: ContentBlock[]
  isError: boolean
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text })

/** Resolve the workspace root from the session the call runs for. */
function sessionCwd(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/** Build the model-visible denial message for a guard block/review (COGNITION §4). */
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

/** Run one gate; returns a denial message to block, or undefined to proceed. */
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
    // Guard threw (shouldn't — GuardClient fail-closes) — fail closed.
    return `[SingGuard] guard error on ${toolName} (${side}) — fail-closed (details redacted).`
  }
  if (verdict.verdict === 'block' || verdict.verdict === 'review') {
    return denialMessage(toolName, verdict, side)
  }
  return undefined
}

/** Execute one bridged tool with the full guarded chain, returning its canonical value. */
async function runGuardedTool(
  tool: Tool,
  args: unknown,
  exec: ToolRunContext,
  guard: { classify: (params: ClassifyParams) => Promise<GuardVerdict> },
): Promise<SgToolOutputValue> {
  const parsed = tool.parseArgs(args)
  if (!parsed.ok) {
    return { content: [textBlock(parsed.error)], isError: true }
  }
  const input = parsed.value
  const cwd = sessionCwd(exec)
  const toolCtx: ToolCallContext = { cwd, guard }

  const isReadOnly = tool.isReadOnly?.(input) ?? false
  // Non-read-only tools are gated (query-side before the body; response-side on
  // the exact content/patch before the file changes). Read-only tools pass.
  if (!isReadOnly) {
    const auditText = tool.auditText ? tool.auditText(input) : JSON.stringify(input)
    const qBlock = await runGate(guard, tool.name, 'query', auditText, cwd, 'query')
    if (qBlock) return { content: [textBlock(qBlock)], isError: true }
    if (tool.sensitiveContent) {
      const rBlock = await runGate(guard, tool.name, 'response', tool.sensitiveContent(input), cwd, 'response')
      if (rBlock) return { content: [textBlock(rBlock)], isError: true }
    }
  }

  try {
    const result: ToolResult = await tool.call(input, toolCtx)
    return { content: result.content, isError: result.isError ?? false }
  } catch (e) {
    return { content: [textBlock(`tool ${tool.name} failed (details redacted)`)], isError: true }
  }
}

/** Project a bridged tool's canonical value to the model-facing content blocks. */
function renderOutput(_args: unknown, value: unknown): ContentBlock[] {
  const v = value as SgToolOutputValue
  return Array.isArray(v.content) && v.content.length > 0 ? v.content : [textBlock('(no output)')]
}

/** Adapt one sg-agent `Tool` into a DSH `ToolDefinition`. */
function adaptTool(tool: Tool): ToolDefinition {
  function guardFor(ctx: Context | undefined): { classify: (params: ClassifyParams) => Promise<GuardVerdict> } {
    // The process-global guard singleton (host root row). If absent (no
    // sg-guard mounted), sensitive tools must fail-closed — the gate wrapper
    // synthesizes that below (COGNITION §B.1).
    const g = ctx && (ctx as Context & { sgGuard?: { classify: (p: ClassifyParams) => Promise<GuardVerdict> } }).sgGuard
    if (g) return g
    return {
      classify: async (params: ClassifyParams): Promise<GuardVerdict> => ({
        verdict: 'block',
        task: params?.task ?? 'query',
        risks: [],
        hardcoded: null,
        analysis: 'fail-closed: no sg-guard mounted (COGNITION §B.1)',
        model_available: false,
      }),
    }
  }

  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: {
      // Canonical value schema: `{ content: ContentBlock[], isError: boolean }`.
      // `content` is an array of JSON-serializable blocks; a permissive schema
      // keeps the bridge lossless (each block is a JSON object with text/type).
      schema: {
        type: 'object' as const,
        properties: {
          isError: { type: 'boolean' },
          content: { type: 'array', items: { type: 'object' } },
        },
        required: ['content', 'isError'],
        additionalProperties: false,
      },
      render: renderOutput,
    },
    isConcurrencySafe: tool.isReadOnly ? (args: unknown) => {
      const parsed = tool.parseArgs(args)
      return parsed.ok ? (tool.isReadOnly?.(parsed.value) ?? false) : false
    } : undefined,
    async execute(args: unknown, exec: ToolRunContext): Promise<SgToolOutputValue> {
      const guard = guardFor(exec.agent?.ctx ?? undefined)
      return runGuardedTool(tool, args, exec, guard)
    },
  }
}

function selectTools(config: SgToolsConfig | undefined): Tool[] {
  const want = config?.tools ?? 'all'
  if (want === 'all' || (Array.isArray(want) && want.includes('all' as SgToolName))) {
    return Object.values(SG_TOOLS)
  }
  if (want === 'read' || (Array.isArray(want) && want.includes('read' as SgToolName))) {
    return Object.values(SG_TOOLS).filter(tool => tool.isReadOnly?.({}) ?? false)
  }
  const names = new Set(Array.isArray(want) ? want : [want])
  return Object.entries(SG_TOOLS)
    .filter(([name]) => names.has(name as SgToolName))
    .map(([, tool]) => tool)
}

/** Cordis plugin entry: register the selected tools into the DSH tools registry. */
export const name = 'sg-tools'
export const inject = ['tools'] as const

export function apply(ctx: Context, config?: SgToolsConfig) {
  const disposers: Array<() => void> = []
  for (const tool of selectTools(config)) {
    disposers.push(ctx.tools.register(adaptTool(tool)))
  }
  ctx.logger.info?.(`[sg-tools] registered ${disposers.length} tools`)
  // Reverse-order disposer (COGNITION §6.3).
  return () => { for (const dispose of disposers.reverse()) dispose() }
}