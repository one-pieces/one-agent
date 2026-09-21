# todo 工具设计（计划工件）

> 前置：`docs/self-planning-design.md`（自主规划：为什么"计划工件"是自行规划的核心）
> 参照实现：Hermes `tools/todo_tool.py`（`TodoStore` + `todo_list` 工具 + 压缩后注入）
> 定位：P1 第一项。它不是一个"便利工具"，而是**让计划跨轮、跨压缩、跨重启存活**的载体。

---


> **实施状态（2026-09-20）**：本设计的 §1–§5（数据模型 / 工具契约 / 会话态归属 / 不变量）**已实现**：
> `core/src/todo/TodoStore.ts`、`core/src/todo/todoTool.ts`、`Agent.todos`、`ToolContext.sessionId`、
> `Agent.run` 收尾 meta 合并、kernel 注册 + `/api/tools` 目录登记；测试 `tests/tools/todo.test.ts`（13 例）、
> `tests/agent/planning.test.ts`（6 例）、app `tests/kernel.test.ts`（+3 例）。
> **§6 压缩后重注入已实现（P1-c）**：`AgentLoop.injectTodoSnapshot`（幂等：先移除旧快照再追加）、
> `LLMMessage.synthetic` 标记全链路透传（`toLLMMessage` / `toMessageWithStableId` / `messageKey`）、
> `compactMessages` 丢弃合成消息并排除在摘要输入之外、前端 `toUiMessages` 隐藏。
> 实施中的两处调整见 §0。
> **端到端验证**：`scripts/smoke-planning.py` 覆盖了 todo 工具在真实浏览器 + 真实模型下的调用（第二轮断言）。
> **工具链注意**：app 通过 pnpm `file:` 依赖引用 core，packages 里的文件是**硬链接** ——
> 改写 core 源文件会断链，app（含 Next dev，`transpilePackages` 会编译该副本）会继续用旧代码；
> 改完 core 必须在 `one-agent-app` 下重新 `NODE_ENV=development pnpm install`。

---

## 0. 审视修正（2026-09-20，实施前复核）

设计初稿有 4 处与源码不符，已修正（证据为逐行复核）：

| # | 初稿写法 | 复核结论（源码证据） | 修正 |
|---|---|---|---|
| 1 | 工具落点 `core/src/tools/builtin/todo.ts` | `builtinTools` 是**静态数组**（`tools/builtin/index.ts:17`），无法持有 per-session store；应用层已有同类先例：`knowledge_search` 由 kernel 动态注册（`one-agent-app/lib/kernel.ts:78`） | 改为 `core/src/todo/{TodoStore.ts, todoTool.ts}` 导出**工厂**，由 kernel 注册（与 knowledge_search 同路径） |
| 2 | 未提 UI 目录 | `GET /api/tools` 的目录是**手工维护**的（`builtinTools` + 硬编码的 knowledge_search 项，`app/api/tools/route.ts`）；不在其中则 UI 勾不到 | 需在 `/api/tools` 增加 `todo` 条目；注意 `AgentForm.tsx:58` 对新 Agent 默认 `enabled: !dangerous` → **todo 默认开启**（有意：它是自行规划的地基，无副作用） |
| 3 | "工具中途写盘 + Agent 收尾合并" | 首轮会话可能**尚不存在**（`Agent.run` 只在结尾 saveSession，`Agent.ts:129`）；工具若自建会话记录会写出空 agentId 的行 | 改为**轮内内存 + 收尾合并**（工具不写盘）：不产生第二个写者、无读改写竞态；代价是中断的轮次与它的消息一样不落盘（语义一致） |
| 4 | 未提 sessionId 归一 | `Agent.run` 里 `sessionId = opts.sessionId ?? "default"`，但传给 agentLoop 的是**原 opts**（`Agent.ts:72,84`）→ agentLoop 看到的 `opts.sessionId` 可能为 undefined | `Agent.run` 必须传归一后的 opts：`agentLoop(agent, messages, { ...opts, sessionId })` |

**另有一条实施注意**（非错误，补充）：压缩后注入的集成测试需要让 `compactMessages` 真正生效 —— 它要求待摘要消息 ≥3 条且保留最近 6 条（`memory/index.ts:40-47`），因此测试会话需预置 ≥10 条消息，否则注入路径不会被触发。

## 1. 目标与非目标

**目标**
1. agent 能自主写出、更新、读取任务清单（多步任务先规划再生效）；
2. 清单**顺序即优先级**、同一时刻只有一个 `in_progress`（避免并行自欺）；
3. 上下文压缩（compaction）后，**未完成项自动回到上下文**，已完成/取消项不回（防重做）；
4. 跨会话重启后清单还在（复用现有 SQLite 会话存储）；
5. 多会话隔离：同一 Agent 实例、不同 session 的清单互不串。

