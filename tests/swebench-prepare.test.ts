import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareWorkspace, type PrepareOptions } from '../swebench/prepare.ts'
import type { SwebenchInstance } from '../swebench/types.ts'

// Route git through bash (like prepare.ts) — direct .exe spawn is flaky in the
// bun-test worker, and bin/git.exe is a bash-script shim. Prefer cmd/git.exe.
const GIT = 'C:/Program Files/Git/cmd/git.exe'
function sq(a: string): string {
  return `'${a.replace(/'/g, `'\\''`)}'`
}
function gitOut(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(['bash', '-c', `${sq(GIT)} ${args.map(sq).join(' ')}`], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return r.stdout.toString()
}
function git(cwd: string, args: string[]): number {
  const r = Bun.spawnSync(['bash', '-c', `${sq(GIT)} ${args.map(sq).join(' ')}`], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode ?? -1
}
function gitIn(repoDir: string, args: string[]): string {
  return gitOut(repoDir, args)
}

/** Create a local git repo with two commits, return its path + commit hashes. */
function makeLocalRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-swebench-src-'))
  const g = (args: string[]) => git(dir, args)
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.txt'), 'v1\n'); g(['add', '.']); g(['commit', '-qm', 'c1'])
  const baseCommit = gitOut(dir, ['rev-parse', 'HEAD']).trim()
  writeFileSync(join(dir, 'a.txt'), 'v2\n'); g(['add', '.']); g(['commit', '-qm', 'c2'])
  const headCommit = gitOut(dir, ['rev-parse', 'HEAD']).trim()
  return { dir, baseCommit, headCommit }
}

function inst(repo: string, baseCommit: string): SwebenchInstance {
  return {
    instance_id: 'repo__r-1', repo, base_commit: baseCommit, problem_statement: 'Fix the bug.',
    hints_text: '', version: '1.0', patch: '', test_patch: '', FAIL_TO_PASS: [], PASS_TO_PASS: [],
    environment_setup_commit: '',
  }
}

describe('swebench prepare', () => {
  test('clones a repo and checks out the base_commit', () => {
    const src = makeLocalRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const workspace = prepareWorkspace(inst('a/b', src.baseCommit), {
      reposDir,
      cloneUrl: () => src.dir, // local source — no network
    } as PrepareOptions)
    // repo was cloned under reposDir and checked out at base_commit.
    const head = gitIn(workspace.repoDir, ['rev-parse', 'HEAD']).trim()
    expect(head).toBe(src.baseCommit)
    // workspace contains the checked-out files.
    expect(existsSync(join(workspace.repoDir, 'a.txt'))).toBe(true)
    // problem statement written into the workspace.
    expect(existsSync(join(workspace.repoDir, 'PROBLEM.md'))).toBe(true)
  }, 60000)

  test('checkout of a non-tip commit produces a detached HEAD at base_commit', async () => {
    const src = makeLocalRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const ws = prepareWorkspace(inst('a/b', src.baseCommit), { reposDir, cloneUrl: () => src.dir } as PrepareOptions)
    expect(ws.repoDir).toBeTruthy()
    const file = awaitRead(join(ws.repoDir, 'a.txt'))
    expect(await file).toBe('v1\n') // base_commit content, not HEAD content
  }, 60000)

  test('reuses an already-cloned repo directory (no duplicate clone)', () => {
    const src = makeLocalRepo()
    const reposDir = mkdtempSync(join(tmpdir(), 'sg-swebench-repos-'))
    const opts = { reposDir, cloneUrl: () => src.dir } as PrepareOptions
    const ws1 = prepareWorkspace(inst('a/b', src.baseCommit), opts)
    const ws2 = prepareWorkspace(inst('a/b', src.baseCommit), opts)
    expect(ws1.repoDir).toBe(ws2.repoDir)
  }, 60000)
})

async function awaitRead(p: string): Promise<string> {
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}