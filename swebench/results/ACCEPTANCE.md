# SWE-bench adapter 验收（ACCEPTANCE）

> 日期：2026-09-21
> 范围：SWE-bench 适配器（loader/prepare/evaluate/runner/CLI）+ 真实 radon 推理 e2e（本地 mini repo，无 GitHub）。**hardcoded 分数衡量 codeagent 能力，不衡量 SingGuard 模型质量；本地 pytest ≠ 官方 SWE-bench 分数。**

## 运行证据（本次会话实际输出）

### 1. typecheck
```
npm run typecheck → tsc --noEmit → exit 0
```

### 2. Shape A CLI
```
bun bin/sg-agent.ts --boot-check
  → stack loaded: {llm:true, sgModel:true, sgGuard:true, sgModelProvider:"radon", sgModelModel:"DeepSeek-V4-Flash"}
  → boot-check OK (no model call, no sidecar) → exit 0
```
`RADON_API_KEY` 已设置（值未写入任何结果）。`DAS_API_KEY` 本会话未设置；e2e 未走 fallback。

### 3. 真实 radon e2e（`bun swebench/e2e-real.ts`）

本地迷你仓库：`calc.py` 的 `div` 写成 `return a + b`，`test_calc.py` 断言 `div(8, 2) == 4`。栈：
`Context → LlmRuntime → llm-pi-ai(radon) → SgModel(DeepSeek-V4-Flash) → SgGuard(hardcoded, lazyStart) → QueryEngine(ALL_TOOLS, guard in toolCtx)`。

一次完整成功跑（后台任务 `bvbs31qeg`）：

```
[t3] blocks=text,tool-call:Read  arguments={"file_path":"calc.py"}
[t4] blocks=text,tool-call:Edit  arguments={"file_path":"calc.py","old_string":"return a + b","new_string":"return a / b"}
  result(...) isErr=false: edited calc.py
[e2e-real] turns=5 toolCalls=4
[e2e-real] outcome: resolved=true eval=tests tests=1/1
[e2e-real] model diff (157B):
diff --git a/calc.py b/calc.py
--- a/calc.py
+++ b/calc.py
 def div(a, b):
-    return a + b
+    return a / b
exit 0
```

含义：模型不只读了文件——它发出了 `Edit`，硬编码闸门放行良性写，工作树 diff 非空，Audio python pytest `test_calc.py::test_div` 通过。空 diff 永不 credit（`evaluateSwebench` 要求 `hasModelEdit && testsFailed === 0`）。

更早几次失败是模型只 Read/Grep 就停（`turns=2 toolCalls=1, NO model diff`），不是栈坏。系统提示已加强：「读完后必须 Edit/Write，不得只读就停」。

### 4. bun test
- 全量（含真实 sidecar）：**118 pass / 0 fail**（746 expect，22 files，132.52s）。`[guard] ready=true model_available=true`。
- 中间一次失败是 `swebench prepare > reuses an already-cloned repo` 在 30s 超时：`bash -lc` 每次 git spawn 都 source conda/profile。已改为 `bash -c`。
- 另一次失败是 `swebench-loader` 的 `beforeAll` 默认 5s 超时（sidecar 刚 teardown 时 pandas spawn 偶发慢）。JSONL 已存在则跳过 convert，hook 超时提到 120s。
- `npm run typecheck` → exit 0。

### 5. 管道自检
`tests/swebench-runner.test.ts` 的 `--deterministic` 路径：fake agent 不打 API、不 spawn sidecar，产出 `status=fail resolved=false`（无编辑永不 credit）。

### 6. 凭证
结果 JSONL / 日志 / 本文件均无真实 key。`redactBenchmarkText` 在 runner/evaluate 写出前过一遍。`.env` 不提交。

## 局限
- 无 Docker → 本地 pytest ≠ 官方 SWE-bench 分数。
- `hardcoded` 不 spawn sidecar，不衡量 SingGuard 模型质量。
- agent 无 Bash 工具。
- 本 e2e 是本地迷你仓库，不是官方 2294 实例中的一条。官方实例需 `bun swebench/run.ts --repo … --limit N`（GitHub clone + 真实 radon）。
