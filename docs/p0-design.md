# P0 实现设计方案（不写代码，仅设计）

> 前置：`docs/hermes-gap-analysis.md`（§7 的 P0 清单）
> 范围：8 项，全部是**正确性 / 稳定性**问题，与产品方向无关
> 约束：内核保持零框架依赖；不破坏 `contracts/` 既有语义（新增字段一律可选）；每项都要有 vitest 覆盖
> 现状基线（均已读源码确认）：`one-agent-core/src/{agent/AgentLoop.ts, agent/Agent.ts, tools/ToolRegistry.ts, types.ts, memory/index.ts, providers/*, session/*}`；`one-agent-app/lib/kernel.ts`

---

## 0. 总览：实施顺序与工作量

| 序 | 项 | 主要落点 | 依赖 | 估工 |
|---|---|---|---|---|
| P0-1 | 工具结果截断预算 | `core/src/tools/budget.ts`（新）| 无 | 0.5–1 天 |
| P0-8 | 工具批调度器 ✅ 已实现 | `core/src/agent/toolBatchScheduler.ts`（新）| 无 | 1 天 |
| P0-2 | patch 升级（模糊 + 写保护 + 校验） | `core/src/tools/builtin/patch.ts`（新）、`tools/fileState.ts`（新）| P0-1（结果长度）| 1.5–2 天 |
| P0-3 | read 升级（行号 + 双预算 + 文档抽取） | `core/src/tools/builtin/read.ts`、`tools/extract/*`（新）| P0-1 | 1.5–2 天 |
| P0-4 | terminal 持久会话 + 后台进程 | `core/src/tools/terminal/{session,registry}.ts`（新）| P0-1、P0-8 | 2 天 |
| P0-5 | 错误分类 + 重试/fallback | `core/src/providers/errors.ts`（新）、两个 provider、`AgentLoop` | 无 | 1.5 天 |
| P0-6 | prompt cache 稳定化 | `AgentLoop` / `Agent` / `promptBuilder`（新）| 无 | 0.5–1 天 |
| P0-7 | shadow-git checkpoints | `core/src/checkpoints/ShadowGit.ts`（新）+ kernel 接线 | P0-2（写保护互补）| 1 天 |

原则：**先 P0-1 / P0-8**（改的是所有工具都经过的公共路径，后续项直接受益），最后 P0-7（依赖会话工作区布局）。

---

## P0-1 工具结果截断预算

### 目标
工具输出永不无界进上下文；超限时保留头尾并给出显式标记；按模型上下文窗口自适应。

### 现状问题
`ToolRegistry.execute` 把 `result.output` 原样返回，`AgentLoop.ts:167-173` 把 `JSON.stringify(output)` 原样写进 tool 消息。`bash` 仅在前端截 5000 字符，但**内核消息里仍是全量**；MCP 工具与 `knowledge_search` 的 chunk 输出完全无上限。

### 设计

新增 `one-agent-core/src/tools/budget.ts`：

```ts
export interface BudgetConfig {
  perResultChars: number;   // 单条结果上限
  perTurnChars: number;     // 单轮（一个批次）累计上限
  previewChars: number;     // 超累计预算后的预告长度
}
export const DEFAULT_BUDGET: BudgetConfig = { perResultChars: 100_000, perTurnChars: 200_000, previewChars: 1_500 };
export function resolveBudget(contextWindowTokens?: number): BudgetConfig;
// perResultChars = clamp(windowTokens * 3 * 0.15, 8_000, 100_000)
// perTurnChars   = clamp(windowTokens * 3 * 0.30, 16_000, 200_000)
// windowTokens 缺省 32_000（与 memory.contextWindowTokens 默认一致）；*3 为 token→字符近似
```

导出 `truncateHeadTail(text, maxChars, label): { text, truncated?: { omitted, total, label } }`，算法与 Hermes 同形：**40% 头 / 60% 尾**，中间插 `... [<LABEL> TRUNCATED - N chars omitted out of M total] ...`（头保早期错误、尾保最新输出；与 Hermes 措辞一致便于对照排查）。

