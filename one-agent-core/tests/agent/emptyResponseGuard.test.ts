import { describe, it, expect } from "vitest";
import { Agent } from "../../src/agent/index.ts";
import { ToolRegistry } from "../../src/tools/index.ts";
import { ScriptedProvider } from "../helpers/scripted-provider.ts";
import type { AgentConfig, LLMMessage, StreamChunk } from "../../src/index.ts";

/** 模拟本地小模型：连续给出空回答（既无文本也无工具调用） */
function emptyTurn(): StreamChunk[] {
  return [{ type: "usage", inputTokens: 5, outputTokens: 3 }, { type: "done" }];
}

function makeAgent(provider: ScriptedProvider, extra?: Partial<AgentConfig>) {
  return new Agent(
    {
      id: "empty-guard",
      name: "空响应守卫",
      instructions: "测试",
      model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1" },
      tools: [],
      maxIterations: 5,
      ...extra,
    },
    { provider, tools: new ToolRegistry() },
  );
}

async function collect(agent: Agent): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of agent.run("你好", { sessionId: "t" })) out.push(c);
  return out;
}

describe("空响应守卫", () => {
  it("第一次空 → 追加催促消息重试，第二次有内容则正常结束（不落空 assistant 消息）", async () => {
    const seen: LLMMessage[][] = [];
    const provider = new ScriptedProvider([
      () => emptyTurn(),
      () => [{ type: "text", delta: "这才是回答" }, { type: "usage", inputTokens: 5, outputTokens: 3 }, { type: "done" }],
    ]);
    provider.onChat = (opts) => seen.push(opts.messages.map((m) => ({ ...m })));
    const agent = makeAgent(provider);

    const chunks = await collect(agent);

    expect(provider.calls).toBe(2);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(chunks.filter((c) => c.type === "text").map((c) => (c as Extract<StreamChunk, { type: "text" }>).delta).join("")).toBe("这才是回答");
    // 重试请求里带了催促消息（合成标记，前端会隐藏）
    const nudge = seen[1]!.filter((m) => m.synthetic === "emptyRetryNudge");
    expect(nudge).toHaveLength(1);
    expect(nudge[0]!.role).toBe("user");
    // 历史里没有空 assistant 消息
    const history = await agent.getHistory("t");
    expect(history.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["这才是回答"]);
    expect(history.some((m) => m.synthetic === "emptyRetryNudge")).toBe(false); // 催促消息不入最终历史
  });

  it("连续空到达上限 → 明确的 error chunk（不静默当答案）", async () => {
    const provider = new ScriptedProvider([() => emptyTurn()]);
    const agent = makeAgent(provider);

    const chunks = await collect(agent);

    expect(provider.calls).toBe(3); // 默认 emptyResponseRetries=2 → 1 次 + 2 次重试
    const err = chunks.find((c) => c.type === "error") as Extract<StreamChunk, { type: "error" }>;
    expect(err.message).toContain("空响应");
    expect(chunks.some((c) => c.type === "text")).toBe(false);
  });

  it("emptyResponseRetries=0 → 首次空即报错", async () => {
    const provider = new ScriptedProvider([() => emptyTurn()]);
    const agent = makeAgent(provider, { emptyResponseRetries: 0 });

    const chunks = await collect(agent);

    expect(provider.calls).toBe(1);
    expect(chunks[0]!.type).toBe("error");
  });
});
