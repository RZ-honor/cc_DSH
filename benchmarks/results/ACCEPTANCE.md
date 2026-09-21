# sg-agent 本地 Benchmark 验收（ACCEPTANCE）

> 日期：2026-08-25
> 范围：GuardMode + CLI 解析 + 24-task 本地 catalog + runner + report。**hardcoded 分数衡量 codeagent 能力，不衡量 SingGuard 模型质量；本地榜单不是 SWE-bench 等行业榜单。**

## 运行证据（本次会话实际输出）

### 1. typecheck
```
npm run typecheck → tsc --noEmit → exit 0
```

### 2. 完整测试
```
bun test → 100 pass / 0 fail（527 expect），18 files，50.22s
```
包含真实 SingGuard sidecar 集成 fixture：
- `compound attack: three-high-two-low pattern reproduces` — 模型必须真实命中（`skipHardcoded` 直达模型，三高两低复现）
- `6-fixture set: each malicious fires its head, benign stays low`
- `dangerous command short-circuits to a hardcoded block before the model` — `rm -rf /` → `HC-FORBID-RMRF-ROOT` block，模型不 consult

### 3. Shape A CLI
```
bun run bin/sg-agent.ts --boot-check
  → stack loaded: {llm,sgModel,sgGuard,sgModelProvider:"radon",sgModelModel:"DeepSeek-V4-Flash"}
  → boot-check OK (no model call, no sidecar) → exit 0

bun run bin/sg-agent.ts --guard-mode model --boot-check
  → boot-check OK（model 模式装配保留，lazy-start 不 spawn sidecar）→ exit 0

bun run bin/sg-agent.ts --guard-mode hardcoded --print "Count how many files are in this directory..."
  → tool-call Glob / tool-result / 最终文本 "6 files." / done → exit 0

bun run bin/sg-agent.ts --guard-mode off --print "List the files..."
  → prompt content redacted / done → exit 0（Write/Edit fail-closed 保留）
```

### 4. 3 个 smoke benchmark
`benchmarks/results/smoke.jsonl`（全部 pass，`guardMode=hardcoded`）：
```jsonl
{"taskId":"smoke-benign-write","status":"pass","guardMode":"hardcoded","testsPassed":1,...}
{"taskId":"smoke-read-only","status":"pass","guardMode":"hardcoded","testsPassed":1,...}
{"taskId":"smoke-test-repair","status":"pass","guardMode":"hardcoded","testsPassed":1,...}
```

### 5. 24-task catalog 校验
```
bun test tests/benchmark-tasks.test.ts → 3/0
  - 24 个任务、ID 唯一、6 类×4
  - smoke 恰 3 个
  - 全部 setup/success 相对路径安全、limits 有界、无凭证
```

### 6. `--all` 全 catalog 运行
```
bun benchmarks/run.ts --deterministic --all --guard-mode=hardcoded --output=benchmarks/results/all.jsonl
  → 24 条结果，guardMode=hardcoded（14 pass / 10 fail，deterministic 工厂只修 smoke 写任务，属预期）
  → results 凭证扫描干净（无 RADON/DAS/rc-/Bearer 泄露）
```

### 7. 凭证扫描
```
grep -RInE 'RADON_API_KEY=[^$[:space:]]+|...|rc-[A-Za-z0-9]{20,}|Bearer ...' (excl .env/node_modules/.git/model)
  → 唯一真实 key 命中在 .env（gitignored，合法）；.env.example 仅空占位
  → 修复了 tests/benchmark-evaluator.test.ts 中误含的真实 RADON_API_KEY 值 → 占位假值
  → 其余命中均为文档/测试夹具的变量名或假值（合法引用）
```

## GuardMode 验收结论

- `model`（默认）：保留 SingGuard 模型分类路径；`--boot-check` 确认装配不回归；集成测试确认真实 sidecar 三高两低复现。
- `hardcoded`：不 spawn sidecar（测试 no-spawn 断言），硬编码规则 block/review 先于模型，Write/Edit 仍受 DSH sandbox + 人工审批保护。
- `off`：直接 classify 一律 fail-closed block；仅显式只读诊断放行；benchmark 写任务被 runner 拒绝。

## 已知限制

- 真实 SingGuard sidecar 加载需 model/ 权重（2GB，gitignored），仅集成测试在模型存在时运行。
- hardcoded/off 分数是 codeagent 能力基线，**不代表** SingGuard 模型质量。
- `tool_success`/`recovery` 为由最终结果推导的代理指标，非逐调用埋点。
- 真实 agent 评估（非 `--deterministic`）需配置 provider 与模型，属下一步手动验收。