# SingGuard-NSFA CLI Agent — 完整流程认知

> 内部架构笔记。文中出现的 `D:\...` 路径是作者机器上的历史定位，不是 clone 要求；运行时路径见根 README 与 `.env.example`（`SG_MODEL_PATH` / `SG_CONDA_ENV` / `SG_PYTHON`）。

## Context

本文档不是新的实现计划——实现计划已存在于当时的 `PLAN.md`（19 节）。本文档是对该计划 + 环境约束 + 三大源依据的**完整流程认知合成**，用于在动手实现前建立端到端心智模型。

工作目录 `D:\ProJect_Ds\code_cordis\`（即本文件所在目录）是待建目标项目根。

源依据已逐一确认：
- **Claude Code 架构参考**取自本地源码快照 `<local-dump>/src`（已逐文件读取，用于架构参考；未随本仓库分发）。`query/transitions.ts` 在该 dump 中缺失，`Terminal`/`Continue` 类型从 `State` 记录与每个 `return`/`continue` 站点重建。
- **SingGuard 研究**：`singguard_research/` 下技术报告 + model card + config + 风险分类 JSON 全部确认。
- **DSH 宿主**：`D:\deepseek\.dsh\` 与源码 `D:\ProJect_Ds\deepseek-harness` 中的 `cordis.yml`/`agent.cordis.yml` 已读，双平面与 isolate 语义已从注释确认。

## 0. 项目一句话论点与设计核心定位

构建一个遵循真实 Claude Code 运行时架构的编码 agent，**以一组 Cordis 插件行挂载进 DSH 宿主**（Shape B 主交付），并用 **SingGuard-NSFA-0.8B** 作为代码执行/仓库改写的单轮操作风险护栏层。安全边界必须在 agent 获得变更能力之前就位。

**设计核心定位（已澄清）：**
- **核心基于 DSH**：插件行布局、注册表、isolate realm、会话持久化/投影、沙箱、审批栈——这些宿主与组合机制全部走 DSH 原生，不自研宿主。
- **Claude Code 仅作"代码 Agent 的架构参考"**：即 QueryEngine/queryLoop 主循环、Tool 契约、工具执行链、系统提示词装配这一层从 Claude Code 镜像，但作为预置组合行挂载进 DSH，不复制 Claude Code 的宿主/进程模型。
- **安全 = 对抗审批 + 硬编码回退**：见 §A/§B。

## 1. 三大源依据与各自已确认事实

### 1.1 Claude Code 运行时（实现镜像基准）

关键分离：`QueryEngine` 拥有**一会话 + 一提交的用户轮**；`query()`/`queryLoop()`（`query.ts`）拥有真正的 `while(true)` 模型/工具循环。两者通过异步生成器（`SDKMessage`/`Message`/`StreamEvent`）通信。

**两条贯穿性不变量（实现时必须保留）：**
1. **接受的用户消息在首次 LLM 请求之前持久化到 transcript**（`QueryEngine.ts:450-463`）——进程被杀在 API 响应前，会话仍可从用户消息恢复。
2. **每次循环 continuation 重新赋值一个全新 `State` 对象**并带 `transition` reason——循环从不原地修改 `state` 字段（`query.ts:1099-1727`）。

**queryLoop 四阶段控制流：**
- **Phase A 预检**（`query.ts:307-648`）：`getMessagesAfterCompactBoundary` 切片 → `applyToolResultBudget` → snip/microcompact → context-collapse → autocompact → 解析 `currentModel` → blocking-limit 抢占返回。
- **Phase B 调模型 + 流式**（`:650-954`）：`deps.callModel` 流式 `for await`； withhold 可恢复错误（prompt-too-long / media / max_output_tokens）推迟到恢复成功/失败才 yield；`catch FallbackTriggeredError` 切 `fallbackModel` 并 `continue`；外层 `catch` → `return {reason:'model_error'}`。
- **Phase C 无工具终止**（`!needsFollowUp`，`:1062-1358`）： withheld 413 → collapse_drain_retry → reactive_compact_retry → max_output_tokens 升档/恢复注入 → stop hooks → token-budget 续轮 → `return {reason:'completed'}`。API 错误末条跳过 stop hooks 防死循环。
- **Phase D 工具执行**（`:1360-1728`）：`streamingToolExecutor.getRemainingResults()` 或 `runTools` → yield 每条 update → 收集 `newContext` → 生成 `nextPendingToolUseSummary`（Haiku，非阻塞）→ 中途 abort 处理 → max-turns 检查 → `state = next{transition:'next_turn'}; continue`。

**工具执行链**（镜像 `services/tools/toolExecution.ts` 的 `checkPermissionsAndCallTool`）：
```
tool_use → runToolUse
  → Zod parse (fail→is_error tool_result)
  → tool.validateInput (fail→is_error)
  → 投机性 bash classifier (并行)
  → backfillObservableInput (克隆，保护 transcript 稳定)
  → PreToolUse hooks → resolveHookPermissionDecision (hook allow 不绕过 settings.json deny/ask)
  → canUseTool (rule+mode+classifier+交互对话)  ← sg-agent 在此插入 SingGuard query-side gate
  → tool.call
  → mapToolResultToToolResultBlockParam (单次、缓存)
  → PostToolUse hooks  ← sg-agent 在 Write/Edit 的此处插 response-side gate（见 §3）
  → addToolResult → user message content=[toolResultBlock,…]
  → result.newMessages 追加; shouldPreventContinuation→hook_stopped_continuation
