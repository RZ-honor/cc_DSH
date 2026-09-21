#!/usr/bin/env bun
/**
 * sg-agent print runner (Shape A) — a real end-to-end run against the live
 * radon provider (with das fallback), through the full stack:
 *   dsh-llm (LlmRuntime) + llm-pi-ai (providers from settings) → ctx.llm
 *   → sg-model-route (ctx.sgModel) → QueryEngine → queryLoop → executeTools
 *   (double-gate) → tools (Read/Grep/Glob/Write/Edit) → sg-memory.
 *
 * The SingGuard sidecar (sg-guard) is loaded for real — its classify() feeds
 * the query/response gates. The provider API key is read by llm-pi-ai from
 * the env var named in `apiKeyEnv` (RADON_API_KEY / DAS_API_KEY); this runner
 * NEVER touches the secret value.
 *
 * Usage:
 *   export RADON_API_KEY=...        # required (primary provider)
 *   bun bin/sg-agent.ts "your prompt here"
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as llmPiAiMod from '@deepseek-ai/dsh-llm-pi-ai'

import { SgModel } from '../plugins/sg-model-route.ts'
import { SgGuard } from '../plugins/sg-guard.ts'
import { defaultCondaEnv, defaultModelPath } from '../src/env-paths.ts'
import { parseGuardMode } from '../src/types.ts'
import { parseCliArgs } from '../src/cli.ts'
import { summarizeLog } from '../src/cli-log.ts'
import { QueryEngine } from '../src/query/QueryEngine.ts'
import { ALL_TOOLS } from '../src/tools/write.ts'

// llm-pi-ai is a functional plugin (named exports name/apply/Config); the
// module namespace is the plugin object cordis loads.
const llmPiAi = llmPiAiMod as unknown as Parameters<Context['plugin']>[0]

/** Providers mirror D:\deepseek\.dsh\settings.yaml `llm-pi-ai.providers`. */
const PROVIDERS = {
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

const SYSTEM_PROMPT = `You are sg-agent, a coding assistant in the workspace ${'<cwd>'}.
You can read, search, and (guarded) write files via the Read, Grep, Glob, Write, Edit tools.
A SingGuard safety layer audits sensitive tool calls: if a tool result says
"[SingGuard blocked ...]" it means the guard found the call unsafe. Do NOT
bypass the guard or retry the same dangerous action — choose a safe
alternative that preserves the user's legitimate goal.
Keep answers brief and factual. Verify work by reading it back.`

async function main() {
  const cli = parseCliArgs(process.argv.slice(2), parseGuardMode(process.env.SG_GUARD_MODE ?? process.env.GUARD_MODE))
  const { bootCheck, prompt, guardMode } = cli
  if (!bootCheck) console.error(summarizeLog('prompt', prompt))

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(llmPiAi, { providers: PROVIDERS })
  await ctx.plugin(SgModel, {
    primary: 'radon', primaryModel: 'DeepSeek-V4-Flash',
    fallback: 'das', fallbackModel: 'gpt-5.6-terra',
  })
  // boot-check: lazy-start the guard (no sidecar spawn) so the boot wiring is
  // verified with NO outward model call and NO sidecar model load.
  await ctx.plugin(SgGuard, {
    mode: guardMode,
    modelPath: defaultModelPath(),
    condaEnv: defaultCondaEnv(),
    lazyStart: bootCheck,
  })
  // Verify every service registered (proxy read resolves them).
  const registered = {
    llm: !!ctx.llm,
    sgModel: !!ctx.sgModel,
    sgGuard: !!ctx.sgGuard,
    sgModelProvider: ctx.sgModel?.primaryProvider,
    sgModelModel: ctx.sgModel?.primaryModel,
  }
  console.error('[sg-agent] stack loaded:', JSON.stringify(registered))
  if (bootCheck) {
    console.error('[sg-agent] boot-check OK (no model call, no sidecar)')
    return
  }

  const cwd = process.cwd()
  const system = SYSTEM_PROMPT.replace('<cwd>', cwd)
  const engine = new QueryEngine({
    ctx, system,
    tools: ALL_TOOLS,
    toolCtx: { cwd, guard: ctx.sgGuard },
    maxTurns: 25,
  })

  for await (const ev of engine.submitMessage(prompt)) {
    switch (ev.type) {
      case 'chunk': {
        const c = ev.chunk
        if (c.type === 'text-delta') process.stdout.write(c.text)
        else if (c.type === 'tool-call-delta' && c.name) process.stderr.write(`${summarizeLog('tool-call', { name: c.name })}\n`)
        break
      }
      case 'assistant':
        process.stderr.write('\n')
        break
      case 'tool_results': {
        for (const m of ev.messages) {
          const b = m.content[0] as { type: string; content?: { text?: string }[]; isError?: boolean }
          process.stderr.write(`${summarizeLog('tool-result', { isError: b?.isError })}\n`)
        }
        break
      }
      case 'error':
        process.stderr.write(`${summarizeLog('error', ev.error)}\n`)
        break
    }
  }
  process.stderr.write('[sg-agent] done\n')
}

main().catch(() => {
  console.error('[sg-agent] fatal: operation failed (details redacted)')
  process.exit(1)
})
