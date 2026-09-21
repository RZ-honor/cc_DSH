/**
 * Benchmark evaluator for filesystem and command success criteria.
 * All commands execute with the workspace as cwd and bounded timeouts.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import type { BenchmarkTask, BenchmarkResult } from './types.ts'

function assertInWorkspace(workspace: string, path: string): string {
  const root = resolve(workspace)
  const resolved = resolve(root, path)
  const rel = relative(root, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === sep || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`path escape: ${path} resolves outside workspace ${workspace}`)
  }
  let realRoot: string
  let realPath: string
  try {
    realRoot = realpathSync(root)
    realPath = realpathSync(resolved)
  } catch {
    // Preserve lexical containment for paths that do not exist yet.
    return resolved
  }
  const realRel = relative(realRoot, realPath)
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(realRel)) {
    throw new Error(`path escape: ${path} resolves outside workspace ${workspace}`)
  }
  return resolved
}

function runCommand(workspace: string, command: string, timeoutMs: number) {
  try {
    const stdout = execSync(command, { cwd: workspace, encoding: 'utf-8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    return { exitCode: 0, stdout, stderr: '' }
  } catch (error: any) {
    const timedOut = error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT'
    return {
      exitCode: typeof error?.status === 'number' ? error.status : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: timedOut ? 'command timed out' : String(error?.stderr ?? error?.message ?? 'command failed'),
    }
  }
}

export async function evaluateTask(
  workspace: string,
  success: BenchmarkTask['success'],
): Promise<{ passed: boolean; failures: string[]; testsPassed: number; testsFailed: number }> {
  const failures: string[] = []
  let testsPassed = 0
  let testsFailed = 0
  for (const file of success.files ?? []) {
    const path = assertInWorkspace(workspace, file.path)
    if (!existsSync(path)) {
      failures.push(`missing file: ${file.path}`); testsFailed++; continue
    }
    const content = readFileSync(path)
    for (const needle of file.contains ?? []) {
      if (content.toString('utf-8').includes(needle)) testsPassed++
      else { failures.push(`file ${file.path} missing expected content: ${needle}`); testsFailed++ }
    }
    if (file.sha256) {
      const actual = createHash('sha256').update(content).digest('hex')
      if (actual === file.sha256) testsPassed++
      else { failures.push(`file ${file.path} sha256 ${actual} (expected ${file.sha256})`); testsFailed++ }
    }
    if (!(file.contains?.length) && !file.sha256) testsPassed++
  }
  for (const command of success.commands ?? []) {
    const result = runCommand(workspace, command.command, Math.max(1, (command.timeoutSeconds ?? 30) * 1000))
    const expected = command.expectedExitCode ?? 0
    if (result.exitCode === expected) testsPassed++
    else { failures.push(`command "${redactBenchmarkText(command.command)}" exit ${result.exitCode} (expected ${expected}): ${redactBenchmarkText(result.stderr)}`); testsFailed++ }
  }
  for (const check of success.checks ?? []) {
    const result = runCommand(workspace, check, 30_000)
    if (result.exitCode === 0) testsPassed++
    else { failures.push(`check "${redactBenchmarkText(check)}" failed: ${redactBenchmarkText(result.stderr)}`); testsFailed++ }
  }
  return { passed: testsFailed === 0, failures, testsPassed, testsFailed }
}

export function redactBenchmarkText(text: string): string {
  return text
    .replace(/([A-Z_]*_API_KEY)\s*=\s*[^\s"']+/gi, '$1=<redacted>')
    .replace(/([A-Z_]*_TOKEN)\s*=\s*[^\s"']+/gi, '$1=<redacted>')
    .replace(/([A-Z_]*_SECRET)\s*=\s*[^\s"']+/gi, '$1=<redacted>')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|rc)-[A-Za-z0-9._-]{8,}/g, '<redacted>')
}

export function buildResult(
  task: BenchmarkTask, guardMode: string, durationMs: number, turns: number, toolCalls: number,
  evalOutcome: { passed: boolean; failures: string[]; testsPassed: number; testsFailed: number },
  extra?: { transcriptPath?: string; workspacePath?: string },
): BenchmarkResult {
  return {
    taskId: task.id, status: evalOutcome.passed ? 'pass' : 'fail', guardMode, turns, toolCalls, durationMs,
    testsPassed: evalOutcome.testsPassed, testsFailed: evalOutcome.testsFailed,
    failureReason: evalOutcome.failures.length ? redactBenchmarkText(evalOutcome.failures.join('; ')) : undefined,
    transcriptPath: extra?.transcriptPath, workspacePath: extra?.workspacePath,
  }
}
