# CodeAgent GuardMode 与本地 Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不删除 SingGuard、不中断 DSH/Claude Code 风格主循环的前提下，增加安全审核模式控制，修正 Shape A 参数解析，并建立可重复的离线 codeagent 本地 benchmark 与榜单。

**Architecture:** `GuardMode` 由 runner 明确解析并通过 `SgGuard`/`ToolCallContext` 传递。默认 `model`，`hardcoded` 跳过模型分类但仍执行硬编码规则、DSH sandbox 与人工审批接口，`off` 仅允许显式只读诊断且 Write/Edit 仍拒绝。Benchmark runner 为每个任务创建隔离临时 workspace，驱动现有 `QueryEngine`/`queryLoop`，通过文件快照、命令退出码和断言评估，不以模型最终文本作为成功条件。

**Tech Stack:** Bun 1.3.13、TypeScript 5、DSH Cordis、`@deepseek-ai/dsh-llm`、现有 `GuardClient`/SingGuard sidecar、Bun Test、JSONL 结果。

---

## 文件结构与职责

- Modify: `src/types.ts` — 增加 `GuardMode` 与统一模式解析/验证类型。
- Modify: `src/guard-client.ts` — 支持 `model`/`hardcoded` 模式；hardcoded 模式不 spawn sidecar，保留 Python sidecar 同源的硬编码 verdict 请求边界。
- Modify: `plugins/sg-guard.ts` — 接收并暴露 `mode`，将模式传入 `GuardClient`，保持默认 `model`。
- Modify: `src/tools/execution.ts` — 对 `off` 模式保持 Write/Edit fail-closed，对 `hardcoded`/`model` 使用统一 guard verdict。
- Modify: `bin/sg-agent.ts` — 增加严格 CLI 参数解析，支持 `--boot-check`、`--guard-mode <mode>`、`--print <prompt>`，禁止把 `--print` 当用户 prompt。
- Create: `src/cli.ts` — 可单测的参数解析函数，避免直接测试 `process.argv` 副作用。
- Create: `benchmarks/types.ts` — 本地 benchmark task/result schema。
- Create: `benchmarks/runner.ts` — 创建隔离 workspace、调用 QueryEngine、记录脱敏结果。
- Create: `benchmarks/evaluate.ts` — 文件、命令、断言、测试结果评估。
- Create: `benchmarks/tasks/*.json` — 24 个离线任务，按六类各 4 个；首批 smoke 标记 3 个。
- Create: `benchmarks/run.ts` — CLI 入口，支持 `--smoke`、`--all`、`--guard-mode`、`--output`。
- Create: `tests/guard-mode.test.ts` — GuardMode 解析及 hardcoded/off 安全不变量。
- Create: `tests/cli-args.test.ts` — CLI 参数解析回归测试。
- Create: `tests/benchmark-evaluator.test.ts` — 评估器与凭证脱敏测试。
- Create: `tests/benchmark-tasks.test.ts` — 24 个任务 schema/唯一 ID/smoke 集完整性。
- Modify: `RUNBOOK.md` — 命令、模式含义、验收证据和风险。
- Modify: `.env.example` — 只保留空凭证占位，不写入真实 key。
- Create: `benchmarks/README.md` — 任务 schema、运行方式、指标和限制。

---

### Task 1: GuardMode 类型与安全不变量测试

**Files:**
- Modify: `src/types.ts`
- Test: `tests/guard-mode.test.ts`

- [ ] **Step 1: Write the failing tests**

在 `tests/guard-mode.test.ts` 先写以下行为测试：

```ts
import { describe, expect, test } from 'bun:test'
import { parseGuardMode, type GuardMode, failClosedVerdict } from '../src/types.ts'

const allow = { verdict: 'allow', task: 'query', risks: [], hardcoded: null, analysis: null, model_available: true } as const

describe('GuardMode', () => {
  test('defaults missing mode to model', () => {
    expect(parseGuardMode(undefined)).toBe('model')
  })

  test('accepts model, hardcoded and off', () => {
    for (const mode of ['model', 'hardcoded', 'off']) {
      expect(parseGuardMode(mode)).toBe(mode as GuardMode)
    }
  })

  test('rejects unknown mode', () => {
    expect(() => parseGuardMode('unsafe')).toThrow('invalid guard mode')
  })

  test('off mode cannot produce an allow verdict for a write audit', async () => {
    const verdict = failClosedVerdict('query', 'off mode only permits explicit read-only diagnostics')
    expect(verdict.verdict).toBe('block')
    expect(verdict.model_available).toBe(false)
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd D:/ProJect_Ds/code_cordis
bun test tests/guard-mode.test.ts
```

