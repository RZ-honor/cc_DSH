/**
 * Read-only tools: Read / Glob / Grep (no writes — `isReadOnly: () => true`).
 *
 * Path resolution is relative to the tool-context cwd. No sandbox confinement
 * in v1 standalone; the DSH fs-sandbox (workspace-write) confines reads when
 * mounted, and the SingGuard query-side gate catches dangerous reads
 * (e.g. /etc/passwd) once guard gates are wired. Read results are truncated to
 * bound the tool-result tokens returned to the model.
 */
import { resolve } from 'node:path'

import { buildTool, type Tool } from './tool.ts'

const textBlock = (text: string) => ({ type: 'text' as const, text })
const errResult = (msg: string) => ({ content: [textBlock(msg)], isError: true })
const safeFailure = (kind: string) => `${kind} failed (details redacted)`

const READ_MAX = 50_000
const GLOB_MAX = 200
const GREP_MAX = 100

export const Read: Tool<{ file_path: string }> = buildTool<{ file_path: string }>({
  name: 'Read',
  description: 'Read a file from the workspace. Returns the file text (truncated to 50KB).',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'Absolute or cwd-relative path.' } },
    required: ['file_path'],
  },
  isReadOnly: () => true,
  parseArgs: (raw) => {
    const fp = (raw as { file_path?: unknown })?.file_path
    return typeof fp === 'string' && fp.length > 0
      ? { ok: true, value: { file_path: fp } }
      : { ok: false, error: 'file_path (non-empty string) is required' }
  },
  call: async (input, ctx) => {
    const path = resolve(ctx.cwd, input.file_path)
    try {
      const file = Bun.file(path)
      if (!(await file.exists())) return errResult(`file not found: ${path}`)
      const text = await file.text()
      const truncated = text.length > READ_MAX
        ? text.slice(0, READ_MAX) + `\n…[truncated ${text.length - READ_MAX} chars]`
        : text
      return { content: [textBlock(truncated)] }
    } catch (e) {
      return errResult(safeFailure('read'))
    }
  },
})

export const Glob: Tool<{ pattern: string }> = buildTool<{ pattern: string }>({
  name: 'Glob',
  description: 'Find files matching a glob pattern (relative to cwd). Returns up to 200 paths.',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string', description: 'e.g. "src/**/*.ts"' } },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  parseArgs: (raw) => {
    const p = (raw as { pattern?: unknown })?.pattern
    return typeof p === 'string' && p.length > 0
      ? { ok: true, value: { pattern: p } }
      : { ok: false, error: 'pattern (non-empty string) is required' }
  },
  call: async (input, ctx) => {
    try {
      const glob = new Bun.Glob(input.pattern)
      const matches: string[] = []
      for await (const p of glob.scan({ cwd: ctx.cwd, onlyFiles: true })) {
        matches.push(p)
        if (matches.length >= GLOB_MAX) break
      }
      return { content: [textBlock(matches.length ? matches.join('\n') : '(no matches)')] }
    } catch (e) {
      return errResult(safeFailure('glob'))
    }
  },
})

export const Grep: Tool<{ pattern: string; glob?: string }> = buildTool<{ pattern: string; glob?: string }>({
  name: 'Grep',
  description: 'Search file contents with a regex. Returns matching lines as path:line:line (up to 100).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regex.' },
      glob: { type: 'string', description: 'File glob to search (default **/*).' },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  parseArgs: (raw) => {
    const p = (raw as { pattern?: unknown })?.pattern
    return typeof p === 'string' && p.length > 0
      ? { ok: true, value: { pattern: p, glob: (raw as { glob?: string })?.glob } }
      : { ok: false, error: 'pattern (non-empty string) is required' }
  },
  call: async (input, ctx) => {
    try {
      const re = new RegExp(input.pattern)
      const glob = new Bun.Glob(input.glob ?? '**/*')
      const out: string[] = []
      for await (const p of glob.scan({ cwd: ctx.cwd, onlyFiles: true })) {
        try {
          const text = await Bun.file(resolve(ctx.cwd, p)).text()
          const lines = text.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) out.push(`${p}:${i + 1}: ${lines[i]!.slice(0, 200)}`)
            if (out.length >= GREP_MAX) break
          }
        } catch { /* skip unreadable files */ }
        if (out.length >= GREP_MAX) break
      }
      return { content: [textBlock(out.length ? out.join('\n') : '(no matches)')] }
    } catch (e) {
      return errResult(safeFailure('grep'))
    }
  },
})

/** All read-only tools, ready to register with the execution layer / queryLoop. */
export const READ_ONLY_TOOLS: Tool[] = [Read, Glob, Grep]

/** Explicit capability registry; `isReadOnly` alone is never trusted by execution. */
const TRUSTED_READ_ONLY_SET = new Set<Tool>(READ_ONLY_TOOLS)
export function isTrustedReadOnlyTool(tool: Tool): boolean {
  return TRUSTED_READ_ONLY_SET.has(tool)
}
