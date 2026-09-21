import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { BenchmarkTask, Category } from '../benchmarks/types.ts'

const root = resolve(import.meta.dir, '..')
const benchmarkDir = join(root, 'benchmarks')
const taskFiles = readdirSync(benchmarkDir).filter((name) => name.endsWith('.json'))
const tasks = taskFiles.map((name) => JSON.parse(readFileSync(join(benchmarkDir, name), 'utf8')) as BenchmarkTask)
const categories: Category[] = ['file-discovery', 'code-understanding', 'single-file-edit', 'multi-file-edit', 'test-repair', 'tool-recovery']

describe('benchmark task catalog', () => {
  test('contains 24 tasks with unique ids and four tasks per category', () => {
    expect(tasks).toHaveLength(24)
    expect(new Set(tasks.map((task) => task.id)).size).toBe(24)
    for (const category of categories) expect(tasks.filter((task) => task.category === category)).toHaveLength(4)
  })

  test('marks exactly three smoke tasks', () => {
    expect(tasks.filter((task) => task.smoke === true)).toHaveLength(3)
  })

  test('uses safe relative setup and success paths, bounded limits, and no credentials', () => {
    for (const task of tasks) {
      expect(task.prompt).not.toMatch(/(?:api[_-]?key|token|secret|password|bearer|sk-|rc-)/i)
      expect(task.limits.maxTurns).toBeGreaterThan(0)
      expect(task.limits.timeoutSeconds).toBeGreaterThan(0)
      for (const file of [...task.setup, ...(task.success.files ?? [])]) {
        expect(file.path).not.toMatch(/^(?:[A-Za-z]:[\\/]|[\\/]|\.\.(?:[\\/]|$))/)
        expect(resolve(benchmarkDir, file.path)).toBe(resolve(benchmarkDir, relative(benchmarkDir, resolve(benchmarkDir, file.path))))
        expect(JSON.stringify(file)).not.toMatch(/(?:api[_-]?key|token|secret|password|bearer|sk-|rc-)/i)
      }
    }
  })
})