Expected: FAIL because `parseGuardMode` is not exported yet.

- [ ] **Step 3: Implement the minimal type/parser**

在 `src/types.ts` 增加：

```ts
export type GuardMode = 'model' | 'hardcoded' | 'off'

export function parseGuardMode(value: unknown): GuardMode {
  if (value === undefined || value === '') return 'model'
  if (value === 'model' || value === 'hardcoded' || value === 'off') return value
  throw new Error(`invalid guard mode: ${String(value)} (expected model, hardcoded or off)`)
}
```

保持现有 `failClosedVerdict` 不变；它是所有不可用路径的统一 deny 形状。

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command. Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/guard-mode.test.ts
git commit -m "feat: define explicit guard modes"
```

---

### Task 2: GuardClient/SgGuard 模式传播

**Files:**
- Modify: `src/guard-client.ts`
- Modify: `plugins/sg-guard.ts`
- Modify: `src/tools/execution.ts`
- Test: `tests/guard-mode.test.ts`

- [ ] **Step 1: Extend tests before implementation**

追加测试：

```ts
test('hardcoded mode does not spawn a sidecar', async () => {
  let spawned = false
  const guard = new GuardClient({ mode: 'hardcoded', spawnImpl: () => {
    spawned = true
    throw new Error('must not spawn in hardcoded mode')
  }})
  const verdict = await guard.classify({ task: 'query', text: 'hello' })
  expect(spawned).toBe(false)
  expect(verdict.verdict).toBe('allow')
  expect(verdict.model_available).toBe(false)
})

test('hardcoded mode still blocks absolute destructive commands', async () => {
  const guard = new GuardClient({ mode: 'hardcoded' })
  const verdict = await guard.classify({
    task: 'query', text: 'rm -rf /', audit: { tool: 'Bash', operation: 'query' },
  })
  expect(verdict.verdict).toBe('block')
  expect(verdict.hardcoded?.severity).toBe('block')
})
```

- [ ] **Step 2: Run tests and verify RED**

```bash
bun test tests/guard-mode.test.ts
```

Expected: FAIL because `GuardClientConfig.mode` and the hardcoded-only path do not exist.

- [ ] **Step 3: Implement mode-aware GuardClient**

在 `GuardClientConfig` 增加 `mode?: GuardMode`，构造时用 `parseGuardMode(config.mode)`，默认 `model`。把 hardcoded rule evaluation 抽成共享的纯函数（若当前规则只在 Python sidecar，则在 `src/hardcoded-rules.ts` 以同一规则 ID/严重级别实现最小 TS 镜像），并按以下顺序返回：

1. hardcoded block → 立即 block；
2. hardcoded review → review；
3. `mode === 'hardcoded'` → allow（`model_available:false`）；
4. `mode === 'off'` → 对 query/response 写审计返回 fail-closed block；
5. `mode === 'model'` → 既有 sidecar classify 流程。

hardcoded 规则只用于安全回退，不允许调用模型覆盖 block。不要在 `off` 分支为 Write/Edit 返回 allow。

`SgGuardConfig` 增加 `mode?: GuardMode`，`SgGuard.Config` 用 `z.string().default('model')` 后通过 `parseGuardMode` 归一化。`SgGuard` 将 mode 传给 `GuardClient`。

`src/tools/execution.ts` 保持对 `ctx.guard` 缺失的 fail-closed；不要添加绕过 guard 的条件。

- [ ] **Step 4: Run focused tests and typecheck**

```bash
bun test tests/guard-mode.test.ts tests/guard-gate.test.ts tests/write-gate.test.ts
npm run typecheck
```

Expected: focused tests pass and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/guard-client.ts plugins/sg-guard.ts src/tools/execution.ts tests/guard-mode.test.ts src/hardcoded-rules.ts
git commit -m "feat: add fail-closed guard mode propagation"
```

---

### Task 3: 可单测 CLI 参数解析

**Files:**
- Create: `src/cli.ts`
- Modify: `bin/sg-agent.ts`
- Create: `tests/cli-args.test.ts`

- [ ] **Step 1: Write failing parser tests**

