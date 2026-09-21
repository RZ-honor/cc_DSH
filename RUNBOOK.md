# sg-agent RUNBOOK

状态：sg-agent 核心 TS 栈 + GuardMode + 本地 benchmark + SWE-bench 适配器已建。最新 fresh 验收（2026-09-21）：`npm run typecheck` exit 0；**完整 `bun test` 118 pass / 0 fail（746 expect，22 files，132.52s）**，含真实 SingGuard sidecar（`ready=true`，三高两低 + 硬编码 `rm -rf /`）以及 swebench loader/prepare/evaluate/runner。Shape A `--boot-check` exit 0；真实 radon e2e（`swebench/e2e-real.ts`）Edit 修复 `div`、pytest 1/1、`resolved=true`。凭证扫描干净。
## 已完成（已验证）

| 层 | 文件 | 验证 |
|---|---|---|
| 护栏侧车 | `guard/*.py`（server/model/heads/prompts/quantization/hardcoded_rules/rpc/protocol） | `verify_embedding.py` 三高两低复现；`tests/guard-client.test.ts` 3/0（真实 sidecar） |
| GuardClient（TS） | `src/guard-client.ts` + `src/types.ts` | 3/0（spawn/ready/JSON-RPC/fail-closed/有界重启） |
| 宿主行 sg-guard | `plugins/sg-guard.ts` + `host.cordis.yml` | 2/0（ctx.sgGuard + lazy + fail-closed） |
| 宿主行 sg-model-route | `plugins/sg-model-route.ts` | 4/0（radon 主/das 备/首 chunk 前错才 fallback） |
| 宿主行 sg-memory | `plugins/sg-memory.ts` + `src/project-memory.ts` | 9/0（record/dedupe/recall-rank/view/forget/expire） |
| queryLoop + QueryEngine | `src/query/queryLoop.ts` + `QueryEngine.ts` | 3/0（往返/不变量 #1/流错） |
| 工具 + Phase D | `src/tools/{tool,read-only,write,execution}.ts` | 4/0（Read/Grep/Glob + executeTools） |
| 双闸门 + Write/Edit | `execution.ts`（升级）+ `write.ts` | guard-gate 6/0 + write-gate 6/0 |
| 全栈组合 | `tests/full-stack.test.ts` | 2/0（真实 SgModel+QueryEngine+queryLoop+executeTools+tools） |
| 预置适配器 | `plugins/sg-tools.ts` / `sg-prompt.ts` / `sg-query.ts` | `npm run typecheck` 通过；sg-tools 对接真实 `ctx.tools.register(ToolDefinition)`，sg-prompt 对接真实 `ctx.systemPrompt.section()` | 
| Shape A 验收 | `bin/sg-agent.ts` | `--boot-check` 通过；真实 radon 只读 prompt 成功完成（Glob + Read，exit 0） | 
| GuardMode | `src/types.ts` + `src/guard-client.ts` + `plugins/sg-guard.ts` + `src/guard-hardcoded.ts` | guard-mode 测试 25/0（含 hardcoded no-spawn/block、off fail-closed、TS 元数据规则）；真实 sidecar `rm -rf /` 硬编码 block |
| CLI 解析 | `src/cli.ts` + `bin/sg-agent.ts` | cli-args 测试 4/0（`--boot-check`/`--print`/`--guard-mode`/拒绝未知） |
| 本地 benchmark | `benchmarks/{types,evaluate,runner,run,report}.ts` + 24 任务 + README | evaluator 14/0 + runner 6/0 + catalog 3/0；`--deterministic --all` 24/24 产出；报告聚合通过 | 

不变量已落地：#1（用户消息先于 LLM 入 transcript）/ #2（queryLoop 每次 continue 新 State+transition）。安全边界就位：guard block 时 Write/Edit 文件绝不触碰；硬编码规则 first-line 不可绕过（block/review 在任何 mode 都先于模型）；sidecar 死时 TS fail-closed。GuardMode 已落地：`model`/`hardcoded`/`off`，默认 `model`；`--guard-mode` + `--print` + `--boot-check` 严格解析（`src/cli.ts`），`--print` 绝不当 prompt。

## GuardMode 语义与命令

| 模式 | 行为 | 用途 |
|---|---|---|
| `model`（默认） | 硬编码规则 + SingGuard 模型分类 + 高风险人工审批 | 生产默认，不降级 |
| `hardcoded` | 跳过模型分类，保留硬编码规则 + DSH sandbox + 人工审批 | 功能/benchmark 基线，`model_available:false` |
| `off` | 仅显式只读诊断；Write/Edit fail-closed，benchmark 写任务禁用 | 只读调试 |

```bash
bun run bin/sg-agent.ts --boot-check                       # 仅验装配，无模型调用/无 sidecar
bun run bin/sg-agent.ts --guard-mode hardcoded --print "..."  # 真实模型只读 run（跳过模型审核）
bun run bin/sg-agent.ts --guard-mode model --boot-check    # 确认 model 模式装配保留
```

## 本地 Benchmark（local-baseline）

24 任务（6 类×4：file-discovery/code-understanding/single-file-edit/multi-file-edit/test-repair/tool-recovery），离线、机器判定、临时隔离 workspace。凭证统一脱敏；`--guard-mode off` 禁止写类任务。

