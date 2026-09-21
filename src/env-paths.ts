/**
 * Runtime path defaults. Clone-friendly: env first, then repo-relative / conda,
 * never required to match a particular disk layout.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function defaultModelPath(): string {
  return process.env.SG_MODEL_PATH || join(PROJECT_ROOT, 'model')
}

export function defaultCondaEnv(): string {
  return process.env.SG_CONDA_ENV || 'Audio'
}

export function defaultHeadsDir(modelPath = defaultModelPath()): string {
  return process.env.SG_HEADS_DIR || join(modelPath, 'nsfa_heads')
}

/** Python used by swebench convert/evaluate. */
export function resolvePython(): string {
  if (process.env.SG_PYTHON) return process.env.SG_PYTHON
  const conda = process.env.CONDA_PREFIX
  if (conda) {
    for (const c of [join(conda, 'python.exe'), join(conda, 'bin', 'python')]) {
      if (existsSync(c)) return c
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}
