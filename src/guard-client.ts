/**
 * GuardClient — Bun/Node client for the SingGuard sidecar.
 *
 * Spawns `conda run -n Audio python -m guard.server`, speaks the non-standard
 * newline-delimited JSON-RPC over stdio (responses use {ok,result}|{ok,error}),
 * and implements the host-side fail-closed + bounded-restart policy (COGNITION §B.1).
 *
 * Framework-agnostic (no cordis) so it is independently testable in Shape A and
 * wrappable by the Cordis Service (Shape B) later.
 *
 * Wire contract (mirror guard/server.py + guard/rpc.py):
 *   - sidecar emits a ready NOTIFICATION first: {"jsonrpc":"2.0","method":"ready","params":{ready,model_available}}
 *   - request : {"id":<n>,"method":"classify"|"ping"|"shutdown","params":{...}}
 *   - response: {"id":<n>,"ok":true,"result":{...}} | {"id":<n>,"ok":false,"error":{code,message,data?}}
 *   - stdout carries protocol lines only; diagnostics on stderr.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { evaluateHardcoded } from './guard-hardcoded.ts'
import { summarizeLog } from './cli-log.ts'
import { defaultCondaEnv, defaultHeadsDir, defaultModelPath, PROJECT_ROOT } from './env-paths.ts'
import {
  ErrorCode,
  failClosedVerdict,
  type ClassifyParams,
  type GuardVerdict,
  type JsonRpcError,
  type PingResult,
  type ReadyNotification,
  type Task,
  parseGuardMode,
} from './types.ts'

export interface GuardClientConfig {
  /** Guard mode: model, hardcoded, or fail-closed off. */
  mode?: 'model' | 'hardcoded' | 'off'
  /** Absolute path to the model directory (default code_cordis/model). */
  modelPath?: string
  headsDir?: string
  /** Disable 4-bit quantization (debug only — will OOM on 2GB VRAM). */
  no4bit?: boolean
  /** Conda env name (default Audio). */
  condaEnv?: string
  /** cwd for the sidecar — must contain the importable `guard` package. */
  cwd?: string
  /** Per-classify deadline (default 30s; MX450 forward+heads is slow). */
  classifyTimeoutMs?: number
  /** Startup deadline — model load is slow on MX450 (default 240s). */
  startupTimeoutMs?: number
  /** Max restart attempts within the restart window. */
  maxRestarts?: number
  /** Inject a custom spawner (tests). */
  spawnImpl?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams
}

/** A JSON-RPC error surfaced from the sidecar. */
export class GuardRpcError extends Error {
  code: ErrorCode
  data?: unknown
  constructor(err: JsonRpcError) {
    super(`${err.code}: request rejected`)
    this.name = 'GuardRpcError'
    this.code = err.code
    this.data = err.data
  }
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class GuardClient {
  private readonly cfg: Required<Omit<GuardClientConfig, 'spawnImpl' | 'modelPath' | 'headsDir' | 'no4bit' | 'condaEnv' | 'cwd' | 'mode'>> & {
    mode: 'model' | 'hardcoded' | 'off'
    modelPath: string; headsDir: string; no4bit: boolean; condaEnv: string; cwd: string
    spawnImpl?: GuardClientConfig['spawnImpl']
  }
  private proc: ChildProcessWithoutNullStreams | null = null
  private alive = false
  private ready = false
  private modelAvailable = false
  private readyResolvers: { resolve: () => void; reject: (e: Error) => void } | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private stdoutBuf = ''
  private restartCount = 0
  private restartWindowStart = 0
  private readonly logger: (msg: string) => void

  constructor(config: GuardClientConfig = {}, logger: (msg: string) => void = () => {}) {
    const modelPath = config.modelPath || defaultModelPath()
    this.cfg = {
      mode: parseGuardMode(config.mode),
      modelPath,
      headsDir: config.headsDir || defaultHeadsDir(modelPath),
      no4bit: config.no4bit ?? false,
      condaEnv: config.condaEnv || defaultCondaEnv(),
      cwd: config.cwd || PROJECT_ROOT,
      classifyTimeoutMs: config.classifyTimeoutMs ?? 30_000,
      startupTimeoutMs: config.startupTimeoutMs ?? 240_000,
      maxRestarts: config.maxRestarts ?? 3,
      spawnImpl: config.spawnImpl,
    }
    this.logger = logger
  }

  /** Whether the sidecar process is currently alive and has signaled ready. */
  get isReady(): boolean { return this.alive && this.ready }
  get isModelAvailable(): boolean { return this.modelAvailable }

  /** Start the sidecar and resolve once the ready notification lands. */
  async start(): Promise<void> {
    if (this.alive) return
    await this.spawnAndWait()
  }

  private spawnProc(): ChildProcessWithoutNullStreams {
    const args = ['run', '-n', this.cfg.condaEnv, '--no-capture-output', 'python', '-m', 'guard.server',
      '--model', this.cfg.modelPath, '--heads', this.cfg.headsDir]
    if (this.cfg.no4bit) args.push('--no-4bit')
    const spawnFn = this.cfg.spawnImpl ?? spawn
    // On Windows `conda` resolves to conda.bat — needs a shell to find it.
    const opts: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean } = { cwd: this.cfg.cwd, env: process.env }
    if (process.platform === 'win32') opts.shell = true
    return spawnFn('conda', args, opts)
  }

