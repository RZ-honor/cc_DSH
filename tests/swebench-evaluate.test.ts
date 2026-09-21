import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { prepareWorkspace } from '../swebench/prepare.ts'
import { applyGitPatch, captureModelDiff, evaluateSwebench, runPytest } from '../swebench/evaluate.ts'
import { redactBenchmarkText } from '../benchmarks/evaluate.ts'
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

/**
 * Build a tiny Python repo with a buggy function and a pytest regression test
 * that fails at base_commit and passes once the fix is applied.
 * Returns the SwebenchInstance fields that describe it.
 */
function makePyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-swebench-py-'))
  const g = (args: string[]) => git(dir, args)
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])

  // Buggy module: `div` returns the wrong value (adds instead of divides).
  writeFileSync(join(dir, 'calc.py'), 'def div(a, b):\n    return a + b\n')
  writeFileSync(join(dir, 'test_calc.py'), 'import calc\n\ndef test_div():\n    assert calc.div(8, 2) == 4\n')

  g(['add', '.']); g(['commit', '-qm', 'base'])
  const baseCommit = gitOut(dir, ['rev-parse', 'HEAD']).trim()

  // Produce a REAL unified diff for the fix: fix the bug on a branch, commit,
  // then diff base..fix. The result is a patch that applies cleanly to the
  // base_commit tree.
  writeFileSync(join(dir, 'calc.py'), 'def div(a, b):\n    return a / b\n')
  g(['add', '.']); g(['commit', '-qm', 'fix'])
  const fixCommit = gitOut(dir, ['rev-parse', 'HEAD']).trim()
  const fixDiff = gitOut(dir, ['diff', baseCommit, fixCommit])

  const testPatch = '' // regression test already committed in base
  return { dir, baseCommit, fixDiff, testPatch }
}

function inst(repo: string, baseCommit: string, testPatch: string): SwebenchInstance {
  return {
    instance_id: 'mini__calc-1', repo, base_commit: baseCommit, problem_statement: 'Fix div.',
    hints_text: '', version: '1.0', patch: '', test_patch: testPatch,
    FAIL_TO_PASS: ['test_calc.py::test_div'], PASS_TO_PASS: [],
    environment_setup_commit: '',
  }
}

describe('swebench evaluate', () => {
  test('applyGitPatch applies a patch and changes files', () => {
    const src = makePyRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const ws = prepareWorkspace(inst('a/b', src.baseCommit, ''), { reposDir, cloneUrl: () => src.dir } as any)
    const base = resolve(reposDir)
    // Before: buggy code present.
    expect(readFileSync(join(ws.repoDir, 'calc.py'), 'utf8')).toContain('a + b')
    const applied = applyGitPatch(base, ws.repoDir, src.fixDiff)
    expect(applied.ok).toBe(true)
    expect(readFileSync(join(ws.repoDir, 'calc.py'), 'utf8')).toContain('a / b')
  }, 40000)

  test('applyGitPatch rejects a patch that escapes the repo', () => {
    const src = makePyRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const ws = prepareWorkspace(inst('a/b', src.baseCommit, ''), { reposDir, cloneUrl: () => src.dir } as any)
    const base = resolve(reposDir)
    const escape = [
      'diff --git a/../escape.txt b/../escape.txt',
      '--- a/../escape.txt',
      '+++ b/../escape.txt',
      '@@ -0,0 +1 @@',
      '+pwned',
    ].join('\n') + '\n'
    const applied = applyGitPatch(base, ws.repoDir, escape)
    expect(applied.ok).toBe(false)
  }, 40000)

  test('runPytest reports a failing test as failed', () => {
    const src = makePyRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const ws = prepareWorkspace(inst('a/b', src.baseCommit, ''), { reposDir, cloneUrl: () => src.dir } as any)
    const base = resolve(reposDir)
    // Without the fix, test_div fails (buggy code returns 8+2=10 != 4).
    const r = runPytest(base, ws.repoDir, ['test_calc.py::test_div'])
    expect(r.failed).toContain('test_calc.py::test_div')
    expect(r.passed).not.toContain('test_calc.py::test_div')
  }, 40000)

  test('evaluateSwebench resolves after a correct fix patch', () => {
    const src = makePyRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const ws = prepareWorkspace(inst('a/b', src.baseCommit, ''), { reposDir, cloneUrl: () => src.dir } as any)
    const base = resolve(reposDir)
    // Apply the model's fix diff, then evaluate.
    applyGitPatch(base, ws.repoDir, src.fixDiff)
    const modelDiff = captureModelDiff(base, ws.repoDir)
    expect(modelDiff).toContain('a / b')
    const outcome = evaluateSwebench(inst('a/b', src.baseCommit, ''), base, ws.repoDir, modelDiff)
    expect(outcome.method).toBe('tests')
    expect(outcome.testsFailed).toBe(0)
    expect(outcome.resolved).toBe(true)
  }, 40000)

  test('evaluateSwebench does not resolve with a wrong/no fix', () => {
    const src = makePyRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const ws = prepareWorkspace(inst('a/b', src.baseCommit, ''), { reposDir, cloneUrl: () => src.dir } as any)
    const base = resolve(reposDir)
    // Empty diff -> nothing applied, test still fails.
    const outcome = evaluateSwebench(inst('a/b', src.baseCommit, ''), base, ws.repoDir, '')
    expect(outcome.resolved).toBe(false)
    expect(outcome.testsFailed).toBeGreaterThan(0)
  }, 40000)

  test('redacts credentials in outcome text', () => {
    const leak = 'Bearer sk-1234567890abcdef crashed with OPENAI_API_KEY=secret123'
    const redacted = redactBenchmarkText(leak)
    expect(redacted).not.toContain('secret123')
    expect(redacted).not.toContain('sk-1234567890abcdef')
  })
})