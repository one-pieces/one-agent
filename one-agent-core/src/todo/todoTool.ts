import { z } from "zod";
import { defineTool } from "../tools/define.ts";
import type { ToolSpec, ToolContext } from "../types.ts";
import { TodoStore, type TodoInputItem } from "./TodoStore.ts";

/**
 * todo 工具（计划工件）：agent 自主维护任务清单。
 *
 * 状态挂在**会话**（ctx.sessionId）而不是 Agent 实例：Agent 按 agentId 缓存、
 * 同一实例服务多个会话（见 docs/todo-list-design.md §4）。
 *
 * 触发纪律写在 description 里（与 Hermes 的做法一致）—— 让工具自己约束模型何时该用、
 * 何时不该用，而不必强依赖 system 里的规划规程。
 */
export function createTodoTool(store: TodoStore): ToolSpec {
  return defineTool({
    name: "todo",
    description: [
      "维护当前任务清单（计划工件）。",
      "无参数调用 = 读取当前清单。",
      "写入规则：列表顺序即优先级；同一时刻只保持一个 in_progress；每步要具体（哪份文件、做什么动作）；",
      "验证通过后才标记 completed；任务变化时传完整列表覆盖，或用 merge:true 按 id 增量更新。",
      "单步简单任务不要使用本工具（写清单本身也是成本）。",
    ].join(""),
    schema: z.object({
      todos: z
        .array(
          z.object({
            id: z.string().min(1).optional(),
            content: z.string().min(1),
            status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
            parent: z.string().min(1).optional(),
          }),
        )
        .optional(),
      merge: z.boolean().optional(),
    }),
    async execute(ctx: ToolContext, input: { todos?: TodoInputItem[]; merge?: boolean }) {
      const sessionId = ctx.sessionId;
      if (!sessionId) {
        return { ok: false, output: null, error: "todo 需要会话上下文（ctx.sessionId 缺失）" };
      }

      if (!input.todos) {
        const state = await store.read(sessionId);
        return {
          ok: true,
          output: {
            items: state.items,
            revision: state.revision,
            note: state.items.length === 0 ? "清单为空" : undefined,
          },
        };
      }

      const before = await store.load(sessionId);
      const state = await store.write(sessionId, input.todos, { merge: input.merge === true });
      const beforeById = new Map(before.items.map((i) => [i.id, i]));
      const afterIds = new Set(state.items.map((i) => i.id));
      const added = state.items.filter((i) => !beforeById.has(i.id)).length;
      const updated = state.items.filter((i) => {
        const prev = beforeById.get(i.id);
        return prev && prev.content !== i.content;
      }).length;
      const statusChanged = state.items.filter((i) => {
        const prev = beforeById.get(i.id);
        return prev && prev.status !== i.status;
      }).length;
      const removed = before.items.filter((i) => !afterIds.has(i.id)).length;

      return {
        ok: true,
        output: {
          items: state.items,
          revision: state.revision,
          changed: { added, updated, statusChanged, removed },
        },
      };
    },
  });
}
