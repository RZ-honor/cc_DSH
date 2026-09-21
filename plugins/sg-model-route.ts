/**
 * sg-model-route — DSH host-root Cordis plugin exposing ctx.sgModel.
 *
 * A thin model-call surface over DSH's `ctx.llm` (the vendored
 * @deepseek-ai/dsh-llm streaming client, backed by llm-pi-ai providers). It
 * applies the sg-agent default provider/model (radon/DeepSeek-V4-Flash primary,
 * das/gpt-5.6-terra fallback) and isolates the queryLoop from provider
 * selection + dialect differences (radon=openai-completions, das=openai-responses
 * — both hidden by the dsh-llm adapters).
 *
 * Fallback policy: if the primary stream errors BEFORE yielding any chunk
 * (connection / request / auth failure), retry once on the fallback provider.
 * Errors after the first chunk are surfaced — a mid-stream fallback would
 * interleave a second response and garble the transcript. (Claude Code mirrors
 * this with withheld-recoverable-error handling in queryLoop Phase B.)
 *
 * @module sg-agent/plugins/sg-model-route
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export interface SgModelConfig {
  /** Primary provider route (default 'radon'). */
  primary?: string
  /** Primary model id (default 'DeepSeek-V4-Flash'). */
  primaryModel?: string
  /** Fallback provider route (default 'das'); omit to disable fallback. */
  fallback?: string
  /** Fallback model id (default 'gpt-5.6-terra'). */
  fallbackModel?: string
  /** Default reasoning effort passed through to the adapter. */
  reasoningEffort?: string
  /** Default temperature (caller may override per-call). */
  temperature?: number
  /** Default max output tokens (caller may override per-call). */
  maxTokens?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sgModel: SgModel
  }
}

/**
 * Stream options as the queryLoop passes them: `messages` required, but
 * `provider`/`model` optional (sg-model-route fills them from config). Every
 * other GenerateOptions field keeps its original optionality.
 */
export type SgStreamOptions = Omit<GenerateOptions, 'provider' | 'model'> & {
  provider?: string
  model?: string
}

export class SgModel extends Service {
  static Config: z<SgModelConfig> = z.object({
    primary: z.string().default('radon'),
    primaryModel: z.string().default('DeepSeek-V4-Flash'),
    fallback: z.string().default('das'),
    fallbackModel: z.string().default('gpt-5.6-terra'),
    reasoningEffort: z.string().required(false),
    temperature: z.number().required(false),
    maxTokens: z.number().required(false),
  })

  private readonly modelConfig: Required<Omit<SgModelConfig, 'reasoningEffort' | 'temperature' | 'maxTokens'>>
    & Pick<SgModelConfig, 'reasoningEffort' | 'temperature' | 'maxTokens'>

  constructor(ctx: Context, config: SgModelConfig = {}) {
    super(ctx, 'sgModel')
    this.modelConfig = {
      primary: config.primary ?? 'radon',
      primaryModel: config.primaryModel ?? 'DeepSeek-V4-Flash',
      fallback: config.fallback ?? 'das',
      fallbackModel: config.fallbackModel ?? 'gpt-5.6-terra',
      reasoningEffort: config.reasoningEffort,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    }
  }

  /** Configured primary provider (for labeling assistant messages; TODO: track
   * the provider that actually served the stream after a fallback). */
  get primaryProvider(): string { return this.modelConfig.primary }
  /** Configured primary model id. */
  get primaryModel(): string { return this.modelConfig.primaryModel }

  /**
   * Stream a model response. Caller supplies `messages` (required) and any
   * per-call overrides (system, tools, temperature, maxTokens, even
   * provider/model). Config defaults fill provider/model + reasoningEffort +
   * temperature + maxTokens when the caller omits them.
   */
  async *stream(options: SgStreamOptions): AsyncIterable<StreamChunk> {
    const base = this._withDefaults(options)
    let started = false
    try {
      for await (const chunk of this.ctx.llm.stream(base)) {
        started = true
        yield chunk
      }
    } catch (e) {
      if (started || !this.modelConfig.fallback) throw e
      // Pre-first-chunk failure only — safe to retry on the fallback provider.
      const fallbackOpts: GenerateOptions = {
        ...base,
        provider: this.modelConfig.fallback,
        model: this.modelConfig.fallbackModel,
      }
      yield* this.ctx.llm.stream(fallbackOpts)
    }
  }

  /** Apply config defaults under the caller's options (caller wins). */
  private _withDefaults(options: SgStreamOptions): GenerateOptions {
    const c = this.modelConfig
    // Destructure provider/model out so the spread doesn't re-specify them
    // (TS2783) — they are filled explicitly from config when the caller omits.
    const { provider: optProvider, model: optModel, ...rest } = options
    const merged: GenerateOptions = {
      ...rest,
      provider: optProvider ?? c.primary,
      model: optModel ?? c.primaryModel,
    }
    if (c.reasoningEffort !== undefined && options.reasoningEffort === undefined) {
      merged.reasoningEffort = c.reasoningEffort as GenerateOptions['reasoningEffort']
    }
    if (c.temperature !== undefined && options.temperature === undefined) merged.temperature = c.temperature
    if (c.maxTokens !== undefined && options.maxTokens === undefined) merged.maxTokens = c.maxTokens
    return merged
  }
}

export default SgModel
