/**
 * Unit tests for the framework-agnostic ProjectMemory store + a fast cordis
 * mount smoke test for ctx.sgMemory. The store's recall ranking, dedupe,
 * expiry, and forget are exercised directly; the Service just wraps them.
 */
import { test, expect, describe } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'

import { ProjectMemory, type MemoryFact } from '../src/project-memory.ts'
import { SgMemory } from '../plugins/sg-memory.ts'

const WS = 'D:/proj/x'
const mk = (type: MemoryFact['type'], content: string, over: Partial<MemoryFact> = {}): Omit<MemoryFact, 'id' | 'recordedAt'> & { recordedAt?: number } => ({
  workspace: WS, type, content, ...over,
})

describe('ProjectMemory store', () => {
  test('record stores, recall returns ranked by recency', async () => {
    const m = new ProjectMemory()
    m.record(mk('decision', 'use bun for runtime', { recordedAt: 1_000 }))
    m.record(mk('constraint', 'never touch Audio env', { recordedAt: 2_000 }))
    m.record(mk('verified-fact', 'transformers 5.2 ok', { recordedAt: 3_000 }))
    const out = m.recall(WS, { limit: 10 })
    expect(out).toHaveLength(3)
    // recency-dominant: newest first
    expect(out[0]!.content).toBe('transformers 5.2 ok')
    expect(out.at(-1)!.content).toBe('use bun for runtime')
  })

  test('dedupe by content+type within a workspace', () => {
    const m = new ProjectMemory()
    const r1 = m.record(mk('decision', 'same content'))
    const r2 = m.record(mk('decision', 'same content'))
    const r3 = m.record(mk('constraint', 'same content')) // different type = NOT a dup
    expect(r1.stored).toBe(true)
    expect(r2.stored).toBe(false)
    expect(r2.reason).toBe('duplicate')
    expect(r2.id).toBe(r1.id)
    expect(r3.stored).toBe(true) // same string, different type, stored
    expect(m.view(WS)).toHaveLength(2)
  })

  test('recall keyword relevance biases ranking', () => {
    const m = new ProjectMemory()
    m.record(mk('task-state', 'alpha config set', { recordedAt: 1_000 }))
    m.record(mk('task-state', 'beta config set', { recordedAt: 10_000 })) // newer
    // 'alpha' term: the older alpha fact should outrank the newer beta fact
    const out = m.recall(WS, { text: 'alpha', limit: 2 })
    expect(out[0]!.content).toBe('alpha config set')
  })

  test('recall filters by type', () => {
    const m = new ProjectMemory()
    m.record(mk('decision', 'd', { recordedAt: 1 }))
    m.record(mk('constraint', 'c', { recordedAt: 2 }))
    const out = m.recall(WS, { types: ['constraint'] })
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('constraint')
  })

  test('expiry drops facts past ttl on read', async () => {
    const m = new ProjectMemory()
    m.record(mk('verified-fact', 'ephemeral', { recordedAt: Date.now() - 1000, ttlMs: 100 }))
    m.record(mk('verified-fact', 'permanent', { recordedAt: Date.now() - 1000 }))
    const out = m.recall(WS, { limit: 10 })
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('permanent')
  })

  test('forget removes a fact by id', () => {
    const m = new ProjectMemory()
    const r = m.record(mk('constraint', 'drop me'))
    expect(m.forget(WS, r.id)).toBe(true)
    expect(m.view(WS)).toHaveLength(0)
    expect(m.forget(WS, r.id)).toBe(false)
  })

  test('rejects empty + too-long content', () => {
    const m = new ProjectMemory()
    expect(m.record(mk('decision', '   ')).reason).toBe('too-long')
    expect(m.record(mk('decision', 'x'.repeat(2001))).reason).toBe('too-long')
  })

  test('isolates facts by workspace', () => {
    const m = new ProjectMemory()
    m.record(mk('decision', 'ws-x fact', { workspace: 'X' } as any))
    expect(m.recall('Y')).toHaveLength(0)
    expect(m.recall('X')).toHaveLength(1)
  })
})

describe('sg-memory Cordis Service (ctx.sgMemory)', () => {
  test('ctx.plugin exposes ctx.sgMemory with working record/recall', async () => {
    const ctx = new Context()
    await ctx.plugin(SgMemory, {})
    expect(ctx.sgMemory).toBeInstanceOf(SgMemory)
    const r = ctx.sgMemory.record(mk('decision', 'via service'))
    expect(r.stored).toBe(true)
    const rec = ctx.sgMemory.recall(WS)
    expect(rec).toHaveLength(1)
    expect(rec[0]!.content).toBe('via service')
  })
})