接线点（三处，缺一不可）：

1. `ToolSpec.meta` 增加 `maxResultChars?: number`（覆盖全局 perResultChars；`read` 设 `Infinity`，因为它自己有分页，截断会造成 persist→read 循环）。
2. `ToolRegistry.execute(ctx, call)` 增加可选 `ctx.budget`，结果落地前统一走截断；`ToolResult` 增加**可选** 字段 `truncated?: { omitted, total, label }`。
3. `AgentLoop` 每轮开始重置 `usedChars = 0`；每个结果追加后累加；超 `perTurnChars` 的后续结果只保留 `previewChars` 并标注 `label: "TURN BUDGET"`。

`contracts/stream-protocol.md` 与 `contracts/agent-config.schema.json`：`tool_result` 增可选 `truncated` 字段说明（向后兼容，前端可选用）。

### 测试（`one-agent-core/tests/tools/budget.test.ts`）
恰好等于上限不截断 / 超一字符截断 / 空串 / CJK 多字节不产生半个字符 / 头尾长度精确等于预算 / turn 预算耗尽后只留 preview / `read` 的 meta 覆盖生效。

### 风险
截断后模型可能基于残缺内容下结论 → 标记里带 `total` 与建议（"如需完整内容请用 offset 分页读取"）。

---

## P0-8 工具批调度器（并行/串行分段）

> 命名说明：Hermes 内部叫它 planner（`_plan_tool_batch_segments`），但它是 **dispatch 调度器**，不产生计划；见 `docs/planner-deep-dive.md` §5 的规划能力全景。

> **状态：✅ 已实现（2026-09-20）**
> 落地文件：`one-agent-core/src/agent/toolBatchScheduler.ts`（新增）、`one-agent-core/src/agent/AgentLoop.ts`（接线）、`one-agent-core/src/agent/index.ts`（导出；`src/index.ts` 用 `export *` 自动透出）
> 测试：`one-agent-core/tests/agent/toolBatchScheduler.test.ts`（15 例）、`one-agent-core/tests/agent/toolBatchExecution.test.ts`（7 例）
> 验证：`pnpm --prefix one-agent-core test` 89 passed；`pnpm run typecheck` 通过；app 侧 33 passed + typecheck 通过
> 机制详解（含流程图）：`docs/planner-deep-dive.md`
> 顺带修掉的相邻缺陷：未注册工具 / 工具执行抛错不再让整批 `Promise.all` 失败中断对话，改为 `ok:false` 的 tool_result。

### 目标
消除同轮工具间的路径竞态，同时保留纯读批次的并行收益；结果顺序与全串行完全一致。

### 现状问题
`AgentLoop.ts:144-176` 对整批 `Promise.all`：
- 同轮 `read` + `edit` 同文件 → `edit` 可能读到写前/写后不确定的版本；
- 两条 `edit` 同文件 → 读-改-写丢更新（`edit.ts` 是 `readFile` → 替换 → `writeFile`）；
- `bash` 与文件工具同轮 → 更不可控。

### 设计（与 Hermes `_plan_tool_batch_segments` 同构的最小子集）

新增 `one-agent-core/src/agent/toolBatchScheduler.ts`（实际签名）：

```ts
export interface SchedulableToolCall { id: string; name: string; input: unknown }
export interface ToolCallSegment<T extends SchedulableToolCall = SchedulableToolCall> {
  kind: "parallel" | "sequential";
  calls: T[];
}
export interface SchedulerTables {
  neverParallel: ReadonlySet<string>;     // 默认: 空（预留交互类工具）
  pathScopedReaders: ReadonlySet<string>; // 默认: read, grep, find, ls, tree
  pathScopedWriters: ReadonlySet<string>; // 默认: write, edit（P0-2 加 patch）
  parallelSafe: ReadonlySet<string>;      // 默认: web_search, knowledge_search
}
export function scheduleToolBatch<T extends SchedulableToolCall>(
  calls: readonly T[], opts?: { cwd?: string; tables?: Partial<SchedulerTables> },
): Array<ToolCallSegment<T>>;
export function isFullyParallel(calls, opts): boolean;
export function canonicalToolPath(raw: string, cwd?: string): string;
export function pathsOverlap(left: string, right: string): boolean;
```