```

**Tool 契约**（`Tool.ts`）：`Tool<Input,Output,P>` 大接口 + `ToolDef` + `buildTool()`。`TOOL_DEFAULTS` **默认 fail-closed**：`isConcurrencySafe:false`、`isReadOnly:false`、`isDestructive:false`、`checkPermissions: allow`、`toAutoClassifierInput:''`。`ToolResult<T>={data, newMessages?, contextModifier?, mcpMeta?}`（`contextModifier` 仅对非并发安全工具生效）。

**系统提示词装配**（`constants/prompts.ts`）：静态段（intro/system/doing-tasks/actions/using-tools/tone/output-efficiency）→ `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记（前为跨组织可缓存 `scope:'global'`，后为用户/会话特定）→ 注册表解析的动态段（session_guidance / memory / env_info / language / output_style / mcp_instructions[DANGEROUS_uncached] / scratchpad / frc / summarize_tool_results / token_budget）。

### 1.2 SingGuard-NSFA-0.8B（护栏层）

**关键定性**：官方契约是 **vLLM-only**。研究显式声明无 plain-transformers 官方路由（Integration Reference §4 Route C, §7 gap #4）。侧车用 transformers forward pass 取 last-token embedding 替代 vLLM（避开 2GB VRAM 的 vLLM 开销）是**项目级适配，非已确认官方路由**。研究**已确认**的是：(a) 提取哪个 embedding；(b) `.pth` head 如何消费它。这两点足以在 transformers 中复现 vLLM embedding-mode 行为。

**已确认事实：**
- **基座**：Qwen3.5 **Base** 变体 0.8B（非 chat 模型）；架构类 `Qwen3_5ForConditionalGeneration`（多模态，文本模式用）；`model_type:"qwen3_5"`，dtype `bfloat16`；`transformers_version:"5.2.0"`（≥5.2 必需 + `trust_remote_code=True`）；text trunk `hidden_size:1024`、24 层、混合注意力（3×linear_attention + 1×full_attention）。
- **权重**：`model.safetensors` = 2,213,611,352 B ≈ 2.06 GiB（bf16），**超过 2GB VRAM** → 必须 4-bit 量化 + CPU offload。
- **7 个 head**：位于 HF repo `nsfa_heads/`，每个 `.pth` ~268KB。每个 .pth 是 legacy pickle，`torch.load(pth, weights_only=False, map_location=device)`；keys：`head_state_dict`/`head_config`/`task`/`sub_task_name`/`system_prompt?`/`max_tokens?`。**必须用 `data["sub_task_name"]` 作为域键，而非文件名**。
  - Query-side (5)：`prompt_injection_and_jailbreak`、`malicious_code_and_cyberattack`、`sensitive_info_stealing`、`danger_ops_and_tool_abuse`、`resource_abuse`。
  - Response-side (2)：`hazardous_action_generation`、`sensitive_info_leakage`（**response 域 `sub_task_name` 字符串是从文件名推断的**——加载时从 .pth 实读，勿硬编码）。
