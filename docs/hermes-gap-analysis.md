# Hermes Agent 能力对比与缺口分析

> 分析对象：本仓库 `one-agent`（main，本地工作区状态）vs. Hermes Agent 源码 checkout `~/.hermes/hermes-agent`（branch `main`，HEAD `9dee8863e1`，2026-09-19）
> 分析日期：2026-09-20 · 结论用于确定 one-agent 后续里程碑的取舍，不代表要追平 Hermes
> 方法：one-agent 侧逐文件通读（内核 + 应用层）；Hermes 侧 5 个并行子代理分域勘察 + 关键路径存在性复核。可信度说明见 §8。

---

## 1. 定位与量级

| 维度 | one-agent | Hermes Agent |
|---|---|---|
| 定位 | 自研 agent 内核 + 单用户 Web 应用（配置即数据） | agent 运行时 + 工具生态 + 多渠道路由 + 长时任务治理 |
| 规模 | 11,617 行（含测试；内核 `one-agent-core` ≈ 2.3k） | `cli.py` 单文件 228KB；`tools/` 268 文件；`agent/` 244 项 |
| 内核 | 自研 Provider + ToolRegistry + ReAct loop（3 个源文件：`Agent.ts` / `AgentLoop.ts` / `ToolRegistry.ts`） | mixin 拼装的 `AIAgent` + 阶段化 turn pipeline（`turn_preflight` / `turn_api_call` / `turn_response_check` / `turn_tool_round` / `turn_overflow` / `turn_recovery` / `turn_finalizer`） |
| Provider | 2（openai-compatible / anthropic 原生） | 39 个 provider 插件 + 5 种传输层（chat_completions / anthropic / bedrock / codex / codex_app_server） |
| 工具 | 9 内置 + MCP 桥 + `knowledge_search` | 注册 100 个，默认按 toolset + `check_fn` 暴露 24–25 个 |
| 交互面 | Next.js 5 页面 + SSE + HTTP API | CLI / TUI / Dashboard / Electron / ACP 编辑器 + 22 个消息平台 |
| 长时任务 | 无 | cron + kanban + 后台进程 + 子代理 |
| 对外契约 | `contracts/`（流协议 + JSON Schema，为 Python 内核预留） | 单语言；扩展面为 plugins / hooks |

---

## 2. one-agent 现状基线（避免误报缺口）

已实现且可用的能力（均经源码确认）：

- **Provider 层**：原生 fetch + `eventsource-parser`，流式 SSE 解析、工具参数跨 chunk 分片聚合、`usage` / `prompt_cache_hit_tokens` 统计、AbortSignal 传导（`one-agent-core/src/providers/openai-compatible.ts:107`、`providers/anthropic.ts`）。
- **工具系统**：运行时 `add/remove/update`、zod 入参校验、`meta.dangerous` 审批钩子、`meta.sandbox` → worker_threads 隔离执行、异常不抛出（`tools/ToolRegistry.ts:54`、`tools/define.ts`）。
- **内置工具 9 个**：`read`（支持 `paths` 批量）/ `write` / `edit` / `bash` / `grep` / `find` / `ls` / `tree` / `web_search`。
- **MCP 桥**：stdio + streamable HTTP，连接时拉取工具列表并带前缀注册，`disconnect()` 注销（`mcp/McpBridge.ts`）。
- **Agent loop**：ReAct，同轮多工具 `Promise.all` 并行、结果按原序回填、迭代耗尽前注入收尾 system 提示、usage 聚合、错误 chunk 终止（`agent/AgentLoop.ts:60-188`）。
- **记忆**：`none` / `window`（保留 system + 最近 N 条）/ `compaction`（摘要压缩，阈值 75%、保留最近 6 条）；粗略 token 估算（CJK 1 token/字，英文 1 token/4 字符）。
- **会话**：SQLite（`node:sqlite`，WAL）+ 内存两种 SessionStore、消息级 usage、会话标题、`session.meta` 存覆盖项（`session/SqliteSessionStore.ts`、`agent/Agent.ts:99-130`）。
- **应用层**：SSE 桥（`app/api/chat/route.ts`）、Agents 管理 UI、会话级 model/tool override、`allowDangerous` 默认拒绝、API key AES-256-GCM 加密（`lib/crypto.ts`）、请求日志（`lib/observability.ts`）、完整 RAG（bge-m3 本地向量 + BM25 + RRF + 可选 cross-encoder 重排 + `knowledge_search`）。

---

