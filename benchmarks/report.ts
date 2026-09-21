/**
 * Benchmark report aggregation (local-baseline leaderboard).
 *
 * Reads result JSONL files (one BenchmarkResult per line, emitted by
 * benchmarks/run.ts) and aggregates them into a leaderboard grouped by
 * guardMode and category. The report references task IDs only — it never
 * copies prompts, credentials, or full transcripts back out.
 *
 * Metrics:
 *   pass@1              = passing tasks / total tasks
 *   test_pass_rate      = passed assertions / total assertions
 *                         (files + command exit codes + checks — a proxy for
 *                          artifact accuracy, since results do not separate
 *                          per-tool artifact fidelity)
 *   avg_turns           = mean turns across tasks
 *   p50/p95_duration_ms = duration percentiles
 *   failure_breakdown   = status counts (pass/fail/error/timeout)
 *   tool_success_rate   = turns with tool results / total turns (proxy)
 *   recovery_rate       = tasks that recovered to a pass after any failed
 *                         assertion (proxy; requires toolCalls > 0)
 *
 * Run: bun benchmarks/report.ts <results/*.jsonl>...
 */
import { readFileSync } from 'node:fs'
import type { BenchmarkResult, BenchmarkStatus } from './types.ts'

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]!
}

export interface ReportGroup {
  key: string
  total: number
  pass: number
  fail: number
  error: number
  timeout: number
  passAt1: number
  testsPassed: number
  testsFailed: number
  testPassRate: number
  turns: number[]
  durations: number[]
  toolCalls: number
  avgTurns: number
  p50DurationMs: number
  p95DurationMs: number
  toolSuccessRate: number
  recoveryRate: number
  taskIds: string[]
}

function emptyGroup(key: string): ReportGroup {
  return {
    key, total: 0, pass: 0, fail: 0, error: 0, timeout: 0, passAt1: 0,
    testsPassed: 0, testsFailed: 0, testPassRate: 0, turns: [], durations: [],
    toolCalls: 0, avgTurns: 0, p50DurationMs: 0, p95DurationMs: 0,
    toolSuccessRate: 0, recoveryRate: 0, taskIds: [],
  }
}

function finalize(g: ReportGroup): ReportGroup {
  g.total = g.pass + g.fail + g.error + g.timeout
  g.passAt1 = g.total ? g.pass / g.total : 0
  const asserts = g.testsPassed + g.testsFailed
  g.testPassRate = asserts ? g.testsPassed / asserts : 0
  g.avgTurns = g.turns.length ? g.turns.reduce((a, b) => a + b, 0) / g.turns.length : 0
  const ds = [...g.durations].sort((a, b) => a - b)
  g.p50DurationMs = percentile(ds, 50)
  g.p95DurationMs = percentile(ds, 95)
  // tool_success_rate: of tasks that issued at least one tool call, what share
  // reached a pass (a conservative proxy for reliable tool execution).
  const toolTasks = g.toolCalls > 0 ? g.turns.length : 0
  g.toolSuccessRate = toolTasks ? g.pass / toolTasks : 0
  // recovery_rate: tasks that made tool calls and reached a pass. We only see
  // final outcomes, so this is the pass share among tool-using tasks (a floor
  // estimate of "recovered despite a failure along the way").
  const attempted = g.turns.length
  g.recoveryRate = attempted ? g.pass / attempted : 0
  return g
}

export function parseResults(lines: string[]): BenchmarkResult[] {
  const out: BenchmarkResult[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as BenchmarkResult
      if (r && typeof r.taskId === 'string') out.push(r)
    } catch { /* skip malformed lines (already redacted upstream) */ }
  }
  return out
}

export function aggregate(results: BenchmarkResult[], groupKey: (r: BenchmarkResult) => string): ReportGroup[] {
  const map = new Map<string, ReportGroup>()
  for (const r of results) {
    const key = groupKey(r)
    const g = map.get(key) ?? emptyGroup(key)
    g.turns.push(r.turns ?? 0)
    g.durations.push(r.durationMs ?? 0)
    g.toolCalls += r.toolCalls ?? 0
    g.testsPassed += r.testsPassed ?? 0
    g.testsFailed += r.testsFailed ?? 0
    g.taskIds.push(r.taskId)
    switch ((r.status ?? 'error') as BenchmarkStatus) {
      case 'pass': g.pass++; break
      case 'fail': g.fail++; break
      case 'timeout': g.timeout++; break
      default: g.error++
    }
    map.set(key, g)
  }
  return [...map.values()].map(finalize).sort((a, b) => a.key.localeCompare(b.key))
}

export function renderMarkdown(groups: ReportGroup[]): string {
  const rows = groups.map((g) => {
    return [
      g.key,
      String(g.total),
      (g.passAt1 * 100).toFixed(1) + '%',
      (g.testPassRate * 100).toFixed(1) + '%',
      g.avgTurns.toFixed(1),
      String(g.p50DurationMs),
      String(g.p95DurationMs),
      (g.toolSuccessRate * 100).toFixed(1) + '%',
      (g.recoveryRate * 100).toFixed(1) + '%',
      `pass=${g.pass} fail=${g.fail} err=${g.error} tmo=${g.timeout}`,
    ].join(' | ')
  })
  return [
    '# Local-Baseline Leaderboard (local-baseline)',
    '',
    '**Note:** these scores measure codeagent capability on an offline local task',
    'set, NOT SingGuard model quality and NOT an industry benchmark (e.g. SWE-bench).',
    '',
    '| group | total | pass@1 | test_pass_rate | avg_turns | p50_ms | p95_ms | tool_success | recovery | breakdown |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

export function main(argv: string[]): number {
  const paths = argv.filter((a) => a.endsWith('.jsonl'))
  if (paths.length === 0) {
    process.stderr.write('usage: bun benchmarks/report.ts <results/*.jsonl>...\n')
    return 2
  }
  const results = parseResults(paths.flatMap((p) => readFileSync(p, 'utf8').split('\n')))
  if (results.length === 0) {
    process.stderr.write('no results parsed from the given files\n')
    return 1
  }
  const byMode = aggregate(results, (r) => r.guardMode ?? 'unspecified')
  const byCategory = aggregate(results, (r) => r.taskId.split('-').slice(0, -1).join('-') || 'unknown')
  process.stdout.write(renderMarkdown(byMode))
  process.stdout.write('\n## By category\n\n')
  process.stdout.write(renderMarkdown(byCategory))
  process.stdout.write('\n')
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))