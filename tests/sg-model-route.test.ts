/**
 * Unit test for sg-model-route's primary→fallback logic, using a mock `llm`
 * service (no network, no real provider). Verifies:
 *  - primary success passes through unchanged
 *  - pre-first-chunk primary failure falls back to the fallback provider
 *  - mid-stream primary failure does NOT fall back (no duplicate output)
 *  - no fallback configured + primary failure rethrows
 */
import { test, expect, describe } from 'bun:test'
import { Context, Service } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import { SgModel } from '../plugins/sg-model-route.ts'

/** A fake `llm` service whose stream() behavior is controlled per-provider. */
class MockLlm extends Service {
  // provider -> behavior: 'throw-pre' (throw before yielding), 'throw-mid'
  // (yield one chunk then throw), 'ok' (yield two chunks + finish).
  behaviors: Record<string, 'ok' | 'throw-pre' | 'throw-mid'> = {}
  calls: string[] = []
  constructor(ctx: Context) { super(ctx, 'llm') }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options.provider)
    const b = this.behaviors[options.provider] ?? 'ok'
    if (b === 'throw-pre') throw new Error(`${options.provider} unavailable`)
    if (b === 'throw-mid') {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      throw new Error(`${options.provider} died mid-stream`)
    }
    yield { type: 'text-delta', index: 0, text: 'hello' }
    yield { type: 'finish', reason: 'stop' }
  }
}

async function harness(config: Record<string, unknown> = {}): Promise<{ ctx: Context; mock: MockLlm }> {
  const ctx = new Context()
  await ctx.plugin(MockLlm)
  const mock = ctx.llm as unknown as MockLlm
  await ctx.plugin(SgModel, config as any)
  return { ctx, mock }
}

const collect = async (iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
  const out: StreamChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

describe('sg-model-route fallback', () => {
  test('primary success passes through, fallback provider not called', async () => {
    const { ctx, mock } = await harness({ primary: 'radon', fallback: 'das' })
    mock.behaviors = { radon: 'ok', das: 'ok' }
    const chunks = await collect(ctx.sgModel.stream({ messages: [] as any }))
    expect(mock.calls).toEqual(['radon'])
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toMatchObject({ type: 'finish', reason: 'stop' })
  })

  test('pre-first-chunk primary failure falls back to fallback provider', async () => {
    const { ctx, mock } = await harness({ primary: 'radon', fallback: 'das' })
    mock.behaviors = { radon: 'throw-pre', das: 'ok' }
    const chunks = await collect(ctx.sgModel.stream({ messages: [] as any }))
    expect(mock.calls).toEqual(['radon', 'das'])
    expect(chunks[0]).toMatchObject({ type: 'text-delta', text: 'hello' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  })

  test('mid-stream primary failure does NOT fall back (no duplicate output)', async () => {
    const { ctx, mock } = await harness({ primary: 'radon', fallback: 'das' })
    mock.behaviors = { radon: 'throw-mid', das: 'ok' }
    await expect(collect(ctx.sgModel.stream({ messages: [] as any }))).rejects.toThrow('died mid-stream')
    // Only radon was called — no fallback after a chunk was already yielded.
    expect(mock.calls).toEqual(['radon'])
  })

  test('no fallback configured + primary failure rethrows', async () => {
    const { ctx, mock } = await harness({ primary: 'radon', fallback: '' } as any)
    mock.behaviors = { radon: 'throw-pre' }
    await expect(collect(ctx.sgModel.stream({ messages: [] as any }))).rejects.toThrow('unavailable')
    expect(mock.calls).toEqual(['radon'])
  })
})