## 3. Hermes 能力全景（勘察结果摘要）

- **工具目录**：文件 4 + 终端 2 + 代码执行 1 + 委派 1 + Web 3 + 媒体 7 + 浏览器 12 + agent 状态 5 + 技能 3 + 调度 1 + kanban 14 + 桌面 GUI 12 + HomeAssistant 4 + 平台工具（discord/feishu/yuanbao/spotify/a2a/google_meet）+ 动态 `mcp__*`。
- **渐进式工具披露**：`tool_search` / `tool_describe` / `tool_call` 桥 + 默认延迟集合（`tools/tool_search.py:134`）。
- **可靠性骨架**：`IterationBudget`（父 500 / 子 50，`execute_code` 轮退款）、空响应守卫（含成本感知重试预算）、复读/停滞守卫、28 类错误分类驱动的 retry/rotate/compress/fallback、凭据池、fallback 冷却（60s→4h）。
- **上下文**：两层压缩（gateway 85% + agent 50%，先 prune tool result 再 LLM 摘要，`protect_first_n=3` / `protect_last_n=20`）、上下文分桶统计、prompt cache 字节稳定不变量。
- **持久状态**：长期记忆 `MEMORY.md` / `USER.md`、技能 SKILL.md + curator、会话 FTS5 检索、shadow-git checkpoints、cron jobs.json、kanban SQLite、learning graph。
- **安全**：三档审批 + 87KB 危险命令检测 + 用户 deny 高于 yolo、OS 级沙箱（docker/singularity/modal/daytona/ssh）、注入扫描、SSRF 底线、密钥脱敏、ESTOP。
- **运维**：doctor 自诊断、backup/升级迁移、profile 隔离、i18n 17 语言、主题皮肤、insights 报表、OTel 导出。

---

## 4. 缺口清单（Hermes 有 / one-agent 没有）

### 4.1 工具工程化

| 能力 | Hermes 实现要点 | one-agent 现状 |
|---|---|---|
| 编辑 | 9 级模糊匹配、V4A 多文件、写前读保护、写后 SHA-256、语法/LSP 校验（`tools/file_tools.py`、`file_tools_write_guards.py`、`tool_dispatch_helpers.py`） | `edit.ts` 精确 `split` 替换，无模糊、无校验、无写保护 |
| 读取 | 行号、双预算（行 + 字符）、文档抽取（pdf/docx/xlsx/epub/ipynb）、图片拒读并引导 vision | 裸文本 + 单 `maxChars` 截断；图片只回元信息 |
| 结果预算 | 每工具 `max_result_size_chars` + 按窗口 15%/结果、30%/轮动态取（`tools/budget_config.py`）+ 40/60 头尾截断（`tools/tool_output_truncate.py`） | **无任何截断策略**，工具输出全量进上下文 |
| 终端 | 持久 shell（cwd/env 跨调用）、7 后端、后台进程 + notify、>600s 自动升级后台、sudo 处理 | 单次 `exec`，30s 超时，`maxBuffer` 10MB 后丢尾 |
| 进程管理 | `process_manage` 9 动作 + 200KB 滚动缓冲 + 完成回执 | 无 |
| 代码执行 | `execute_code` kernel 子进程 + `hermes_tools` 白名单桥（7 工具）+ 资源限额 + stdout spill | 无（仅有工具级 worker 沙箱） |
| 渐进披露 | tool_search 桥 + 延迟加载（`clarify` 刻意不延迟） | 每轮全量 schema |
| 多模态 | vision/video/image/video-gen/TTS(11)/STT(8)/wake word | 无 |
| 浏览器 / 桌面 | 12 个 browser 工具（含 CDP、凭据 vault）+ `computer_use` | 无 |
| 平台工具 | discord / feishu / yuanbao / spotify / HA / a2a / google_meet | 无 |

### 4.2 Agent loop 工程化

- 迭代：Hermes 500 轮 + 预算耗尽 grace call + 阶段化 pipeline；one-agent `for (i < maxIterations)` 默认 10 + 收尾提示。
- 并行：Hermes **路径重叠感知 planner**（见 §5，重点）；one-agent 无条件 `Promise.all`。
- 护栏：空响应守卫 ✅（已实现，`AgentConfig.emptyResponseRetries`）/ 复读守卫 / 停滞守卫 / 截断处理；后三者 one-agent 仍无。
- 错误：28 类分类 → retry / rotate / compress / fallback + 抖动退避 + `Retry-After`；one-agent provider 直接 `yield error` 并终止轮次。
- Provider 生态：39 插件 + fallback chain + 凭据池 + 模型别名/窗口目录 + reasoning effort clamp；one-agent 2 provider、单 key、无 fallback。

