import { describe, expect, test, beforeAll } from 'bun:test'
import { existsSync } from 'node:fs'
import { loadInstances, filterInstances, INSTANCES_JSONL } from '../swebench/loader.ts'
import { runConvert } from '../swebench/convert.ts'
import type { SwebenchInstance } from '../swebench/types.ts'

let all: SwebenchInstance[]

beforeAll(async () => {
  // Convert is idempotent but pandas+pyarrow spawn can exceed bun's 5s default
  // hook timeout when the sidecar has just been tearing down. Skip if JSONL
  // already exists; otherwise allow two minutes for the Audio python convert.
  if (!existsSync(INSTANCES_JSONL)) await runConvert()
  all = loadInstances(INSTANCES_JSONL)
}, 120_000)

describe('swebench loader', () => {
  test('converts test parquet to full instance set', () => {
    expect(all.length).toBe(2294)
  })

  test('each instance has the full schema', () => {
    for (const inst of all.slice(0, 20)) {
      expect(inst.instance_id).toBeTruthy()
      expect(inst.repo).toMatch(/\w+\/\w+/)
      expect(inst.base_commit).toMatch(/^[0-9a-f]{40}$/)
      expect(typeof inst.problem_statement).toBe('string')
      expect(typeof inst.patch).toBe('string')
      expect(typeof inst.test_patch).toBe('string')
      expect(typeof inst.version).toBe('string')
      expect(Array.isArray(inst.FAIL_TO_PASS)).toBe(true)
      expect(Array.isArray(inst.PASS_TO_PASS)).toBe(true)
    }
  })

  test('filter by repo returns only that repo', () => {
    const pytest = filterInstances(all, { repo: 'pytest-dev/pytest' })
    expect(pytest.length).toBeGreaterThan(0)
    expect(pytest.every((i) => i.repo === 'pytest-dev/pytest')).toBe(true)
  })

  test('filter by limit returns exact count', () => {
    expect(filterInstances(all, { limit: 5 }).length).toBe(5)
  })

  test('filter by exact instance ids', () => {
    const ids = [all[0]!.instance_id, all[100]!.instance_id]
    const picked = filterInstances(all, { instances: ids })
    expect(picked.map((i) => i.instance_id).sort()).toEqual([...ids].sort())
  })

  test('filter combines repo + limit', () => {
    const r = filterInstances(all, { repo: 'psf/requests', limit: 3 })
    expect(r.length).toBe(3)
    expect(r.every((i) => i.repo === 'psf/requests')).toBe(true)
  })
})

describe('swebench convert', () => {
  test('JSONL file exists and is valid lines', () => {
    const lines = require('node:fs').readFileSync(INSTANCES_JSONL, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2294)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.instance_id).toBeTruthy()
  })
})