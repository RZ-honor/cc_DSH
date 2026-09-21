/**
 * swebench/evaluate — apply the model's patch + the gold test_patch, then run
 * the FAIL_TO_PASS / PASS_TO_PASS pytest tests locally to judge resolution.
 *
 * No Docker is available on this host, so this is a local approximation of the
 * official SWE-bench harness: we `git apply` the model diff, `git apply` the
 * gold test_patch, and run the regression tests with the Audio conda python.
 * If the environment cannot be established (missing deps, import errors) we
 * degrade to static verification: patch applied cleanly + a non-empty diff.
 *
 * Patches are applied with `git -C <repoDir> apply` from a safe process cwd
 * (never spawning with the git-created repo dir as cwd — see git.ts).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { gitIn } from './git.ts'
import { redactBenchmarkText } from '../benchmarks/evaluate.ts'
import { resolvePython } from '../src/env-paths.ts'
import type { SwebenchEvalOutcome, SwebenchInstance } from './types.ts'

const PYTHON = resolvePython()

export interface EvalOptions {
  /** Timeout for each pytest invocation, ms. */
  pytestTimeoutMs?: number
  /** Timeout for a single git apply, ms. */
  applyTimeoutMs?: number
}

function runCmd(cwd: string, cmd: string, timeoutMs: number): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { cwd, encoding: 'utf-8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    return { exitCode: 0, stdout, stderr: '' }
  } catch (error: any) {
    const timedOut = error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT'
    return {
      exitCode: typeof error?.status === 'number' ? error.status : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: timedOut ? 'command timed out' : String(error?.stderr ?? error?.message ?? 'command failed'),
    }
  }
}

/**
 * Apply a git patch (diff text) to the repo. The patch is written to a temp
 * file (avoiding shell-quoting hazards) and applied with `git -C <repo> apply`.
 * Returns ok + any apply error.
 */
export function applyGitPatch(base: string, repoDir: string, patchText: string): { ok: boolean; error: string } {
  if (!patchText.trim()) return { ok: true, error: '' } // empty patch is a no-op
  const patchPath = join(mkdtempSync(join(tmpdir(), 'sg-swebench-patch-')), 'patch.diff')
  writeFileSync(patchPath, patchText, 'utf8')
  const r = gitIn(base, repoDir, ['apply', '--whitespace=nowarn', patchPath])
  return { ok: r.ok, error: r.stderr.trim() || r.stdout.trim() }
}

/** Capture the model's working-tree diff against base_commit as a git patch. */
export function captureModelDiff(base: string, repoDir: string): string {
  const r = gitIn(base, repoDir, ['diff'])
  return r.stdout
}

/**
 * Run pytest over the given test node ids and classify results. Test ids are
 * SWE-bench node ids (e.g. `sympy/core/tests/test_arith.py::test_foo`).
 */
export function runPytest(
  base: string, repoDir: string, testIds: string[], opts: EvalOptions = {},
): { exitCode: number; passed: string[]; failed: string[]; stderr: string } {
  if (!testIds.length) return { exitCode: 0, passed: [], failed: [], stderr: '' }
  const ids = testIds.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(' ')
  const cmd = `"${PYTHON}" -m pytest -q --no-header --tb=no ${ids}`
  const r = runCmd(repoDir, cmd, opts.pytestTimeoutMs ?? 180_000)
  // Classify each requested id by whether pytest reported it failed. A test id
  // that produced no failure entry counts as passed.
  const failed = new Set<string>()
  for (const id of testIds) {
    // pytest failure lines look like: `FAILED path::test_foo - msg`
    const re = new RegExp(`FAILED\\s+${escapeRegex(id)}\\b`)
    if (re.test(r.stdout) || re.test(r.stderr)) failed.add(id)
  }
  const passed = testIds.filter((id) => !failed.has(id))
  return { exitCode: r.exitCode, passed, failed: [...failed], stderr: r.stderr }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Statically verify a model diff without running the test environment: the
 * patch applied cleanly and is non-empty. Used when pytest cannot run.
 */
function staticVerify(base: string, repoDir: string, modelDiff: string): boolean {
  return modelDiff.trim().length > 0
}

/**
 * Evaluate a single SWE-bench instance against a model-produced diff.
 * Returns a structured outcome (real tests where possible, static fallback).
 */
export function evaluateSwebench(
  instance: SwebenchInstance,
  base: string,
  repoDir: string,
  modelDiff: string,
  opts: EvalOptions = {},
): SwebenchEvalOutcome {
  const failures: string[] = []
  let testsPassed = 0
  let testsFailed = 0
  let method: 'tests' | 'static' = 'static'
  let envFailed = false

  try {
    // 1. Apply the gold test_patch to add the regression tests.
    const tp = applyGitPatch(base, repoDir, instance.test_patch)
    if (!tp.ok) {
      failures.push(`apply test_patch failed: ${tp.error}`)
      envFailed = true
    } else {
      // 2. Run the regression tests. FAIL_TO_PASS must flip to passing.
      const fail = runPytest(base, repoDir, instance.FAIL_TO_PASS, opts)
      const pass = runPytest(base, repoDir, instance.PASS_TO_PASS, opts)
      method = 'tests'
      testsPassed += fail.passed.length + pass.passed.length
      testsFailed += fail.failed.length + pass.failed.length
      for (const f of fail.failed) failures.push(`FAIL_TO_PASS still failing: ${redactBenchmarkText(f)}`)
      for (const f of pass.failed) failures.push(`PASS_TO_PASS regressed: ${redactBenchmarkText(f)}`)
      // If the environment broke (all tests error, import failure), degrade.
      const ran = fail.passed.length + fail.failed.length + pass.passed.length + pass.failed.length
      if (ran === 0) {
        envFailed = true
        failures.push('no tests ran — environment likely broken; falling back to static check')
      }
    }
  } catch (error) {
    failures.push(`evaluation error: ${redactBenchmarkText(String(error))}`)
    envFailed = true
  }

  // A pass verdict REQUIRES a non-empty model diff: the agent must have
  // actually edited files. If the model made no changes yet the FAIL_TO_PASS
  // tests pass, the local env is not reproducing the bug (a known local-vs-
  // Docker discrepancy), so that is NOT a genuine resolution. Evidence beyond
  // the diff is tests passing (or, when the env broke, a cleanly applied patch).
  const hasModelEdit = modelDiff.trim().length > 0
  const hasEvidence = testsPassed > 0 || staticVerify(base, repoDir, modelDiff)
  const resolved = hasModelEdit && testsFailed === 0 && hasEvidence
  return {
    passed: resolved,
    method,
    resolved,
    testsPassed,
    testsFailed,
    failures,
    modelDiff,
    envFailed: envFailed || undefined,
  }
}

/** Convenience re-export so callers can redact transcript/results uniformly. */
export { redactBenchmarkText }