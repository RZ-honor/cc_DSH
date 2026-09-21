/**
 * swebench/convert — convert the downloaded SWE-bench parquet to a JSONL file
 * the TS loader can read with zero heavy dependencies.
 *
 * The parquet is resolved from `SWEBENCH_PARQUET` or `swebench/data/*.parquet`. We
 * shell out to SG_PYTHON / conda python (needs pandas + pyarrow) to emit a
 * JSONL of `SwebenchInstance` rows aligned to `swebench/types.ts`.
 *
 * The output is written once and cached; `runConvert()` is idempotent (only
 * rewrites if the target is missing or the parquet is newer).
 */
import { mkdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePython } from '../src/env-paths.ts'

export const INSTANCES_JSONL = join(dirname(fileURLToPath(import.meta.url)), 'data', 'instances.jsonl')
const TEST_PARQUET = process.env.SWEBENCH_PARQUET
  || join(dirname(fileURLToPath(import.meta.url)), 'data', 'test-00000-of-00001.parquet')

const PYTHON = resolvePython()

const CONVERT_SCRIPT = `
import json, sys, os
import pandas as pd
src = sys.argv[1]
dst = sys.argv[2]
df = pd.read_parquet(src)
os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(dst, 'w', encoding='utf-8') as f:
    for _, row in df.iterrows():
        rec = {
            'instance_id': str(row.get('instance_id') or ''),
            'repo': str(row.get('repo') or ''),
            'base_commit': str(row.get('base_commit') or ''),
            'problem_statement': str(row.get('problem_statement') or ''),
            'hints_text': str(row.get('hints_text') or ''),
            'version': str(row.get('version') or ''),
            'patch': str(row.get('patch') or ''),
            'test_patch': str(row.get('test_patch') or ''),
            'FAIL_TO_PASS': [str(x) for x in (row.get('FAIL_TO_PASS') or [])],
            'PASS_TO_PASS': [str(x) for x in (row.get('PASS_TO_PASS') or [])],
            'environment_setup_commit': str(row.get('environment_setup_commit') or ''),
        }
        f.write(json.dumps(rec, ensure_ascii=False) + '\\n')
print(f'wrote {len(df)} rows to {dst}')
`

/**
 * Regenerate the JSONL from the test parquet. Returns true if it (re)wrote.
 * Idempotent: skips when the JSONL already exists and is newer than the parquet.
 */
export async function runConvert(opts: { force?: boolean } = {}): Promise<boolean> {
  if (!existsSync(TEST_PARQUET)) throw new Error(`SWE-bench test parquet not found: ${TEST_PARQUET}`)
  const needs = opts.force
    || !existsSync(INSTANCES_JSONL)
    || statSync(INSTANCES_JSONL).mtimeMs < statSync(TEST_PARQUET).mtimeMs
  if (!needs) return false
  mkdirSync(dirname(INSTANCES_JSONL), { recursive: true })
  const scriptPath = join(dirname(INSTANCES_JSONL), '_convert_swebench.py')
  writeFileSync(scriptPath, CONVERT_SCRIPT)
  // Spawn python directly (no bash) so backslash paths are preserved. Convert
  // to forward slashes to be safe in arg passing. Async spawn awaits exit so
  // a large (130MB+) JSONL write does not hang the sync variant.
  const toPosix = (p: string) => p.replace(/\\/g, '/')
  const child = Bun.spawn([PYTHON, toPosix(scriptPath), toPosix(TEST_PARQUET), toPosix(INSTANCES_JSONL)], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await child.exited
  if (code !== 0) {
    const err = await new Response(child.stderr).text()
    throw new Error(`swebench convert failed (exit ${code}): ${err}`)
  }
  return true
}

/** CLI entry: `bun swebench/convert.ts [--force]`. */
if (import.meta.main) {
  const force = process.argv.includes('--force')
  const wrote = await runConvert({ force })
  console.log(wrote ? `regenerated ${INSTANCES_JSONL}` : `up-to-date ${INSTANCES_JSONL}`)
}