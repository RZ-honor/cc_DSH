# CodeAgent 功能验收与本地 Benchmark 设计

## 1. 目标与范围

本阶段先验证 codeagent 本身，不以 SingGuard 模型加载是否成功作为 codeagent 功能门槛。模型安全审核采用显式运行时模式控制：默认仍开启；benchmark 与功能验收使用 `hardcoded` 模式，仅跳过模型分类，保留硬编码规则、DSH sandbox 和人工审批接口。`off` 不作为默认模式，仅保留给纯只读诊断。

本阶段不接 SWE-bench 等外部榜单。先建立可重复的本地任务集，覆盖工具调用、代码修改、测试运行、多轮恢复和状态持久化；本地基线稳定后再接外部 benchmark。

## 2. 运行时设计

新增统一的 `GuardMode`：

- `model`：硬编码规则 + SingGuard 模型分类 + 高风险人工审批；默认值。
- `hardcoded`：跳过 SingGuard 模型分类，但保留硬编码规则与人工审批。
- `off`：跳过模型和硬编码审核，仅允许显式只读诊断，不作为 benchmark 默认值。

配置沿 `bin/sg-agent.ts` → `SgGuard`/`ToolCallContext` → `executeTools` 传递。工具执行链不通过删除 guard 分支实现停用，而是让 guard 返回统一 verdict；因此 QueryEngine、ToolResult 和自愈流程保持不变。

模型审核失败时：

- `model` 模式继续 fail-closed。
- `hardcoded` 模式不启动 sidecar，硬编码规则命中 block，其他操作交由 DSH sandbox/人工审批。
- `off` 模式仅用于无写入的诊断，Write/Edit 仍需显式确认或被 benchmark runner 禁止。

runner 必须修正参数解析：`--boot-check`、`--guard-mode <mode>`、`--print <prompt>` 与默认 prompt 分开解析，不能把 `--print` 当成用户 prompt。

## 3. 本地 Benchmark Runner

新增 `benchmarks/`：

- `tasks/*.json`：任务定义、初始化命令、成功条件、限制。
- `runner.ts`：逐任务创建临时工作区，加载指定 guard mode，执行一次 agent turn，保存 transcript 和结果。
- `evaluate.ts`：检查文件快照、命令退出码、测试结果和断言。
- `results/`：每次运行输出 JSONL + 汇总榜单，禁止覆盖历史结果。

任务 schema：

```json
{
  "id": "local-write-001",
  "category": "single-file-edit",
  "prompt": "...",
  "setup": [{"file":"src/example.ts","content":"..."}],
  "success": {
    "files": [{"path":"src/example.ts","sha256":"..."}],
    "commands": [{"run":"bun test","exitCode":0}],
    "checks": ["..." ]
  },
  "limits": {"maxTurns":12,"timeoutSeconds":300}
}
```

每个结果记录：`taskId`、`status`、`guardMode`、`turns`、`toolCalls`、`durationMs`、`testsPassed`、`testsFailed`、`failureReason`、`transcriptPath`、`workspacePath`。

## 4. 首批任务集

首批 24 个任务，分为：

- 文件发现与读取：4
- 代码理解与定位：4
- 单文件修改：4
- 多文件修改：4
- 测试驱动修复：4
- 工具链与恢复：4

每个任务必须可离线运行，不依赖外部网络或真实凭证；写任务在临时 workspace 执行。任务成功必须由机器检查，不能以模型最终文本作为唯一判据。

## 5. 测评指标与榜单

汇总榜单至少包括：

- `pass@1`：一次执行完整通过率。
- `test_pass_rate`：目标测试全部通过率。
- `artifact_accuracy`：文件/patch 与目标断言匹配率。
- `tool_success_rate`：工具调用成功率。
- `recovery_rate`：遇到工具或测试失败后成功恢复的比例。
- `avg_turns`、`p50_duration_ms`、`p95_duration_ms`。
- `failure_breakdown`：解析、模型、工具、测试、超时、权限、环境。

榜单必须按 `guardMode`、model/provider、任务类别和运行日期分组，避免把不同安全策略或模型配置混为一个分数。

## 6. 验收顺序

1. TDD：先为 GuardMode 解析、hardcoded verdict、`--print` 解析写失败测试。
2. 修正 runner 与 guard mode，运行 targeted tests。
3. 运行全部 TS typecheck 和 Bun tests；sidecar 集成失败要单独标注，不得隐藏。
4. 使用 `hardcoded` 模式跑 3 个 smoke benchmark：只读、单文件 benign write、测试修复。
5. smoke 全通过后扩展到 24 个本地任务。
6. 本地榜单稳定后再设计 SWE-bench adapter，不能提前把本地结果宣称为行业 benchmark。

## 7. 非目标

本阶段不修复 MX450 4-bit offload；不删除 SingGuard 代码；不将默认安全模式改为宽松；不接入远程执行、浏览器自动化、MCP 或多 agent benchmark；不上传任务内容、凭证或 workspace 快照到外部服务。