```ts
import { describe, expect, test } from 'bun:test'
import { parseCliArgs } from '../src/cli.ts'

describe('sg-agent CLI args', () => {
  test('parses boot check without prompt', () => {
    expect(parseCliArgs(['--boot-check'])).toEqual({ bootCheck: true, guardMode: 'model', prompt: undefined })
  })

  test('parses --print prompt as one prompt', () => {
    expect(parseCliArgs(['--print', 'List', 'the', 'files'])).toEqual({
      bootCheck: false, guardMode: 'model', prompt: 'List the files',
    })
  })

  test('parses guard mode before print prompt', () => {
    expect(parseCliArgs(['--guard-mode', 'hardcoded', '--print', 'write', 'a', 'file'])).toEqual({
      bootCheck: false, guardMode: 'hardcoded', prompt: 'write a file',
    })
  })

  test('rejects missing guard mode value and unknown flags', () => {
    expect(() => parseCliArgs(['--guard-mode'])).toThrow()
    expect(() => parseCliArgs(['--wat'])).toThrow('unknown argument')
  })
})
```

- [ ] **Step 2: Run parser tests and verify RED**

```bash
bun test tests/cli-args.test.ts
```

Expected: FAIL because `src/cli.ts` does not exist.

- [ ] **Step 3: Implement parser**

`parseCliArgs(argv: string[]): ParsedCliArgs` must scan left-to-right, accept exactly:

```ts
export interface ParsedCliArgs {
  bootCheck: boolean
  guardMode: GuardMode
  prompt: string | undefined
}
```

`--boot-check` sets `bootCheck`; `--guard-mode` consumes exactly one value and calls `parseGuardMode`; `--print` consumes all remaining tokens and joins them with spaces. A non-flag first token remains backward-compatible as the prompt. Unknown flags throw. `--print` must never become the prompt string.

修改 `bin/sg-agent.ts` 使用 `parseCliArgs(process.argv.slice(2))`，将 `guardMode` 传给 `SgGuard`；`--boot-check` 不启动 sidecar；只输出 prompt 结果，不把凭证打印到 stdout/stderr。

- [ ] **Step 4: Run parser tests and typecheck**

```bash
bun test tests/cli-args.test.ts
npm run typecheck
```

Expected: all parser tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts bin/sg-agent.ts tests/cli-args.test.ts
 git commit -m "fix: parse sg-agent print and guard mode flags"
```

---

### Task 4: Benchmark schema 与评估器 TDD

**Files:**
- Create: `benchmarks/types.ts`
- Create: `benchmarks/evaluate.ts`
- Create: `tests/benchmark-evaluator.test.ts`

- [ ] **Step 1: Write failing evaluator tests**

覆盖：文件内容 hash/文本断言、命令退出码、测试失败、超时失败、结果脱敏。测试必须使用临时目录和真实文件，不 mock evaluator 本身：

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateTask } from '../benchmarks/evaluate.ts'

test('passes when file and text checks match', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
  writeFileSync(join(cwd, 'answer.txt'), 'correct')
  const result = await evaluateTask(cwd, {
    files: [{ path: 'answer.txt', contains: ['correct'] }], commands: [], checks: [],
  })
  expect(result.passed).toBe(true)
})

test('fails when expected file is missing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sg-bench-'))
  const result = await evaluateTask(cwd, {
    files: [{ path: 'missing.txt', contains: [] }], commands: [], checks: [],
  })
  expect(result.passed).toBe(false)
  expect(result.failures[0]).toContain('missing.txt')
})

test('redacts credential-like values in serialized results', () => {
  const text = 'RADON_API_KEY=secret-value'
  expect(redactBenchmarkText(text)).not.toContain('secret-value')
})
```

- [ ] **Step 2: Run evaluator tests and verify RED**

```bash
bun test tests/benchmark-evaluator.test.ts
```

- [ ] **Step 3: Implement exact schemas/functions**

`benchmarks/types.ts` 定义：

```ts
export interface BenchmarkTask {
  id: string
  category: 'file-discovery' | 'code-understanding' | 'single-file-edit' | 'multi-file-edit' | 'test-repair' | 'tool-recovery'
  prompt: string
  setup: Array<{ path: string; content: string }>
  success: { files: Array<{ path: string; contains?: string[]; sha256?: string }>; commands: Array<{ run: string; exitCode: number }>; checks: string[] }
  limits: { maxTurns: number; timeoutSeconds: number }
  smoke?: boolean
}
export interface BenchmarkResult { taskId: string; status: 'pass' | 'fail' | 'error' | 'timeout'; guardMode: GuardMode; turns: number; toolCalls: number; durationMs: number; testsPassed: number; testsFailed: number; failureReason?: string; transcriptPath?: string; workspacePath?: string }
```

