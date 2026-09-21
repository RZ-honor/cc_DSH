#!/usr/bin/env bun
/**
 * swebench/e2e-real — real-inference end-to-end verification WITHOUT GitHub.
 *
 * Builds a local Python repo (buggy `div` + failing regression test), then
 * drives the REAL sg-agent stack directly (Context → LlmRuntime → llm-pi-ai →
 * SgModel → SgGuard(hardcoded) → QueryEngine with guard in toolCtx), printing
 * every event so the agent's actual tool behavior is visible. Then evaluates.
 *
 * Usage: export RADON_API_KEY=... && bun swebench/e2e-real.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as llmPiAiMod from '@deepseek-ai/dsh-llm-pi-ai'
import { SgModel } from '../plugins/sg-model-route.ts'
import { SgGuard } from '../plugins/sg-guard.ts'
import { defaultCondaEnv, defaultModelPath } from '../src/env-paths.ts'
import { QueryEngine } from '../src/query/QueryEngine.ts'
import { ALL_TOOLS } from '../src/tools/write.ts'
import { prepareWorkspace } from './prepare.ts'
import { captureModelDiff, evaluateSwebench } from './evaluate.ts'
import { GIT, sq } from './git.ts'
import type { SwebenchInstance } from './types.ts'

const llmPiAi = llmPiAiMod as unknown as Parameters<Context['plugin']>[0]

function git(cwd: string, args: string[]): number {
  const r = Bun.spawnSync(['bash', '-c', `${sq(GIT)} ${args.map(sq).join(' ')}`], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode ?? -1
}
function gitOut(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(['bash', '-c', `${sq(GIT)} ${args.map(sq).join(' ')}`], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return r.stdout.toString()
}

function makePyRepo(): { dir: string; baseCommit: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sg-e2e-real-'))
  const g = (a: string[]) => git(dir, a)
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  writeFileSync(join(dir, 'calc.py'), 'def div(a, b):\n    return a + b\n')
  writeFileSync(join(dir, 'test_calc.py'), 'import calc\n\ndef test_div():\n    assert calc.div(8, 2) == 4\n')
  g(['add', '.']); g(['commit', '-qm', 'base'])
  const baseCommit = gitOut(dir, ['rev-parse', 'HEAD']).trim()
  return { dir, baseCommit }
}

const SYSTEM = `You are sg-agent, a coding assistant.
You resolve the issue by editing repository files with the Read, Grep, Glob,
Write, Edit tools. Do NOT output a patch as text — edit the actual files.
Do not stop after reading: once you have identified the bug you MUST call
Edit or Write to apply the minimal fix before your final reply. Keep it brief.`

async function main() {
  const src = makePyRepo()
  const reposDir = mkdtempSync(join(tmpdir(), 'sg-e2e-repos-'))
  const instance: SwebenchInstance = {
    instance_id: 'mini__calc-e2e', repo: 'a/b', base_commit: src.baseCommit,
    problem_statement: 'The div() function returns the wrong value. It currently adds its two arguments instead of dividing them. Fix it so that div(8, 2) returns 4.0.',
    hints_text: '', version: '1.0', patch: '', test_patch: '',
    FAIL_TO_PASS: ['test_calc.py::test_div'], PASS_TO_PASS: [],
    environment_setup_commit: '',
  }
  const ws = prepareWorkspace(instance, { reposDir, cloneUrl: () => src.dir })
  console.error(`[e2e-real] src=${src.dir} base=${src.baseCommit.slice(0, 8)} workspace=${ws.repoDir}`)

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(llmPiAi, {
    providers: {
      radon: { displayName: 'radon', apiKeyEnv: 'RADON_API_KEY', api: 'openai-completions', baseURL: 'https://developer.amd.com.cn/radeon/api/v1', models: [{ id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash', contextWindow: 1048576 }] },
    } as any,
  })
  await ctx.plugin(SgModel, { primary: 'radon', primaryModel: 'DeepSeek-V4-Flash' })
  await ctx.plugin(SgGuard, { mode: 'hardcoded', modelPath: defaultModelPath(), condaEnv: defaultCondaEnv(), lazyStart: true })

  const engine = new QueryEngine({
    ctx, system: SYSTEM, tools: ALL_TOOLS,
    toolCtx: { cwd: ws.repoDir, guard: ctx.sgGuard },
    maxTurns: 30,
  })

  let turns = 0
  let toolCalls = 0
  for await (const ev of engine.submitMessage(instance.problem_statement)) {
    if (ev.type === 'chunk') {
      const c = ev.chunk
      if (c.type === 'text-delta') process.stdout.write(c.text)
      else if (c.type === 'tool-call-delta' && c.name) console.error(`  [chunk] tool-call-delta: ${c.name}`)
    } else if (ev.type === 'assistant') {
      turns++
      const blocks = ev.message.content
      const label = (b: (typeof blocks)[number]) => b.type === 'tool-call' ? `tool-call:${b.name}` : b.type
      console.error(`[t${turns}] blocks=${blocks.map(label).join(',')} raw=${JSON.stringify(blocks).slice(0, 260)}`)
    } else if (ev.type === 'tool_results') {
      for (const m of ev.messages) {
        toolCalls++
        const b = m.content[0]
        const isErr = b?.type === 'tool-result' ? !!b.isError : false
        const inner = b?.type === 'tool-result' ? b.content[0] : undefined
        const txt = inner?.type === 'text' ? inner.text : JSON.stringify(b ?? {}).slice(0, 120)
        const callId = m.source.kind === 'tool' ? String(m.source.callId) : '?'
        console.error(`  result(call=${callId.slice(0, 30)}) isErr=${isErr}: ${String(txt).slice(0, 140)}`)
      }
    } else if (ev.type === 'error') {
      console.error(`  ERROR: ${String(ev.error).slice(0, 300)}`)
    }
  }

  const modelDiff = captureModelDiff(ws.repoDir, ws.repoDir)
  const outcome = evaluateSwebench(instance, ws.repoDir, ws.repoDir, modelDiff)
  console.error(`[e2e-real] turns=${turns} toolCalls=${toolCalls}`)
  console.error(`[e2e-real] outcome: resolved=${outcome.resolved} eval=${outcome.method} tests=${outcome.testsPassed}/${outcome.testsPassed + outcome.testsFailed}`)
  if (modelDiff.trim()) {
    console.error(`[e2e-real] model diff (${modelDiff.length}B):`)
    console.error(modelDiff.split('\n').slice(0, 24).join('\n'))
  } else {
    console.error('[e2e-real] NO model diff')
  }
  process.exit(outcome.resolved ? 0 : 1)
}

main().catch((e) => { console.error(`[e2e-real] fatal: ${e?.message ?? e}`); process.exit(1) })