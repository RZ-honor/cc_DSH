import { describe, expect, test } from 'bun:test'
import { ALL_TOOLS } from '../src/tools/write.ts'

describe('model-visible tool errors are payload-free', () => {
  test('read-only tool failures omit exception text and raw args', async () => {
    const read = ALL_TOOLS.find((tool) => tool.name === 'Read')!
    const result = await read.call({ file_path: '\u0000secret-token' }, { cwd: 'D:/missing', guard: undefined })
    const text = String(result.content[0]?.text)
    expect(text).toContain('read failed')
    expect(text).not.toContain('secret-token')
  })

  test('tool adapter failures omit raw exception text', async () => {
    const write = ALL_TOOLS.find((tool) => tool.name === 'Write')!
    const result = await write.call({ file_path: '\u0000secret-token', content: 'private payload' }, { cwd: 'D:/missing', guard: undefined })
    const text = String(result.content[0]?.text)
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('private payload')
  })
})
