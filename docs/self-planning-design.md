# 自主规划设计（层 A 移植：让 agent 自己规划）

> **实施状态（2026-09-20）**
> - ✅ **P1-a 规划规程**：`core/src/agent/planning.ts`（`PLANNING_GUIDANCE` / `resolvePlanningGuidance` / `buildSystemPrompt`）+ `AgentConfig.planning`（zod + `contracts/agent-config.schema.json`）+ `AgentLoop` 首轮 system 注入
> - ✅ **P1-b todo 计划工件**：`core/src/todo/{TodoStore.ts, todoTool.ts}` + `ToolContext.sessionId` + `Agent.todos` + `Agent.run` 收尾 meta 合并；app 侧 `kernel` 注册同一 `TodoStore`、`/api/tools` 目录登记
> - ✅ **P1-c 压缩后重注入**：`AgentLoop` 压缩成功后以**合成 user 消息**注入未完成项（`injectTodoSnapshot`）；`LLMMessage.synthetic` / `Message.synthetic` 全链路透传；`compactMessages` 丢弃旧快照且不把快照喂给摘要器；前端 `toUiMessages` 隐藏合成消息
> - ✅ **P1-d 方案文档**：`plan` 工具（写/读，落 `<工作区>/.oneagent/plans/<ts>-<slug>.md`）+ `core/src/plan/planFiles.ts`；调度器把 plan 视为**派生作用域 writer**（作用域=`.oneagent/plans`）；压缩后快照同时带上方案路径
> - ✅ **P1-e 方案面板**：`GET /api/sessions/[id]/plan` + `Chat.tsx` 顶部可折叠面板（复用 `.bubble` markdown 样式，限高 45vh）
> - ✅ **P1-f 规划开关**：`AgentForm` 新增「规划（自规划规程）」开关（开启时同步勾选 todo，与 kernel 自动启用一致）
> - 未做：**P2** goal-like 持久目标 + judge 门禁（按设计保持不做）
> - 验证：core 129 passed + `tsc` 通过；app 37 passed + `tsc` 通过
> - ✅ **冒烟测试**：`scripts/smoke-planning.py`（Playwright + 本地 Ollama，19 项断言，最近两次连续 19/19 通过）
>   覆盖：AgentForm 规划开关（含持久化状态、todo 自动回启）、plan 工具 → 方案落盘 → 聊天页方案面板、todo 工具调用、合成消息不被渲染成用户消息
> - ✅ **空响应守卫**（冒烟测试中发现的缺口）：模型既无文本也无工具调用时追加催促重试（默认 2 次，`AgentConfig.emptyResponseRetries`），
>   仍为空则返回明确 error chunk —— 不再把空回答静默当作最终答案落库（此前现象：本地 7B 模型偶发空回答，会话看起来"完全没反应"）
> - 注意：`pnpm build`（生产构建）在本仓库**本就失败**于 Next 自动生成的 `/_global-error` 预渲染（`Cannot read properties of null (reading 'useContext')`，digest 3818243340）—— 已用「还原本次 UI 改动后重跑」验证为既有问题，与本次改动无关；开发用 `pnpm dev`。

> 前置阅读：`docs/planner-deep-dive.md` §5（Hermes 规划能力全景 —— 层 A/B/C 的形态归属）
> 关联设计：`docs/todo-list-design.md`（计划工件：todo 工具）
> 结论先行：**能移植，且成本很低** —— 因为 Hermes 的"规划"本质上不是组件，而是「提示词规程 + 计划工件 + 压缩后重注入 + 收尾决策」四件事的组合。

---

## 1. 层 A 的实质：不是"一句提示词"，是四件事

Hermes 的 `/plan` 只做第一件（且是用户触发），真正的"自行规划"要靠四件齐备：

| # | 要素 | Hermes 的做法 | 缺了会怎样 |
|---|---|---|---|
| 1 | **倾向**：让模型先规划再动手 | 系统提示 + plan mode 提示词（`agent/plan_prompt.py`，含"好计划"的写作规范） | 模型直接乱动手，长任务中途跑偏 |
| 2 | **工件**：计划必须可复读 | `.hermes/plans/<ts>-<slug>.md`；`todo_list` 工具（`tools/todo_tool.py`） | 计划只存在于对话里 → 一旦压缩/裁剪就消失 |
| 3 | **注入**：工件在压缩后回到上下文 | `format_for_injection()` + `TODO_INJECTION_HEADER`（"[Your active task list was preserved across context compression]"），只注入未完成项 | 压缩后模型忘记进度 → 重做已完成工作或丢失目标 |
| 4 | **决策**：什么时候继续/收尾 | `maxIterations` + `/goal` 的 judge & quality gates（Ralph loop） | 早停（做一半）或空转 |