`evaluateTask` 只允许在 task workspace 执行明确的 setup/success 命令；路径必须经 `resolve(workspace, relative)` 并拒绝 workspace 外路径。`redactBenchmarkText` 替换 `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `Bearer ...` 和类似高熵值，结果 JSONL 不写 prompt 中疑似凭证原文。

- [ ] **Step 4: Run evaluator tests and typecheck**

```bash
bun test tests/benchmark-evaluator.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add benchmarks/types.ts benchmarks/evaluate.ts tests/benchmark-evaluator.test.ts
git commit -m "feat: add local benchmark schemas and evaluator"
```

---

### Task 5: Benchmark runner 与 3 个 smoke 任务

**Files:**
- Create: `benchmarks/runner.ts`
- Create: `benchmarks/run.ts`
- Create: `benchmarks/tasks/local-read-001.json`
- Create: `benchmarks/tasks/local-write-001.json`
- Create: `benchmarks/tasks/local-test-repair-001.json`
- Create: `tests/benchmark-runner.test.ts`

- [ ] **Step 1: Write failing runner tests**

测试 runner 在临时目录创建 workspace、写入 setup、调用可注入的 agent factory、保存脱敏 JSONL，并拒绝缺少 guard mode 的写任务。示例断言：

```ts
test('runner creates isolated workspace and persists a redacted result', async () => {
  const result = await runBenchmarkTask(task, {
    guardMode: 'hardcoded',
    outputDir: mkdtempSync(join(tmpdir(), 'sg-results-')),
    createAgent: async () => ({ run: async () => ({ turns: 1, toolCalls: 1 }) }),
  })
  expect(result.status).toBe('pass')
  expect(result.workspacePath).toBeDefined()
  expect(readFileSync(result.resultPath!, 'utf8')).not.toContain('RADON_API_KEY')
})
```

- [ ] **Step 2: Run runner tests and verify RED**

```bash
bun test tests/benchmark-runner.test.ts
```

- [ ] **Step 3: Implement runner**

`runBenchmarkTask` 执行顺序：创建临时 workspace → materialize setup → 创建 `Context`/`SgModel`/`SgGuard`（按 `guardMode`，benchmark 默认 `hardcoded`）→ 构造现有 `QueryEngine`，cwd 指向临时 workspace → 运行 prompt → `evaluateTask` → 记录脱敏 `BenchmarkResult`。模型 provider 可由 runner 注入；离线 smoke 默认使用 deterministic test model，不访问网络。

`benchmarks/run.ts` 支持：

```text
bun benchmarks/run.ts --smoke --guard-mode hardcoded --output benchmarks/results
bun benchmarks/run.ts --all --guard-mode hardcoded --output benchmarks/results
```

禁止 `--guard-mode off` 跑含 Write/Edit 的任务；禁止将 `.env`、API key、完整 sidecar 原始日志复制到 results。

- [ ] **Step 4: Run runner tests and 3-task smoke**

```bash
bun test tests/benchmark-runner.test.ts
bun benchmarks/run.ts --smoke --guard-mode hardcoded --output benchmarks/results
```

Expected: 3 个任务均产生独立 JSONL 结果；每个结果包含 status、duration、turns、toolCalls、failureReason（如有）。

- [ ] **Step 5: Commit**

```bash
git add benchmarks tests/benchmark-runner.test.ts
 git commit -m "feat: add offline benchmark runner and smoke tasks"