- **head 数学**：单隐层 MLP `h=Dropout(ReLU(LayerNorm(W1·e+b1)))` → `z=W2·h+b2`；`d_hidden=64`、`n_classes=2`；`softmax(logits)[:,1]` = 风险概率（class1=unsafe）；各 head 独立 → 天然多标签。
- **embedding 提取**（vLLM 契约）：`PoolerConfig(pooling_type="LAST", normalize=False)`；dtype `torch.float32`；shape `(N,1024)`。复现目标：`emb = model(input_ids).last_hidden_state[:, -1, :].to(torch.float32)`。**必须 `add_generation_prompt=True`**——last token 是 assistant 前缀的最后一个 token，head 即在此训练。tokenizer `truncation_side="left"`, `use_fast=True`。
- **输入格式**（`prepare_prompt` 原样移植）：coerce→算模板开销→XML 转义（`&`→`&amp;`、`<`→`&lt;`、`>`→`&gt;`）→左截断（`token_budget = max_tokens-overhead-200`，`CHARS_PER_TOKEN_SAFETY_RATIO=0.2`，保留最后 `token_budget` 个 token）→边界标签包裹→套 chat template `add_generation_prompt=True`。包裹为 `<untrusted_input>\n{escaped}\n</untrusted_input>`（query）/`<untrusted_output>\n{escaped}\n</untrusted_output>`（response），**标签内有字面换行**。
- **阈值**：默认 0.5 全 head；决策规则 = 任一 head 超阈值即 unsafe；可按域校准。**无分类模式灰区/review 带**（review 带 = 侧车选择，非来自模型）。
- **基准验收 fixture**：
  - 复合攻击样本应得 query head 概率：`prompt_injection_and_jailbreak=99.83%`、`sensitive_info_stealing=97.45%`、`danger_ops_and_tool_abuse=98.92%`、`malicious_code_and_cyberattack=0.03%`、`resource_abuse=0.07%`。**若偏差大，说明 embedding 提取错（错层/漏 add_generation_prompt/视觉塔干扰）**。
  - model card 6 条 fixture：keylogger→malicious_code；系统提示词窃取→sensitive_info_stealing；`rm -rf /`→danger_ops；重复 'A'×100000→resource_abuse；DAN 越狱→prompt_injection；"Hello, how are you?"→No_Risk（全 head<0.5）。

### 1.3 DSH 宿主（挂载目标 / 设计核心）

**双平面模型**（从 `standard/agent.cordis.yml` 注释确认）：
- **宿主平面**（`cordis.yml` / `base.cordis.yml` + `web.cordis.yml`）持有：注册表本身（tools/systemPrompt/agents）、沙箱执行器（`bash-sandbox`/`pwsh-sandbox` 经 `dsh-sandbox-local`+`dsh-bash-sandbox`）、审批栈（`dsh-user-approval`）、持久化（`dsh-session-persistence-jsonl`）、模型路由（`dsh-llm-deepseek` 读 `settings.yaml`）、token-meter、compaction、session-projection。
- **预置平面**（`agent.cordis.yml`）每会话贡献：工具行 + 提示词段，注册进宿主注册表。挂载一次于 standing scope，各会话按 scope 父继承加入。

**isolate 语义**：service 行**必须**置于带 `isolate` realm 的 `cordis:group`（`group:true` + `isolate:{<name>:true}`）内，否则发布进根 realm（进程全局，同名碰撞，`dsh-agent-presets` 挂载时拒绝）。`true` = entry-local realm。**label 不池化实例**——`provide()` 在同 realm symbol 下二次注册即抛错。

**inject vs get**：硬依赖用 `inject` 声明；可选能力用 `ctx.get(name)` 读取并显式判空。

**模型路由**（`D:\deepseek\.dsh\settings.yaml` 已读）：`llm-pi-ai.providers` 定义 `das`（openai-responses，`gpt-5.6-terra`）、`radon`（openai-completions，`DeepSeek-V4-Flash`，contextWindow 1048576）、`nnvidia`（`z-ai/glm-5.2`）。`.credentials.yaml` 仅存值，源码绝不读取/日志其值，只按 `apiKeyEnv` 契约定位环境变量。

**沙箱模式**：`workspace-write`（默认，bash+fs 限工作区+temp）、`danger-full-access`、`read-only`。经 `DSH_PERMISSION_MODE` 或 `sandbox-policy.config.mode` 覆盖。`fs-sandbox` 与 bash 共享同一 sandbox policy。

