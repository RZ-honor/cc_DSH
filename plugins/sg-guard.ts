/**
 * sg-guard — DSH host-root Cordis plugin exposing ctx.sgGuard.
 *
 * Wraps the framework-agnostic GuardClient (src/guard-client.ts) as a Cordis
 * Service so other plugin rows (sg-tools, the query/response gates) can inject
 * it via `ctx.inject(['sgGuard'], ...)` or read `ctx.sgGuard` directly.
 *
 * Mounts in the HOST ROOT composition (COGNITION §2) so the sidecar process
 * is a process-global singleton in the ROOT realm — shared across every agent
 * session, never per-session isolated. Preset rows must NOT host this service
 * (the DSH leak audit would reject a root-realm leak from a preset).
 *
 * The sidecar starts in the background on construction (model load is ~1-2 min
 * on MX450) so app boot is not blocked; the first classify awaits readiness.
 *
 * @module sg-agent/plugins/sg-guard
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { GuardClient } from '../src/guard-client.ts'
import type { GuardClientConfig } from '../src/guard-client.ts'
import type { ClassifyParams, GuardVerdict, PingResult, GuardMode } from '../src/types.ts'
import { parseGuardMode, failClosedVerdict } from '../src/types.ts'
import { evaluateHardcoded } from '../src/guard-hardcoded.ts'
import { summarizeLog } from '../src/cli-log.ts'

/** Config validated by Schemastery from the cordis.yml `config:` block. */
export interface SgGuardConfig {
  mode?: GuardMode
  modelPath?: string
  headsDir?: string
  no4bit?: boolean
  condaEnv?: string
  cwd?: string
  classifyTimeoutMs?: number
  startupTimeoutMs?: number
  maxRestarts?: number
  /** Skip background start in the constructor; start lazily on first classify.
   * Lets app boot avoid the slow model load entirely if the guard is never
   * queried, and enables fast mount tests without spawning the sidecar. */
  lazyStart?: boolean
  spawnImpl?: GuardClientConfig['spawnImpl']}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sgGuard: SgGuard
  }
}

/**
 * Host-side owner of the SingGuard sidecar lifecycle. Provides `classify()` /
 * `ping()` and synthesizes fail-closed verdicts when the sidecar is unavailable
 * (the client itself implements fail-closed + bounded restart; this Service
 * just exposes that surface to the rest of the composition).
 */
export class SgGuard extends Service {
  static Config: z<any> = z.object({
    // Path fields are genuinely optional — GuardClient derives them from the
    // project root when absent. Schemastery has no `.optional()`; the idiom is
    // `.required(false)` (optional, no default) vs `.default(x)` (optional+default).
    mode: z.string().default('model'),
    modelPath: z.string().required(false),
    headsDir: z.string().required(false),
    cwd: z.string().required(false),
    no4bit: z.boolean().default(false),
    condaEnv: z.string().default(process.env.SG_CONDA_ENV || 'Audio'),
    classifyTimeoutMs: z.number().default(30_000),
    startupTimeoutMs: z.number().default(240_000),
    maxRestarts: z.number().default(3),
    lazyStart: z.boolean().default(false),
  })

  private readonly client: GuardClient
  private readonly mode: GuardMode
  private startPromise: Promise<void> | null

  constructor(ctx: Context, config: SgGuardConfig = {}) {
    super(ctx, 'sgGuard')
    const log = (m: string) => ctx.logger?.(m) ?? console.error(summarizeLog('error', m))
    this.mode = parseGuardMode(config.mode)
    this.client = new GuardClient({ ...config, mode: this.mode }, log)
    if (this.mode !== 'model') {
      this.startPromise = Promise.resolve()
      return
    }
    // Kick off the slow model load in the background so the composition finishes
    // booting; classify() will await readiness on first use. `lazyStart` defers
    // even the background spawn until first classify (useful for tests and for
    // compositions that may never query the guard).
    if (config.lazyStart) {
      this.startPromise = null
    } else {
      this.startPromise = this.client.start().catch((e: Error) => {
        log(summarizeLog('guard-start-error', { length: e.message.length }))
        return
      })
    }
  }

  /** Whether the sidecar has signaled ready. */
  get ready(): boolean { return this.client.isReady }
  /** Whether the model loaded (false => classify fails closed). */
  get modelAvailable(): boolean { return this.client.isModelAvailable }

  /** Await sidecar readiness (e.g. before a batch of classifications).
   * Under `lazyStart`, the first call triggers the background spawn. */
  async ensureReady(): Promise<boolean> {
      if (this.mode !== 'model') return Promise.resolve(false)
    if (!this.startPromise) {
      const log = (m: string) => this.ctx.logger?.(m) ?? console.error(summarizeLog('error', m))
      this.startPromise = this.client.start().catch((e: Error) => {
        log(summarizeLog('guard-start-error', { length: e.message.length }))
        return
      })
    }
    await this.startPromise
    return this.client.isReady
  }

  /**
   * Classify a tool call. Always returns a GuardVerdict — synthesizes a
   * fail-closed `block` when the sidecar is unavailable/timed out (COGNITION
   * §B.1). See src/guard-client.ts for the full failure semantics.
   */
  classify(params: ClassifyParams): Promise<GuardVerdict> {
    if (params.task !== 'query' && params.task !== 'response') {
      return Promise.reject(new Error(`invalid classify task: ${String(params.task)}`))
    }
    if (this.mode === 'off') {
      return Promise.resolve(failClosedVerdict(params.task, 'guard mode off is fail-closed for direct classification'))
    }
    if (this.mode === 'hardcoded') {
      const hit = evaluateHardcoded({ text: params.text, ...params.audit })
      return Promise.resolve({ verdict: hit?.severity ?? 'allow', task: params.task, risks: [], hardcoded: hit, analysis: hit ? `hardcoded: ${hit.reason}` : null, model_available: false })
    }
    return this.client.classify(params)
  }

  /** Ping the sidecar (throws if not alive / times out). */
  async ping(): Promise<PingResult> {
    await this.startPromise
    return this.client.ping()
  }

  /** Disposer — shut the sidecar down on composition teardown. */
  dispose(): Promise<void> {
    return this.client.shutdown()
  }
}

export default SgGuard
