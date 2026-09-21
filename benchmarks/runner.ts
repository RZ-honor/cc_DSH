import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { evaluateTask, redactBenchmarkText, buildResult } from './evaluate.ts'
import { parseGuardMode } from '../src/types.ts'
import { QueryEngine } from '../src/query/QueryEngine.ts'
import type { ToolCallContext } from '../src/tools/tool.ts'
import type { BenchmarkResult, BenchmarkTask } from './types.ts'

export interface BenchmarkAgent {
  submitMessage(prompt: string): AsyncGenerator<any, any>
  getMessages(): unknown[]
}
export type AgentFactory = (workspace: string, task: BenchmarkTask) => BenchmarkAgent

export interface RunnerOptions {
  guardMode?: string
  outputPath?: string
  agentFactory: AgentFactory
}

export function materializeWorkspace(task: BenchmarkTask): string {
  const workspace = mkdtempSync(join(tmpdir(), `sg-benchmark-${task.id}-`))
  for (const file of task.setup) {
    const path = resolve(workspace, file.path)
    if (path !== workspace && !path.startsWith(`${workspace}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`setup path escape: ${file.path}`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.content)
  }
  return workspace
}

function taskNeedsSafety(task: BenchmarkTask): boolean {
  return task.category === 'single-file-edit' || task.category === 'multi-file-edit' || task.category === 'test-repair'
}

function writeResult(path: string, result: BenchmarkResult): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${redactBenchmarkText(JSON.stringify(result))}\n`, { flag: 'a' })
}

export async function runBenchmarkTask(task: BenchmarkTask, options: RunnerOptions): Promise<BenchmarkResult> {
  if (taskNeedsSafety(task)) {
    if (!options.guardMode) throw new Error(`write task ${task.id} requires a safety mode`)
    const guardMode = parseGuardMode(options.guardMode)
    if (guardMode === 'off') throw new Error(`write task ${task.id} cannot run with guard mode off`)
  }
  const workspace = materializeWorkspace(task)
  const started = Date.now()
  const agent = options.agentFactory(workspace, task)
  let turns = 0
  let toolCalls = 0
  try {
    for await (const event of agent.submitMessage(task.prompt)) {
      if (event.type === 'assistant') turns++
      if (event.type === 'tool_results') toolCalls += event.messages?.length ?? 0
    }
    const evalOutcome = await evaluateTask(workspace, task.success)
    const result = buildResult(task, options.guardMode ?? 'unspecified', Date.now() - started, turns, toolCalls, evalOutcome, { workspacePath: workspace })
    if (options.outputPath) writeResult(options.outputPath, result)
    return result
  } catch (error) {
    const result = buildResult(task, options.guardMode ?? 'unspecified', Date.now() - started, turns, toolCalls, { passed: false, failures: [String(error)], testsPassed: 0, testsFailed: 1 }, { workspacePath: workspace })
    if (options.outputPath) writeResult(options.outputPath, result)
    return result
  }
}

export function createQueryEngineAgent(ctx: any, workspace: string, task: BenchmarkTask, system: string, tools?: any[], toolCtx?: Partial<ToolCallContext>): BenchmarkAgent {
  // Optional guard passed through so Write/Edit are gated (fail-closed without
  // it). Callers may inject a guard (e.g. ctx.sgGuard) to allow benign edits.
  const engineToolCtx: ToolCallContext = toolCtx?.guard ? { cwd: workspace, guard: toolCtx.guard } : { cwd: workspace }
  return new QueryEngine({ ctx, system, tools, toolCtx: engineToolCtx, maxTurns: task.limits.maxTurns })
}
