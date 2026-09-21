# sg-agent

受 SingGuard-NSFA 护栏保护的编码 agent。一个 Claude Code 风格的运行时（`QueryEngine` / `queryLoop` / `Tool`），以 Cordis 插件的形式挂载进 [DeepSeek Harness](https://github.com/deepseek-ai)，并带有不可绕过的硬编码安全层与 SingGuard-NSFA-0.8B 侧车（sidecar）。

本仓库即 `code_cordis` / `DSH_cc` 目录树。许可证：MIT（见 [LICENSE](LICENSE)）。

## 为什么这套设计可以开源

这里的*设计*是一组插件组合，而不是对专有宿主的 fork：

| 层次 | 它是什么 | 它不是什么 |
|---|---|---|
| DSH 宿主 | Cordis 插件行、isolate realm、LLM provider | DeepSeek Harness 的重新实现 |
| Agent 运行时 | QueryEngine / queryLoop / Tool 契约（Claude Code 架构） | Claude Code 本身，或其宿主/进程模型 |
| 安全层 | 硬编码规则 + SingGuard 侧车 + 双侧闸门 | 一句“请注意安全”的提示词 |

关于「克隆即可运行」，有一点如实说明：DSH 包以 `"workspace:^"` 声明，需要从本地 [deepseek-harness](https://github.com/deepseek-ai) 检出解析。本仓库**不**内嵌 DSH、模型权重或 API 密钥。

## 安全：为什么审计模型是模块，而不是提示词

一个能执行 `Write`/`Edit` 的编码 agent 就是特权进程。只存在于系统提示词里的护栏是可以被绕过的（越狱、工具结果注入、“忽略以上指令”）。因此审计栈被设计成**独立进程 + fail-closed 契约**，位于工具执行路径上：

```
用户输入
  → QueryEngine / queryLoop
      → executeTools
          1. 硬编码规则          （TypeScript + Python，最先触发，无法跳过）
          2. query 侧 SingGuard   （敏感工具执行前）
          3. 工具主体            （Read / Grep / Glob / Write / Edit —— 无 Bash）
          4. response 侧 SingGuard（Write/Edit 之后，针对实际内容/patch）
      ← block 时直接拒绝，或转入 review（高风险需要人来裁决，而不是重试）
```

优先级，由高到低：

1. **硬编码规则** —— 绝对拒绝（`rm -rf /`、mkfs、反弹 shell、私钥）与需复核的操作（`sudo`、force-push、`DROP TABLE`、凭据导出）。这是安全兜底核心，即使模型被删除也仍然存在。
2. **人工 / 对抗式审批** —— `review` 对 agent 而言就是拒绝，不是软提示。
3. **SingGuard-NSFA-0.8B 侧车** —— last-token 嵌入 + 5 个 query head + 2 个 response head（transformers 4-bit；无需官方 vLLM）。基于 stdio 的 JSON-RPC。侧车挂掉 → fail-closed。
4. DSH 沙箱 / settings / hooks / 工具权限。

`GuardMode`：

| 模式 | 侧车 | 典型用途 |
|---|---|---|
| `model`（默认） | 会启动 | 生产环境 / 评估护栏本身 |
| `hardcoded` | 不启动 | 评估*编码 agent*；分数不代表 SingGuard 质量 |
| `off` | 不启动 | 所有敏感工具一律 fail-closed |

绝不要为了让 agent “跑起来”而设为 `off`。没有在线护栏时，敏感工具会被拒绝。

权重（`inclusionAI/SingGuard-NSFA-0.8B`，Apache-2.0，约 2 GB）是**运行时下载，不随仓库分发**：

```bash
conda run -n Audio python guard/download_model.py
# 或：SG_MODEL_PATH=/path/to/dir python guard/download_model.py
```

## 环境要求

- [Bun](https://bun.sh)（测试、CLI、类型检查）
- Python 3.10+，需 `torch`、`transformers>=5.2`、`bitsandbytes`、`accelerate`（侧车）。默认 conda 环境名：`Audio`（`SG_CONDA_ENV`）。
- 本地 **deepseek-harness** 目录树，使 `@deepseek-ai/cordis`、`schemastery`、`dsh-llm`、`dsh-llm-pi-ai`、`dsh-tools`、`dsh-agent`、`dsh-system-prompt` 能被解析。`package.json` 使用 `"workspace:^"` —— 公开的 clone 无法仅靠 npm 完成 `bun install`。
- 环境变量中的 LLM provider 密钥（绝不入库）：`RADON_API_KEY`，可选 `DAS_API_KEY`。把 [`.env.example`](.env.example) 复制为 `.env`。

典型目录布局：

```
<parent>/
  deepseek-harness/     # DSH 宿主（同级 workspace）
  DSH_cc/               # 本仓库（sg-agent）
```

把 Bun/npm workspace 指向该父目录，或在 DSH 包处软链 `node_modules/@deepseek-ai/*`，与你现有的 DSH 运行方式保持一致即可。

## 快速开始

```bash
git clone https://github.com/RZ-honor/cc_DSH.git
cd DSH_cc
cp .env.example .env          # 填入 RADON_API_KEY；.env 绝不提交
# 先从本地 DSH 检出解析 @deepseek-ai/*，然后：

bun install                   # 或你的 DSH workspace install
bun bin/sg-agent.ts --boot-check
bun test
npx tsc --noEmit
```

交互式运行（权重与密钥就绪后）：

```bash
export SG_GUARD_MODE=model    # 默认
bun bin/sg-agent.ts "list the TypeScript files under src/"
```

## 目录结构

```
bin/sg-agent.ts          Shape A CLI（Context → LlmRuntime → SgModel → SgGuard → QueryEngine）
plugins/                 Cordis 插件行：sg-guard、sg-model-route、sg-memory、sg-tools、sg-prompt、sg-query
src/query/               QueryEngine + queryLoop
src/tools/               Read/Grep/Glob/Write/Edit + 双侧闸门 executeTools
src/guard-hardcoded.ts   宿主侧硬编码规则（与 guard/hardcoded_rules.py 对应）
src/guard-client.ts      JSON-RPC 客户端；fail-closed + 有界重启
guard/                   Python 侧车（protocol、heads、4-bit 加载、硬编码规则）
host.cordis.yml          ROOT-realm 组合（侧车为进程级单例）
agent.cordis.yml         每会话 isolate 预设
swebench/                SWE-bench 适配器（本地 pytest；非官方 Docker 分数）
benchmarks/              本地 24 任务测试集
```

架构说明见 [COGNITION.md](COGNITION.md)（文中部分路径为作者机器的历史路径，不是 clone 要求）。运维说明见 [RUNBOOK.md](RUNBOOK.md)。

## SWE-bench

本地适配器 —— agent 修改文件，评测器再 `git apply` 官方 `test_patch` 并运行 pytest。**不使用 Docker → 不是官方 SWE-bench 分数。** 详见 [swebench/README.md](swebench/README.md)。

```bash
# parquet 通过 SWEBENCH_PARQUET 或 swebench/data/test-00000-of-00001.parquet 指定
bun swebench/convert.ts
bun swebench/run.ts --repo pallets/flask --limit 2 --deterministic
```

当你想评估 agent 而非护栏时，`--guard-mode hardcoded` 才是正确的模式。

## 未纳入 git 的内容

| 路径 | 原因 |
|---|---|
| `.env` | 真实 API 密钥 |
| `model/` | 约 2 GB 权重；用 `guard/download_model.py` 下载 |
| `node_modules/` | 含 DSH workspace 软链 |
| `swebench/data/*.jsonl`、`*.parquet` | 可再生成 / 体积过大 |
| `swebench/results/*.jsonl`、`benchmarks/results/*.jsonl` | 运行产物（人工整理的 ACCEPTANCE.md 会保留） |
| `.claude/`、`.codegraph/` | 本地编辑器 / 索引 |

## 许可证与第三方

- 本目录树：MIT，Copyright 2026 RZ-honor。
- SingGuard-NSFA-0.8B 权重：Apache-2.0，[inclusionAI/SingGuard-NSFA-0.8B](https://huggingface.co/inclusionAI/SingGuard-NSFA-0.8B) —— 需单独下载。
- `@deepseek-ai/*`：MIT（DeepSeek），以本地 workspace peer 方式使用，未复制到本仓库。

不要把真实凭据粘贴到 issue、日志或结果 JSONL 中。运行器会对已知密钥模式做脱敏；那只是兜底，不代表可以记录密钥。
