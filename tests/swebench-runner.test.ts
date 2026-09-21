import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSwebench } from '../swebench/runner.ts'
import { GIT, sq } from '../swebench/git.ts'
import type { SwebenchInstance } from '../swebench/types.ts'

function git(cwd: string, args: string[]): number {
  const r = Bun.spawnSync(['bash', '-c', `${sq(GIT)} ${args.map(sq).join(' ')}`], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode ?? -1
}
function gitOut(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(['bash', '-c', `${sq(GIT)} ${args.map(sq).join(' ')}`], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return r.stdout.toString()
}

/** A tiny Python repo with a buggy `div` and a failing regression test. */
function makePyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-swebench-py-'))
  const g = (args: string[]) => git(dir, args)
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  writeFileSync(join(dir, 'calc.py'), 'def div(a, b):\n    return a + b\n')
  writeFileSync(join(dir, 'test_calc.py'), 'import calc\n\ndef test_div():\n    assert calc.div(8, 2) == 4\n')
  g(['add', '.']); g(['commit', '-qm', 'base'])
  const baseCommit = gitOut(dir, ['rev-parse', 'HEAD']).trim()
  return { dir, baseCommit }
}

function inst(repo: string, baseCommit: string): SwebenchInstance {
  return {
    instance_id: 'mini__calc-1', repo, base_commit: baseCommit, problem_statement: 'Fix div.',
    hints_text: '', version: '1.0', patch: '', test_patch: '',
    FAIL_TO_PASS: ['test_calc.py::test_div'], PASS_TO_PASS: [],
    environment_setup_commit: '',
  }
}

describe('swebench runner', () => {
  test('deterministic run makes no provider call and yields a result', async () => {
    const src = makePyRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const result = await runSwebench(inst('a/b', src.baseCommit), {
      reposDir,
      cloneUrl: () => src.dir,
      deterministic: true,
      guardMode: 'hardcoded',
    })
    // Result shape matches SwebenchResult.
    expect(result.instance_id).toBe('mini__calc-1')
    expect(result.repo).toBe('a/b')
    expect(result.base_commit).toBe(src.baseCommit)
    expect(result.guardMode).toBe('hardcoded')
    expect(typeof result.durationMs).toBe('number')
    // No model edits happened, so the bug remains -> not resolved.
    expect(result.resolved).toBe(false)
    // The status is 'fail' (regression still failing) — not 'error'/'timeout'.
    expect(result.status).toBe('fail')
    expect(result.turns).toBeGreaterThanOrEqual(0)
  }, 40000)

  test('deterministic result is credential-redacted', async () => {
    const src = makePyRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const result = await runSwebench(inst('a/b', src.baseCommit), {
      reposDir,
      cloneUrl: () => src.dir,
      deterministic: true,
    })
    const json = JSON.stringify(result)
    // Any leaked secret-ish patterns are redacted to <redacted>.
    expect(json).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
    expect(json).not.toMatch(/RADON_API_KEY=.{6,}/)
  }, 40000)
})