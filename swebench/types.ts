/**
 * SWE-bench types — a single instance and its evaluation outcome.
 *
 * Mirror of the official `princeton-nlp/SWE-bench` dataset row, plus the
 * harness result shape. The gold `patch`/`test_patch` are present so the
 * evaluator can (a) verify a model patch's shape and (b) apply the test patch
 * to run FAIL_TO_PASS / PASS_TO_PASS locally. We never feed the gold patch to
 * the model during inference — it is only used for local verification.
 */
import type { BenchmarkResult, BenchmarkStatus } from '../benchmarks/types.ts'

/** One SWE-bench instance (one GitHub issue + gold PR resolution). */
export interface SwebenchInstance {
  /** e.g. `sympy__sympy-20590`. */
  instance_id: string
  /** e.g. `sympy/sympy`. */
  repo: string
  /** 40-char commit hash of repo HEAD before the solution PR. */
  base_commit: string
  /** The issue title + body (the prompt the model must resolve). */
  problem_statement: string
  /** Community hints (may be empty). */
  hints_text: string
  /** Repository package version at the time of the issue. */
  version: string
  /** Gold solution patch (git diff). Used only for local verification. */
  patch: string
  /** Test patch that adds the regression tests. Applied for verification. */
  test_patch: string
  /** Test node ids that must flip from failing to passing. */
  FAIL_TO_PASS: string[]
  /** Test node ids that must keep passing. */
  PASS_TO_PASS: string[]
  /** Commit hash for environment setup (Docker; unused locally). */
  environment_setup_commit: string
}

/** Outcome of a single SWE-bench evaluation. */
export interface SwebenchEvalOutcome {
  passed: boolean
  /** How the verdict was reached: `tests` (real pytest) or `static` (fallback). */
  method: 'tests' | 'static'
  resolved: boolean
  testsPassed: number
  testsFailed: number
  failures: string[]
  /** Model-produced git diff that was applied (empty if none). */
  modelDiff: string
  /** True if local test environment could not be established. */
  envFailed?: boolean
}

/** A finished SWE-bench run result (extends the shared benchmark result). */
export interface SwebenchResult extends BenchmarkResult {
  instance_id: string
  repo: string
  base_commit: string
  evalMethod: 'tests' | 'static'
  resolved: boolean
  modelDiff?: string
}

/** Filter options for selecting a subset of instances to run. */
export interface SwebenchFilter {
  /** Keep only this repo (e.g. `psf/requests`). */
  repo?: string
  /** Keep at most this many instances (after repo/instances filter). */
  limit?: number
  /** Keep exactly these instance ids. */
  instances?: string[]
}

/** Re-export the shared status type for convenience. */
export type { BenchmarkResult, BenchmarkStatus }