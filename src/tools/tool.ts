/**
 * Tool contract — minimal mirror of Claude Code's Tool/ToolDef/buildTool +
 * TOOL_DEFAULTS (COGNITION §1.1 / §9).
 *
 * Fail-closed defaults (a tool is treated as a WRITE unless it declares
 * otherwise): `isReadOnly` defaults to false. The read-only execution phase
 * (COGNITION §19 delivery order) denies any tool whose `isReadOnly(input)` is
 * not true — so Read/Grep/Glob declare `isReadOnly: () => true` and pass,
 * while a future Write/Edit (also defaulting false) is denied until the guard
 * gates are wired.
 *
 * The model-facing schema is a plain JSON Schema object (ToolSchema.parameters
 * from dsh-llm); validation is a per-tool `parseArgs` so no schema lib is
 * pulled in for tools.
 */
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ClassifyParams, GuardVerdict } from '../types.ts'

/** Per-call context handed to every tool's `call`. */
export interface ToolCallContext {
  /** Workspace root for path resolution + sandbox confinement. */
  cwd: string
  /** The SingGuard guard, if loaded. Sensitive (non-read-only) tools are gated
   * through `guard.classify`; if absent, sensitive tools fail-closed (block)
   * per COGNITION §B.1. */
  guard?: { classify: (params: ClassifyParams) => Promise<GuardVerdict> }
}

export interface ToolResult {
  /** Content blocks returned to the model (e.g. a text block with file text). */
  content: ContentBlock[]
  isError?: boolean
}

export interface ParseOk<T> { ok: true; value: T }
export interface ParseErr { ok: false; error: string }
export type ParseResult<T> = ParseOk<T> | ParseErr

export interface Tool<I = any> {
  readonly name: string
  readonly description: string
  /** JSON Schema for the model (the `parameters` field of ToolSchema). */
  readonly parameters: Record<string, unknown>
  /** Default false — fail-closed: a tool is a write unless this returns true. */
  readonly isReadOnly?: (input: I) => boolean
  /** Parse + validate raw model arguments (a JSON.parse'd object). */
  readonly parseArgs: (raw: unknown) => ParseResult<I>
  readonly call: (input: I, ctx: ToolCallContext) => Promise<ToolResult>
  /** Text the query-side gate classifies for sensitive tools (default:
   * JSON of the input). Bash overrides with the command; Write with the path+content. */
  readonly auditText?: (input: I) => string
  /** If present, the response-side gate classifies this text (the exact content
   * being written/patched) before the file changes. Write/Edit declare it. */
  readonly sensitiveContent?: (input: I) => string
}

/** Fail-closed defaults — mirror Claude Code's TOOL_DEFAULTS. */
const TOOL_DEFAULTS: Pick<Tool, 'isReadOnly' | 'auditText'> = {
  isReadOnly: () => false,
  auditText: (input: any) => JSON.stringify(input),
}

/** Apply defaults to a tool definition (isReadOnly falls back to false). */
export function buildTool<I>(def: Tool<I>): Tool<I> {
  return { ...TOOL_DEFAULTS, ...def } as Tool<I>
}

/** Convert an sg-agent Tool to the dsh-llm ToolSchema sent to the model. */
export function toToolSchema(tool: Tool): ToolSchema {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}
