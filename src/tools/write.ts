/**
 * Write/Edit — change tools. They run BEHIND the SingGuard double-gate (the
 * query-side gate on `auditText`, the response-side gate on `sensitiveContent`
 * = the exact content/patch before the file changes). `isReadOnly` is false
 * (default), so the gates always run before `call` — a guard block means the
 * file is NEVER touched (COGNITION §3 response-side gate).
 *
 * Path resolution is relative to the tool-context cwd; v1 standalone allows
 * absolute paths. The DSH fs-sandbox (workspace-write) confines writes when
 * mounted; the guard catches dangerous content (reverse shell, secrets) here.
 */
import { resolve } from 'node:path'

import { buildTool, type Tool } from './tool.ts'
import { READ_ONLY_TOOLS } from './read-only.ts'

const textBlock = (text: string) => ({ type: 'text' as const, text })
const errResult = (msg: string) => ({ content: [textBlock(msg)], isError: true })
const safeFailure = (kind: string) => `${kind} failed (details redacted)`

export const Write: Tool<{ file_path: string; content: string }> = buildTool<{ file_path: string; content: string }>({
  name: 'Write',
  description: 'Write content to a file (creates/overwrites). Guarded: the content is response-side audited before the file changes.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or cwd-relative path.' },
      content: { type: 'string', description: 'The full file content to write.' },
    },
    required: ['file_path', 'content'],
  },
  // isReadOnly defaults to false — the gates run.
  auditText: (i) => `write ${i.file_path}`,
  sensitiveContent: (i) => i.content,
  parseArgs: (raw) => {
    const r = raw as { file_path?: unknown; content?: unknown }
    return typeof r?.file_path === 'string' && r.file_path.length > 0 && typeof r?.content === 'string'
      ? { ok: true, value: { file_path: r.file_path, content: r.content } }
      : { ok: false, error: 'file_path (non-empty) and content (string) are required' }
  },
  call: async (input, ctx) => {
    const path = resolve(ctx.cwd, input.file_path)
    try {
      await Bun.write(path, input.content)
      return { content: [textBlock(`wrote ${input.content.length} bytes to ${path}`)] }
    } catch (e) {
      return errResult(safeFailure('write'))
    }
  },
})

export const Edit: Tool<{ file_path: string; old_string: string; new_string: string; replace_all?: boolean }> = buildTool({
  name: 'Edit',
  description: 'Replace old_string with new_string in a file. Errors if old_string is not found. Guarded: new_string is response-side audited before the change.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace (must exist).' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default first only).' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  auditText: (i) => `edit ${i.file_path}`,
  sensitiveContent: (i) => i.new_string,
  parseArgs: (raw) => {
    const r = raw as { file_path?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown }
    if (typeof r?.file_path !== 'string' || !r.file_path) return { ok: false, error: 'file_path required' }
    if (typeof r?.old_string !== 'string' || typeof r?.new_string !== 'string') return { ok: false, error: 'old_string and new_string required' }
    return { ok: true, value: { file_path: r.file_path, old_string: r.old_string, new_string: r.new_string, replace_all: typeof r.replace_all === 'boolean' ? r.replace_all : false } }
  },
  call: async (input, ctx) => {
    const path = resolve(ctx.cwd, input.file_path)
    try {
      const original = await Bun.file(path).text()
      if (!original.includes(input.old_string)) {
        return errResult(`old_string not found in ${path}`)
      }
      const updated = input.replace_all
        ? original.split(input.old_string).join(input.new_string)
        : original.replace(input.old_string, input.new_string)
      await Bun.write(path, updated)
      return { content: [textBlock(`edited ${path}`)] }
    } catch (e) {
      return errResult(safeFailure('edit'))
    }
  },
})

export const WRITE_TOOLS: Tool[] = [Write, Edit]

/** Full tool set: read-only + guarded write/edit. */
export const ALL_TOOLS: Tool[] = [...READ_ONLY_TOOLS, ...WRITE_TOOLS]
