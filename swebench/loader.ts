/**
 * swebench/loader — read the converted JSONL into typed instances and apply
 * filter options (repo / limit / exact instance ids).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SwebenchFilter, SwebenchInstance } from './types.ts'

export const INSTANCES_JSONL = join(dirname(fileURLToPath(import.meta.url)), 'data', 'instances.jsonl')

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function coerce(raw: unknown): SwebenchInstance {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    instance_id: String(r.instance_id ?? ''),
    repo: String(r.repo ?? ''),
    base_commit: String(r.base_commit ?? ''),
    problem_statement: String(r.problem_statement ?? ''),
    hints_text: String(r.hints_text ?? ''),
    version: String(r.version ?? ''),
    patch: String(r.patch ?? ''),
    test_patch: String(r.test_patch ?? ''),
    FAIL_TO_PASS: isStringArray(r.FAIL_TO_PASS) ? r.FAIL_TO_PASS : [],
    PASS_TO_PASS: isStringArray(r.PASS_TO_PASS) ? r.PASS_TO_PASS : [],
    environment_setup_commit: String(r.environment_setup_commit ?? ''),
  }
}

/** Read all instances from the JSONL (must be converted first). */
export function loadInstances(jsonlPath: string = INSTANCES_JSONL): SwebenchInstance[] {
  const text = readFileSync(jsonlPath, 'utf8').trim()
  if (!text) return []
  return text.split('\n').filter((l) => l.trim()).map((l) => coerce(JSON.parse(l)))
}

/**
 * Select a subset of instances. Order: exact ids first, then repo filter,
 * then limit. If `instances` is given it wins; otherwise `repo` narrows and
 * `limit` caps.
 */
export function filterInstances(instances: SwebenchInstance[], opts: SwebenchFilter = {}): SwebenchInstance[] {
  let out = instances
  if (opts.instances && opts.instances.length > 0) {
    const want = new Set(opts.instances)
    out = out.filter((i) => want.has(i.instance_id))
  } else if (opts.repo) {
    out = out.filter((i) => i.repo === opts.repo)
  }
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit)
  return out
}