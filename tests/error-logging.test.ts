import { describe, expect, test } from 'bun:test'

import { parseCliArgs } from '../src/cli.ts'
import { summarizeLog } from '../src/cli-log.ts'

describe('error logging stays payload-free', () => {
  test('unknown flags report category without token', () => {
    expect(() => parseCliArgs(['--secret-token'])).toThrow('unknown flag')
    expect(() => parseCliArgs(['--secret-token'])).not.toThrow('secret-token')
  })

  test('sidecar stderr reports category and line count only', () => {
    expect(summarizeLog('sidecar-stderr', { lines: 3 })).toBe('[sidecar] stderr diagnostics received (lines=3)')
  })

  test('restart failures report category and error length only', () => {
    expect(summarizeLog('restart-error', { length: 42 })).toBe('[guard] restart failed (error-length=42)')
  })

  test('guard startup failures report category and error length only', () => {
    expect(summarizeLog('guard-start-error', { length: 17 })).toBe('[sg-guard] sidecar failed to start (error-length=17)')
  })
})