**非目标**
- 不做跨 agent / 跨会话的共享清单（那是 kanban，属 P2）；
- 不做进度百分比/依赖图（todo 是 checklist，不是 DAG）；
- 不做自动执行（todo 只记录，不驱动调度）。

---

## 2. 数据模型

```ts
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;            // 稳定 id（写入时生成；模型不必提供）
  content: string;       // 一项任务，单行、动作导向
  status: TodoStatus;
  parent?: string;       // 指向父项 id，用于嵌套子任务（可选）
}

export interface TodoState {
  items: TodoItem[];     // 数组顺序 = 优先级
  revision: number;      // 每次写入 +1（前端/注入用来判断是否变化）
  updatedAt: string;     // ISO
}
```

存储位置：`Session.meta.todos`（复用 `session/SqliteSessionStore.ts` 的 `data` JSON 列），键名固定为 `todos`；`meta.todoRevision` 随写入递增。

**为什么放 `meta` 而不是新表**：会话已经是持久化单元、`meta` 已随会话读写、数据量极小（≤50 项）；新增表会引入第二个真相源与迁移成本。

---

## 3. 工具契约

工具名 `todo`（与 Hermes 的 `todo_list` 对齐语义；one-agent 工具命名统一用短名）。

```
schema:
  todos?:  Array<{ id?: string; content: string; status: "pending"|"in_progress"|"completed"|"cancelled"; parent?: string }>
  merge?:  boolean   // 默认 false = 整表替换（重写计划）；true = 按 id 合并更新
无参调用  → 读取当前清单（不修改）
```

```ts
// 无参：读
{ ok: true, output: { items: [...], revision: n } }
// 写入：返回写入后的完整清单 + 变更摘要
{ ok: true, output: { items: [...], revision: n, changed: { added: 2, updated: 1, removed: 0 } } }
```

`description` 里必须写死的硬规则（抄 Hermes 的做法，让模型自己约束自己）：

> "维护当前任务清单。**列表顺序即优先级**；**同一时刻只保持一个 `in_progress`**；每步要具体（哪份文件、做什么）；**验证通过后**才标 `completed`；任务改变时传完整列表覆盖（或 `merge: true` 按 id 增量更新）；无参数调用读取当前清单。单步简单任务不要使用本工具。"

`meta`：无 `dangerous`、无 `sandbox`（纯内存/DB 状态），因此**不进** worker 沙箱。

---

## 4. 关键架构改动：工具状态必须挂 session，不是 Agent

现状：`ToolContext` 只有 `cwd`（`types.ts:60` 注释已预留 `sessionId`）；而 `ToolRegistry`/`Agent` 按 **agentId** 缓存（`lib/kernel.ts:68`），同一 Agent 实例服务多个会话 → **工具实例不能持有会话状态**。

设计（两步，都是小改动）：

1. **扩展 `ToolContext`**：`{ cwd?, sessionId?, signal? }`；`AgentLoop` 传 `{ cwd: opts.cwd, sessionId: opts.sessionId }`。
2. **`TodoStore` 由 Agent 持有、通过工厂注入工具**（沿用现有 `createKnowledgeSearchTool(...)` 的工厂模式，见 `lib/knowledge-tool.ts:10`）：

```ts
// core/src/todo/TodoStore.ts
export class TodoStore {
  constructor(private sessions: SessionStore) {}
  read(sessionId: string): Promise<TodoState>;                      // 从 session.meta 读
  write(sessionId: string, items: TodoItem[], opts?: { merge?: boolean }): Promise<TodoState>;
  formatForInjection(sessionId: string): Promise<string | null>;    // 只含未完成项，无则 null
}
```

```ts
// core/src/tools/builtin/todo.ts
export function createTodoTool(store: TodoStore, sessionIdFrom: (ctx: ToolContext) => string | undefined): ToolSpec;
```

**并发安全（必须处理）**：`Agent.run` 现在是「开始时读会话 → 结束时用**开始时那份 meta** 回写」（`Agent.ts:99-128`）。工具在轮次中途写 todos 会被结尾的保存覆盖。两种修法，推荐第 2 种：

1. TodoStore 直接写库：需要避免"中途写库 vs 结尾整体覆盖"的竞态（读-改-写窗口）；
2. **轮次内存 + 收尾合并**（推荐）：TodoStore 持有 `Map<sessionId, TodoState>` 作为本轮工作副本；`Agent.run` 保存会话前，若工作副本有变更则**重读 disk meta → 合并 todos → 写回**。保证单写者、无竞态，且同一轮内多次读写零 DB 往返。

---

## 5. 不变量与校验（对应 Hermes 的语义）

