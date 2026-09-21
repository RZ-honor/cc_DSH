import { describe, expect, test } from 'bun:test'

import { summarizeLog } from '../src/cli-log.ts'

describe('safe GuardClient diagnostics', () => {
  test('summarizes malformed protocol input without raw payload', () => {
    const raw = '{"text":"secret prompt", "token":"super-secret-token"}'
    const line = summarizeLog('guard-protocol', { category: 'non-json stdout line', length: raw.length })
    expect(line).toBe(`[guard] non-json stdout line (length=${raw.length})`)
    expect(line).not.toContain('secret prompt')
    expect(line).not.toContain('super-secret-token')
  })

  test('summarizes orphan and malformed responses by category only', () => {
    const orphan = summarizeLog('guard-protocol', { category: 'orphan message', length: 123 })
    const malformed = summarizeLog('guard-protocol', { category: 'malformed response', length: 456 })
    expect(orphan).toBe('[guard] orphan message (length=123)')
    expect(malformed).toBe('[guard] malformed response (length=456)')
  })
})
