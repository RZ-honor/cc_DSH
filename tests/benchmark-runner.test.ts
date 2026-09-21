import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BenchmarkTask } from '../benchmarks/types.ts'
import { runBenchmarkTask, materializeWorkspace, type BenchmarkAgent } from '../benchmarks/runner.ts'

const readTask: BenchmarkTask = {
  id: 'smoke-read', category: 'file-discovery', prompt: 'inspect files', setup: [{ path: 'note.txt', content: 'hello' }],
  success: { files: [{ path: 'note.txt', contains: ['hello'] }] }, limits: { maxTurns: 2, timeoutSeconds: 5 }, smoke: true,
}
const writeTask: BenchmarkTask = {
  id: 'smoke-write', category: 'single-file-edit', prompt: 'write answer', setup: [],
  success: { files: [{ path: 'answer.txt', contains: ['done'] }] }, limits: { maxTurns: 2, timeoutSeconds: 5 }, smoke: true,
}
const fakeAgent = (action?: (workspace: string) => void): ((workspace: string, task: BenchmarkTask) => BenchmarkAgent) =>
  (workspace, task) => ({
    async *submitMessage() { action?.(workspace); yield { type: 'assistant', message: { content: [{ type: 'text', text: `completed ${task.id}` }] } } as any; return { reason: 'completed', turnCount: 1, messages: [] } as any },
    getMessages: () => [],
  })

describe('benchmark runner', () => {
  test('materializes setup into a temporary workspace', () => {
    const workspace = materializeWorkspace(readTask)
    expect(existsSync(join(workspace, 'note.txt'))).toBe(true)
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('hello')
  })

  test('injects the agent factory and writes a redacted JSONL result', async () => {
    const output = join(mkdtempSync(join(tmpdir(), 'sg-result-')), 'results.jsonl')
    let called = false
    const result = await runBenchmarkTask(writeTask, {
      guardMode: 'hardcoded', outputPath: output,
      agentFactory: (workspace, task) => { called = task.id === writeTask.id; return fakeAgent((cwd) => { writeFileSync(join(cwd, 'answer.txt'), 'done RADON_API_KEY=rc-secret-value') })(workspace, task) },
    })
    expect(called).toBe(true)
    expect(result.status).toBe('pass')
    const line = readFileSync(output, 'utf8')
    expect(line).toContain('smoke-write')
    expect(line).not.toContain('rc-secret-value')
  })

  test('runs hardcoded mode without network access', async () => {
    const result = await runBenchmarkTask(readTask, { guardMode: 'hardcoded', agentFactory: fakeAgent() })
    expect(result.status).toBe('pass')
    expect(result.guardMode).toBe('hardcoded')
  })

  test('rejects write tasks when no safety mode is provided', async () => {
    await expect(runBenchmarkTask(writeTask, { agentFactory: fakeAgent() })).rejects.toThrow('safety mode')
  })

  test('rejects write tasks with an invalid safety mode', async () => {
    await expect(runBenchmarkTask(writeTask, { guardMode: 'unsafe', agentFactory: fakeAgent() })).rejects.toThrow('invalid guard mode')
  })

  test('rejects write tasks when safety mode is off', async () => {
    await expect(runBenchmarkTask(writeTask, { guardMode: 'off', agentFactory: fakeAgent() })).rejects.toThrow('write task')
  })
})
