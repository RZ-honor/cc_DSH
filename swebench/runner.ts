/**
 * swebench/runner — run one SWE-bench instance through the real sg-agent stack
 * (Context + LlmRuntime + llm-pi-ai + SgModel + SgGuard + QueryEngine) and
 * evaluate the model's patch locally.
 *
 * The agent edits files directly (Read/Grep/Glob/Write/Edit; no Bash tool).
 * The SingGuard guard is threaded into the QueryEngine toolCtx so Write/Edit
 * are gated (fail-closed without it). After the agent finishes, the working
 * tree diff is captured and evaluated against the gold FAIL_TO_PASS /
 * PASS_TO_PASS tests via swebench/evaluate.
 *
 * `deterministic` skips the real provider entirely: a fake agent makes no tool
 * calls, so the run exercises prepare + evaluate + result wiring with no API
 * spend and no sidecar. Every result is credential-redacted before writing.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as llmPiAiMod from '@deepseek-ai/dsh-llm-pi-ai'

import { SgModel } from '../plugins/sg-model-route.ts'
import { SgGuard } from '../plugins/sg-guard.ts'
import { defaultCondaEnv, defaultModelPath } from '../src/env-paths.ts'
import { parseGuardMode } from '../src/types.ts'
import { QueryEngine } from '../src/query/QueryEngine.ts'
import { ALL_TOOLS } from '../src/tools/write.ts'
import type { BenchmarkAgent } from '../benchmarks/runner.ts'
import { prepareWorkspace } from './prepare.ts'
import { captureModelDiff, evaluateSwebench } from './evaluate.ts'
import { redactBenchmarkText } from '../benchmarks/evaluate.ts'
import type { SwebenchInstance, SwebenchResult } from './types.ts'

const llmPiAi = llmPiAiMod as unknown as Parameters<Context['plugin']>[0]

/** Providers mirror D:\deepseek\.dsh\settings.yaml `llm-pi-ai.providers`. */
export const PROVIDERS = {
  radon: {
    displayName: 'radon',
    apiKeyEnv: 'RADON_API_KEY',
    api: 'openai-completions',
    baseURL: 'https://developer.amd.com.cn/radeon/api/v1',
    models: [{ id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash', contextWindow: 1048576 }],
  },
  das: {
    displayName: 'das',
    apiKeyEnv: 'DAS_API_KEY',
    api: 'openai-responses',
    baseURL: 'https://dasuapi.com/v1',
    models: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-sol' }],
  },
} as const

export interface SwebenchRunOptions {
  /** Directory holding per-repo clones (see prepare). */
  reposDir?: string
  /** Which guard mode to run with (hardcoded/model/off). */
  guardMode?: string
  /** Resolve a repo owner/name to a clone source (tests inject local sources). */
  cloneUrl?: (repo: string) => string
  /** Max agent turns. */
  maxTurns?: number
  /** If true, run with a fake agent — no provider call, no sidecar. */
  deterministic?: boolean
  /** Timeout for each pytest invocation, ms. */
  pytestTimeoutMs?: number
}

function buildSystem(repoDir: string): string {
  return `You are sg-agent, a coding assistant in the workspace ${repoDir}.
You must resolve the GitHub issue described in PROBLEM.md by editing the
repository files directly with the Read, Grep, Glob, Write, Edit tools. Do NOT
try to output a patch or diff as text — edit the actual files. Do NOT run
commands or install anything; you have no shell. Read PROBLEM.md first, then
read the relevant source, then make the minimal change that fixes the bug.
Do not stop after reading: once you have identified the bug you MUST call
Edit or Write to apply the fix before your final reply. Keep the change
focused and verify it by reading the file back.
A SingGuard safety layer audits sensitive writes: if a tool result says
"[SingGuard blocked ...]" the call was refused — choose a safe alternative
that still fixes the bug.`
}

/** A fake agent for --deterministic: replies but never calls a tool. */
function fakeAgent(): BenchmarkAgent {
  return {
    submitMessage(prompt: string) {
      return (async function* () {
        yield { type: 'assistant', text: 'deterministic (no provider call)' }
        yield { type: 'terminal', response: 'no tool calls in deterministic mode' }
      })()
    },
    getMessages() {
      return []
    },
  }
}

/**
 * Build the real sg-agent stack and return a QueryEngine agent bound to the
 * workspace, with the guard threaded into toolCtx.
 */
function realAgent(
  ctx: Context, repoDir: string, system: string, maxTurns: number,
): BenchmarkAgent {
  const engine = new QueryEngine({
    ctx, system,
    tools: ALL_TOOLS,
    toolCtx: { cwd: repoDir, guard: ctx.sgGuard },
    maxTurns,
  })
  return {
    submitMessage(prompt: string) {
      return engine.submitMessage(prompt)
    },
    getMessages() {
      return engine.getMessages?.() ?? []
    },
  }
}

/** Run one SWE-bench instance and return a credential-redacted result. */
export async function runSwebench(instance: SwebenchInstance, options: SwebenchRunOptions = {}): Promise<SwebenchResult> {
  const guardMode = options.guardMode ?? 'hardcoded'
  const maxTurns = options.maxTurns ?? 25
  const started = Date.now()
  const workspace = prepareWorkspace(instance, {
    reposDir: options.reposDir,
    cloneUrl: options.cloneUrl,
  })

  let turns = 0
  let toolCalls = 0
  let agent: BenchmarkAgent

  if (options.deterministic) {
    agent = fakeAgent()
  } else {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(llmPiAi, { providers: PROVIDERS })
    await ctx.plugin(SgModel, {
      primary: 'radon', primaryModel: 'DeepSeek-V4-Flash',
      fallback: 'das', fallbackModel: 'gpt-5.6-terra',
    })
    await ctx.plugin(SgGuard, {
      mode: parseGuardMode(guardMode),
      modelPath: defaultModelPath(),
      condaEnv: defaultCondaEnv(),
      lazyStart: true,
    })
    const system = buildSystem(workspace.repoDir)
    agent = realAgent(ctx, workspace.repoDir, system, maxTurns)
  }

  try {
    for await (const event of agent.submitMessage(instance.problem_statement)) {
      if (event.type === 'assistant') turns++
      if (event.type === 'tool_results') toolCalls += event.messages?.length ?? 0
    }
  } catch (error) {
    const durationMs = Date.now() - started
    return {
      taskId: instance.instance_id, status: 'error', guardMode, turns, toolCalls, durationMs,
      testsPassed: 0, testsFailed: 0, failureReason: redactBenchmarkText(String(error)),
      workspacePath: workspace.repoDir,
      instance_id: instance.instance_id, repo: instance.repo, base_commit: instance.base_commit,
      evalMethod: 'static', resolved: false,
    }
  }

  const durationMs = Date.now() - started
  const modelDiff = captureModelDiff(workspace.repoDir, workspace.repoDir)
  const outcome = evaluateSwebench(instance, workspace.repoDir, workspace.repoDir, modelDiff, {
    pytestTimeoutMs: options.pytestTimeoutMs,
  })

  const result: SwebenchResult = {
    taskId: instance.instance_id,
    status: outcome.resolved ? 'pass' : 'fail',
    guardMode,
    turns, toolCalls, durationMs,
    testsPassed: outcome.testsPassed, testsFailed: outcome.testsFailed,
    failureReason: outcome.failures.length ? redactBenchmarkText(outcome.failures.join('; ')) : undefined,
    workspacePath: workspace.repoDir,
    instance_id: instance.instance_id,
    repo: instance.repo,
    base_commit: instance.base_commit,
    evalMethod: outcome.method,
    resolved: outcome.resolved,
    modelDiff: modelDiff || undefined,
  }
  return result
}

/** Write one result as a redacted JSONL line. */
export function writeResult(path: string, result: SwebenchResult): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${redactBenchmarkText(JSON.stringify(result))}\n`, { flag: 'a' })
}