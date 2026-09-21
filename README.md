# sg-agent

一个 Claude Code 风格的编码 agent 运行时（`QueryEngine` / `queryLoop` / `Tool`），以 Cordis 插件的形式挂载进 [DeepSeek Harness](https://github.com/deepseek-ai)，并带有不可绕过的硬编码安全层。

本仓库即 `code_cordis` / `DSH_cc` 目录树。许可证：MIT（见 [LICENSE](LICENSE)）。

## 为什么这套设计可以开源

这里的*设计*是一组插件组合，而不是对专有宿主的 fork：

| 层次 | 它是什么 | 它不是什么 |
|---|---|---|
| DSH 宿主 | Cordis 插件行、isolate realm、LLM provider | DeepSeek Harness 的重新实现 |
| Agent 运行时 | QueryEngine / queryLoop / Tool 契约（Claude Code 架构） | Claude Code 本身，或其宿主/进程模型 |
| 安全层 | 硬编码规则 + 审批闸门 + 宿主沙箱 | 一句“请注意安全”的提示词 |

关于「克隆即可运行」，有一点如实说明：DSH 包以 `"workspace:^"` 声明，需要从本地 [deepseek-harness](https://github.com/deepseek-ai) 检出解析。本仓库**不**内嵌 DSH 或 API 密钥。

## 安全：为什么护栏是代码，而不是提示词

一个能执行 `Write`/`Edit` 的编码 agent 就是特权进程。只存在于系统提示词里的护栏是可以被绕过的（越狱、工具结果注入、“忽略以上指令”）。因此安全判定被放在工具执行路径上的**代码层**，而不是提示词里：

```
用户输入
  → QueryEngine / queryLoop
      → executeTools
          1. 硬编码规则  （TypeScript + Python，最先触发，无法跳过）
          2. 工具主体    （Read / Grep / Glob / Write / Edit —— 无 Bash）
          3. 结果复核    （Write/Edit 之后，针对实际内容/patch）
      ← block 时直接拒绝，或转入 review（高风险需要人来裁决，而不是重试）
```

优先级，由高到低：

1. **硬编码规则** —— 绝对拒绝（`rm -rf /`、mkfs、反弹 shell、私钥）与需复核的操作（`sudo`、force-push、`DROP TABLE`、凭据导出）。这是安全兜底核心，不依赖任何外部模型或服务。
2. **人工 / 对抗式审批** —— `review` 对 agent 而言就是拒绝，不是软提示。
3. **DSH 沙箱 / settings / hooks / 工具权限** —— 宿主侧的最后一道边界。

## 环境要求

- [Bun](https://bun.sh)（测试、CLI、类型检查）
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

交互式运行（密钥就绪后）：

```bash
bun bin/sg-agent.ts "list the TypeScript files under src/"
```

## 目录结构

```
bin/sg-agent.ts          Shape A CLI（Context → LlmRuntime → SgModel → 安全闸门 → QueryEngine）
plugins/                 Cordis 插件行：sg-guard、sg-model-route、sg-memory、sg-tools、sg-prompt、sg-query
src/query/               QueryEngine + queryLoop
src/tools/               Read/Grep/Glob/Write/Edit + 带闸门的 executeTools
src/guard-hardcoded.ts   宿主侧硬编码规则（与 guard/hardcoded_rules.py 对应）
host.cordis.yml          ROOT-realm 组合
agent.cordis.yml         每会话 isolate 预设
benchmarks/              本地任务测试集
```

架构说明见 [COGNITION.md](COGNITION.md)（文中部分路径为作者机器的历史路径，不是 clone 要求）。运维说明见 [RUNBOOK.md](RUNBOOK.md)。

## 许可证与第三方

- 本目录树：MIT，Copyright 2026 RZ-honor。
- `@deepseek-ai/*`：MIT（DeepSeek），以本地 workspace peer 方式使用，未复制到本仓库。

不要把真实凭据粘贴到 issue、日志或运行结果中。运行器会对已知密钥模式做脱敏；那只是兜底，不代表可以记录密钥。

## 后续规划

以下是尚未实现的方向，仅作路线说明，当前版本不包含：

- **模型侧风险审计**：引入独立的风险审计模型（例如 SingGuard-NSFA 系列）作为独立进程侧车，在敏感工具执行前后各做一次判定，与硬编码规则组成双侧闸门；侧车不可用时 fail-closed。当前版本尚未接入，安全能力完全由硬编码规则 + 审批 + DSH 沙箱提供。
- **标准基准评测**：对接 SWE-bench 一类公开基准，量化评估 agent 的真实修复能力。
- **工具与记忆**：扩充工具集、改进会话记忆与项目索引，提升长任务表现。
