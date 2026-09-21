/** Public surface of sg-agent (DSH Cordis plugins + Claude Code-style runtime). */
export { QueryEngine } from './query/QueryEngine.ts'
export { queryLoop } from './query/queryLoop.ts'
export { GuardClient } from './guard-client.ts'
export { evaluateHardcoded } from './guard-hardcoded.ts'
export { ALL_TOOLS } from './tools/write.ts'
export { parseGuardMode, failClosedVerdict } from './types.ts'
export type { GuardMode, GuardVerdict, ClassifyParams, Task, Verdict } from './types.ts'
export { defaultModelPath, defaultCondaEnv, PROJECT_ROOT } from './env-paths.ts'
