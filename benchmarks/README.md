# sg-agent Local Benchmark (local-baseline)

An offline, repeatable benchmark for the sg-agent coding agent. It measures
codeagent capability (tool use, code edits, test repair, recovery) on a small
local task set — **not** SingGuard model quality and **not** an industry
benchmark like SWE-bench.

## Scope

- 24 tasks across 6 categories, 4 each:
  - `file-discovery` — locate and read files
  - `code-understanding` — explain/search code
  - `single-file-edit` — modify one file
  - `multi-file-edit` — modify several files together
  - `test-repair` — fix a failing test
  - `tool-recovery` — recover after a failed tool/command
- 3 of the 24 are marked `smoke: true` (fast, offline, deterministic-friendly).
- Every task is offline: no external network, no real credentials, and its
  success is machine-checkable (file content/hash, command exit code, checks).

## Task schema (`benchmarks/*.json`)

```json
{
  "id": "local-file-discovery-001",
  "category": "file-discovery",
  "prompt": "Find the file that contains the string 'needle-7f3a' and report its path.",
  "setup": [
    {"path": "src/gamma.txt", "content": "needle-7f3a is here\n"}
  ],
  "success": {
    "files": [{"path": "src/gamma.txt", "contains": ["needle-7f3a"]}],
    "commands": [{"command": "bun test src/test.js", "expectedExitCode": 0, "timeoutSeconds": 20}],
    "checks": []
  },
  "limits": {"maxTurns": 6, "timeoutSeconds": 30},
  "smoke": false
}
```

- `setup` paths are relative to a fresh temporary workspace created per task.
- `success.files[].path` must be relative and stay inside the workspace
  (enforced by the evaluator's path-escape guard).
- `success.commands[].command` runs with the workspace as cwd and a bounded
  timeout.
- `checks[]` are shell commands that must exit 0.

## Running

All commands run with Bun. The runner always creates an isolated temporary
workspace, materializes `setup`, drives an agent, and saves a redacted JSONL
result (one `BenchmarkResult` per line).

```bash
# Smoke set (3 tasks), offline deterministic factory
bun benchmarks/run.ts --deterministic --smoke --guard-mode=hardcoded --output=benchmarks/results/smoke.jsonl

# Full 24-task catalog, offline deterministic factory
bun benchmarks/run.ts --deterministic --all --guard-mode=hardcoded --output=benchmarks/results/all.jsonl

# Aggregate results into a leaderboard
bun benchmarks/report.ts benchmarks/results/*.jsonl
```

`--deterministic` uses a local-only agent factory (no network, no model). To
evaluate the real agent, drive the runner with the live `QueryEngine` agent
factory (see `benchmarks/runner.ts` `createQueryEngineAgent`) instead of
`--deterministic` — that path needs the model/provider configured.

### Guard modes

- `model` (default) — hardcoded rules + SingGuard model classify + manual approval
- `hardcoded` — skip the model, keep hardcoded rules + DSH sandbox + approval
- `off` — read-only diagnostics only

Write-category tasks (`single-file-edit`, `multi-file-edit`, `test-repair`)
**require** a safety mode and are **rejected** under `--guard-mode off`.

## Metrics

`benchmarks/report.ts` groups results by guardMode and by task category and
prints:

- `pass@1` — passing tasks / total tasks
- `test_pass_rate` — passing assertions / total assertions (files + commands + checks)
- `avg_turns` — mean turns across tasks
- `p50_ms` / `p95_ms` — duration percentiles
- `tool_success` — pass share among tasks that made tool calls
- `recovery` — pass share among attempted tasks
- `breakdown` — pass / fail / error / timeout counts

## Credential hygiene

- Results are redacted before writing (`*_API_KEY`, `*_TOKEN`, `*_SECRET`,
  `Bearer ...`, `rc-`/`sk-` keys).
- The report references task IDs only — it never copies prompts, credentials,
  or full transcripts.
- Never commit `.env`, model cache, sidecar logs, or result workspaces.
- `.env.example` holds blank placeholders only.

## Limitations

- A `pass` here means the task's machine checks passed, not that the agent's
  final prose was correct.
- The leaderboard is a **local baseline**; it is not comparable to SWE-bench or
  other industry leaderboards.
- `tool_success` / `recovery` are proxies derived from final outcomes, not
  per-call instrumentation.
- Model-mode scores are not reported as SingGuard quality; run `hardcoded`
  mode for a codeagent-only capability baseline.