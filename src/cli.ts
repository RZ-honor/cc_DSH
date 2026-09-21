import { parseGuardMode } from './types.ts'
import type { GuardMode } from './types.ts'

export interface CliArgs {
  bootCheck: boolean
  print: boolean
  guardMode: GuardMode
  prompt: string
}

/** Parse sg-agent's command-line flags without treating --print as prompt text. */
export function parseCliArgs(
  argv: string[],
  defaultGuardMode: GuardMode = parseGuardMode(process.env.SG_GUARD_MODE ?? process.env.GUARD_MODE),
): CliArgs {
  let bootCheck = false
  let print = false
  let guardMode = defaultGuardMode
  const promptTokens: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--print') {
      print = true
      // --print is a terminal option: every remaining token is prompt text,
      // including strings that happen to look like flags.
      const remainingPrompt = argv.slice(i + 1)
      if (remainingPrompt.length === 0) throw new Error('--print requires a prompt')
      promptTokens.push(...remainingPrompt)
      break
    } else if (token === '--boot-check') {
      bootCheck = true
    } else if (token === '--guard-mode') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--guard-mode requires a value')
      }
      guardMode = parseGuardMode(value)
    } else if (token.startsWith('--')) {
      throw new Error('unknown flag')
    } else {
      promptTokens.push(token)
    }
  }

  return { bootCheck, print, guardMode, prompt: promptTokens.join(' ') }
}