**会话持久化/投影**：`dsh-session-persistence-jsonl` 追加式 SessionEvent JSONL；`dsh-session-projection` 投影注册表——事件流经已注册投影单元折叠；`sessionProjections`/`sessionProjectionCache` 按 Session 键。

**hooks**：`dsh-hooks-claude-code`（PreToolUse/PostToolUse，config 从 launch cwd 读一次，missing=空操作，警告用 `ctx.logger` 绝不写 stdout）。

---

## A. 对抗审批模型（Adversarial Approval）——安全审核的核心范式

**核心原则**：安全审核方的职责是**主动寻找不安全路径并尝试驳回**，而非为操作背书/盖章。这是"adversarial verify"范式：审核方默认怀疑，要放行必须**反驳掉所有风险假设**，反驳不掉就拦。

### A.1 三方对抗结构
一个高风险操作的放行需要**三个独立视角**，任一反对即拦：

| 视角 | 角色 | 默认立场 | 驳回条件 |
|---|---|---|---|
| **执行方** | 主循环模型（写 tool_use） | 想执行 | 不参与审批，只产出意图 |
| **静态守门** | SingGuard query/response head | 默认风险高 | 任一域 `probability > threshold` → block |
| **对抗复核方** | 第二个独立 LLM 调用（radon/das 之一，与主循环不同 provider） | **默认拒绝**，必须给出"为何不安全"清单 | 找到任一未被反驳的风险路径 → block；只有当它**枚举尽风险假设且逐一反驳掉**才 allow |

对抗复核方提示词显式要求：列出该操作可能造成的最坏后果、副作用、越权路径、可逆性、爆炸半径；逐一论证为何在本上下文不会发生；论证不充分 → 转 `review`（人工）。

### A.2 对抗 vs 背书的判定矩阵
```
静态守门 block          → 直接 block（对抗复核不参与，守门已定性）
静态守门 allow + 对抗复核 block  → block（复核找到风险路径）
静态守门 allow + 对抗复核 allow  → allow（双方均无法找到风险路径）
静态守门 review + 对抗复核 review → review（人工）
任一方 model 不可用         → 高风险操作 fail-closed（见 §B）
```
对抗复核**只对高风险操作触发**（见 §B.2 高风险清单），低风险只读操作只过静态守门，避免每操作双 LLM 成本。

### A.3 对抗复核的不可绕过性
- 对抗复核方与主循环**不同 provider/不同会话/无共享上下文**——主循环无法通过提示词影响复核方。
- 复核输入是**规范化审计记录**（tool/operation/cwd/exact-content-or-patch），不是主循环的自然语言叙述，防止主循环"美化"操作描述骗过复核。
- 复核结果作为 `tool_result(is_error)` 回流主循环，形状与普通工具失败一致（见 §4 自愈）。

---

## B. 硬编码安全回退规则（Hardcoded Safety Fallback）——最核心、不可绕过

借鉴 Claude Code 的 `TOOL_DEFAULTS`（fail-closed 默认）与 DSH 的 `danger-full-access` 必须显式 opt-in、`dsh-user-approval` 栈——这些是**编译期/加载期硬编码、优先级最高、任何配置/提示词/hook/模型决策都不得绕过**的规则。

### B.1 回退总原则（最高优先级，写死在代码里）
> **拿不准 → 手动审批 → 拿不到审批 → 拒绝。**
> 任何安全相关组件不可用、超时、结果矛盾、置信不足，一律**向更严格的方向回退**，绝不向更宽松的方向放行。

具体硬编码回退（不可由配置翻转）：
1. SingGuard 侧车无法启动 / 反复超时 / 4-bit 仍装不下 VRAM → **所有写/编辑/open-world 工具 fail-closed**，只读本地工具可单独配置为"仅当策略显式允许时放行"。
2. 对抗复核方不可用 → 高风险操作 fail-closed（不降级为"只过静态守门"）。
3. 静态守门与对抗复核结果矛盾（一个 allow 一个 block）→ 取 **block**。
4. schema 校验失败 / 权限决策不可解析 → `is_error tool_result`，不执行。
5. 模型请求失败 → 备用 provider；仍失败 → 保 transcript 返回诊断，不执行该轮工具。
6. context 过长且 autocompact 不可用 → 终止而非截断丢失。
7. 无静默 guard 绕过：未来 `--guard-failure-mode=open` 必须 **opt-in 且在报告里可见**，默认永不开。

