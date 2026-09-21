/**
 * Fast mount test: the SgGuard cordis Service registers and exposes
 * `ctx.sgGuard` WITHOUT spawning the sidecar (lazyStart). The slow
 * sidecar path is covered by tests/guard-client.test.ts; this test
 * verifies only the cordis Service wiring (registration + lazy start +
 * fail-closed when the sidecar can't start).
 */
import { test, expect, describe } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'

import { SgGuard } from '../plugins/sg-guard.ts'

describe('sg-guard Cordis Service registration (no real sidecar)', () => {
  test('ctx.plugin exposes ctx.sgGuard as a SgGuard instance', async () => {
    const ctx = new Context()
    await ctx.plugin(SgGuard, { lazyStart: true })
    expect(ctx.sgGuard).toBeInstanceOf(SgGuard)
    // lazyStart => no background start; client not alive, ready stays false.
    expect(ctx.sgGuard.ready).toBe(false)
    expect(ctx.sgGuard.modelAvailable).toBe(false)
  })

  test('classify() lazily starts and returns fail-closed when sidecar cannot start', async () => {
    // A nonexistent conda env makes `conda run` fail fast without loading the
    // model. classify() must NOT throw — it synthesizes a fail-closed block
    // (COGNITION §B.1) since the sidecar is unavailable.
    const ctx = new Context()
    await ctx.plugin(SgGuard, {
      lazyStart: true,
      condaEnv: '__nonexistent_env_for_test__',
      startupTimeoutMs: 15_000,
      maxRestarts: 1,
    })
    const v = await ctx.sgGuard.classify({ task: 'query', text: 'hi' })
    expect(v.verdict).toBe('block')
    expect(v.model_available).toBe(false)
  }, 120_000)
})