```

---

### Task 6: 补齐 24 任务与榜单汇总

**Files:**
- Create: remaining `benchmarks/tasks/*.json` (21 files)
- Create: `benchmarks/report.ts`
- Create: `tests/benchmark-tasks.test.ts`
- Create: `benchmarks/README.md`

- [ ] **Step 1: Write task catalog tests first**

测试：加载全部任务、ID 唯一、六类各 4 个、smoke 恰好 3 个、所有 setup/success 路径为相对路径、所有任务有 maxTurns/timeout、prompt 不含 `RADON_API_KEY`/`DAS_API_KEY`。

- [ ] **Step 2: Run catalog tests and verify RED**

```bash
bun test tests/benchmark-tasks.test.ts
```

- [ ] **Step 3: Add exactly 24 offline tasks**

六类各 4 个：`file-discovery`、`code-understanding`、`single-file-edit`、`multi-file-edit`、`test-repair`、`tool-recovery`。任务必须只操作临时 workspace，不要求外网，不携带真实凭证；每项有机器可判定 success 条件。前三个 smoke 任务标记 `smoke:true`。

- [ ] **Step 4: Implement report aggregation**

`benchmarks/report.ts` 读取结果 JSONL，按 `guardMode`、provider/model、category、run date 分组，输出 `pass@1`、`test_pass_rate`、`artifact_accuracy`、`tool_success_rate`、`recovery_rate`、平均 turns、p50/p95 duration 和 failure breakdown。报告只引用结果中的 task ID，不复制 prompt/凭证/完整 transcript。

- [ ] **Step 5: Run catalog and report tests**

```bash
bun test tests/benchmark-tasks.test.ts tests/benchmark-evaluator.test.ts tests/benchmark-runner.test.ts
bun benchmarks/run.ts --all --guard-mode hardcoded --output benchmarks/results
bun benchmarks/report.ts benchmarks/results/*.jsonl
```

- [ ] **Step 6: Commit**

```bash
git add benchmarks tests/benchmark-tasks.test.ts benchmarks/README.md
 git commit -m "feat: add 24-task local benchmark catalog and report"
```

---

### Task 7: Full acceptance and documentation

**Files:**
- Modify: `RUNBOOK.md`
- Modify: `.env.example`
- Create: `benchmarks/results/ACCEPTANCE.md`

- [ ] **Step 1: Run fresh full validation**

```bash
cd D:/ProJect_Ds/code_cordis
npm run typecheck
bun test
bun run bin/sg-agent.ts --boot-check
bun run bin/sg-agent.ts --guard-mode hardcoded --print "List the files in the current directory and read the first one."
bun benchmarks/run.ts --smoke --guard-mode hardcoded --output benchmarks/results
```

Record actual exit codes and counts; do not claim success from prior runs.

- [ ] **Step 2: Run security-mode checks**

```bash
bun run bin/sg-agent.ts --guard-mode model --boot-check
bun run bin/sg-agent.ts --guard-mode off --print "List files"
```

Expected: model mode preserves existing sidecar path; off mode does not allow Write/Edit. If model sidecar is unavailable, report fail-closed rather than masking it.

- [ ] **Step 3: Update RUNBOOK and acceptance report**

Document exact commands, actual results, mode semantics, benchmark counts, provider/model, elapsed time, skipped/failed tests, and sidecar limitations. Explicitly state that `hardcoded` benchmark scores do not measure SingGuard model quality.

- [ ] **Step 4: Verify credential hygiene**

```bash
cd D:/ProJect_Ds/code_cordis
if grep -RInE 'RADON_API_KEY=[^$[:space:]]+|DAS_API_KEY=[^$[:space:]]+|Bearer [A-Za-z0-9._-]+' --exclude=.env --exclude-dir=node_modules --exclude-dir=.git .; then exit 1; else echo 'credential scan clean'; fi
```

`.env.example` must contain only blank placeholders. Never include `.env`, model cache, sidecar logs, or result workspaces in git.

- [ ] **Step 5: Commit final acceptance documentation**

```bash
git add RUNBOOK.md .env.example benchmarks/results/ACCEPTANCE.md
 git commit -m "docs: record codeagent and local benchmark acceptance"
```

---

## Verification Evidence Required Before Completion

必须提供本次会话刚运行的证据：

1. `npm run typecheck` exit 0。
2. `bun test` 显示完整 pass/fail 数量，不能只引用 targeted tests。
3. `--boot-check` exit 0。
4. `--guard-mode hardcoded --print` 真实运行结果。
5. 3 个 smoke benchmark 的 JSONL 结果。
6. 24-task catalog 检查结果（6 类 × 4）。
7. 凭证扫描无命中。
8. 如运行 `model` 模式失败，明确写出失败组件（模型加载/sidecar/provider/工具/评估器），不能把 hardcoded 结果当作 model guard 结果。

## Risks and Controls

- **Sidecar 负载慢/失败**：不删除 model 模式；hardcoded 仅用于功能基线，结果单独标记。
- **`off` 绕过写操作**：execution 层与 runner 双重拒绝 Write/Edit。
- **任务被模型最终文本误导**：只使用文件/命令/测试断言判定。
- **路径逃逸**：setup、success、workspace 统一做相对路径校验。
- **凭证泄露**：环境变量只由 provider 读取；结果/transcript/log 统一脱敏；`.env.example` 只留空值。
- **本地 benchmark 与行业 benchmark 混淆**：报告标题明确 `local-baseline`，SWE-bench 另行实现。
- **DSH 架构偏离**：runner 只创建现有 `Context`/`SgModel`/`SgGuard`/`QueryEngine`，不复制宿主或另造 agent loop。
