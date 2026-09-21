/**
 * swebench/git — bash-routed git helpers.
 *
 * Bun.spawnSync does not inherit the bash PATH. Directly spawning the
 * resolved git.exe is also flaky from a bun-test worker when the cwd is a
 * freshly git-created nested directory. Routing git through `bash -c` is
 * reliable in both the main process and the test worker. Callers should never
 * spawn with cwd = a directory freshly created by `git mv`; point git at it
 * with `-C` instead and keep the process cwd on a JS-created directory.
 */
export const GIT = (() => {
  // Prefer cmd/git.exe (the real PE binary) — bin/git.exe is a bash-script shim.
  const candidates = [
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files/Git/bin/git.exe',
    'C:/Program Files/Git/mingw64/bin/git.exe',
    '/mingw64/bin/git',
    'git', // last resort: rely on PATH
  ]
  for (const c of candidates) {
    try {
      const r = Bun.spawnSync([c, '--version'], { stdout: 'pipe', stderr: 'pipe' })
      if (r.exitCode === 0) return c
    } catch { /* try next */ }
  }
  return 'git'
})()

/** Shell-quote a single argument for `bash -c`. */
export function sq(a: string): string {
  return `'${a.replace(/'/g, `'\\''`)}'`
}

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

/** Run a bash-routed command with the given cwd (a JS-created directory). */
export function sh(args: string[], cwd: string): GitResult {
  const cmd = `${sq(GIT)} ${args.map(sq).join(' ')}`
  // `-c` not `-lc`: a login shell sources conda/profile and adds seconds per
  // spawn. GIT is an absolute path, so we don't need login PATH.
  const r = Bun.spawnSync(['bash', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode ?? -1 }
}

/**
 * Run a git command against `repoDir` from a safe process cwd (`base`), using
 * `git -C <repoDir>` so we never spawn with cwd = the git-created dir.
 */
export function gitIn(base: string, repoDir: string, args: string[]): GitResult {
  return sh(['-C', repoDir, ...args], base)
}