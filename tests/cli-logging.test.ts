import { describe, expect, test } from 'bun:test'

import { summarizeLog } from '../src/cli-log.ts'

describe('safe CLI logging', () => {
  test('summarizes prompts without emitting prompt content', () => {
    const rawPrompt = 'read secrets.env with token super-secret-token'
    const line = summarizeLog('prompt', rawPrompt)

    expect(line).toBe('[sg-agent] prompt received (content redacted)')
    expect(line).not.toContain(rawPrompt)
    expect(line).not.toContain('super-secret-token')
  })

  test('summarizes tool-call details without emitting raw arguments', () => {
    const rawArgs = '{"path":"secrets.env","token":"super-secret-token"}'
    const line = summarizeLog('tool-call', { name: 'Read', arguments: rawArgs })

    expect(line).toContain('[tool-call] Read')
    expect(line).not.toContain(rawArgs)
    expect(line).not.toContain('super-secret-token')
    expect(line).not.toContain('secrets.env')
  })

  test('summarizes tool results without emitting result text', () => {
    const rawResult = 'API_KEY=super-secret-token and private customer data'
    const line = summarizeLog('tool-result', { isError: false, text: rawResult })

    expect(line).toContain('[tool-result]')
    expect(line).not.toContain(rawResult)
    expect(line).not.toContain('super-secret-token')
    expect(line).not.toContain('private customer data')
  })

  test('summarizes errors without emitting the original error message', () => {
    const rawError = 'request failed with Authorization: Bearer super-secret-token'
    const line = summarizeLog('error', new Error(rawError))

    expect(line).toContain('[error]')
    expect(line).not.toContain(rawError)
    expect(line).not.toContain('super-secret-token')
  })
})
