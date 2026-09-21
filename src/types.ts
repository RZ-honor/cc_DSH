/**
 * TS protocol types mirroring guard/protocol.py + guard/server.py.
 *
 * Pure data — no cordis/torch dependency. Shared by the standalone GuardClient
 * (Shape A debug) and the future Cordis Service wrapper (Shape B host row).
 *
 * The wire format is newline-delimited JSON-RPC 2.0 over stdio, but NON-standard:
 * responses use `{id, ok:true, result}` or `{id, ok:false, error:{code,message,data?}}`
 * instead of the standard `result`/`error` pair. This file encodes that contract.
 */

/** Side of a classification: input guardrail (query) vs output guardrail (response). */
export type Task = 'query' | 'response'

/** Final sidecar verdict. */
export type Verdict = 'allow' | 'block' | 'review'

/** JSON-RPC error codes (mirror guard/protocol.py ErrorCode). */
export const ErrorCode = {
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  NOT_READY: 'NOT_READY',
  TIMEOUT: 'TIMEOUT',
  INVALID_PARAMS: 'INVALID_PARAMS',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/** One head's evaluation result. */
export interface Risk {
  domain: string
  probability: number
  threshold: number
}

/** A §B hardcoded-rule match. severity 'block' = absolute forbidden, 'review' = force manual. */
export interface HardcodedHit {
  rule_id: string
  severity: 'block' | 'review'
  reason: string
  matched: string | null
}

/** Final sidecar verdict returned to the host. Shape mirrors guard/server.py `_verdict_to_dict`. */
export interface GuardVerdict {
  verdict: Verdict
  task: Task
  risks: Risk[]
  hardcoded: HardcodedHit | null
  analysis: string | null
  model_available: boolean
}

/** `classify` request params. `audit` feeds the hardcoded-rule layer (tool/operation/cwd). */
export const TRUSTED_READ_ONLY = Symbol('sg.guard.trustedReadOnly')

export interface ClassifyParams {
  task: Task
  text: string
  thresholds?: Record<string, number>
  audit?: {
    tool?: string
    operation?: string
    cwd?: string
    trusted?: symbol
  }
  /** INTERNAL (tests only): bypass the host-side hardcoded pre-filter and ask the
   * sidecar directly. Used by the embedding-verification integration tests, whose
   * attack fixtures may coincidentally trip a hardcoded rule but must still reach
   * the model heads to prove extraction. Never set by the guarded tool chain. */
  skipHardcoded?: boolean
}

/** `ping` response. */
export interface PingResult {
  ready: boolean
  model_available: boolean
  /** [domain, task] pairs for every loaded head. */
  heads: [string, Task][]
}

/** Ready notification the sidecar emits on stdout before entering the serve loop. */
export interface ReadyNotification {
  jsonrpc: '2.0'
  method: 'ready'
  params: { ready: boolean; model_available: boolean }
}

/** A failure returned as `{ok:false,error}`. */
export interface JsonRpcError {
  code: ErrorCode
  message: string
  data?: unknown
}

export type GuardMode = 'model' | 'hardcoded' | 'off'

export function parseGuardMode(value: unknown): GuardMode {
  if (value === undefined || value === '') return 'model'
  if (value === 'model' || value === 'hardcoded' || value === 'off') return value
  throw new Error('invalid guard mode (expected model, hardcoded or off)')
}

/**
 * A fail-closed verdict the TS GuardClient synthesizes when the sidecar process
 * is dead, unreachable, or times out. Mirrors the sidecar's own model-unavailable
 * block so callers treat both paths uniformly (COGNITION §B.1).
 */
export function failClosedVerdict(task: Task, reason: string): GuardVerdict {
  return {
    verdict: 'block',
    task,
    risks: [],
    hardcoded: null,
    analysis: `fail-closed: ${reason}`,
    model_available: false,
  }
}
