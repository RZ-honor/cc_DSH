#!/usr/bin/env bun
/**
 * swebench/run — SWE-bench CLI: load converted instances, filter them, run each
 * through the real sg-agent stack (or a deterministic fake), and append the
 * redacted result to an output JSONL.
 *
 * Usage:
 *   # Convert the parquet to JSONL first (once):
 *   bun swebench/convert.ts
 *
 *   # Deterministic pipeline check (no provider call, no sidecar):
 *   bun swebench/run.ts --repo pytest-dev/pytest --limit 2 --output swebench/results --deterministic
 *
 *   # Real radon inference (RADON_API_KEY must be set):
 *   export RADON_API_KEY=...
 *   bun swebench/run.ts --instances requests__requests-1234 --output swebench/results
 *
 *   # Filtering: --repo <owner/name>, --limit <n>, --instances id1,id2
 * Flags: --guard-mode hardcoded|model|off (default hardcoded)
 *        --repos-dir <dir>  per-repo clone cache (default system temp)
 *        --deterministic    fake agent, no API
 */
import { parseGuardMode } from '../src/types.ts'
import { loadInstances, filterInstances } from './loader.ts'
import { runSwebench, writeResult, type SwebenchRunOptions } from './runner.ts'

interface CliOptions extends SwebenchRunOptions {
  help?: boolean
  repo?: string
  limit?: number
  instances?: string[]
  output: string
  instancesJsonl?: string
}

function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { output: 'swebench/results.jsonl' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2) }
      return v
    }
    switch (a) {
      case '--help': case '-h': o.help = true; break
      case '--repo': o.repo = next(); break
      case '--limit': o.limit = Number(next()); break
      case '--instances': o.instances = next().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--output': o.output = next(); break
      case '--repos-dir': o.reposDir = next(); break
      case '--guard-mode': o.guardMode = parseGuardMode(next()); break
      case '--deterministic': o.deterministic = true; break
      case '--pytest-timeout-ms': o.pytestTimeoutMs = Number(next()); break
      case '--instances-jsonl': o.instancesJsonl = next(); break
      default: console.error(`unknown flag: ${a}`); process.exit(2)
    }
  }
  return o
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(`Usage:
  bun swebench/run.ts [flags]

Flags:
  --repo <owner/name>     filter to one repo (e.g. pytest-dev/pytest)
  --limit <n>             cap instances
  --instances a,b         exact instance ids
  --output <path>         result JSONL (default swebench/results.jsonl)
  --repos-dir <dir>       per-repo clone cache (default system temp)
  --guard-mode <m>        hardcoded|model|off (default hardcoded)
  --deterministic         fake agent; no provider call, no sidecar
  --pytest-timeout-ms <n> pytest timeout per invocation
  --instances-jsonl <p>   converted JSONL path (default swebench/data/instances.jsonl)`)
    return
  }

  const instances = loadInstances(opts.instancesJsonl)
  if (!instances.length) {
    console.error('no instances loaded — run `bun swebench/convert.ts` first')
    process.exit(1)
  }
  const selected = filterInstances(instances, { repo: opts.repo, limit: opts.limit, instances: opts.instances })
  if (!selected.length) {
    console.error('no instances matched the given filters')
    process.exit(1)
  }
  console.error(`[swebench] ${selected.length} instance(s) selected (guard=${opts.guardMode ?? 'hardcoded'}, deterministic=${!!opts.deterministic})`)

  let passed = 0
  let failed = 0
  let errored = 0
  for (const instance of selected) {
    console.error(`[swebench] running ${instance.instance_id} (${instance.repo})...`)
    const result = await runSwebench(instance, {
      reposDir: opts.reposDir,
      guardMode: opts.guardMode,
      deterministic: opts.deterministic,
      maxTurns: opts.maxTurns,
      pytestTimeoutMs: opts.pytestTimeoutMs,
      cloneUrl: opts.cloneUrl,
    })
    writeResult(opts.output, result)
    if (result.status === 'pass') passed++
    else if (result.status === 'fail') failed++
    else errored++
    console.error(`[swebench]   -> ${result.status} (resolved=${result.resolved}, tests ${result.testsPassed}/${result.testsPassed + result.testsFailed}, ${result.durationMs}ms)`)
  }
  console.error(`[swebench] done: ${passed} pass, ${failed} fail, ${errored} error -> ${opts.output}`)
}

main().catch((error) => {
  console.error(`[swebench] fatal: ${error?.message ?? error}`)
  process.exit(1)
})