### 4.3 上下文 / 记忆 / 技能 / 状态

| 能力 | Hermes | one-agent |
|---|---|---|
| 压缩 | 两层阈值、先 prune 后摘要、保护首尾、失败有确定性 fallback | 单阈值 75%、保留最近 6 条、无 prune |
| 长期记忆 | MEMORY.md / USER.md（2200 / 1375 字符）+ 每轮后台自动抽取 + 冻结快照 | 无（仅会话历史） |
| 技能 | SKILL.md + skill_manage + curator + hub 安装 | 无 |
| 会话检索 | FTS5 全文，零 LLM 调用 | 无 |
| Checkpoints | 影子 git 每轮快照 + `/rollback` | 无 |
| 上下文引用 | `@file:` / `@folder:` / `@diff` / `@url:`；AGENTS.md 自动加载 + 注入扫描 | 无（连项目 AGENTS.md 都没喂给模型） |
| 成本 | usage_pricing（Decimal）/ credits / per-model usage / insights | 仅 token 计数，无价格 |

### 4.4 编排与长时任务
子代理委派（隔离上下文 + steering/stop + output_schema + spawn tree）、kanban 工作队列（dispatcher + 一审 + 心跳）、cron（5 种调度语法 + 多平台投递 + at-most-once + 看门狗）、后台任务（`/bg`、进程注册表、完成通知）、rooms/peer —— one-agent 全部没有，且设计方案已把「多 agent 编排」列为非目标。

### 4.5 交互面
CLI 60 子命令组 + 102 slash 命令；React Ink TUI（审批与 clarify 反向提问、断线重放）；22 个平台插件 + 内建 signal / iMessage / weixin / whatsapp_cloud / qqbot / api_server / webhook；FastAPI Dashboard（20+ 页面）/ Electron Desktop / ACP（Zed/VS Code）/ LSP；Termux。one-agent：5 个页面 + SSE。

### 4.6 安全与沙箱（one-agent README 自认的最大缺口）

| 能力 | Hermes | one-agent |
|---|---|---|
| OS 隔离 | docker（cap-drop ALL / no-new-privileges / 资源限额 / 凭据只读挂载）、singularity、modal、daytona、ssh | worker_threads 线程级（可访问全盘） |
| 审批 | manual/smart/off；危险命令检测（归一化去混淆 / heredoc / Windows 层 / hardline）；用户 deny glob 优先于 yolo；永久 allowlist；平台审批按钮；非交互 fail-closed | `meta.dangerous` 布尔 + 回调 |
| 密钥/文件 | 凭据文件禁读、项目 .env 全禁、redact 默认开、secret_scope fail-closed、SSRF 云 metadata 恒禁、注入扫描（工具结果 / AGENTS.md / 记忆 / cron）、Tirith 预执行扫描、自我仓库改写守卫 | AES 存 key + cwd 限会话工作区 |
| 中断/停机 | ESTOP、中断作用域、重启环路断路器 | 仅 AbortSignal |

### 4.7 验证 / 可靠 / 运维
验证证据库 + 收尾守卫 + `hermes verify` + lint/LSP 门；doctor 自诊断、setup 向导、backup、升级迁移、profile 隔离、i18n 17 语言、主题皮肤、日志脱敏轮转、插件系统（30+ hook + 中间件 + 事件总线 + 19 个内置插件目录）。one-agent 只有请求日志页。

---

## 5. Planner 深度分析（Hermes 的「真 planner」是怎么写的）

Hermes 里叫 planner 的其实是**四个不同层次**的决策器，彼此独立。工具批 planner 是与你最相关、也最值得移植的一个。

### 5.1 工具批 planner（并行/串行分段）

**调用链**：`conversation_loop.run_conversation` → 每轮 `turn_tool_round.run_tool_round`（校验/去重/上限 → 持久化 → 执行 → 压缩）→ `_execute_tool_calls` → 若 batch 可并行则 `tool_executor.execute_tool_calls_segmented`，否则 `execute_tool_calls_sequential`。

**核心函数**：`agent/tool_dispatch_helpers.py:_plan_tool_batch_segments(tool_calls, *, execution_cwd)` → `List[("parallel"|"sequential", calls)]`。

**判定三步**：

