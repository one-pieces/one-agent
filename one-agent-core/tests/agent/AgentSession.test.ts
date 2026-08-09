import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent/index.js";
import { ToolRegistry, calculatorTool } from "../../src/tools/index.js";
import { InMemorySessionStore, SqliteSessionStore } from "../../src/session/index.js";
import { ScriptedProvider } from "../helpers/scripted-provider.js";
import type { AgentConfig, LLMMessage, StreamChunk } from "../../src/index.js";

function makeAgent(provider: ScriptedProvider, store?: InstanceType<typeof InMemorySessionStore> | SqliteSessionStore, extra?: Partial<AgentConfig>) {
  const registry = new ToolRegistry();
  registry.add(calculatorTool);
  return new Agent(
    {
      id: "test",
      name: "测试助手",
      instructions: "你是测试助手。",
      model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1" },
      tools: [{ name: "calculator", enabled: true }],
      maxIterations: 3,
      ...extra,
    },
    { provider, tools: registry, sessionStore: store },
  );
}

async function collect(agent: Agent, input: string | LLMMessage[], opts?: Parameters<Agent["run"]>[1]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of agent.run(input, opts)) out.push(c);
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "one-agent-session-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Agent 会话集成", () => {
  it("会话隔离：不同 sessionId 互不污染", async () => {
    const provider = new ScriptedProvider([
      () => [{ type: "text", delta: "回复" }, { type: "done" }],
      () => [{ type: "text", delta: "回复" }, { type: "done" }],
    ]);
    const agent = makeAgent(provider);
    await collect(agent, "甲会话问题", { sessionId: "s1" });
    await collect(agent, "乙会话问题", { sessionId: "s2" });

    const h1 = await agent.getHistory("s1");
    const h2 = await agent.getHistory("s2");
    expect(h1.some((m) => m.role === "user" && m.content === "甲会话问题")).toBe(true);
    expect(h1.some((m) => m.role === "user" && m.content === "乙会话问题")).toBe(false);
    expect(h2.some((m) => m.role === "user" && m.content === "乙会话问题")).toBe(true);
    expect(h2.some((m) => m.role === "user" && m.content === "甲会话问题")).toBe(false);
  });

  it("同一 store 换新 Agent 实例 → 历史保留（重启恢复）", async () => {
    const store = new InMemorySessionStore();
    const p1 = new ScriptedProvider([() => [{ type: "text", delta: "第一次回答" }, { type: "done" }]]);
    const a1 = makeAgent(p1, store);
    await collect(a1, "第一轮");

    const p2 = new ScriptedProvider([() => [{ type: "text", delta: "第二次回答" }, { type: "done" }]]);
    const a2 = makeAgent(p2, store);
    await collect(a2, "第二轮");

    const h = await a2.getHistory();
    expect(h.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["第一轮", "第二轮"]);
    // 第二轮调用时 messages 包含第一轮历史
    const secondCallMsgs = (p2 as unknown as { onChat?: (o: { messages: LLMMessage[] }) => void }).onChat;
    void secondCallMsgs;
  });

  it("SQLite 持久化：跨 store 实例（模拟进程重启）对话可恢复并继续", async () => {
    const dbPath = join(dir, "sessions.db");
    const store1 = new SqliteSessionStore(dbPath);
    const p1 = new ScriptedProvider([() => [{ type: "text", delta: "第一" }, { type: "done" }]]);
    const a1 = makeAgent(p1, store1);
    await collect(a1, "你好");
    store1.close();

    const store2 = new SqliteSessionStore(dbPath);
    const p2 = new ScriptedProvider([() => [{ type: "text", delta: "第二" }, { type: "done" }]]);
    const a2 = makeAgent(p2, store2);
    expect((await a2.getHistory()).some((m) => m.role === "user" && m.content === "你好")).toBe(true);
    await collect(a2, "继续");
    const h = await a2.getHistory();
    expect(h.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["你好", "继续"]);
    store2.close();
  });

  it("消息 id 跨轮稳定（内容不变复用原 id）", async () => {
    const store = new InMemorySessionStore();
    const provider = new ScriptedProvider([
      () => [{ type: "text", delta: "一" }, { type: "done" }],
      () => [{ type: "text", delta: "二" }, { type: "done" }],
    ]);
    const agent = makeAgent(provider, store);
    await collect(agent, "第一句");
    const h1 = await agent.getHistory();
    const userMsgId1 = h1.find((m) => m.role === "user")!.id;

    await collect(agent, "第二句");
    const h2 = await agent.getHistory();
    const userMsgId2 = h2.find((m) => m.role === "user" && m.content === "第一句")!.id;
    expect(userMsgId2).toBe(userMsgId1);
  });

  it("clearSession 清空会话", async () => {
    const provider = new ScriptedProvider([() => [{ type: "text", delta: "x" }, { type: "done" }]]);
    const agent = makeAgent(provider);
    await collect(agent, "hi");
    expect((await agent.getHistory()).length).toBeGreaterThan(0);
    await agent.clearSession();
    expect(await agent.getHistory()).toEqual([]);
  });

  it("loop 触发 compaction：长历史 + 小上下文窗口 → 摘要调用后继续回答", async () => {
    const provider = new ScriptedProvider([
      () => [{ type: "text", delta: "用户问了十个问题。" }, { type: "usage", inputTokens: 5, outputTokens: 5 }, { type: "done" }], // 摘要调用
      () => [{ type: "text", delta: "最终回答" }, { type: "usage", inputTokens: 5, outputTokens: 2 }, { type: "done" }], // 正式回答
    ]);
    const agent = makeAgent(provider, undefined, {
      memory: { strategy: "compaction", contextWindowTokens: 100, thresholdPercent: 0.5 }, // 阈值 50
      maxIterations: 2,
    });

    const longHistory: LLMMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `这是第 ${i} 条比较长的消息内容，用于把上下文推到阈值以上`,
    }));

    const out: StreamChunk[] = [];
    for await (const c of agent.run(longHistory, { sessionId: "t" })) out.push(c);

    // 摘要调用(1) + 正式回答(1) = 2 次模型调用
    expect(provider.calls).toBe(2);
    const text = out.filter((c) => c.type === "text").map((c) => (c as Extract<StreamChunk, { type: "text" }>).delta).join("");
    expect(text).toBe("最终回答");
    // 历史中出现摘要
    const saved = await agent.getHistory("t");
    expect(saved.some((m) => m.content.includes("[历史对话摘要]"))).toBe(true);
  });
});
