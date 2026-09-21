/**
 * sg-prompt — DSH preset Cordis plugin exposing the SingGuard guardrail
 * system-prompt section via `ctx.systemPrompt`.
 *
 * Registers the guardrail section (COGNITION §12.3 stable statement) into the
 * DSH `dsh-system-prompt` registry in the calling agent's scope, so every
 * agent session that mounts this preset advertises the guard policy to the
 * model. The section is registered through the agent-scoped context
 * (`agent.ctx`) so it does not leak into the ROOT realm and collides with no
 * other session (COGNITION §1.3 isolate; RUNBOOK "预置行适配器").
 *
 * Ordering: harness identity is -100, deployment persona 0, tool guidance
 * 100-199, and this guardrail is 200 so it renders after tool guidance and
 * before any later session-specific sections — the model reads the safety
 * contract last, immediately before the tools and the request.
 *
 * @module sg-agent/plugins/sg-prompt
 */
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Section name — duplicate registration in one layer throws (shadowed per scope). */
export const GUARDRAIL_SECTION = 'sg-agent:guardrail'

/** Section name for the model's response-language instruction. */
export const LANGUAGE_SECTION = 'sg-agent:language'

/** Render order: after the 100-199 tool-guidance band, before anything later. */
export const GUARDRAIL_ORDER = 200

/** The language instruction renders just before the guardrail section. */
export const LANGUAGE_ORDER = 150

export interface SgPromptConfig {
  /** Override the default guardrail text. Rarely needed; the default is the
   * COGNITION §12.3 stable statement that connects runtime policy to the
   * self-healing loop. */
  text?: string
  /** Language the model should respond in. Defaults to 中文 (Chinese). Set to
   * an empty string to disable the language instruction entirely. */
  language?: string
}

const DEFAULT_TEXT = [
  'All commands, file mutations, and generated code changes are audited by SingGuard-NSFA.',
  'A rejected tool call is returned as an error result. Do not bypass, encode, split, or reframe a',
  'rejected operation to evade the guard. Instead, use a safe equivalent approach that still',
  'addresses the user\'s legitimate goal.',
].join('\n')

/** The response-language instruction the model sees (COGNITION §1.1 language
 * dynamic segment). Prompts the model to answer in the configured language. */
function languageText(lang: string): string {
  return `Always respond in ${lang} unless the user asks otherwise.`
}

/** Cordis plugin entry: register the guardrail + response-language prompt
 * sections in this scope. */
export const name = 'sg-prompt'
export const inject = ['systemPrompt'] as const

export function apply(ctx: Context, config?: SgPromptConfig) {
  const language = config?.language ?? '中文'
  const disposers: Array<() => void> = []
  if (language.length > 0) {
    disposers.push(ctx.systemPrompt.section({
      name: LANGUAGE_SECTION,
      order: LANGUAGE_ORDER,
      text: languageText(language),
    }))
  }
  disposers.push(ctx.systemPrompt.section({
    name: GUARDRAIL_SECTION,
    order: GUARDRAIL_ORDER,
    text: config?.text ?? DEFAULT_TEXT,
  }))
  ctx.logger.info?.(`[sg-prompt] registered ${disposers.length} sections (language=${language || 'off'})`)
  // Reverse-order disposer (COGNITION §6.3).
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export default apply