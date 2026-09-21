/**
 * queryLoop + QueryEngine unit tests with a mock sgModel (no network).
 *
 * Verifies the minimal print-mode loop: stream → BlockAssembler → assistant
 * message → terminate on no-tool (Phase C); invariant #1 (user message
 * persisted before the first LLM stream); and the model-error terminal.
 */
import { test, expect, describe } from 'bun:test'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

import { QueryEngine } from '../src/query/QueryEngine.ts'
import type { LoopEvent, Terminal } from '../src/query/queryLoop.ts'

/** A mock `sgModel` service whose stream() emits canned chunks. */
class MockSgModel extends Service {
  static Config = z.object({})
  streamCalls = 0
  behavior: 'ok' | 'fail' = 'ok'
  spy: { transcriptLenAtStart: number } = { transcriptLenAtStart: -1 }
  // closure-set before submitMessage so the mock can observe the engine state
  engineRef: { transcript: { length: number } } | null = null
  constructor(ctx: Context) { super(ctx, 'sgModel') }
  get primaryProvider(): string { return 'mock-prov' }
  get primaryModel(): string { return 'mock-model' }
  async *stream(): AsyncIterable<StreamChunk> {
    this.streamCalls++
    if (this.engineRef) this.spy.transcriptLenAtStart = this.engineRef.transcript.length
    if (this.behavior === 'fail') throw new Error('provider down')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Hello world' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } }
    yield { type: 'finish', reason: 'stop' }
  }
}

async function run(prompt: string, behavior: 'ok' | 'fail' = 'ok'): Promise<{ events: LoopEvent[]; term: Terminal }> {
  const ctx = new Context()
  await ctx.plugin(MockSgModel)
  const inst = ctx.sgModel as unknown as MockSgModel
  inst.behavior = behavior
  const engine = new QueryEngine({ ctx, system: 'you are a test assistant' })
  inst.engineRef = engine
  // Use the iterator protocol so we capture the generator's return value
  // (Terminal), which `for await` would discard.
  const events: LoopEvent[] = []
  const iter = engine.submitMessage(prompt)
  let term: Terminal = { reason: 'model_error', turnCount: 0, messages: [] }
  while (true) {
    const r = await iter.next()
    if (r.done) { term = r.value; break }
    events.push(r.value)
  }
  return { events, term }
}

describe('queryLoop (print-mode v1, text-only)', () => {
  test('stream → assistant message → terminal completed', async () => {
    const { events, term } = await run('hi', 'ok')
    // one chunk-stream (4 chunks), one assistant message
    const chunks = events.filter((e) => e.type === 'chunk')
    expect(chunks.length).toBe(4)
    const assistant = events.find((e) => e.type === 'assistant')
    expect(assistant).toBeDefined()
    if (assistant?.type === 'assistant') {
      expect(assistant.message.role).toBe('assistant')
      expect(assistant.message.content.some((b) => b.type === 'text' && (b as any).text === 'Hello world')).toBe(true)
    }
    expect(term.reason).toBe('completed')
  })

  test('invariant #1: user message persisted before the first stream chunk', async () => {
    const mock = new MockSgModel(new Context())
    mock.behavior = 'ok'
    const ctx = new Context()
    await ctx.plugin(MockSgModel)
    const inst = ctx.sgModel as unknown as MockSgModel
    const engine = new QueryEngine({ ctx, system: 's' })
    inst.engineRef = engine
    for await (const _ of engine.submitMessage('hi')) { void _ }
    // The mock captured transcript length at stream start — must be >= 1 (user msg).
    expect(inst.spy.transcriptLenAtStart).toBeGreaterThanOrEqual(1)
    // And the transcript contains the user message.
    expect(engine.transcript.length).toBeGreaterThanOrEqual(1)
    expect(engine.transcript[0]!.role).toBe('user')
  })

  test('model stream error → error event (stream phase), no assistant', async () => {
    const { events, term } = await run('hi', 'fail')
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') {
      expect(err.phase).toBe('stream')
      expect(err.error.message).toBe('provider down')
    }
    expect(events.some((e) => e.type === 'assistant')).toBe(false)
    expect(term.reason).toBe('model_error')
  })
})