算法（严格照搬 Hermes 语义）：

1. 对每个调用做准入 `admit(call)` →
   - `null`（屏障）：`neverParallel` 命中、工具未注册、`input` 不可解析为非空对象、`bash`（见下）、路径型工具但**取不到路径**；
   - `{ paths, isWriter }`：路径受限工具（路径来自参数 `path` / `paths`；`grep`/`find`/`ls`/`tree` 缺省路径取 `"."`）；
   - `{ paths: [], isWriter: false }`：`parallelSafe`。
2. 归一化 `canonicalPath(p, cwd)` = `resolve(cwd, p)` → `realpath`（失败回落 `resolve`）→ 去尾斜杠；重叠判定 = **路径段前缀比较**（父子目录算重叠）。
3. 顺序扫描：屏障 → 关闭当前 run、并入 sequential；路径工具与「当前 run 已预留路径」冲突（任一侧是 writer）→ 关闭当前 run 再入新 run；否则并入。
4. 收尾：run 长度 `< 2` 降级 sequential；相邻 sequential 合并。

`bash` 归为**无条件屏障**（P0 范围内不做破坏性命令启发式；P1 可加 `_DESTRUCTIVE_PATTERNS` 等价物，届时只把"看起来只读"的 bash 放进 parallel 段）。

`AgentLoop` 接线（已落地）：把整批 `Promise.all(...)` 替换为

```ts
const outcomes = new Array<ToolOutcome | undefined>(toolCalls.length);
const indexOf = new Map<ToolCall, number>(toolCalls.map((tc, i) => [tc, i]));
const runToolCall = async (tc: ToolCall) => { outcomes[indexOf.get(tc)!] = await runSingleToolCall(...); };

for (const segment of scheduleToolBatch(toolCalls, { cwd: opts.cwd })) {
  if (segment.kind === "parallel") await Promise.all(segment.calls.map(runToolCall));
  else for (const tc of segment.calls) await runToolCall(tc);
}
for (const outcome of outcomes) { if (outcome) { yield outcome.result; messages.push(outcome.message); } }
```

`runSingleToolCall` 即原来的「审批 → execute → 组装 tool_result/tool 消息」闭包，抽成模块级函数；结果按**原调用索引**回填（`outcomes` 数组 + `Map<ToolCall, index>`，用对象身份索引，避免重复 callId 冲突）。

`tool_call` 事件仍在执行前按原序 yield（保持 `contracts/stream-protocol.md` 的成对语义不变）。

### 测试（`one-agent-core/tests/agent/toolBatchScheduler.test.ts` + `tests/agent/toolBatchExecution.test.ts`）

规划层（纯函数，15 例）：
- 三个 `read`（不同文件）→ 单 parallel 段；
- `read` + `edit` 同文件 → 单个 sequential 段（读先于写）；
- `read a` + `read b` + `edit a` + `read c` + `read a` → `[parallel][parallel][sequential]`，展平顺序不变；
- 两次 `edit` 同文件 → sequential；父子目录（`src/app.ts` vs `src`）算重叠；
- `bash`（未登记）→ 屏障，其后的读写仍可并行；相邻 sequential 段合并；
- `grep` 缺省 `"."` → 与读重叠但读读并行、与写则冲突；`read.paths[]` 批量全部参与判定；
- 参数不可信（字符串 / null / 数组 / 缺 path）→ 屏障；
- MCP 工具默认屏障，`tables.parallelSafe` 显式 opt-in 后并行；
- 单调用降级；任意组合下展平顺序 == 原始顺序；
- 路径归一：相对 vs 绝对等价、symlink 与目标同一、`pathsOverlap` 父子/兄弟。

