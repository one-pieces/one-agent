import { describe, expect, it } from "vitest";
import { applyChunk, iterationFinished, toUiMessages, type UiMessage } from "../lib/chat-messages";
import type { Message as PersistedMessage, StreamChunk } from "@one-agent/core";

/** 模拟内核 SSE 事件序列：文本 → 工具卡片 → 结果 → 下一轮文本 */
function run(chunks: StreamChunk[], initial: UiMessage[] = [userMsg()]): UiMessage[] {
  return chunks.reduce((ms, chunk) => applyChunk(ms, chunk), initial);
}

function userMsg(): UiMessage {
  return { id: "u1", role: "user", content: "看看代码", toolCalls: [] };
}

/** start 是流式 assistant 占位消息（与 Chat.send 一致） */
function withPlaceholder(): UiMessage[] {
  return [userMsg(), { id: "a1", role: "assistant", content: "", toolCalls: [], streaming: true }];
}

describe("applyChunk 消息/工具顺序", () => {
  it("同一轮：文本先到达 → 文本与工具卡在同一条消息（文本在前，渲染时工具卡在其后）", () => {
    const ms = run(
      [
        { type: "text", delta: "我先读一下文件。" },
        { type: "tool_call", id: "c1", name: "read", input: { path: "a.ts" } },
        { type: "tool_result", id: "c1", ok: true, output: "code" },
      ],
      withPlaceholder(),
    );
    expect(ms).toHaveLength(2);
    const a = ms[1]!;
    expect(a.content).toBe("我先读一下文件。");
    expect(a.toolCalls.map((tc) => [tc.id, tc.status])).toEqual([["c1", "done"]]);
  });

  it("跨轮：上一轮工具全部返回后的文本另起一条消息（顺序为 文本1 / 工具1 / 文本2）", () => {
    const ms = run(
      [
        { type: "text", delta: "我先读一下文件。" },
        { type: "tool_call", id: "c1", name: "read", input: {} },
        { type: "tool_result", id: "c1", ok: true, output: "code" },
        { type: "text", delta: "文件里定义了 Foo。" },
      ],
      withPlaceholder(),
    );
    expect(ms.map((m) => [m.role, m.content, m.toolCalls.map((t) => t.id)])).toEqual([
      ["user", "看看代码", []],
      ["assistant", "我先读一下文件。", ["c1"]],
      ["assistant", "文件里定义了 Foo。", []],
    ]);
    // 上一轮的消息不再处于流式状态（光标只在最新一条）
    expect(ms[1]!.streaming).toBe(false);
    expect(ms[2]!.streaming).toBe(true);
  });

  it("工具仍在执行时到来的文本归入当前轮（同一轮内不会误切分）", () => {
    const ms = run(
      [
        { type: "text", delta: "调用中" },
        { type: "tool_call", id: "c1", name: "bash", input: {} },
        { type: "text", delta: "……" },
      ],
      withPlaceholder(),
    );
    expect(ms).toHaveLength(2);
    expect(ms[1]!.content).toBe("调用中……");
  });

  it("新轮无文本、直接调用工具时另起一条消息（与落库结构一致）", () => {
    const ms = run(
      [
        { type: "text", delta: "第一轮" },
        { type: "tool_call", id: "c1", name: "read", input: {} },
        { type: "tool_result", id: "c1", ok: true, output: "x" },
        { type: "tool_call", id: "c2", name: "find", input: {} },
        { type: "tool_result", id: "c2", ok: true, output: "y" },
        { type: "text", delta: "汇总" },
      ],
      withPlaceholder(),
    );
    expect(ms.map((m) => [m.content, m.toolCalls.map((t) => t.id)])).toEqual([
      ["看看代码", []],
      ["第一轮", ["c1"]],
      ["", ["c2"]],
      ["汇总", []],
    ]);
  });

  it("并行工具：结果按 id 归属到发起它的消息，状态与输出正确", () => {
    const ms = run(
      [
        { type: "text", delta: "并行读取" },
        { type: "tool_call", id: "c1", name: "read", input: {} },
        { type: "tool_call", id: "c2", name: "tree", input: {} },
        { type: "tool_result", id: "c1", ok: true, output: "A" },
        { type: "tool_result", id: "c2", ok: false, output: "boom" },
      ],
      withPlaceholder(),
    );
    const a = ms[1]!;
    expect(a.toolCalls.map((tc) => [tc.id, tc.status, tc.output])).toEqual([
      ["c1", "done", "A"],
      ["c2", "error", "boom"],
    ]);
  });

  it("done 事件结束流式标记", () => {
    const ms = run([{ type: "text", delta: "答案" }, { type: "done" }], withPlaceholder());
    expect(ms[1]!.streaming).toBe(false);
    expect(iterationFinished(ms[1]!)).toBe(false); // 无工具调用 → 不触发切分
  });
});

describe("toUiMessages 历史回放顺序", () => {
  const persisted: PersistedMessage[] = [
    { id: "m0", role: "system", content: "指令", createdAt: "t0" },
    { id: "m1", role: "user", content: "问题", createdAt: "t0" },
    { id: "m2", role: "assistant", content: "我先看看", toolCalls: [{ id: "c1", name: "read", input: {} }], createdAt: "t1" },
    { id: "m3", role: "tool", content: "\"code\"", toolCallId: "c1", createdAt: "t1" },
    { id: "m4", role: "assistant", content: "结论", createdAt: "t2" },
  ];

  it("每条 assistant 消息 = 一条 UI 消息（保持 文本/工具 的时间顺序，system/tool 不渲染）", () => {
    const ui = toUiMessages(persisted);
    expect(ui.map((m) => [m.role, m.content, m.toolCalls.map((t) => [t.id, t.status])])).toEqual([
      ["user", "问题", []],
      ["assistant", "我先看看", [["c1", "done"]]],
      ["assistant", "结论", []],
    ]);
  });

  it("工具结果缺失时状态为执行中，错误结果标记为失败", () => {
    const ui = toUiMessages([
      { id: "x", role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", input: {} }], createdAt: "t" },
      { id: "y", role: "assistant", content: "", toolCalls: [{ id: "c2", name: "read", input: {} }], createdAt: "t" },
      { id: "z", role: "tool", content: "{\"error\":\"boom\"}", toolCallId: "c2", createdAt: "t" },
    ]);
    expect(ui.map((m) => m.toolCalls[0]!.status)).toEqual(["running", "error"]);
  });
});

describe("toUiMessages 隐藏合成消息", () => {
  it("压缩后注入的 todo 快照（synthetic）不渲染成用户消息", () => {
    const ui = toUiMessages([
      { id: "m1", role: "user", content: "继续推进", createdAt: "t0" },
      { id: "s1", role: "user", content: "[你的任务清单在上下文压缩后被保留]", synthetic: "contextSnapshot", createdAt: "t1" },
      { id: "m2", role: "assistant", content: "好", createdAt: "t2" },
    ]);
    expect(ui.map((m) => [m.role, m.content])).toEqual([
      ["user", "继续推进"],
      ["assistant", "好"],
    ]);
  });
});
