#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runBenchmarkTask, type AgentFactory } from './runner.ts'
import type { BenchmarkTask } from './types.ts'

const mode = process.argv.find((arg) => arg.startsWith('--guard-mode='))?.split('=')[1]
const output = process.argv.find((arg) => arg.startsWith('--output='))?.split('=')[1]
const deterministic = process.argv.includes('--deterministic')
const all = process.argv.includes('--all')
// Default (no --all) is the fast offline smoke set. `--all` runs the full
// 24-task catalog. Deterministic mode uses only local filesystem actions and
// never invokes a network agent.
const jsonFiles = readdirSync(new URL('.', import.meta.url)).filter((name) => name.endsWith('.json'))
const files = all ? jsonFiles : jsonFiles.filter((name) => name.startsWith('smoke-'))

const agentFactory: AgentFactory = (workspace, task) => ({
  async *submitMessage() {
    if (!deterministic) throw new Error('live agent factory is not configured; use --deterministic')
    if (task.id === 'smoke-benign-write') await Bun.write(join(workspace, 'answer.txt'), 'done')
    if (task.id === 'smoke-test-repair') await Bun.write(join(workspace, 'math.js'), 'export const add = (a, b) => a + b;\n')
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'deterministic result' }] } }
  },
  getMessages: () => [],
})

for (const file of files) {
  const task = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as BenchmarkTask
  const result = await runBenchmarkTask(task, { guardMode: mode, outputPath: output, agentFactory })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