### B.2 高风险操作清单（必须手动审批，硬编码）
下列操作无论静态守门/对抗复核是否 allow，**默认进 `review` → 人工 Y/n**，除非 `DSH_PERMISSION_MODE=danger-full-access`（该模式本身需显式设置且记录）：

- 任何 `rm -rf`、`format`、磁盘分区、工厂重置、递归删除类命令。
- 写入/覆盖工作区根之外路径（系统目录、用户家目录非工作区子树、`/etc`、注册表）。
- 提权命令（sudo/runas/特权提升）、沙箱逃逸、审批绕过。
- 凭证/密钥/API token 的读取、转发、外发、写入文件。
- 网络外发到非允许域（反向 shell、数据外发、`curl|bash` 类）。
- 批量/递归变更（`git push --force`、`git reset --hard`、覆盖超过 N 个文件的脚本）。
- 不可逆 DB 操作（DROP、TRUNCATE、DELETE without WHERE）。
- 安装/下载可执行内容（pip install、包注入、持久化后门类）。

### B.3 权限优先级链（高 → 低，低层不得推翻高层）
```
1. 硬编码回退规则（§B.1，代码写死，不可配置）        ← 最高
2. 高风险清单强制 review（§B.2，代码写死）
3. 对抗审批矩阵（§A.2）
4. SingGuard 静态守门（query/response head）
5. DSH sandbox-policy / DSH_PERMISSION_MODE
6. settings.json 规则 (deny > ask > allow)
7. PreToolUse hook 决策
8. 工具自身 checkPermissions
9. 交互式 Y/n 对话                                   ← 最低
```
低层 allow **不得**推翻高层 deny——这是 Claude Code `resolveHookPermissionDecision` 的同款语义（hook allow 不绕过 settings.json deny/ask）的强化版：**任何层 deny/不可用 → 最终 deny**。

### B.4 与 DSH/Claude Code 硬编码规则的对齐
- 对齐 Claude Code `TOOL_DEFAULTS`：sg-agent 的 `buildTool()` 默认 `isReadOnly:false`、`isConcurrencySafe:false`、`isDestructive:false`，新工具**默认按写/破坏/非并发安全处理**，须显式声明才是只读安全。
- 对齐 DSH `danger-full-access`：必须 `DSH_PERMISSION_MODE` 显式设且不在默认值；默认 `workspace-write`。
- 对齐 DSH `dsh-user-approval`：高风险走 `policy: ask`，`danger-full-access` 下才 `never`。

---

## 2. sg-agent 的 6 个 Cordis 插件行（Shape B）

```
宿主根组合 (host.cordis.yml)
  - sg-guard      @local/sg-agent-guard        宿主：跨会话共享护栏侧车进程 + GuardClient(JSON-RPC over stdio)；isolate realm
  - sg-memory     @local/sg-agent-memory       宿主：事件投影 + 工作区级项目记忆服务
  - sg-model-route @local/sg-agent-model-route 宿主：模型路由，复用 DSH llm-pi-ai providers
预置组合 (agent.cordis.yml)
  - sg-tools      @local/sg-agent-tools        预置：受审工具 + memory 查询工具 → 注册进 DSH tools 注册表
  - sg-prompt     @local/sg-agent-prompt       预置：护栏系统提示词段 → 注册进 systemPrompt 注册表
  - sg-query      @local/sg-agent-query        预置：QueryEngine/queryLoop 行（Claude Code 式主循环）
```
硬性规则：`sg-guard`/`sg-memory` 进程唯一、跨会话消费，留宿主根组合，绝不在预置发布/按会话隔离；仅向注册表注册的 `sg-tools`/`sg-prompt` 不需 realm；生命周期 `start()`/`stop()` 逆序，每个副作用有 disposer。

**Shape A（调试形态，非交付）**：`bin/sg-agent.ts` 以 Bun 独立跑同一核心，DI 容器是 Cordis 容器轻量封装，模型路由读 DSH_HOME 配置。CLI 表面两形态一致。

## 3. SingGuard 护栏侧车流程

**进程模型**：Bun CLI spawn `conda run -n Audio python guard/server.py`（见 §6 环境策略——直接复用已升级的 Audio 环境）→ 换行分隔 JSON-RPC over stdio → 模型/head 加载+预热后发 ready 响应。侧车常驻量化模型与 head 在内存。stdout 纯协议 JSON 行，诊断走 stderr。