执行层（AgentLoop 集成，7 例，用 `scripted-provider` + 探针工具记录 start/end 时序）：
- 同轮读+写同文件 → 事件序严格 `read:start, read:end, write:start, write:end`；
- 两个不同文件的读 → 两个 `:start` 都先于任何 `:end`（真并行）；
- `read a` + `write b` → 并行；
- `bash` 屏障 → 其后的读必须等 bash 结束，且它们之间仍并行；
- 结果按原始调用顺序回填（即便后面的调用先完成）；
- 未注册工具 → `ok:false` 且继续到最终回答（无 error chunk）；
- tool_call 事件全部先于 tool_result。

### 风险与实测边界
保守化会让原本并行的批次变串行（纯读批次不受影响）；`ls`/`tree` 作用域取 `.` 会与同轮的 `read` 判为重叠 → 读读重叠是允许的，已用测试钉住。实测额外发现两点：`bash` 作为屏障顺带让危险工具的审批提示天然串行（不需要 Hermes 的 authorization gate）；同轮 `write` 会把 `grep(".")` 推到写之后的段（保守但正确）。

---

## P0-2 patch 升级：模糊匹配 + 写保护 + 写后校验

### 目标
模型不必逐字符精确复现文件内容；写入不会被并发/陈旧状态静默覆盖；改错了能立刻发现。

### 现状问题
`edit.ts:34-38` 用 `content.split(old_string).length - 1` 精确计数，未命中只回 200 字符开头，模型基本靠"再读一次猜缩进"；无写前读校验、无写后校验；`write.ts` 直接覆盖任意文件。

### 设计

**A. 匹配策略链**（新增 `core/src/tools/patchMatch.ts`，`edit` 保留为兼容别名）

按序尝试，返回 `{ index, length, matchedBy }`：
1. `exact` — 原始子串；
2. `line_trimmed` — 逐行 `trimEnd` 后比对（行首缩进保留）；
3. `whitespace_normalized` — 连续空白折叠为单空格后比对；
4. `indentation_flexible` — 计算 `old_string` 与候选块的公共缩进并归一化后比对；
5. `escape_normalized` — `\n` / `\t` 字面量还原为真实字符后比对（模型常传转义串）；
6. `trimmed_boundary` — 首尾空白裁剪后比对；
7. `block_anchor` — 取首尾非空行作为锚定行，中间块模糊匹配；
8. `context_aware` — 对候选块做行级相似度（归一化 Levenshtein / LCS 比）打分，**仅当最高分 ≥ 0.9 且唯一**才接受。

约束：命中策略属于 `{block_anchor, context_aware}` 时**禁止 `replace_all`**（模糊匹配 + 全量替换是不可控破坏）；命中非 `exact` 时结果里返回 `matchedBy`，并在卡片上显示（前端已有 `ToolContent`，无需新 UI，仅多一个字段）。

未命中时返回**更可操作的错误**：最相似的 3 个候选块（行号 + 前 3 行摘要）+ 建议（"请改用精确上下文或先 read 该范围"）。

**B. 写前读保护**（新增 `core/src/tools/fileState.ts`）

进程内（按 Agent 实例）维护：

```ts
interface FileReadState { hash: string; readAt: number; fullRead: boolean }
class FileReadTracker {
  recordRead(absPath: string, content: string, fullRead: boolean): void;
  check(absPath: string, currentContent: string): { ok: true } | { ok: false; code: "not_read" | "stale"; message: string };
  forget(absPath: string): void;   // 写入成功后更新为新 hash
}
```

规则（Hermes 同款语义）：
- `write` / `patch` 修改**已存在**文件时，若本任务没有该文件的完整读记录 → 拒绝，返回 `code:"not_read"`（文件保持不动），提示"请先 read_file 再改"；
- 若磁盘内容 hash 与读记录不一致（外部改动/另一会话写过）→ 拒绝，`code:"stale"`，提示重新读；
- 新建文件（不存在）直接放行；
- 写入成功后 `forget` + 记录新 hash；
- 豁免：会话工作区内的临时产物不必豁免——统一适用，规则简单可预测。

**C. 写后校验**（新增 `core/src/tools/syntaxCheck.ts` 与写回读）