  private async spawnAndWait(): Promise<void> {
    this.proc = this.spawnProc()
    this.alive = true
    this.ready = false
    this.stdoutBuf = ''

    this.proc.stderr.on('data', (b: Buffer) => {
      const s = b.toString()
      const lines = s.split('\n').filter((line: string) => line.trim()).length
      if (lines > 0) this.logger(summarizeLog('sidecar-stderr', { lines }))
    })
    this.proc.stdout.on('data', (b: Buffer) => this.onStdout(b))
    this.proc.on('exit', (code, signal) => this.onExit(code, signal))

    await new Promise<void>((resolve, reject) => {
      this.readyResolvers = { resolve, reject }
      // Startup timeout.
      const timer = setTimeout(() => {
        if (!this.ready) {
          this.kill()
          reject(new Error(`sidecar startup timed out after ${this.cfg.startupTimeoutMs}ms`))
        }
      }, this.cfg.startupTimeoutMs)
      // Clear timer once ready resolves (via readyResolvers.resolve wrapper).
      const origResolve = this.readyResolvers.resolve
      this.readyResolvers.resolve = () => { clearTimeout(timer); origResolve() }
      const origReject = this.readyResolvers.reject
      this.readyResolvers.reject = (e: Error) => { clearTimeout(timer); origReject(e) }
    })
  }

