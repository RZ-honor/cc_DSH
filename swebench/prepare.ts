/**
 * swebench/prepare — clone a repo at a pinned base_commit into a per-repo
 * cache directory, then write the problem statement next to it.
 *
 * Workspaces live under `reposDir/<repo>/` (not a random temp dir) so multiple
 * instances of the same repo share one clone. Each instance's agent runs with
 * cwd = the repo dir; the problem statement is written to `PROBLEM.md` at the
 * repo root so the model can read it via the Read tool.
 *
 * The clone source is injectable (`cloneUrl`) so tests never hit the network.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gitIn, sh } from './git.ts'
import type { SwebenchInstance } from './types.ts'

export interface PrepareOptions {
  /** Directory that holds one clone per repo (default system temp). */
  reposDir?: string
  /** Resolve a repo owner/name to a clone source (default GitHub https). */
  cloneUrl?: (repo: string) => string
  /** Force a fresh clone even if the dir exists. */
  force?: boolean
}

export interface PreparedWorkspace {
  /** The checked-out repo directory (the agent's cwd). */
  repoDir: string
  /** Alias of repoDir for symmetry with the benchmark runner. */
  workspace: string
}

const DEFAULT_CLONE = (repo: string) => `https://github.com/${repo}.git`

/**
 * Run a git command against `repoDir`. The process spawns with cwd = `base`
 * (a JS-created dir) and points git at the repo via `-C`, because spawning any
 * process with cwd = a directory freshly created by `git mv` throws ENOENT in a
 * bun-test worker (a worker spawn-resolver quirk).
 */
function gitInRepo(base: string, repoDir: string, args: string[]): { ok: boolean; stdout: string; stderr: string; code: number } {
  return gitIn(base, repoDir, args)
}

/** Clone (if needed) and check out `base_commit`; return the repo dir. */
export function prepareWorkspace(instance: SwebenchInstance, opts: PrepareOptions = {}): PreparedWorkspace {
  const base = resolve(opts.reposDir ?? join(process.env.TEMP ?? '/tmp', 'sg-swebench'))
  const cloneUrl = opts.cloneUrl ?? DEFAULT_CLONE
  const repoDir = resolve(base, instance.repo)

  if (!existsSync(repoDir) || opts.force) {
    mkdirSync(base, { recursive: true })
    // Clone into a temp dir then rename, so a failed clone never leaves a
    // half-populated repoDir that looks valid. The rename is a Node fs call
    // (not `git mv`, which needs a git repo, nor a bash mv — bash -lc spawns
    // are slow and the worker can't spawn with the moved dir as cwd).
    const tmp = `${repoDir}.cloning-${process.pid}`
    const cl = sh(['clone', '--quiet', cloneUrl(instance.repo), tmp], base)
    if (!cl.ok) throw new Error(`git clone failed for ${instance.repo}: ${cl.stderr.trim()}`)
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true })
    renameSync(tmp, repoDir)
  }

  // Disable autocrlf so the checked-out tree matches the source byte-for-byte
  // (LF). Line-ending conversion would corrupt `git apply` and break pytest.
  // Set on every call (fresh or reused clone) before the reset/checkout that
  // re-materializes the tree with the correct line endings.
  gitInRepo(base, repoDir, ['config', 'core.autocrlf', 'false'])

  // Detach at the base commit. A dirty prior checkout is reset first.
  gitInRepo(base, repoDir, ['reset', '--hard', '-q'])
  const co = gitInRepo(base, repoDir, ['checkout', '-q', '--detach', instance.base_commit])
  if (!co.ok) throw new Error(`git checkout ${instance.base_commit} failed for ${instance.repo}: ${co.stderr.trim()}`)

  // Inject the problem statement so the model can read it.
  writeFileSync(join(repoDir, 'PROBLEM.md'), `${instance.problem_statement}\n`, 'utf8')

  return { repoDir, workspace: repoDir }
}