1. 回读磁盘并计算 SHA-256，返回 `{ verified: true, bytes }`；回读不一致 → `ok:false`（绝不静默）。
2. 语法检查（扩展名白名单）：
   - JSON / JSONC → `JSON.parse`；
   - YAML / TOML → 若仓库已有解析器依赖则用，否则仅括号/引号平衡启发式（标注 `heuristic: true`）；
   - `ts/tsx/js/jsx` → 括号平衡 + `tsc` 仅在用户显式开启时调用（可选子进程，超时 10s）；
   - `py` → `node:child_process` 调 `python -c "compile(...)"`，不存在则跳过。
3. **只报新错误**：解析改动前内容得到 baseline 错误集，改动后 diff，只把新增错误报给模型（Hermes 的 lint delta 语义），避免"文件本来就有噪音 → 模型反复瞎改"。

### 契约与配置
`ToolSpec.meta` 增加 `readBeforeWrite?: boolean`（默认 true）；`AgentConfig` 增加 `toolsGuards?: { readBeforeWrite?: boolean; syntaxCheck?: boolean }`（缺省开启），让 UI 可关（调试用）。

### 测试（`tests/tools/patch.test.ts`、`tests/tools/fileState.test.ts`）
8 种策略各一条用例 + 模糊策略拒绝 `replace_all` + 未命中返回候选块 + `not_read` / `stale` 拒绝路径 + 语法新增错误只报 delta + 回读 hash 不一致的失败路径。

### 风险
严格写保护会增加一个 read 轮次 → 但换来"永不静默覆盖"，且 P0-6 的缓存稳定化会让多出来的 read 很便宜。`patch` 大改会把 `edit` 语义扩大，需要文档更新（`one-agent-core/src/tools/builtin/index.ts` 的注释与工具描述）。

---

## P0-3 read 升级

### 目标
模型能引用行号、能分页、能读常见文档格式；不再因为"读不到"而放弃。

### 设计
1. **行号输出**：`LINE|CONTENT`（1-based），与 Hermes 一致；`offset` / `limit`（默认 2000 行）参数化。
2. **双预算**：`limit` 与 `maxChars`（默认 100_000，`meta.maxResultChars = Infinity`）同时生效，按**行边界**截断，返回 `next_offset`、`truncated_by: "lines" | "bytes"`。
3. **文档抽取** `core/src/tools/extract/`：
   - `.ipynb` → JSON 解析取 `cell.source` + 输出摘要（首行/前 N 字符）；
   - `.docx` / `.xlsx` / `.pptx` → `node:zlib` 解 zip（或系统 `unzip` 存在性探测）+ 轻量 XML 文本提取（`<w:t>` / sharedStrings / `<a:t>`）；
   - `.pdf`（文本层）→ 探测系统 `pdftotext`（`which` 缓存），有则子进程抽取并按页数返回；**逐页覆盖率审计**：抽取字符数 < 阈值（如 32 字/页）的页标记 `[NEEDS OCR]` 并给出 `pdftoppm -jpeg -r 150 -f N -l N` 建议命令（模型可自行调用 bash，P1 再接视觉通道）；
   - 无可用工具 → 明确报错（"缺少 pdftotext，可 brew install poppler"），不要静默返回空。
4. **图片**：保持元信息，但返回体加 `needsVision: true` 与说明（为将来 `vision_analyze` 预留接口，P2）。
5. **UTF-16 / BOM**：自动解码而不是当二进制拒绝；二进制启发式（NUL 字节占比）→ 明确拒绝并说明。
6. **批量 `paths`**：保留现有批量读取（已经是优势），每个文件独立 `next_offset`。

### 测试
`tests/tools/read.test.ts`：行号格式 / 分页连续性（两次读拼接等于全文）/ 字符预算按行截断 / BOM / UTF-16 / 二进制拒绝 / 抽取 fixtures（小 .docx、.ipynb、含文本层的小 .pdf）/ 无 pdftotext 时的错误分支。

### 风险
依赖系统工具（poppler）→ 全部走"探测 + 明确报错 + 可降级"，不引入硬依赖。

---

## P0-4 terminal 持久会话 + 后台进程