```bash
bun benchmarks/run.ts --deterministic --smoke --guard-mode=hardcoded --output=benchmarks/results/smoke.jsonl  # 3 个 smoke
bun benchmarks/run.ts --deterministic --all --guard-mode=hardcoded --output=benchmarks/results/all.jsonl        # 全部 24
bun benchmarks/report.ts benchmarks/results/*.jsonl        # 榜单（pass@1/test_pass_rate/turns/p50/p95/failure）
```

**明确**：`hardcoded` 分数衡量 codeagent 能力，不衡量 SingGuard 模型质量；本地榜单不是 SWE-bench 等行业榜单。详见 `benchmarks/README.md`。

## SWE-bench 榜单（swebench/）

真实外部行业榜单。官方 `princeton-nlp/SWE-bench` test split（2294 实例，12 仓库），HF 不可达故经 hf-mirror 下载缓存到 `D:/ProJect_Ds/models/swe-bench/data/`。sg-agent 用真实 radon 推理（Context→LlmRuntime→llm-pi-ai→SgModel→SgGuard→QueryEngine，guard 传入 toolCtx 使 Write/Edit 可被 gate 放行）直接编辑文件修复 issue，然后本地验证模型 diff（`git apply` + 跑 FAIL_TO_PASS/PASS_TO_PASS pytest）。

```bash
bun swebench/convert.ts                                                               # parquet→instances.jsonl（首次，Audio python）
bun swebench/run.ts --repo pallets/flask --limit 2 --deterministic --output swebench/results/flask.jsonl   # 管道自检（不打 API、无 sidecar）
export RADON_API_KEY=...                                                              # 真实推理
bun swebench/run.ts --instances requests__requests-1234 --output swebench/results/requests.jsonl
```

**已完成（实测）**：
- `convert.ts` 产出 2294 test 实例 JSONL；`loader.ts` 过滤（repo/limit/instances）正确。
- `prepare.ts` 经 bash 路由 git（`git -C`，禁 autocrlf）clone+checkout base_commit 稳定；swebench 单元测试覆盖 loader/prepare/evaluate/runner。
- 端到端 deterministic smoke：`pallets/flask --limit 2` 两个实例走通 prepare→evaluate→redacted result 全链。
- 判定收紧：`resolved` 必须「模型改动非空 && 无失败」——无编辑的 agent 永不 credit（本地 env 常不复现官方 bug，防误报）。
- **真实 radon e2e（2026-09-21）**：`bun swebench/e2e-real.ts` 用 DeepSeek-V4-Flash + hardcoded guard，5 轮 / 4 次工具调用（Read→Edit `a + b` → `a / b`），pytest 1/1，`resolved=true`，exit 0。证据：`swebench/results/ACCEPTANCE.md`。系统提示强制「读完必须 Edit/Write」，否则模型会只读就停。

**关键修正（本次会话踩坑）**：`Bun.spawnSync` 直接 spawn `bin/git.exe`（bash-script shim）与在 bun-test worker 里以「git mv 新建的嵌套目录」为 cwd spawn 均 ENOENT/不稳定 → 统一 bash 路由 + `git -C`（cwd 用 JS 建的 base）；`git apply` 空 patch 视为 no-op。

**局限（无 Docker）**：本地 pytest ≠ 官方 SWE-bench 分数（env 差异）；env 崩则降级 static（`evalMethod=static`）；`hardcoded` 不衡量 SingGuard 模型质量（用 `--guard-mode model` 才测）；agent 无 Bash 工具，需 shell 的 issue 不在范围内。详见 `swebench/README.md`。

## 剩余手动收尾

### 1. 预置适配器（已完成并验证）
`plugins/sg-tools.ts` 对接真实 `@deepseek-ai/dsh-tools` 的 `ToolDefinition`/`ctx.tools.register`；`plugins/sg-prompt.ts` 对接真实 `@deepseek-ai/dsh-system-prompt` 的 `ctx.systemPrompt.section`；`plugins/sg-query.ts` 保持 session-scoped QueryEngine 包装。三者当前已通过 typecheck，但真实 preset mount 仍需按 DSH profile 实际启动路径验收。

### 2. 真实 DSH profile 挂载
在 `D:\deepseek\.dsh\profiles\<profile>\cordis.patch.yml`（或新建 profile）里 include sg-agent 组合：
```yaml
- id: sg-host
  name: '@deepseek-ai/cordis-plugin-include'
  config:
    path: D:/ProJect_Ds/code_cordis/host.cordis.yml
```
预置 `agent.cordis.yml` 经 DSH preset 机制挂载（isolate realm，见文件头注释）。

### 2. 真实模型 print run
设凭证（环境变量，按 `settings.yaml` 的 `apiKeyEnv`）：
```bash
export RADON_API_KEY=...   # 主 provider（DeepSeek-V4-Flash，openai-completions）
export DAS_API_KEY=...      # 备 provider（gpt-5.6-terra，openai-responses）
```
侧车 HF 缓存指向可写目录（`~/.cache/huggingface` 被沙箱拒写）：
```bash
export HF_HOME=D:/ProJect_Ds/models/hf-cache
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
```
跑端到端测试矩阵（PLAN §15 / COGNITION §8）：良性 Read/Edit 放行、`rm -rf /` 硬编码 block、反向 shell response-side block、凭证写 block、guard 进程被杀→fail-closed。

## 环境注意（会话间易回退）
Audio 环境的 transformers 会被回退到 4.57.6。若 `qwen3_5` 报错或 `transformers<5.2`：
```bash
conda run -n Audio pip install transformers==5.2.0
```
guard/ 代码与 model/ 权重无需重建。详见记忆 `sg-audio-env-upgrade`。
