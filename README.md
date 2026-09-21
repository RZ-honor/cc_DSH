# sg-agent

SingGuard-NSFA guarded coding agent. A Claude Code-style runtime (`QueryEngine` / `queryLoop` / `Tool`) mounted into [DeepSeek Harness](https://github.com/deepseek-ai) as Cordis plugins, with an unbypassable hardcoded safety layer and a SingGuard-NSFA-0.8B sidecar.

This repository is the `code_cordis` / `DSH_cc` tree. License: MIT (see [LICENSE](LICENSE)).

## Why this design is open-sourceable

The *design* is a plugin composition, not a fork of a proprietary host:

| Layer | What it is | What it is not |
|---|---|---|
| DSH host | Cordis plugin rows, isolate realms, LLM providers | A reimplementation of DeepSeek Harness |
| Agent runtime | QueryEngine / queryLoop / Tool contract (Claude Code architecture) | Claude Code itself, or its host/process model |
| Safety | Hardcoded rules + SingGuard sidecar + dual gates | A prompt-only “please be safe” instruction |

Clone-and-run is honest about one peer: DSH packages are declared as `"workspace:^"` and resolve from a local [deepseek-harness](https://github.com/deepseek-ai) checkout. This repo does **not** vendor DSH, model weights, or API keys.

## Safety: why the audit model is a module, not a prompt

A coding agent that can `Write`/`Edit` is a privileged process. Guardrails that live only in the system prompt are bypassable (jailbreak, tool-result injection, “ignore previous instructions”). The audit stack is therefore a **separate process with a fail-closed contract**, sitting on the tool-execution path:

```
user prompt
  → QueryEngine / queryLoop
      → executeTools
          1. hardcoded rules          (TypeScript + Python, fire first, cannot be skipped)
          2. query-side SingGuard     (before a sensitive tool runs)
          3. tool body                (Read / Grep / Glob / Write / Edit — no Bash)
          4. response-side SingGuard  (after Write/Edit, on the exact content/patch)
      ← deny on block OR review (high-risk needs a human, not a retry)
```

Priority, highest first:

1. **Hardcoded rules** — absolute denies (`rm -rf /`, mkfs, reverse shells, private keys) and review-band ops (`sudo`, force-push, `DROP TABLE`, credential dumps). These are the core safety fallback and stay even if the model is deleted.
2. **Human / adversarial approval** — `review` is a deny to the agent, not a soft warn.
3. **SingGuard-NSFA-0.8B sidecar** — last-token embedding + 5 query heads + 2 response heads (transformers 4-bit; official vLLM is not required). JSON-RPC over stdio. Sidecar dead → fail-closed.
4. DSH sandbox / settings / hooks / tool permissions.

`GuardMode`:

| Mode | Sidecar | Typical use |
|---|---|---|
| `model` (default) | spawned | production / measuring the guard |
| `hardcoded` | not spawned | measuring the *code agent*; scores are not SingGuard quality |
| `off` | not spawned | fail-closed on every sensitive tool |

Never set `off` to “make the agent work”. Sensitive tools without a live guard are denied.

Weights (`inclusionAI/SingGuard-NSFA-0.8B`, Apache-2.0, ~2 GB) are **downloaded, not vendored**:

```bash
conda run -n Audio python guard/download_model.py
# or: SG_MODEL_PATH=/path/to/dir python guard/download_model.py
```

## Requirements

- [Bun](https://bun.sh) (tests, CLI, typecheck)
- Python 3.10+ with `torch`, `transformers>=5.2`, `bitsandbytes`, `accelerate` (sidecar). Default conda env name: `Audio` (`SG_CONDA_ENV`).
- A local **deepseek-harness** tree so `@deepseek-ai/cordis`, `schemastery`, `dsh-llm`, `dsh-llm-pi-ai`, `dsh-tools`, `dsh-agent`, `dsh-system-prompt` resolve. `package.json` uses `"workspace:^"` — a public clone cannot `bun install` from npm alone.
- An LLM provider key in the environment (never in git): `RADON_API_KEY` and optionally `DAS_API_KEY`. Copy [`.env.example`](.env.example) to `.env`.

Typical layout:

```
<parent>/
  deepseek-harness/     # DSH host (peer workspace)
  DSH_cc/               # this repo (sg-agent)
```

Point Bun/npm workspaces at that parent, or symlink `node_modules/@deepseek-ai/*` at the DSH packages, matching however you already run DSH.

## Quick start

```bash
git clone https://github.com/RZ-honor/DSH_cc.git
cd DSH_cc
cp .env.example .env          # fill RADON_API_KEY; never commit .env
# resolve @deepseek-ai/* from your local DSH checkout, then:

bun install                   # or your DSH workspace install
bun bin/sg-agent.ts --boot-check
bun test
npx tsc --noEmit
```

Interactive (after weights + key):

```bash
export SG_GUARD_MODE=model    # default
bun bin/sg-agent.ts "list the TypeScript files under src/"
```

## Layout

```
bin/sg-agent.ts          Shape A CLI (Context → LlmRuntime → SgModel → SgGuard → QueryEngine)
plugins/                 Cordis rows: sg-guard, sg-model-route, sg-memory, sg-tools, sg-prompt, sg-query
src/query/               QueryEngine + queryLoop
src/tools/               Read/Grep/Glob/Write/Edit + dual-gate executeTools
src/guard-hardcoded.ts   host-side hardcoded rules (mirror of guard/hardcoded_rules.py)
src/guard-client.ts      JSON-RPC client; fail-closed + bounded restart
guard/                   Python sidecar (protocol, heads, 4-bit load, hardcoded rules)
host.cordis.yml          ROOT-realm composition (sidecar is a process singleton)
agent.cordis.yml         per-session isolate preset
swebench/                SWE-bench adapter (local pytest; not the official Docker score)
benchmarks/              local 24-task harness
```

Architecture notes: [COGNITION.md](COGNITION.md) (some paths in that file are historical author-machine paths, not clone requirements). Operator notes: [RUNBOOK.md](RUNBOOK.md).

## SWE-bench

Local adapter — the agent edits files; an evaluator `git apply`s the gold `test_patch` and runs pytest. **No Docker → not an official SWE-bench score.** See [swebench/README.md](swebench/README.md).

```bash
# parquet via SWEBENCH_PARQUET or swebench/data/test-00000-of-00001.parquet
bun swebench/convert.ts
bun swebench/run.ts --repo pallets/flask --limit 2 --deterministic
```

`--guard-mode hardcoded` is the right mode when you want to measure the agent, not the guard.

## What is not in git

| Path | Why |
|---|---|
| `.env` | live API keys |
| `model/` | ~2 GB weights; `guard/download_model.py` |
| `node_modules/` | includes DSH workspace symlinks |
| `swebench/data/*.jsonl`, `*.parquet` | regenerable / oversized |
| `swebench/results/*.jsonl`, `benchmarks/results/*.jsonl` | run dumps (human ACCEPTANCE.md notes are kept) |
| `.claude/`, `.codegraph/` | local editor / index |

## License and third-party

- This tree: MIT, Copyright 2026 RZ-honor.
- SingGuard-NSFA-0.8B weights: Apache-2.0, [inclusionAI/SingGuard-NSFA-0.8B](https://huggingface.co/inclusionAI/SingGuard-NSFA-0.8B) — download separately.
- `@deepseek-ai/*`: MIT (DeepSeek), consumed as a local workspace peer, not copied into this repo.

Do not paste real credentials into issues, logs, or result JSONL. The runner redacts known key patterns; that is a backstop, not a license to log secrets.