### 目标
`cd` / `export` 跨调用生效；长任务可后台跑并通知；输出不丢。

### 设计
新增 `core/src/tools/terminal/session.ts`：

- 每（会话, 工具实例）一个长驻 `spawn(shell, ["-l"])`；`shell` 默认 `$SHELL ?? /bin/bash`（Windows 走 `powershell` 分支留 P1）。
- 命令投递：`stdin.write(cmd + "\n")`，紧跟哨兵 `printf '__OA_%s_%d__\n' <nonce> $?`；stdout 累积按哨兵正则切分 → 得到 `{ output, exitCode }`。**nonce 每次会话随机**（防命令自身伪造哨兵）。
- 状态：`cwd` 由命令输出前注入 `pwd` 探测（或解析 `cd` 后的哨兵行），`env` 由子进程自然保持。
- 超时：前台默认 180s；请求超 `FOREGROUND_MAX = 600s` → **自动升级为后台**并返回 `{ session_id, promoted: true }`（与 Hermes 语义一致）。
- 中断：`ctx.signal` 触发时写 `\x03`（SIGINT）而不是杀掉整条 shell。

新增 `core/src/tools/terminal/registry.ts`：进程注册表 `Map<id, { child, buffer: RingBuffer(200_000), startedAt, status }>`，新增工具 `process_manage`（`list | poll | log | wait | kill`，P0 只做这 5 个动作；`write/submit/handoff` 归 P1）。`notify` 语义：`{ background: true, notify: true }` → 完成时向注册表写入一条 `pendingNotice`，`AgentLoop` 在**下一轮开头**把它作为 user 角色消息注入（不得插 system，见 P0-6）。

`bash` 工具保持 `meta.dangerous`（默认关闭），`process_manage` 中的 `kill` 同样标记 dangerous。

### 测试
`tests/tools/terminal.test.ts`：`cd` 持续 / `export` 持续 / 哨兵切分（输出中混入伪哨兵）/ 退出码透传 / 超时升级后台 / 后台 poll 与 kill / 输出超 50KB 走 P0-1 头尾截断 / 沙箱模式（`meta.sandbox` worker）下持久会话的降级行为（worker 线程无法持子进程 → 明确降级为单次 exec 并说明）。

### 风险
长驻子进程的生命周期（会话删除 / 进程退出）→ `kernel.deleteSession` 时统一 kill；dev server 热重载会导致会话丢失 → 用 `globalThis` 单例缓存（与 `lib/kernel.ts` 现有 `export const kernel` 模式一致）。

---

## P0-5 错误分类 + 重试 / fallback

### 目标
限流、超时、5xx 不再直接终止对话；模型不可用时可自动降级到备用模型。

### 设计
**A. 分类器** `core/src/providers/errors.ts`：

```ts
export type FailoverKind =
  | "rate_limit" | "auth" | "overloaded" | "server" | "timeout"
  | "network" | "context_overflow" | "bad_request" | "content_filter" | "unknown";
export interface ClassifiedError {
  kind: FailoverKind; message: string; status?: number;
  retryable: boolean; shouldCompress: boolean; shouldFallback: boolean;
  retryAfterMs?: number;
}
export function classifyProviderError(err: unknown, status?: number, bodyText?: string): ClassifiedError;
```

规则表（按序）：`401/403` → auth（不重试、不 fallback，提示检查 key）；`429` → rate_limit（可重试，解析 `Retry-After` 与 `x-ratelimit-reset-*`）；`408/5xx/529` → timeout/server/overloaded（可重试 + 可 fallback）；`context_length_exceeded` / "maximum context" / "prompt is too long" → context_overflow（**不重试，触发压缩**，直连 P1 的 compaction 前置）；`fetch` 异常（ECONNRESET/ENOTFOUND/abort≠用户取消）→ network（可重试）；`400` 其余 → bad_request（不重试）。

**B. 重试循环**（两个 provider 内共用 helper `withRetry`）

