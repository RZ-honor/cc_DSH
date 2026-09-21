import { describe, expect, test } from 'bun:test'
import { parseGuardMode, type GuardMode, failClosedVerdict } from '../src/types.ts'
import { GuardClient } from '../src/guard-client.ts'
import { SgGuard } from '../plugins/sg-guard.ts'
import { evaluateHardcoded } from '../src/guard-hardcoded.ts'
const noSpawn = () => { throw new Error('sidecar must not spawn') }

describe('GuardMode', () => {
  test('defaults missing or empty mode to model', () => {
    expect(parseGuardMode(undefined)).toBe('model')
    expect(parseGuardMode('')).toBe('model')
  })

  test('accepts model, hardcoded and off', () => {
    for (const mode of ['model', 'hardcoded', 'off']) {
      expect(parseGuardMode(mode)).toBe(mode as GuardMode)
    }
  })

  test('rejects unknown mode', () => {
    expect(() => parseGuardMode('unsafe')).toThrow('invalid guard mode')
  })

  test('direct GuardClient hardcoded allows benign text without model', async () => {
    const client = new GuardClient({ mode: 'hardcoded', spawnImpl: noSpawn as any })
    const verdict = await client.classify({ task: 'query', text: 'hello', audit: { tool: 'Bash', operation: 'query', cwd: '.' } })
    expect(verdict.verdict).toBe('allow')
    expect(verdict.model_available).toBe(false)
  })

  test('direct GuardClient hardcoded blocks dangerous commands with a hardcoded hit', async () => {
    const client = new GuardClient({ mode: 'hardcoded', spawnImpl: noSpawn as any })
    const verdict = await client.classify({ task: 'query', text: 'rm -rf /', audit: { tool: 'Bash', operation: 'query', cwd: '.' } })
    expect(verdict.verdict).toBe('block')
    expect(verdict.hardcoded?.rule_id).toBe('HC-FORBID-RMRF-ROOT')
    expect(verdict.model_available).toBe(false)
  })

  test('direct GuardClient off always fail-closes classification', async () => {
    const client = new GuardClient({ mode: 'off', spawnImpl: noSpawn as any })
    const verdict = await client.classify({ task: 'query', text: 'hello', audit: { tool: 'Read', operation: 'query', cwd: '.', trusted: 'read-only' as any } })
    expect(verdict.verdict).toBe('block')
    expect(verdict.model_available).toBe(false)
  })

  test('hardcoded evaluator uses tool operation and cwd metadata', () => {
    expect(evaluateHardcoded({ text: 'hello', tool: 'Write', operation: 'query', cwd: '/etc' })?.severity).toBe('review')
    expect(evaluateHardcoded({ text: 'hello', tool: 'Bash', operation: 'query', cwd: '/workspace' })).toBeNull()
    expect(evaluateHardcoded({ text: 'hello', tool: 'Edit', operation: 'response', cwd: '/etc' })?.severity).toBe('review')
  })

  test('hardcoded mode does not spawn and blocks dangerous commands', async () => {
    const ctx = new (await import('@deepseek-ai/cordis')).Context()
    await ctx.plugin(SgGuard, { mode: 'hardcoded', spawnImpl: noSpawn as any })
    const verdict = await ctx.sgGuard.classify({ task: 'query', text: 'rm -rf /', audit: { tool: 'Bash', operation: 'query', cwd: '.' } })
    expect(verdict.verdict).toBe('block')
    expect(verdict.hardcoded?.rule_id).toBe('HC-FORBID-RMRF-ROOT')
    expect(verdict.model_available).toBe(false)
  })


  test('model mode applies TS metadata rules before sidecar', async () => {
    const client = new GuardClient({ mode: 'model', spawnImpl: noSpawn as any })
    const verdict = await client.classify({ task: 'response', text: 'benign', audit: { tool: 'Write', operation: 'response', cwd: '/etc' } })
    expect(verdict.verdict).toBe('review')
    expect(verdict.hardcoded?.rule_id).toBe('HC-HR-AUDIT-SYSTEM-PATH')
  })

  test('classify rejects invalid task', async () => {
    const client = new GuardClient({ mode: 'hardcoded', spawnImpl: noSpawn as any })
    await expect(client.classify({ task: 'invalid' as any, text: 'hello' })).rejects.toThrow('invalid classify task')
    const ctx = new (await import('@deepseek-ai/cordis')).Context()
    await ctx.plugin(SgGuard, { mode: 'hardcoded', spawnImpl: noSpawn as any })
    await expect(ctx.sgGuard.classify({ task: 'invalid' as any, text: 'hello' })).rejects.toThrow('invalid classify task')
  })

  test('hardcoded mode allows benign text without model', async () => {
    const ctx = new (await import('@deepseek-ai/cordis')).Context()
    await ctx.plugin(SgGuard, { mode: 'hardcoded', spawnImpl: noSpawn as any })
    const verdict = await ctx.sgGuard.classify({ task: 'response', text: 'hello', audit: { tool: 'Write', operation: 'response', cwd: '.' } })
    expect(verdict.verdict).toBe('allow')
    expect(verdict.model_available).toBe(false)
  })


  test('off blocks direct dangerous and forged read metadata', async () => {
    const ctx = new (await import('@deepseek-ai/cordis')).Context()
    await ctx.plugin(SgGuard, { mode: 'off', spawnImpl: noSpawn as any })
    for (const params of [
      { task: 'query' as const, text: 'rm -rf /', audit: { tool: 'Bash', operation: 'query', cwd: '.', trusted: 'read-only' as any } },
      { task: 'query' as const, text: 'x', audit: { tool: 'Read', operation: 'query', cwd: '.', trusted: 'read-only' as any } },
    ]) {
      expect((await ctx.sgGuard.classify(params)).verdict).toBe('block')
    }
  })

  test('off blocks write audit fail-closed', async () => {
    const ctx = new (await import('@deepseek-ai/cordis')).Context()
    await ctx.plugin(SgGuard, { mode: 'off', spawnImpl: noSpawn as any })
    const verdict = await ctx.sgGuard.classify({ task: 'response', text: 'hello', audit: { tool: 'Write', operation: 'response', cwd: '.' } })
    expect(verdict.verdict).toBe('block')
    expect(verdict.model_available).toBe(false)
  })
})
