# SWE-bench adapter for sg-agent

Runs the **SWE-bench** benchmark (real GitHub issues from 12 open-source repos)
through sg-agent's real inference stack — `Context → LlmRuntime → llm-pi-ai →
SgModel → SgGuard → QueryEngine` — with the SingGuard guard threaded into the
tool context. The model edits repository files directly (Read/Grep/Glob/Write/
Edit; **no shell tool**). After the agent finishes, its working-tree diff is
evaluated locally against the gold regression tests.

## Quick start

```bash
# 1. Convert the SWE-bench parquet to JSONL (once; needs the Audio conda python).
bun swebench/convert.ts

# 2. Deterministic pipeline check — no provider call, no sidecar, no cost.
bun swebench/run.ts --repo pallets/flask --limit 2 --deterministic \
  --output swebench/results/flask.jsonl

# 3. Real radon inference (RADON_API_KEY must be set).
export RADON_API_KEY=...
bun swebench/run.ts --instances requests__requests-1234 \
  --output swebench/results/requests.jsonl
```

## Files

| Path | Purpose |
|------|---------|
| `convert.ts` | parquet → `swebench/data/instances.jsonl` (via Audio conda python + pyarrow). Idempotent. |
| `loader.ts` | read the JSONL + filter (`--repo` / `--limit` / `--instances`). |
| `git.ts` | bash-routed git helpers (`git -C` from a safe cwd). |
| `prepare.ts` | clone a repo at `base_commit` into `reposDir/<repo>/`, disable autocrlf, write `PROBLEM.md`. |
| `evaluate.ts` | apply model diff + gold test_patch, run FAIL_TO_PASS / PASS_TO_PASS, judge `resolved`. |
| `runner.ts` | one instance: prepare → real agent stack → capture diff → evaluate → redacted result. |
| `run.ts` | CLI entry (flags below). |

## Flags (`bun swebench/run.ts`)

- `--repo <owner/name>` — filter to one repo (e.g. `pytest-dev/pytest`).
- `--limit <n>` — cap the number of instances.
- `--instances a,b` — exact instance ids.
- `--output <path>` — result JSONL (default `swebench/results.jsonl`).
- `--repos-dir <dir>` — per-repo clone cache (default system temp).
- `--guard-mode hardcoded|model|off` — default `hardcoded`.
- `--deterministic` — fake agent; **no provider call, no sidecar** (pipeline check only).
- `--pytest-timeout-ms <n>` — pytest timeout per invocation.

## Data source

Official `princeton-nlp/SWE-bench` **test** split (2294 instances, 12 repos:
django 850 / sympy 386 / scikit-learn 229 / sphinx 187 / matplotlib 184 /
pytest 119 / xarray 110 / astropy 95 / pylint 57 / requests 44 / seaborn 22 /
flask 11). Point `SWEBENCH_PARQUET` at the test parquet (or drop it in
`swebench/data/`) then run `bun swebench/convert.ts`. The gold `patch` /
`test_patch` are present for **local verification only** and are never fed
to the model.

## Evaluation approach (no Docker)

This host has **no Docker**, so the official containerized SWE-bench harness
cannot run. Instead the evaluator:

1. `git apply` the model's diff.
2. `git apply` the gold `test_patch` (adds the regression tests).
3. Run `FAIL_TO_PASS` + `PASS_TO_PASS` pytest node ids with `$SG_PYTHON`
   (or `$CONDA_PREFIX` / `python`).
4. Verdict: **resolved = the model made a non-empty change AND nothing failed**
   (tests passed, or the diff applied cleanly when the env could not run).

### Known limitations

- **Local pytest ≠ official SWE-bench score.** Dependency and environment
  differences mean a test can pass locally without the model's fix (or fail
  locally when it passes upstream). The verdict requires a **non-empty model
  diff** so a no-op agent is never credited.
- **Env breakage degrades to static verification.** If the test environment
  cannot be established (import errors, missing deps), the evaluator falls back
  to "patch applied cleanly + non-empty diff" and marks `evalMethod=static`.
- **hardcoded guard mode does not measure SingGuard model quality.** It spawns
  no sidecar and gate-checks benign edits as `allow`, so these runs measure
  code-agent ability, not the SingGuard NSFA model. Use `--guard-mode model`
  to measure the guard's filtering.
- No Bash tool for the agent — issues that need shell-only steps are out of
  scope for this harness.

## Credential safety

- `RADON_API_KEY` / `DAS_API_KEY` are read by llm-pi-ai from env vars; the
  runner never touches the secret value.
- Every result line is passed through `redactBenchmarkText` before writing.
- `.env` is never committed; see `.env.example` for the placeholder shape.