- `maxRetries` 默认 3；抖动指数退避 `min(500ms * 2^n, 8s) * (0.5 + random()*0.5)`，`Retry-After` 优先；
- **流式已经产出文本后不再重试**（否则重复文本进上下文）——判据：`emittedText === 0` 且 `toolCalls.length === 0`；
- 每次重试把 `attempt` 记入日志（`lib/observability.ts` 现有 fetch 包装可复用）。

**C. fallback**：`AgentConfig.model` 增加可选 `fallback?: ProviderConfig[]`（有序）。`AgentLoop` 收到 `error` chunk 时：
1. `classifyProviderError` → 若 `shouldFallback` 且还有备选 → 用备选重建 provider，**重跑当前迭代**（当前 messages 不变），并注入一条 user 角色提示（"上一模型不可用，已切换"）；
2. 若 `shouldCompress` → 强制跑 `compactMessages` 后用同一模型重试一次；
3. 都不可行 → 保持现有行为（yield error 并结束），但错误信息带 `kind`。

**D. 停滞守卫（Hermes stall guard 的最小版）**：同一工具 + 同一 `input` 的 JSON hash 连续出现 3 次 → 注入 user 提示"检测到重复调用，请改变策略或直接回答"；第 4 次直接以现有收尾提示终止。

### 契约
`StreamChunk` 的 `error` 变体增加可选 `kind?: FailoverKind`、`retryable?: boolean`；`agent-config.schema.json` 增加 `model.fallback`。

### 测试
`tests/providers/errors.test.ts`（状态码/文案/异常三路分类表）；`tests/agent/retry.test.ts`（用 `scripted-provider` 模拟 429→200、5xx×4 耗尽、流式已产出不重试）；`tests/agent/fallback.test.ts`（主模型 429 → 备选成功，断言最终回答来自备选）；停滞守卫用例。

### 风险
重试会放大成本 → 上限 3 次 + 每次记日志；fallback 到不同协议（openai-compatible ↔ anthropic）时消息需要重新映射，用 `session/convert.ts` 现有转换函数保证。

---

## P0-6 prompt cache 稳定化

### 目标
会话生命周期内 system 前缀字节稳定，最大化供应商前缀缓存的命中（OpenAI 兼容自动、Anthropic 需显式 `cache_control`）。

### 现状问题
`AgentLoop.ts:129-135` 在 `i >= maxIter - 2` 时 `messages.push({role:"system", ...})` —— 这会改变 system 内容（虽在尾部，但 Anthropic 的缓存断点若落在 system 上即失效，且语义上把"提示"伪装成系统指令）；每轮动态信息无统一收纳处。

### 设计
1. 新增 `core/src/agent/promptBuilder.ts`：`buildSystemPrompt(config) → string`（instructions + 工具使用约定 + 压缩摘要占位），**纯函数、只依赖 config**；`Agent` 在会话首次调用时生成并存 `session.meta.systemPromptHash`，后续轮次校验 hash 不变（变了打 warning，帮助发现回归）。
2. 不变量文档化（写进 `contracts/stream-protocol.md` 或新增 `contracts/prompt-invariants.md`）：
   - system 消息**只允许**由 `buildSystemPrompt` 生成、**只在会话首轮插入**；
   - 每轮动态内容（迭代接近上限、重复调用告警、后台任务完成通知、工具截断提示）一律作为 **user 角色**消息追加在末尾；
   - 压缩（compaction）是**唯一**允许改写历史的行为。
3. `AgentLoop.ts:129` 的收尾提示改为 user 角色（`"[系统提示] ..."` → 明确以 user 消息承载并加前缀标记，避免与真实用户消息混淆，前端可用现有 `role` 渲染区分）。
4. Anthropic provider：在 system 块与**最后一条稳定消息**（最近一次 assistant 消息）上加 `cache_control: { type: "ephemeral" }`；OpenAI 兼容端不做特殊处理（自动前缀缓存），但要确保 messages 序列化稳定（`JSON.stringify` 键序固定：`toOpenAIMessage` 已固定字段顺序）。
5. `usage.cachedTokens` 会话累加已有 → 在 `Chat.tsx` 的 token 展示处补一个"缓存命中率"（可选，一行）。