1. `_batch_admission(tool_call, execution_cwd)` 返回三态（`tool_dispatch_helpers.py:134`）：
   - `None` = **顺序屏障**：`clarify` / `manage_connections` 等交互工具、参数无法 JSON 解析、参数非 dict、未登记在任一面板；
   - `(name, [paths], is_writer)` = **路径受限工具**（`read_file` / `search_files` / `write_file` / `patch`）；
   - `(name, [], False)` = **无路径并行安全工具**（`_PARALLEL_SAFE_TOOLS`：read_file、search_files、web_search、web_extract、vision_analyze、image_generate、session_search、skill_view、skills_list、HA 查询等）。
2. **路径重叠决策**（`_plan_tool_batch_segments:193-210`）：维护当前 run 的 `reserved_paths: [(canonical, is_writer)]`；
   - 读 ↔ 读 重叠 → **允许并入同一 run**；
   - 任一侧是 writer 且路径重叠 → **关闭当前 run**，该调用从新 run 开始（保证批量读不会观察到写了一半的状态）；
   - 路径归一化 `_canonical_path`：`expanduser` → 相对 `execution_cwd` 解析 → `abspath` → `realpath` → `normcase`（Windows 大小写）；重叠判定是**路径段前缀比较** `_paths_overlap`（父子目录也算重叠）。
3. **收尾规则**：`len(current) >= 2` 才成为 parallel 段，否则**降级为 sequential**（单个调用交给顺序路径，它有更丰富的内联 dispatch）；相邻 sequential 段自动合并（`_extend_sequential`）。

**三个容易被忽略的正确性细节**：

- **保序是硬约束**：段内并行，段间串行，后来的调用永不跨越先到的屏障；结果按**原始调用顺序**回填（`_append_batch_results`），因此「并行 vs 全串行」的副作用边界与结果顺序完全一致。
- **桥接剥离**（`_peel_bridge_call:89`）：开启 tool-search 后模型对所有延迟工具都发字面量 `tool_call`，若不剥壳，`supports_parallel_tool_calls: true` 的 MCP server 会在桥激活瞬间静默失去并发；剥离后按**真实工具名**做准入。纯 connector 批才并行，混入本地调用的批保持屏障（否则会绕过路径重叠串行化）。
- **V4A patch 作用域从 patch body 的 `*** Update File:` 头解析**（`_extract_file_mutation_targets`），不信 `path=` 参数，防止「用一个假路径骗过准入」然后改别的文件。

**执行层**（`agent/tool_executor.py`）：分段后用 `DaemonThreadPoolExecutor`（daemon 线程，避免卡死的工具阻塞进程退出）跑 parallel 段；`_MAX_TOOL_WORKERS = 8`，`image_generate` 另有更小的并发上限；带 deadline + 每 5s 轮询 + 30s 心跳 + 中断检查；未填满的槽位由 `_unfinished_tool_result` 合成 `timeout` / `cancelled` / `thread_missing_result` 结果（永不留下没有结果的 tool_call）。

**对 one-agent 的直接启示**：`AgentLoop.ts:144` 的 `Promise.all(toolCalls.map(...))` 存在真实竞态——同一轮里模型同时发 `read` + `edit` 同一文件，或两条 `write` 同文件时，读写顺序不定；`edit` 的「读-改-写」还会在 `replace_all` 场景下丢更新。这不是性能优化问题，是**正确性缺陷**；同时纯读批次（read×3 + grep）又确实值得并行。Hermes 的准入表 + 路径重叠分段是可整体移植的最小正确实现（见设计方案 P0-8）。

### 5.2 迭代预算 planner

`IterationBudget`（`agent/iteration_budget.py`）：每个 `AIAgent`（父/子各一）持有线程安全的 `consume()` / `refund()`；父默认 500、子默认 `delegation.max_iterations`（50）。循环条件是 `while (api_call_count < max_iterations and budget.remaining > 0) or _budget_grace_call` —— **预算耗尽仍给一次收尾机会**（`turn_iteration_prep.py:358`），避免"读一半被掐断"。唯一的退款场景：整轮只有 `execute_code`（程序化工具调用，RPC 式便宜）时 `refund()`。

### 5.3 上下文 planner

不是独立组件，而是挂在工具轮之后：`run_tool_round` 末尾调 `compress_after_tool_results`（`agent/turn_preflight.py`），即**每轮工具结果落地后立刻判断压缩**，而不是等下一次 API 调用前才发现超限。阈值 `threshold_percent=0.50`（可按模型覆写）、`protect_first_n=3` / `protect_last_n=20`；先做不调 LLM 的 prune（旧 tool result），再调辅助模型摘要。

