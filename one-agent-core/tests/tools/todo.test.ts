import { describe, it, expect } from "vitest";
import { TodoStore, MAX_TODO_ITEMS, normalizeState } from "../../src/todo/index.ts";
import { InMemorySessionStore } from "../../src/session/index.ts";
import { createTodoTool } from "../../src/todo/index.ts";
import type { Session } from "../../src/index.ts";

function makeEnv() {
  const sessions = new InMemorySessionStore();
  const store = new TodoStore(sessions);
  return { sessions, store };
}

async function seedSession(sessions: InMemorySessionStore, id: string, meta: Record<string, unknown> = {}) {
  const session: Session = {
    id,
    agentId: "a1",
    messages: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    meta,
  };
  await sessions.saveSession(session);
}

describe("TodoStore", () => {
  it("空清单：读 → 空，formatForInjection → null", async () => {
    const { store } = makeEnv();
    const state = await store.read("s1");
    expect(state.items).toEqual([]);
    expect(await store.formatForInjection("s1")).toBeNull();
    expect(store.snapshotForMeta("s1")).toBeUndefined(); // 只读不写 → 不产快照
  });

  it("写入：整表替换 + revision 递增 + 返回副本", async () => {
    const { store } = makeEnv();
    const first = await store.write("s1", [{ content: "步骤一" }, { content: "步骤二" }]);
    expect(first.items.map((i) => i.content)).toEqual(["步骤一", "步骤二"]);
    expect(first.revision).toBe(1);

    const second = await store.write("s1", [{ content: "只有这一步" }]);
    expect(second.items).toHaveLength(1);
    expect(second.revision).toBe(2);

    // 返回的是副本：改动不影响内部状态
    second.items[0]!.content = "被改了";
    expect((await store.read("s1")).items[0]!.content).toBe("只有这一步");
  });

  it("merge：按 id 增量更新，未提及的旧项保持不动", async () => {
    const { store } = makeEnv();
    const state = await store.write("s1", [
      { id: "a", content: "读代码" },
      { id: "b", content: "写测试" },
    ]);
    expect(state.items.map((i) => i.id)).toEqual(["a", "b"]);

    const merged = await store.write("s1", [{ id: "a", content: "读代码", status: "completed" }], { merge: true });
    expect(merged.items.find((i) => i.id === "a")!.status).toBe("completed");
    expect(merged.items.find((i) => i.id === "b")!.status).toBe("pending");
  });

  it("不变量：单 in_progress（保留最近推进的）+ 提前到 pending 之前", async () => {
    const { store } = makeEnv();
    const state = await store.write("s1", [
      { content: "A", status: "in_progress" },
      { content: "B", status: "in_progress" },
      { content: "C", status: "pending" },
    ]);
    const inProgress = state.items.filter((i) => i.status === "in_progress");
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]!.content).toBe("B"); // 顺序最靠后的那个
    expect(state.items[0]!.content).toBe("B"); // 提前到最前
  });

  it("不变量：非法状态 → pending；content 超长截断；容量上限", () => {
    const normalized = normalizeState({
      items: [
        { id: "x", content: "任务", status: "瞎写的" },
        { id: "y", content: "长".repeat(300) },
      ],
    });
    expect(normalized.items[0]!.status).toBe("pending");
    expect(normalized.items[1]!.content.length).toBeLessThanOrEqual(200);

    const many = normalizeState({ items: Array.from({ length: MAX_TODO_ITEMS + 10 }, (_, i) => ({ content: `t${i}` })) });
    expect(many.items).toHaveLength(MAX_TODO_ITEMS);
  });

  it("不变量：parent 悬空 → 丢弃；parent 成环 → 打断成根", () => {
    const normalized = normalizeState({
      items: [
        { id: "a", content: "A", parent: "ghost" },
        { id: "b", content: "B", parent: "c" },
        { id: "c", content: "C", parent: "b" },
      ],
    });
    expect(normalized.items.find((i) => i.id === "a")!.parent).toBeUndefined();
    const b = normalized.items.find((i) => i.id === "b")!;
    const c = normalized.items.find((i) => i.id === "c")!;
    expect(b.parent === undefined || c.parent === undefined).toBe(true);
  });

  it("formatForInjection：只含未完成项；全完成 → null", async () => {
    const { store } = makeEnv();
    await store.write("s1", [
      { content: "已完成的事", status: "completed" },
      { content: "进行中的事", status: "in_progress" },
      { content: "待办的事", status: "pending" },
      { content: "取消的事", status: "cancelled" },
    ]);
    const text = await store.formatForInjection("s1");
    expect(text).toContain("进行中的事");
    expect(text).toContain("待办的事");
    expect(text).not.toContain("已完成的事");
    expect(text).not.toContain("取消的事");

    await store.write("s1", [{ content: "只剩完成项", status: "completed" }]);
    expect(await store.formatForInjection("s1")).toBeNull();
  });

  it("从会话 meta 恢复（跨进程/重启语义）", async () => {
    const { sessions, store } = makeEnv();
    await seedSession(sessions, "s1", {
      todos: { items: [{ id: "a", content: "恢复的步骤", status: "in_progress" }], revision: 7, updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    const state = await store.read("s1");
    expect(state.revision).toBe(7);
    expect(state.items[0]!.content).toBe("恢复的步骤");
    expect(await store.formatForInjection("s1")).toContain("恢复的步骤");
  });

  it("并发写入串行化：并行 5 次 merge 不丢更新", async () => {
    const { store } = makeEnv();
    await store.write("s1", [{ id: "a", content: "A" }, { id: "b", content: "B" }, { id: "c", content: "C" }]);
    await Promise.all([
      store.write("s1", [{ id: "a", content: "A", status: "completed" }], { merge: true }),
      store.write("s1", [{ id: "b", content: "B", status: "in_progress" }], { merge: true }),
      store.write("s1", [{ id: "c", content: "C", status: "completed" }], { merge: true }),
    ]);
    const state = await store.read("s1");
    expect(state.items.find((i) => i.id === "a")!.status).toBe("completed");
    expect(state.items.find((i) => i.id === "b")!.status).toBe("in_progress");
    expect(state.items.find((i) => i.id === "c")!.status).toBe("completed");
    expect(state.revision).toBe(4);
  });
});

describe("todo 工具", () => {
  const tool = () => createTodoTool(new TodoStore(new InMemorySessionStore()));

  it("无参数 = 读取", async () => {
    const t = tool();
    const r = await t.execute!({ sessionId: "s1" }, {});
    expect(r.ok).toBe(true);
    expect((r.output as { items: unknown[] }).items).toEqual([]);
  });

  it("写入返回完整清单与变更摘要", async () => {
    const t = tool();
    const r = await t.execute!({ sessionId: "s1" }, { todos: [{ id: "a", content: "第一步" }, { id: "b", content: "第二步" }] });
    expect(r.ok).toBe(true);
    const out = r.output as { items: Array<{ id: string }>; changed: { added: number } };
    expect(out.items).toHaveLength(2);
    expect(out.changed.added).toBe(2);

    const r2 = await t.execute!({ sessionId: "s1" }, { todos: [{ id: "a", content: "第一步", status: "completed" }], merge: true });
    expect(((r2.output as { changed: { statusChanged: number } }).changed).statusChanged).toBe(1);
  });

  it("缺会话上下文 → ok:false（不抛错）", async () => {
    const t = tool();
    const r = await t.execute!({}, { todos: [{ content: "x" }] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("sessionId");
  });

  it("会话隔离：两个 session 的清单互不串", async () => {
    const t = tool();
    await t.execute!({ sessionId: "s1" }, { todos: [{ content: "会话一的步骤" }] });
    await t.execute!({ sessionId: "s2" }, { todos: [{ content: "会话二的步骤" }] });
    const r1 = await t.execute!({ sessionId: "s1" }, {});
    const r2 = await t.execute!({ sessionId: "s2" }, {});
    expect((r1.output as { items: Array<{ content: string }> }).items[0]!.content).toBe("会话一的步骤");
    expect((r2.output as { items: Array<{ content: string }> }).items[0]!.content).toBe("会话二的步骤");
  });
});
