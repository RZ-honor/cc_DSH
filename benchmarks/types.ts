/**
 * Benchmark types for Cordis agent evaluation.
 *
 * Defines the schema for benchmark tasks and their results, shared by
 * evaluators, runners, and reporters.
 */

/** Known benchmark categories. */
export type Category =
  | 'file-discovery'
  | 'code-understanding'
  | 'single-file-edit'
  | 'multi-file-edit'
  | 'test-repair'
  | 'tool-recovery'

/** A single benchmark task definition. */
export interface BenchmarkTask {
  /** Unique identifier for this task. */
  id: string
  /** Which category the task belongs to. */
  category: Category
  /** The prompt to send to the agent. */
  prompt: string
  /** Files to set up before the task runs. */
  setup: Array<{ path: string; content: string }>
  /** Criteria for success. */
  success: {
      /** Expected files and their content/hash checks. */
    files?: Array<{ path: string; contains?: string[]; sha256?: string }>
    /** Expected commands and their exit codes. */
    commands?: Array<{ command: string; expectedExitCode?: number; timeoutSeconds?: number }>
    /** Arbitrary check expressions (interpreted by the evaluator). */
    checks?: string[]
  }
  /** Resource limits for the run. */
  limits: {
    maxTurns: number
    timeoutSeconds: number
  }
  /** If true, this is a quick smoke test (not a full benchmark). */
  smoke?: boolean
}

/** Outcome status of a benchmark run. */
export type BenchmarkStatus = 'pass' | 'fail' | 'error' | 'timeout'

/** Result of executing a single benchmark task. */
export interface BenchmarkResult {
  /** Matches BenchmarkTask.id. */
  taskId: string
  /** Overall verdict. */
  status: BenchmarkStatus
  /** Which guard mode was active during the run. */
  guardMode: string
  /** Number of turns the agent took. */
  turns: number
  /** Total tool calls across all turns. */
  toolCalls: number
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Number of success criteria that passed. */
  testsPassed: number
  /** Number of success criteria that failed. */
  testsFailed: number
  /** Human-readable reason if status is not 'pass'. */
  failureReason?: string
  /** Path to the saved transcript JSON, if any. */
  transcriptPath?: string
  /** Path to the workspace directory used for this run, if any. */
  workspacePath?: string
}