### 测试
`tests/agent/promptStability.test.ts`：跑 5 轮（含工具调用、压缩、收尾提示）后断言 messages 中 system 消息内容 hash 与首轮一致、且 system 消息数量为 1；Anthropic provider 的请求体快照测试（`cache_control` 位置）。

### 风险
把收尾提示从 system 改为 user 后，模型对"停止探索"的服从度可能下降 → 用更强的措辞 + 测试（`AgentLoop.test.ts` 已有迭代上限用例，直接扩展断言）。

---

## P0-7 shadow-git checkpoints

### 目标
每轮首个写操作前自动快照会话工作区，`/rollback` 可回退；与 P0-2 的写保护互补（一个防盲写、一个给后悔药）。

### 设计
新增 `core/src/checkpoints/ShadowGit.ts`：

- 存储位置：`data/checkpoints/{sessionId}/repo.git`（**放在会话工作区之外**，agent 的文件工具看不到，避免污染 agent 的目录视图）。
- 每条快照：`git --git-dir=<repo.git> --work-tree=<sessionWorkspace> add -A && commit -m "turn <n> <iso>"`，`GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` 显式传入（不依赖 cwd）；环境隔离 `GIT_AUTHOR_NAME=one-agent` 等，避免读用户全局 git 配置。
- 触发点：`AgentLoop` 每轮**首个** `isWriter` 工具调用前（planner 已能判定 writer，直接复用）触发一次；同轮只快照一次。
- 保留策略：`maxSnapshots = 20`、`retentionDays = 7`、`autoPrune`（`git gc` + 删旧 ref）。全部可通过 `AgentConfig.checkpoints` 关闭（默认开）。
- 回退 API：`kernel.rollback(sessionId, n)`（内部 `git checkout <sha> -- .` + 删除多余文件用 `git clean -fd`，**限工作区内**）；暴露为 app 端 `POST /api/sessions/[id]/rollback`；UI 在会话设置里加一项（复用现有 `SessionSettings` 组件，符合"优先复用现有组件"的偏好）。
- 依赖探测：`git` 不存在 → 功能静默禁用并在日志记一条（不要硬失败）。

### 测试
`tests/checkpoints/ShadowGit.test.ts`（临时目录）：快照/回退/文件删除也回退/prune 保留数/无 git 时降级；`AgentLoop` 集成：一轮内两次写只产生一个快照。

### 风险
大文件工作区快照开销 → 限制单次快照体积（>50MB 跳过并记日志）、仅在**写操作前**触发（不是每轮无脑快照）。

---

## 附：P0 完成后的验收清单

| 项 | 验收方式 |
|---|---|
| P0-1 | `pnpm --prefix one-agent-core test` 中 budget 用例全绿；手工跑一次 `bash` 输出 300KB 的命令，确认上下文里只出现头尾 + 标记 |
| P0-8 ✅ | 已达成：planner 15 例 + 执行时序 7 例全绿（`pnpm --prefix one-agent-core test`：89 passed） |
| P0-2 | 修改一个未读过的文件被拒（错误码 `not_read`）；缩进不一致的 `old_string` 能命中并返回 `matchedBy` |
| P0-3 | 读一个 `.docx` / `.ipynb` 得到文本；读 3000 行文件得到 `next_offset` 且二次读取可拼接 |
| P0-4 | `cd /tmp` 后下一次调用 `pwd` 输出 `/tmp`；`sleep 700` 自动升级为后台并返回 `session_id` |
| P0-5 | 用脚本 provider 模拟 429 → 断言自动重试成功；模拟主模型连续 5xx → 断言切到 fallback |
| P0-6 | prompt 稳定性用例全绿（system 只有 1 条且 hash 不变） |
| P0-7 | 写文件后改坏 → `/rollback` 恢复；`git` 不存在时功能禁用且不影响其他流程 |

全部完成后跑 `pnpm run test` + `pnpm run typecheck`（根目录脚本），并做一次真实模型端到端（agents 页面 → 会话 → 工具调用 → 消息卡片）。