  private onStdout(b: Buffer): void {
    this.stdoutBuf += b.toString()
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (line) this.handleMessage(line)
    }
  }

  private handleMessage(raw: string): void {
    let msg: any
    try { msg = JSON.parse(raw) } catch { this.logger(summarizeLog('guard-protocol', { category: 'non-JSON stdout line', length: raw.length })); return }
    // Ready notification (method + no id) — resolve startup.
    if (msg.method === 'ready' && msg.id === undefined) {
      const params = (msg as ReadyNotification).params
      this.ready = !!params?.ready
      this.modelAvailable = !!params?.model_available
      this.logger(`[guard] ready=${this.ready} model_available=${this.modelAvailable}`)
      this.readyResolvers?.resolve()
      return
    }
    // Response to a request — match by id.
    const id = msg.id
    if (id === undefined || id === null) { this.logger(summarizeLog('guard-protocol', { category: 'orphan message', length: raw.length })); return }
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    if (msg.ok === true) p.resolve(msg.result)
    else if (msg.ok === false) p.reject(new GuardRpcError(msg.error as JsonRpcError))
    else p.reject(new Error('malformed response'))
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.alive = false
    this.ready = false
    const reason = `sidecar exited (code=${code} signal=${signal})`
    this.logger(`[guard] ${reason}`)
    // Fail any in-flight requests; classify() converts these to fail-closed.
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)) }
    this.pending.clear()
    if (this.readyResolvers && !this.ready) this.readyResolvers.reject(new Error(reason))
  }

  /** Send a request and await its result. Throws GuardRpcError on {ok:false}. */
  private send<T>(method: string, params: Record<string, unknown> = {}, timeoutMs: number): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('sidecar not alive'))
    const id = this.nextId++
    const json = JSON.stringify({ id, method, params }) + '\n'
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`method ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer })
      try {
        this.proc!.stdin.write(json)
      } catch (e) {
        clearTimeout(timer); this.pending.delete(id); reject(e as Error)
      }
    })
  }

  /** Ping the sidecar. Throws if not alive / times out. */
  async ping(): Promise<PingResult> {
    if (!this.alive) throw new Error('sidecar not alive')
    return this.send<PingResult>('ping', {}, this.cfg.classifyTimeoutMs)
  }

  /**
   * Classify a tool call. ALWAYS returns a GuardVerdict — never throws for the
   * sidecar-unavailability family (process dead / not ready / timeout) but
   * synthesizes a fail-closed `block` instead (COGNITION §B.1). Throws only on
   * programmer errors (bad params / internal errors) the host must fix.
   */
  async classify(params: ClassifyParams): Promise<GuardVerdict> {
    if (params.task !== 'query' && params.task !== 'response') {
      throw new Error(`invalid classify task: ${String(params.task)}`)
    }
    const hardcoded = params.skipHardcoded ? null : evaluateHardcoded({ text: params.text, ...params.audit })
    // Hardcoded rules are the first-line unbypassable filter (COGNITION §B.1):
    // a block or review verdict short-circuits before the model in every mode.
    if (hardcoded?.severity === 'block' || hardcoded?.severity === 'review') {
      return {
        verdict: hardcoded.severity,
        task: params.task,
        risks: [],
        hardcoded,
        analysis: `hardcoded: ${hardcoded.reason}`,
        model_available: false,
      }
    }
    if (this.cfg.mode === 'off') {
      return failClosedVerdict(params.task, 'guard mode off is fail-closed for direct classification')
    }
    if (this.cfg.mode === 'hardcoded') {
      // No hardcoded hit and not the model → benign under the hardcoded-only gate.
      return {
        verdict: 'allow',
        task: params.task,
        risks: [],
        hardcoded: null,
        analysis: null,
        model_available: false,
      }
    }
    if (!this.alive) return failClosedVerdict(params.task, 'sidecar unavailable and restart failed')
    if (!this.ready) {
      const ok = await this.awaitReady(2_000)
      if (!ok) return failClosedVerdict(params.task, 'sidecar not ready')
    }

    try {
      // `skipHardcoded` is a host-side flag — never forward it to the sidecar.
      const { skipHardcoded: _skip, ...wire } = params
      return await this.send<GuardVerdict>('classify', wire as unknown as Record<string, unknown>, this.cfg.classifyTimeoutMs)
    } catch (e) {
      const err = e as Error & { code?: ErrorCode }
      const code = err.code
      // Unavailability family → fail-closed (don't crash the hot path).
      if (code === ErrorCode.NOT_READY || code === ErrorCode.MODEL_UNAVAILABLE || code === ErrorCode.TIMEOUT) {
        return failClosedVerdict(params.task, err.message)
      }
      if (err.message.includes('timed out') || err.message.includes('sidecar')) {
        // Timeout / death after send — mark dead and fail-closed.
        if (err.message.includes('exited') || err.message.includes('not alive')) this.alive = false
        return failClosedVerdict(params.task, err.message)
      }
      // Programmer error (INVALID_PARAMS / METHOD_NOT_FOUND / INTERNAL_ERROR) — surface.
      throw e
    }
  }

  /** Graceful shutdown of the sidecar. */
  async shutdown(): Promise<void> {
    if (!this.alive) return
    try {
      await this.send<{ stopped: boolean }>('shutdown', {}, 5_000).catch(() => null)
    } finally {
      this.kill()
    }
  }

  private kill(): void {
    this.alive = false
    this.ready = false
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGTERM') } catch { /* noop */ }
      setTimeout(() => { try { this.proc?.kill('SIGKILL') } catch { /* noop */ } }, 3_000)
    }
    this.proc = null
  }

  private async tryRestart(): Promise<boolean> {
    const now = Date.now()
    if (this.restartWindowStart === 0 || now - this.restartWindowStart > 60_000) {
      this.restartWindowStart = now
      this.restartCount = 0
    }
    if (this.restartCount >= this.cfg.maxRestarts) {
      this.logger(`[guard] restart budget exhausted (${this.cfg.maxRestarts} in 60s)`)
      return false
    }
    this.restartCount++
    this.logger(`[guard] restarting sidecar (attempt ${this.restartCount}/${this.cfg.maxRestarts})`)
    this.kill()
    try {
      await this.spawnAndWait()
      return this.alive && this.ready
    } catch (e) {
      this.logger(summarizeLog('restart-error', { length: String((e as Error).message ?? e).length }))
      return false
    }
  }

  private awaitReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(this.ready), timeoutMs)
      const orig = this.readyResolvers
      if (orig) {
        this.readyResolvers = {
          resolve: () => { clearTimeout(timer); orig.resolve(); resolve(true) },
          reject: (e) => { clearTimeout(timer); orig.reject(e); resolve(false) },
        }
      } else {
        // No startup in flight — just poll once after timeout.
        const t = setTimeout(() => { clearTimeout(t); resolve(this.ready) }, timeoutMs)
      }
    })
  }
}
