import { describe, expect, it } from "vitest";
import { messageKey, toMessageWithStableId } from "../../src/session/convert.ts";
import type { LLMMessage } from "../../src/types.ts";
import type { Message } from "../../src/session/types.ts";

const now = "2026-01-01T00:00:00.000Z";

function persisted(overrides: Partial<Message> & { id: string; content: string }): Message {
  return { role: "user", createdAt: now, ...overrides } as Message;
}

describe("消息 id 跨轮次稳定（toMessageWithStableId）", () => {
  it("内容未变 → 复用既有 id 与 createdAt（保证 prompt cache 命中）", () => {
    const existing = [persisted({ id: "m-1", content: "你好", createdAt: "2025-12-31T00:00:00.000Z" })];
    const llm: LLMMessage = { role: "user", content: "你好" };
    const out = toMessageWithStableId(llm, existing, now);
    expect(out.id).toBe("m-1");
    expect(out.createdAt).toBe("2025-12-31T00:00:00.000Z");
  });

  it("内容变了 → 生成新 id", () => {
    const existing = [persisted({ id: "m-1", content: "你好" })];
    const out = toMessageWithStableId({ role: "user", content: "你好呀" }, existing, now);
    expect(out.id).not.toBe("m-1");
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("同一批里两条内容相同的消息 → 不会复用到同一个 id（整批共用 usedIds）", () => {
    const existing = [persisted({ id: "m-1", content: "同一句话" })];
    const usedIds = new Set<string>();
    const batch: LLMMessage[] = [
      { role: "user", content: "同一句话" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "同一句话" }, // 与第一条内容完全相同
    ];
    const saved = batch.map((m) => toMessageWithStableId(m, existing, now, usedIds));

    expect(saved[0]!.id).toBe("m-1"); // 第一条仍复用既有 id
    expect(saved[2]!.id).not.toBe("m-1"); // 第二条另分配，不能撞
    expect(new Set(saved.map((m) => m.id)).size).toBe(3); // 批内 id 全唯一
  });

  it("不传 usedIds（逐条调用）时也能工作 —— 但调用方应整批共用一个集合", () => {
    const existing = [persisted({ id: "m-1", content: "同一句话" })];
    const a = toMessageWithStableId({ role: "user", content: "同一句话" }, existing, now);
    const b = toMessageWithStableId({ role: "user", content: "同一句话" }, existing, now);
    expect(a.id).toBe("m-1");
    expect(b.id).toBe("m-1"); // 逐条独立调用会撞 —— 所以 Agent 落库时传入共享集合
  });

  it("messageKey 区分 role / 内容 / 工具调用", () => {
    expect(messageKey({ role: "user", content: "x" })).not.toBe(messageKey({ role: "assistant", content: "x" }));
    expect(messageKey({ role: "user", content: "x" })).not.toBe(
      messageKey({ role: "user", content: "x", toolCalls: [{ id: "c1", name: "ls", input: {} }] }),
    );
  });
});
