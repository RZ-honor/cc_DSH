import { describe, expect, test } from 'bun:test'

import { parseCliArgs } from '../src/cli.ts'

describe('parseCliArgs', () => {
  test('recognizes boot-check without starting a prompt', () => {
    expect(parseCliArgs(['--boot-check'])).toEqual({
      bootCheck: true,
      print: false,
      guardMode: 'model',
      prompt: '',
    })
  })

  test('--print merges all remaining tokens into the prompt', () => {
    expect(parseCliArgs(['--print', 'hello', 'world'])).toEqual({
      bootCheck: false,
      print: true,
      guardMode: 'model',
      prompt: 'hello world',
    })
  })

  test('--print consumes remaining flag-like tokens as prompt text', () => {
    expect(parseCliArgs(['--print', 'hello', '--guard-mode', 'hardcoded'])).toEqual({
      bootCheck: false,
      print: true,
      guardMode: 'model',
      prompt: 'hello --guard-mode hardcoded',
    })
  })

  test('parses hardcoded guard mode and print distinctly', () => {
    expect(parseCliArgs(['--guard-mode', 'hardcoded', '--print', 'check', 'this'])).toEqual({
      bootCheck: false,
      print: true,
      guardMode: 'hardcoded',
      prompt: 'check this',
    })
  })

  test('rejects a missing guard mode value', () => {
    expect(() => parseCliArgs(['--guard-mode'])).toThrow()
  })

  test('rejects --print without a prompt', () => {
    expect(() => parseCliArgs(['--print'])).toThrow('--print requires a prompt')
  })

  test('does not echo invalid guard mode values in errors', () => {
    const secret = 'sk-live-secret-value'
    try {
      parseCliArgs(['--guard-mode', secret])
      throw new Error('expected parser to reject invalid mode')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })

  test('uses SG_GUARD_MODE as the default when no CLI mode is given', () => {
    const previous = process.env.SG_GUARD_MODE
    process.env.SG_GUARD_MODE = 'hardcoded'
    try {
      expect(parseCliArgs(['prompt'])).toEqual({
        bootCheck: false,
        print: false,
        guardMode: 'hardcoded',
        prompt: 'prompt',
      })
    } finally {
      if (previous === undefined) delete process.env.SG_GUARD_MODE
      else process.env.SG_GUARD_MODE = previous
    }
  })

  test('uses GUARD_MODE when SG_GUARD_MODE is unset', () => {
    const previousSg = process.env.SG_GUARD_MODE
    const previousGuard = process.env.GUARD_MODE
    delete process.env.SG_GUARD_MODE
    process.env.GUARD_MODE = 'off'
    try {
      expect(parseCliArgs([]).guardMode).toBe('off')
    } finally {
      if (previousSg === undefined) delete process.env.SG_GUARD_MODE
      else process.env.SG_GUARD_MODE = previousSg
      if (previousGuard === undefined) delete process.env.GUARD_MODE
      else process.env.GUARD_MODE = previousGuard
    }
  })

  test('CLI guard mode takes precedence over environment default', () => {
    const previous = process.env.SG_GUARD_MODE
    process.env.SG_GUARD_MODE = 'hardcoded'
    try {
      expect(parseCliArgs(['--guard-mode', 'off']).guardMode).toBe('off')
    } finally {
      if (previous === undefined) delete process.env.SG_GUARD_MODE
      else process.env.SG_GUARD_MODE = previous
    }
  })
})