| 不变量 | 规则 |
|---|---|
| 单 `in_progress` | 写入时若发现多个，保留**顺序最靠后**的那个为 `in_progress`（最近推进的步骤），其余降级 `pending`；同时把该 `in_progress` 项**提前**到所有 `pending` 之前（Hermes `_normalize_order` 的做法），保证注入后模型看到的第一项就是当前步骤 |
| parent 完整性 | 指向不存在的 parent → 丢弃 parent（升为顶层）；出现环 → 打断成根 |
| 去重 | 同 id 后者覆盖前者；缺 id 的项生成新 id |
| 容量 | `MAX_TODO_ITEMS = 50`，超出保留优先级头部（顺序靠前）；`content` 单条上限 200 字符，超出截断 + 标记 |
| 状态合法 | 非法状态视为 `pending`（不报错，静默纠正——工具不该因模型笔误失败） |

---

## 6. 上下文注入（本设计的技术核心）

**平时不注入**：正常轮次里计划就在模型自己写的 tool result 里，无需重复注入（Hermes 同此：只在压缩后注入）。理由：省 token、保 prompt cache。

**压缩后注入**：`AgentLoop` 的 compaction 分支（`AgentLoop.ts:61-69`）在压缩成功后：

```
1. text = await todoStore.formatForInjection(sessionId)   // 仅 pending/in_progress，无则 null
2. 有内容 → messages.push({ role: "user", content: text })   // 注意：user 角色，不是 system
```

注入文本（对齐 Hermes 的 `TODO_INJECTION_HEADER`，中文）：

```
[你的任务清单在上下文压缩后被保留]
[>] 重构 parser.ts 的 token 化逻辑
[ ] 更新 parser 的单元测试
[ ] 跑 pnpm test 并修复回归
```

设计约束（都是踩过的坑）：
- **必须是 user 角色**：system 一旦变化就破前缀缓存（P0-6 不变量）；
- **已完成/取消项不注入**：否则模型会重做已完成工作（Hermes `format_for_injection` 明确只注入 `_ACTIVE_STATUSES`）；
- **注入位置在压缩点之后**：压缩会把早期消息摘要化，注入必须晚于它，且这条消息本身要能被后续压缩识别为"合成消息"（建议打标记 `_todoSnapshot: true`，供压缩器保留/丢弃时判断，避免被当作真实用户输入参与摘要）。

---

## 7. 与调度器（`toolBatchScheduler`）的关系

`todo` 是**无路径、无外部副作用**的工具（只改会话状态），因此应加入 `DEFAULT_SCHEDULER_TABLES.parallelSafe`：

```ts
parallelSafe: new Set(["web_search", "knowledge_search", "todo"])
```

注意它写的是 `session.meta`，与文件写（`write`/`edit`）状态域不同 → 与文件操作同轮并行是安全的。这样"先写计划再读文件"这类常见批次不会被无谓串行化。

---

## 8. 测试清单

单元（`tests/tools/todo.test.ts`）：
- 无参读取；整表替换；`merge: true` 增量更新；
- 单 `in_progress` 归一（多个 → 保留最近 + 提前）；status 非法 → pending；
- parent 悬空丢弃、环打断、`MAX_TODO_ITEMS` 截断、`content` 超长截断；
- `formatForInjection` 只含未完成项；全完成 → `null`。

集成（`tests/agent/todoInjection.test.ts`）：
- 触发 compaction 后，messages 中出现含未完成项的 user 消息，且**不含**已完成项；
- 5 轮对话后 system 消息 hash 不变、数量为 1（P0-6 不变量）；
- 多会话隔离：同一 Agent 两个 sessionId，清单互不串；
- 重启恢复：`SqliteSessionStore` 落盘 → 新 Agent 实例读同一 sessionId，清单一致；
- 调度器：`todo` + `read` 同轮 → 单并行段（已在 `parallelSafe` 中）。

---

## 9. 工作量、风险、排期

| 项 | 估工 |
|---|---|
| `ToolContext.sessionId` + `AgentLoop` 传递 | 0.2 天 |
| `TodoStore`（含轮次内存 + 收尾合并） | 0.5 天 |
| `todo` 工具 + 不变量归一 | 0.3 天 |
| 压缩后注入 + 合成消息标记 | 0.3 天 |
| 测试（单元 + 集成） | 0.4 天 |
| **合计** | **1.5–1.7 天** |

**风险**
1. **meta 回写竞态**（§4）——最需要小心的一处，用"轮次内存 + 收尾合并"规避；
2. **过度规划**：小任务也写 todo → 用工具描述里的硬规则 + `PLANNING_GUIDANCE` 的触发条件约束（收尾断言"单步任务不调用 todo"）；
3. **与压缩器的耦合**：注入消息需要"合成消息"标记，否则可能被摘要器当成用户输入吞掉或污染摘要 —— 需要给 `memory/index.ts` 的压缩逻辑加一条"保留/剔除合成消息"的显式规则；
4. **工具可见性**：`todo` 应否默认启用？建议作为 `AgentConfig.tools` 的普通条目（默认关闭，由 Agent 表单或规划规程开启），避免所有 agent 都被塞一个计划工具。