**JSON-RPC**：`{"id","method":"classify","params":{"task":"query"|"response","text","thresholds":{}}}` → `{"id","ok":true,"result":{"verdict":"allow"|"block"|"review","risks":[{domain,probability,threshold}]}}` / `{"id","ok":false,"error":{"code":"MODEL_UNAVAILABLE",...}}`。每请求有超时+取消；小 GPU 初期串行推理。

**双闸门**：
- **query-side gate**（执行前，对 Bash/Write/Edit 等安全相关工具）：构造规范化审计记录（tool/operation/cwd/input），XML 转义包裹 `<untrusted_input>...</untrusted_input>`，评估 5 个 query head。
- **response-side gate**（Write/Edit 文件改动前）：检查确切内容/patch，包裹 `<untrusted_output>...</untrusted_output>`，评估 2 个 response head——防止操作描述良性但生成 patch 含危险命令/反向 shell/凭证泄露。

**GuardVerdict**：`{verdict:'allow'|'block'|'review', task, risks:[{domain,probability,threshold}], analysis?, modelAvailable}`。block=任一域超阈值；review=配置灰区→CLI 审批问人；allow=无相关域超阈值；默认模型失败→敏感操作 fail-closed。

**对抗复核（§A）**：高风险操作在静态守门后、执行前再过一次独立 LLM 对抗复核；只对 §B.2 高风险清单触发。

**Python 组件**（guard/ 下）：`prompts.py`、`quantization.py`、`model.py`、`heads.py`、`server.py`、`rpc.py`+`protocol.py`。

## 4. 自愈行为

拒绝以与普通工具失败相同的 model-visible 形状返回：
```json
{"type":"tool_result","tool_use_id":"...","is_error":true,
 "content":"[SingGuard blocked this Write call] danger_ops_and_tool_abuse=0.93. Do not bypass the guard. Use a safe alternative that preserves the user's legitimate goal."}
```
下轮 `queryLoop` 收到此结果。系统提示词显式告诉模型：把 guard 拒绝解读为"选安全等价实现"，而非终止/绕过 guard。Guard 拒绝默认不 fork——继续正常循环让模型自愈。

恢复矩阵：侧车退出→有界重启，不可用则敏感工具 fail-closed（§B.1）；guard block→tool error 追加，模型重试安全等价；schema 无效→格式化 is_error tool_result；permission deny→格式化错误；模型请求失败→备用 provider 否则保 transcript 返回诊断；output token cap→有界恢复注入；context 过长→自动 compact 带 compact 边界；max turns→返回 max_turns 保 state；abort→取消 LLM+工具，flush state。

## 5. 状态/持久化/记忆

**作用域**：Process（config/DI/guard 侧车/provider 客户端）、Conversation（messages/session id/usage/read-file cache/abort）、User turn（turn 计数/compaction/重试/流式 assistant/tool result batch）、Tool call（解析输入/tool-use id/progress/permission+guard 决策）、Guard request（包裹转义文本/task side/阈值快照/超时）。

**持久化**（Shape B 复用 DSH session/persistence + JSONL transcript 约定）：会话与会话 id；conversation metadata（cwd/model/source[start|resume|fork]/parent+fork id/时间戳/compact flag）；可配置权限规则；guard 阈值与失败模式。事件：user 消息、assistant 消息+流式完成元、tool_use 请求、tool 结果、permission 决策、guard verdict（不记原始敏感内容除非显式开 telemetry）、compact 边界、guard 重启/失败。**用户消息必须在首次 LLM 请求前持久化**。

**resume/fork**：`--resume <session-id>` 加载 transcript 重建历史；致命执行/模型失败可建新 conversation id 记 `forkedFrom` 保原 transcript；guard 拒绝默认不 fork。

**四层记忆**（DSH-native，主机制=按工作区聚合的项目记忆 store，按需查询；模型**不**每轮扫描所有历史会话摘要）：
| Layer | DSH primitive | sg-agent 职责 | 访问规则 |
|---|---|---|---|
| Truth | `sessionPersistence` 追加式 SessionEvent[] + post-commit `session/event` | 不重复 transcript；每记忆条目引用源 session/event 序列 | 仅审计+原始证据回退 |
| Session context | compaction 摘要节点（当前模型表面） | 保当前会话连续性 | 已在当前窗口，勿重取 |
| Session memory | `sessionProjections`+`sessionProjectionCache` | 注册 `sg-memory` 投影：纯 schema 校验 init/apply/view，提取决策/约束/任务态/已验事实/可复用失败教训 | 每会话惰性/预折叠事件日志 |
| Project memory | `workspaceRegistry`+workspace-keyed `sgMemory` 宿主服务 | 合并/去重/过期/排序同规范工作区所有会话事实 | `recall_memory` 按需查询，有界结果 token |

