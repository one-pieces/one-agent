import { describe, it, expect } from "vitest";
import { Agent } from "../../src/agent/index.ts";
import { ToolRegistry, defineTool } from "../../src/tools/index.ts";
import { InMemorySessionStore } from "../../src/session/index.ts";
import { ScriptedProvider } from "../helpers/scripted-provider.ts";
import { z } from "zod";
import type { AgentConfig, StreamChunk } from "../../src/index.ts";

const echoTool = defineTool({
  name: "echo",
  description: "回显（测试）",
  schema: z.object({ text: z.string() }),
  async execute(_ctx, { text }) {
    return { ok: true, output: text };
  },
});

function makeAgent(provider: ScriptedProvider, store: InMemorySessionStore) {
  const registry = new ToolRegistry();
  registry.add(echoTool);
  return new Agent(
    {
      id: "t",
      name: "测试",
      instructions: "你是测试助手。",
      model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1", apiKey: "x" },
      tools: [{ name: "echo", enabled: true }],
      maxIterations: 3,
    } satisfies AgentConfig,
    { provider, tools: registry, sessionStore: store },
  );
}

async function collect(agent: Agent, sessionId: string): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of agent.run("你好", { sessionId })) out.push(c);
  return out;
}

describe("usage 统计：缓存字段聚合 + 持久化", () => {
  it("多轮工具循环：usage chunk 聚合 cachedTokens/cacheCreationTokens，并随消息与会话 meta 持久化", async () => {
    const provider = new ScriptedProvider([
      // 第 1 次 LLM 调用：返回工具调用，无 usage
      () => [{ type: "tool_call", id: "c1", name: "echo", input: { text: "hi" } }, { type: "done" }],
      // 第 2 次 LLM 调用：最终回答 + usage（含缓存命中/写入）
      () => [
        { type: "text", delta: "最终回答" },
        { type: "usage", inputTokens: 100, outputTokens: 20, cachedTokens: 60, cacheCreationTokens: 40 },
        { type: "done" },
      ],
    ]);
    const store = new InMemorySessionStore();
    const agent = makeAgent(provider, store);
    const chunks = await collect(agent, "s1");

    // 最终 usage chunk：两次调用聚合（第 1 次无 usage → 0 + 第 2 次）
    const usage = chunks.find((c) => c.type === "usage") as Extract<StreamChunk, { type: "usage" }>;
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(20);
    expect(usage.cachedTokens).toBe(60);
    expect(usage.cacheCreationTokens).toBe(40);
    expect(chunks.at(-1)?.type).toBe("done");

    // 消息级：assistant 消息携带本轮用量
    const session = await store.getSession("s1");
    expect(session).not.toBeNull();
    const assistantMsgs = session!.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBe(2);
    expect(assistantMsgs[1]?.usage?.inputTokens).toBe(100);
    expect(assistantMsgs[1]?.usage?.cachedTokens).toBe(60);
    expect(assistantMsgs[1]?.usage?.cacheCreationTokens).toBe(40);

    // 会话级：meta.tokenUsage 累计持久化
    const meta = session!.meta as { tokenUsage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number } };
    expect(meta.tokenUsage?.inputTokens).toBe(100);
    expect(meta.tokenUsage?.outputTokens).toBe(20);
    expect(meta.tokenUsage?.cachedTokens).toBe(60);
    expect(meta.tokenUsage?.cacheCreationTokens).toBe(40);
  });

  it("多轮对话：meta.tokenUsage 跨轮累加", async () => {
    const provider = new ScriptedProvider([
      () => [
        { type: "text", delta: "第一轮" },
        { type: "usage", inputTokens: 10, outputTokens: 2, cachedTokens: 5 },
        { type: "done" },
      ],
      () => [
        { type: "text", delta: "第二轮" },
        { type: "usage", inputTokens: 20, outputTokens: 4, cachedTokens: 8 },
        { type: "done" },
      ],
    ]);
    const store = new InMemorySessionStore();
    const agent = makeAgent(provider, store);
    await collect(agent, "s2");
    await collect(agent, "s2");

    const session = await store.getSession("s2");
    const meta = session!.meta as { tokenUsage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } };
    expect(meta.tokenUsage?.inputTokens).toBe(30);
    expect(meta.tokenUsage?.outputTokens).toBe(6);
    expect(meta.tokenUsage?.cachedTokens).toBe(13);
  });
});
