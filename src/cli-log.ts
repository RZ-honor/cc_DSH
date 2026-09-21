export type LogKind = 'prompt' | 'tool-call' | 'tool-result' | 'error' | 'guard-protocol' | 'sidecar-stderr' | 'restart-error' | 'guard-start-error'

/** Produce bounded operational logs without copying sensitive payloads. */
export function summarizeLog(kind: LogKind, value: unknown): string {
  const lengthOf = (key: string): number => {
    const n = typeof value === 'object' && value !== null && key in value
      ? Number((value as Record<string, unknown>)[key])
      : 0
    return Number.isFinite(n) ? n : 0
  }
  if (kind === 'sidecar-stderr') return `[sidecar] stderr diagnostics received (lines=${lengthOf('lines')})`
  if (kind === 'restart-error') return `[guard] restart failed (error-length=${lengthOf('length')})`
  if (kind === 'guard-start-error') return `[sg-guard] sidecar failed to start (error-length=${lengthOf('length')})`
  if (kind === 'guard-protocol') {
    const category = typeof value === 'object' && value !== null && 'category' in value
      ? String((value as { category?: unknown }).category)
      : 'protocol error'
    const length = typeof value === 'object' && value !== null && 'length' in value
      ? Number((value as { length?: unknown }).length)
      : 0
    return `[guard] ${category} (length=${Number.isFinite(length) ? length : 0})`
  }
  if (kind === 'prompt') {
    return '[sg-agent] prompt received (content redacted)'
  }
  if (kind === 'tool-call') {
    const name = typeof value === 'object' && value !== null && 'name' in value
      ? String((value as { name?: unknown }).name)
      : 'unknown'
    return `[tool-call] ${name} (arguments redacted)`
  }
  if (kind === 'tool-result') {
    const isError = typeof value === 'object' && value !== null && 'isError' in value
      ? Boolean((value as { isError?: unknown }).isError)
      : false
    return `[tool-result${isError ? '/error' : ''}] (content redacted)`
  }
  return '[error] operation failed (details redacted)'
}
