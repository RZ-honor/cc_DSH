import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateTask, redactBenchmarkText, buildResult } from '../benchmarks/evaluate.ts'
import type { BenchmarkTask } from '../benchmarks/types.ts'

describe('evaluateTask', () => {
  test('passes when file text and SHA-256 checks match', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
    writeFileSync(join(cwd, 'answer.txt'), 'correct content')
    const result = await evaluateTask(cwd, {
      files: [{
        path: 'answer.txt',
        contains: ['correct'],
        sha256: '55d731f2fe4bc2dc72f0288f5bc9a594dc3069d1949735fa3f50fde6580012f9',
      }],
      commands: [], checks: [],
    })
    expect(result.passed).toBe(true)
    expect(result.testsFailed).toBe(0)
  })

  test('fails when file SHA-256 does not match', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
    writeFileSync(join(cwd, 'answer.txt'), 'correct content')
    const result = await evaluateTask(cwd, {
      files: [{ path: 'answer.txt', sha256: '0000000000000000000000000000000000000000000000000000000000000000' }],
      commands: [], checks: [],
    })
    expect(result.passed).toBe(false)
    expect(result.failures.join(' ')).toContain('sha256')
  })
  test('fails when expected file is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
    const result = await evaluateTask(cwd, {
      files: [{ path: 'missing.txt', contains: [] }],
      commands: [], checks: [],
    })
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain('missing.txt')
  })

  test('fails on path escape', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
    await expect(evaluateTask(cwd, {
      files: [{ path: '../etc/passwd', contains: [] }],
      commands: [], checks: [],
    })).rejects.toThrow('path escape')
  })

  test('rejects symlink escape outside workspace', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
    const outside = mkdtempSync(join(tmpdir(), 'sg-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
    symlinkSync(outside, join(cwd, 'linked'), 'junction')
    await expect(evaluateTask(cwd, {
      files: [{ path: 'linked/secret.txt', contains: ['TOP SECRET'] }],
      commands: [], checks: [],
    })).rejects.toThrow('path escape')
  })

  test('redacts sensitive values from direct evaluator failures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
    const result = await evaluateTask(cwd, {
      files: [],
      commands: [{ command: 'node -e "console.error(\\\"RADON_API_KEY=rc-secret-value\\\"); process.exit(1)"', expectedExitCode: 0 }],
      checks: [],
    })
    expect(result.failures.join(' ')).not.toContain('rc-secret-value')
    expect(result.failures.join(' ')).toContain('<redacted>')
  })
  test('checks command exit code', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
    writeFileSync(join(cwd, 'test.sh'), '#!/usr/bin/env bash\nexit 0\n')
    const result = await evaluateTask(cwd, {
      files: [], commands: [{ command: 'node -e "process.exit(0)"', expectedExitCode: 0 }], checks: [],
    })
    expect(result.passed).toBe(true)
  })

  test('fails on command timeout and reports it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
    const result = await evaluateTask(cwd, {
      files: [], commands: [{ command: 'node -e "setTimeout(() => {}, 1000)"', expectedExitCode: 0, timeoutSeconds: 0.01 }], checks: [],
    })
    expect(result.passed).toBe(false)
    expect(result.failures.join(' ')).toContain('timed out')
  })
  test('fails on wrong command exit code', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
    const result = await evaluateTask(cwd, {
      files: [], commands: [{ command: 'node -e "process.exit(1)"', expectedExitCode: 0 }], checks: [],
    })
    expect(result.passed).toBe(false)
  })
})

describe('redactBenchmarkText', () => {
  test('redacts API keys', () => {
    const text = 'RADON_API_KEY=rc-abc123def456'
    expect(redactBenchmarkText(text)).not.toContain('rc-abc123def456')
    expect(redactBenchmarkText(text)).toContain('<redacted>')
  })

  test('redacts Bearer tokens', () => {
    const text = 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz'
    expect(redactBenchmarkText(text)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(redactBenchmarkText(text)).toContain('<redacted>')
  })

  test('redacts rc- prefixed keys', () => {
    const text = 'key=rc-fakeplaceholder1234567890abcdefghijklmnopqrstuvwxyz012345'
    expect(redactBenchmarkText(text)).toContain('<redacted>')
  })
})

describe('buildResult', () => {
  const task: BenchmarkTask = {
    id: 'test-001', category: 'file-discovery', prompt: 'list files',
    setup: [], success: { files: [], commands: [], checks: [] },
    limits: { maxTurns: 5, timeoutSeconds: 30 },
  }

  test('builds a pass result', () => {
    const r = buildResult(task, 'hardcoded', 1000, 2, 3, { passed: true, failures: [], testsPassed: 1, testsFailed: 0 })
    expect(r.status).toBe('pass')
    expect(r.guardMode).toBe('hardcoded')
    expect(r.turns).toBe(2)
  })

  test('builds a fail result with reason', () => {
    const r = buildResult(task, 'hardcoded', 500, 1, 1, { passed: false, failures: ['file missing'], testsPassed: 0, testsFailed: 1 })
    expect(r.status).toBe('fail')
    expect(r.failureReason).toContain('file missing')
  })
})