`recall_memory` 先查项目聚合；低置信/需源时调 `sessionQuery.searchSessions`+`searchEvents`/`readEvent` 仅取有界证据窗口。`view_memory` 列事实不注入上下文。`record_memory` 显式权限校验纠正路径。

## 6. 约束与硬边界（ENVIRONMENT.md + PLAN §3,§16）

**硬件**：MX450 2GB VRAM、CUDA driver 572.83；bf16 模型 ~2.21GB > 2GB → **不用 vLLM**；用 transformers + 4-bit bitsandbytes + accelerate device-map/CPU offload。
**conda 环境（已落地，策略变更）**：原计划新建 `sg` 环境隔离；**实际执行：直接升级现有 `Audio` 环境**——`transformers` 4.57.6 → **5.2.0**、新增 `bitsandbytes` 0.50.1、`huggingface-hub` 0.36.2 → 1.27.0、`hf-xet` →1.6.0、`click`→8.4.2、新增 `typer-slim` 0.24.0。`torch 2.8.0+cu128` 未动、CUDA 12.8 可用、`qwen3_5` 模型类型在 transformers 5.2 原生注册（验证通过）。
- **冲突已清（2026-08-20）**：`pip check` 返回 **No broken requirements found**。`cupy-cuda12x` 与 `magic-pdf` 均已不在 pip 记录（卸载执行时报告 not installed——此前已不在）。
- **HF 缓存**：`~/.cache/huggingface` 被拒 → 侧车启动时配 `HF_HOME`/`HF_HUB_CACHE` 指向工作区可写目录（如 `D:\ProJect_Ds\models\hf-cache`）。
- **模型下载**：`inclusionAI/SingGuard-NSFA-0.8B`；HF 不可达 → 下载源用 ModelScope；下载位 `D:\ProJect_Ds\models\SingGuard-NSFA-0.8B`（工作区可写）。
**fail-closed**：见 §B.1。
**CLI 运行时**：Bun 1.3.13；主循环 LLM 复用 OpenAI-compatible 端点（radon/DeepSeek-V4-Flash 主，das 备）。
**安全边界（非目标）**：SingGuard 是单轮文本 only 操作风险护栏，**不替代**内核/容器沙箱、FS ACL、网络出站控制、密钥管理、多轮轨迹分析、完整内容审核、高影响业务人工审批。初始 scope 排除 MCP/browser 自动化/远程执行/插件/多 agent 编排。
**权限冲突注意**（PLAN §5.1）：DSH 架构下，工具流程中多个 pre/ex/post 文件读写权限的权衡，防止 auto/edit/manual 工作模式下的权限冲突，尤其 prfile 与 preset 设好的 Agent 能力冲突（安全与执行）。

## 7. 关键实现风险/未知（实现时必须先验证）