### 5.4 任务级 planner

- `todo_list`（`tools/todo_tool.py`）：树形 + 描述里写死规则「顺序即优先级、同一时刻只有一个 `in_progress`、验证完成才标 completed」；悬空 parent 丢弃、环打断成根。
- `kanban`：状态机 + CAS 认领 + `failure_limit=2` 自动 block + 归属守卫（worker 只能改自己的任务）。
- `delegate_task`：批量 `tasks[]` 并行，`_DEFAULT_MAX_CONCURRENT_CHILDREN=10`、`MAX_DEPTH=1`（默认扁平），child 禁用 delegate/clarify/memory/send_message/cronjob。
- `MoA`（`agent/moa_loop.py`）：reference model 扇出 + 汇总，`/moa` 开启。

---

## 6. 反向：one-agent 领先或差异化的地方（补齐时不要丢）

1. **配置即数据 + 运行时热更新**：`AgentConfig` 是 JSON，UI 可编辑、`updateConfig` 热生效、请求级 / 会话级 override 是一等 API（`agent/Agent.ts:50`、`lib/kernel.ts:97-125`）。Hermes 是 config.yaml + profile，多数改动需重建 agent。
2. **语言无关契约**：`contracts/` 为 Python 内核预留（Hermes 无跨语言内核设计）。
3. **内建 RAG**：本地 bge-m3 向量 + BM25 + RRF + 重排 + 分块检视器；Hermes 无知识库检索（只有 web_search / session_search）。
4. **可读性**：4.5k 行 vs 数百模块，单文件 `cli.py` 228KB。

---

## 7. 优先级建议

| 级别 | 项 | 理由 |
|---|---|---|
| **P0** | 工具结果截断预算；patch 模糊匹配 + 写保护 + 写后校验；read 文档抽取 + 双预算；terminal 持久会话 + 后台进程；错误分类 + 重试/fallback；prompt cache 稳定性；shadow-git checkpoints；工具批 planner | 全部是**正确性/稳定性**问题，不依赖产品方向判断，工作量小（详见 `docs/p0-design.md`） |
| **P1** | todo ✅ + 规划规程 ✅ + 压缩后重注入 ✅ / clarify / session_search（规划三件套已落地，见 `docs/self-planning-design.md` 状态块）；长期记忆 MEMORY+USER；SKILL.md 技能；cron；审批体系升级（危险命令检测 + 三档模式）；docker 后端；execute_code | 提升长任务与自省能力，但需要先有 P0 的上下文/安全底座 |
| **P2** | 消息网关多平台、delegate_task、kanban、浏览器自动化、TTS/STT/vision、ACP/LSP | 大工程，取决于产品方向 |
| **不做** | 39 provider 插件、22 平台、MoA、终端全后端、17 语言 i18n | Hermes 的规模优势，不是 one-agent 的战场 |

---

## 8. 方法与可信度

- **one-agent 侧**：逐文件通读 `one-agent-core/src/**`（Agent / AgentLoop / ToolRegistry / memory / providers / session / mcp / builtin tools / define / utils / config）与 app 关键文件（`lib/kernel.ts`、`lib/db.ts` 结构、`app/api/chat/route.ts`、`lib/rag/*`、`components/Chat.tsx`），结论均可直接复验。
- **Hermes 侧**：5 个并行子代理分域勘察 `tools/`、`agent/`、`gateway/`、`cron/`、`hermes_cli/`，各自输出到 `/tmp/hermes-survey/01-core-loop-and-tools.md` … `05-tool-semantics.md`；planner 部分（§5）由我本人逐行读取 `tool_dispatch_helpers.py:1-270`、`turn_tool_round.py`、`tool_executor.py:1300-1813`、`iteration_budget.py`、`tool_output_truncate.py` 复核。
- **已核验**：53 个关键文件路径存在性（唯一修正：`toolsets.py` 在仓库根目录，不在 `tools/`；`tools/registry.py`、`tools/approval.py`、`agent/context_compressor.py` 等 52 项均存在）。
- **未逐条复验**：子代理报告中的行号、内部常量、运行时实测数字（如「registry 100 个工具」）属自报，未逐一行级复核；引用时以概念与位置为主。`search_files` 在该 checkout 下受限（Operation not permitted），Hermes 侧检索均走终端 grep。