**其中 1 和 3 几乎零成本，2 是 todo 工具（见另一份文档），4 是可选加强。** 这就是"层 A 能否用到 one-agent"的答案：能，而且不需要新引擎。

---

## 2. one-agent 的架构优势：规划规程应该是"配置"，不是硬编码提示词

| 维度 | Hermes | one-agent |
|---|---|---|
| 规划规程载体 | 硬编码在 `agent/plan_prompt.py` 的常量字符串 | **`AgentConfig.instructions` 是 JSON 数据** → 规程可作为配置字段：UI 可编辑、每会话可 override、可 A/B |
| system 稳定性 | 靠"不改 system prompt"的纪律 + 测试 | 天然：system 只在会话首轮插入（`AgentLoop.ts:44`），后续只追加尾部消息 → 与 P0-6 的 prompt cache 不变量一致 |
| 会话级状态 | `session.meta` 等价物散落各处 | 已有 `Session.meta` + `kernel.updateSessionOverrides`（`lib/kernel.ts:128`）现成模式：计划状态/进度可直接落 meta |
| 工件持久化 | 内存 TodoStore + 从历史 hydrate（`agent/turn_context.py:608`） | 已有 SQLite `SessionStore`（`session/SqliteSessionStore.ts`）→ 计划工件随会话免费持久化、可跨重启 |

**设计取向：把"怎么规划"变成可配置数据（符合 one-agent 的核心理念），而不是照搬 Hermes 的硬编码提示词。**

---

## 3. 设计：三层能力

### L1 规划规程（0.5 天，零新组件）

`AgentConfig` 增加可选字段（与 `memory` / `maxIterations` 同级）：

```ts
planning?: {
  /** off: 不加任何规划指引（默认保持现状）；prompt: 在 system 前缀追加规划规程 */
  mode: "off" | "prompt";
  /** 自定义规程文本；缺省用内核内置的 PLANNING_GUIDANCE */
  guidance?: string;
};
```

内置 `PLANNING_GUIDANCE`（草案，中文，简版——与合约/风格一致）：

```
规划规程（多步任务时遵循，单步任务不要规划）：
1. 先探查：动手前用 read/grep/find/tree 了解现状；不要凭猜测改文件。
2. 再写计划：任务涉及 3 步以上、或多个文件、或需要先探索再决定时，用 todo 工具写出任务清单；
   顺序即优先级；同一时刻只保持一个 in_progress；每步要具体到文件与动作。
3. 执行中维护：完成一步就更新状态（completed）；发现计划有误就重写清单（传完整列表覆盖）。
4. 完成后验证：能跑测试/检查就真跑（bash/read 回读），验证通过才标记 completed。
5. 收尾：基于已获取的信息给出结论；不确定就说明不确定，不要编造结果。
```

组装点：`AgentLoop` 注入 system 时（`AgentLoop.ts:44`）拼接 `PLANNING_GUIDANCE`；由于 instructions 与规程都不变，system 在会话内保持字节稳定（P0-6 不变量不破）。

### L2 计划工件（1–1.5 天，含 todo 工具）

见 `docs/todo-list-design.md`。要点：`todo` 工具（agent 自主调用）+ `session.meta.todos` 持久化 + **压缩后重注入未完成项**。

这一层才是"自行规划"的实体：L1 只给倾向，L2 才让计划**活着**（跨轮、跨压缩、跨重启）。

**可选**：`write_plan` 工具把 markdown 计划落到会话工作区 `.oneagent/plans/<ts>.md`（等价 Hermes 的 `.hermes/plans/`），并把摘要写进 `session.meta.plan`。适合"大任务先出方案、人来 review"的流程；单用户自用场景可后置。

### L3 交付质量约束（P2，暂不做）

`/goal` 式持久目标 + judge + quality gates：价值高但需要辅助模型调用、熔断、门禁命令执行等一整套设计，且与我们现有的 `maxIterations` 收尾提示有重叠。**明确列为 P2**，等 L1/L2 跑一段时间后再评估（若做，形态应是 `AgentConfig.goals` 配置 + 在 `Agent.run` 收尾处判定，而不是引入引擎）。

---

## 4. 与现有体系的衔接点（逐条给落点）