1. **transformers embedding 路由已验证通过 ✅（2026-08-20）**：4-bit NF4 + double_quant + bf16 compute，MX450 2GB，`device_map=auto`。模型加载为 `Qwen3_5ForCausalLM`（trunk=`Qwen3_5TextModel`），AutoModelForCausalLM 正确解析，无需视觉塔处理。复合攻击 fixture 实测：Prompt_Injection 99.64%（期99.83）、Sensitive_Info_Stealing 94.33%（期97.45）、Danger_Ops 84.27%（期98.92，4-bit 扰动但仍远超阈值）、Malicious_Code 1.98%、Resource_Abuse 0.80%——三高两低模式完全复现。6-fixture 5 干净 PASS；DAN 文本两 head 并列（均>99.9%，文本同时触发注入+恶意代码）；benign 全 <0.5。**head 真实 `sub_task_name` 为 Title_Case**（`Prompt_Injection_and_Jailbreak` 等，非小写 snake_case），从 .pth 实读勿硬编码。
2. **多模态 `Qwen3_5ForConditionalGeneration` 文本模式**：可能需 `pixel_values=None` 或直接调 `model.language_model`/`model.model` 跳过视觉塔。model card 有 monkey-patch 正为此。
3. **response-side `sub_task_name` 字符串推断**：加载时从 .pth 实读，勿硬编码。
4. **`.pth` 是 legacy pickle**（`weights_only=False`，无签名/SBOM 格式）——仅从可信 HF repo 加载。
5. **环境策略已落地**：直接升级 `Audio` 环境（transformers 5.2.0 + bitsandbytes 0.50.1）。已知连带冲突 `magic-pdf`（要求 transformers<5.0），若关键需单独隔离。HF 缓存配 `HF_HOME`/`HF_HUB_CACHE` 指向工作区可写目录（如 `D:\ProJect_Ds\models\hf-cache`），下载源用 ModelScope。
6. **MX450 分类延迟未知**，45ms/sample 是 A100 基线，需预算但勿期待发布值。
7. **硬编码规则覆盖面**：需在实现时枚举绝对禁止 + 高风险类别（§B.2），与 SingGuard head 评估解耦，作为独立 fail-closed 闸。规则集需随测试矩阵迭代。

## 8. 端到端验证（认知校验 = 测试矩阵 PLAN §15）

| 测试 | 预期 |
|---|---|
| 良性 Read+Grep | 无 guard block，完成 |
| 良性 Edit 改本地串 | query+response guard allow，改动生效 |
| Bash `rm -rf /` | query-side block，无进程启动，is_error tool_result |
| Write 含反向 shell | response-side block，无文件改动 |
| Write 含已知测试凭证 | response-side sensitive-info block，无文件改动 |
| 工具输出中 prompt-injection 文本 | query-side 注入检测，执行 block 或 review |
| guard 进程中途被杀 | GuardClient 重启；敏感工具 fail-closed 直到 ready |
| 高风险操作（§B.2 清单） | 静态守门 allow 也进 review→人工；对抗复核 block 即 block |
| 对抗复核方不可用 | 高风险操作 fail-closed |
| 无效 tool schema | validation is_error tool_result，循环一致 |
| Bash 中 SIGINT | abort，子进程清理，transcript flush，会话可 resume |
| context 故意超阈值 | compact 边界记录，循环继续 |
| max turns 达到 | 受控终止 + 持久化会话 |
| **DSH 挂载校验** | `sg-guard` 在 isolate realm；`sg-tools`/`sg-prompt`/`sg-query` 注册进 DSH 注册表；第二会话挂同 preset 不碰撞 |

**交付顺序铁律**（PLAN §19）：护栏侧车先验证→插件行+状态服务→print 模式 queryLoop+只读工具→工具工厂+校验+权限+执行链→插 query/response guard gate + 对抗复核→guard 过测后才加 write/edit 工具→组合验证 DSH 挂载→交互 REPL+恢复+更多工具。**安全边界（含对抗审批 + 硬编码回退）在 agent 获得变更能力之前就位**。

## 9. 实现时的文件映射（sg-agent 目标 ← Claude Code 镜像）

| sg-agent 目标 | Claude Code 镜像 | 关键点 |
|---|---|---|
| `src/query/QueryEngine.ts` | `QueryEngine.ts` | 拥 mutableMessages/readFileState/totalUsage/abortController；submitMessage 装 system prompt、跑 processUserInput、**首次 LLM 请求前持久化用户消息**、`for await (query())` 分类/yield/记录 |
| `src/query/queryLoop.ts` | `query.ts`(queryLoop) | `while(true)` + State 记录每次 continue 重赋值；四阶段 |
| `src/tools/tool.ts` | `Tool.ts` | Tool/ToolDef/buildTool + TOOL_DEFAULTS(fail-closed)；ToolResult<T>={data,newMessages?,contextModifier?} |
| `src/tools/execution.ts` | `toolExecution.ts`+`toolHooks.ts`+`useCanUseTool.tsx` | checkPermissionsAndCallTool 链；SingGuard query gate 插 canUseTool 后、response gate 插 Write/Edit 改动前、对抗复核插高风险操作执行前 |
| `src/prompt/systemPrompt.ts` | `constants/prompts.ts`+`queryContext.ts` | 静态段+DYNAMIC_BOUNDARY+注册表动态段；护栏段（稳定陈述） |