| 要素 | 落点 | 说明 |
|---|---|---|
| 规程注入 | `AgentLoop.ts:44`（system 注入处） | 只在会话首轮，字节稳定 |
| 计划写入/读取 | 新增 `core/src/todo/todoTool.ts`（工厂，由 kernel 注册，同 knowledge_search）+ `ToolContext.sessionId` | **必须**扩展 `ToolContext`（`types.ts:60` 注释里已预留 `sessionId`）：Agent 实例按 agentId 缓存、会话有多个，工具状态只能挂 session |
| 工件持久化 | `session.meta.todos` + `SessionStore` | 复用现有 SQLite；注意：`Agent.run` 结束时用**开始时的 meta 快照**回写，需改成结束时重读合并，否则工具中途写的 todo 会被覆盖（详见 todo 文档 §4） |
| 压缩后重注入 | `memory/index.ts:compactMessages` 之后（`AgentLoop.ts:61-69` 压缩分支） | 压缩成功后追加一条 **user 角色**消息（不是 system！），内容 = 未完成项清单；遵守 P0-6 不变量 |
| 可观测 | `RunOptions.onToolCall`（已有）+ 可选 `onPlanUpdate` | 前端可渲染计划面板 |
| 配置入口 | `agentConfigSchema`（`src/agent/config.ts`） + `contracts/agent-config.schema.json` | 与既有 `memory` 块同构，纯附加 |
| 工具目录 | `app/api/tools/route.ts` | 手工维护的目录需加 `todo` 条目，否则 Agent 表单勾不到（`AgentForm.tsx:58` 对新 Agent 默认开启） |
| 应用层 UI（可选） | `one-agent-app`：会话页读取 `session.meta.todos` 渲染"任务"面板 | 复用现有 `components/ui/*`，不新建组件 |

**实施前提（复核确认）**：
1. `Agent.run` 必须把归一后的 `sessionId` 传下去（`Agent.ts:72,84` 现在传原 `opts`，工具会拿不到会话 id）；
2. 计划状态采用"轮内内存 + 收尾合并"，工具**不直接写盘**（首轮会话可能尚不存在；避免第二写者与读改写竞态）；
3. `/api/tools` 是手工维护的工具目录，新增工具必须同步登记，否则 Agent 表单里勾不到。

---

## 5. 验收标准（可测）

| 场景 | 期望 |
|---|---|
| 多步任务（如"把 X 模块重构成 Y，并跑通测试"） | 断言 agent 在动手前调用 `todo` 写出 ≥2 项计划；执行中至少一次把某项标 `in_progress`→`completed` |
| 单步任务（如"把 a.txt 里的 foo 改成 bar"） | 断言**不**调用 `todo`（防过度规划，与 Hermes 描述里的硬规则一致） |
| 长对话 + 触发 compaction | 断言压缩后的 messages 里存在一条含未完成项的 user 消息；已完成项**不**出现 |
| 会话重启 | 断言 `session.meta.todos` 恢复，且注入内容与重启前一致 |
| system 稳定性 | 断言 5 轮（含压缩、含 todo 调用）后 system 消息 hash 不变、数量为 1 |
| 多会话隔离 | 断言两个会话的 todos 互不串（同一 Agent 实例，不同 sessionId） |

---

## 6. 工作量与排期建议（并入 P1）

| 项 | 内容 | 估工 | 依赖 |
|---|---|---|---|
| P1-a | L1 规划规程 + `AgentConfig.planning` + schema/契约 | 0.5 天 | 无 |
| P1-b | `TodoStore` + `todo` 工具 + `ToolContext.sessionId` + 测试 | 1–1.5 天 | P1-a |
| P1-c | 压缩后重注入 + 会话 meta 合并写 + 测试 | 0.5 天 | P1-b |
| P1-d（可选） | `write_plan` 工具 + `.oneagent/plans/` 约定 | 0.5–1 天 | P1-b |
| P1-e（可选） | 前端任务/计划面板（读 session.meta） | 0.5–1 天 | P1-c |
| P2 | goal-like 持久目标 + judge + 门禁 | 3–5 天 | 先观察 L1/L2 效果 |

建议顺序：**P1-a → P1-b → P1-c**（这三步做完就已经具备"自行规划"能力），d/e 视使用体验再定。

---

## 7. 明确不做的事

- 不引入"规划引擎/规划器组件"（Hermes 也没有：`/plan` 是提示词注入，`todo` 是工具）；
- 不在每轮把完整计划注入上下文（只在压缩后，与 Hermes 一致 —— 否则白烧 token 且破 prompt cache）；
- 不做自动 plan→execute 的两阶段编排（`/plan` 的语义是"规划完询问是否执行"，把决定权留给人；如果要自动化，用 P2 的 goal 形态而不是偷偷执行）。
