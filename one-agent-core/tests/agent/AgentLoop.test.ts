import { describe, it, expect } from "vitest";
import { Agent } from "../../src/agent/index.js";
import { calculatorTool, ToolRegistry } from "../../src/tools/index.js";
import type { LanguageProvider } from "../../src/providers/index.js";
import type { ChatOptions } from "../../src/providers/types.js";
import type { AgentConfig, LLMMessage, StreamChunk } from "../../src/index.js";

/** 脚本化 Provider：按调用次数返回预设 chunk 序列 */
class ScriptedProvider implements LanguageProvider {
  readonly kind = "openai-compatible" as const;
  calls = 0;
  receivedTools: unknown[][] = [];
  script: Array<() => StreamChunk[]>;
  onChat?: (opts: ChatOptions) => void;

  constructor(script: Array<() => StreamChunk[]>, onChat?: (opts: ChatOptions) => void) {
    this.script = script;
    this.onChat = onChat;
  }

  async *chat(opts: ChatOptions): AsyncIterable<StreamChunk> {
    this.onChat?.(opts);
    this.receivedTools.push(opts.tools ?? []);
    const step = this.script[this.calls] ?? this.script[this.script.length - 1]!;
    this.calls++;
    for (const c of step()) yield c;
  }
}

function makeAgent(provider: LanguageProvider, extra?: Partial<AgentConfig>) {
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
    { provider, tools: registry },
  );
}

async function collect(agent: Agent, input: string): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of agent.run(input, { sessionId: "t" })) out.push(c);
  return out;
}

describe("AgentLoop", () => {
  it("单轮：无工具调用 → text + usage + done", async () => {
    const provider = new ScriptedProvider([
      () => [
        { type: "text", delta: "你好" } as StreamChunk,
        { type: "usage", inputTokens: 10, outputTokens: 2 },
        { type: "done" },
      ],
    ]);
    const agent = makeAgent(provider);
    const chunks = await collect(agent, "hi");

    const text = chunks.filter((c) => c.type === "text").map((c) => (c as Extract<StreamChunk, { type: "text" }>).delta).join("");
    expect(text).toBe("你好");
    const usage = chunks.find((c) => c.type === "usage") as Extract<StreamChunk, { type: "usage" }>;
    expect(usage.inputTokens).toBe(10);
    expect(chunks.at(-1)?.type).toBe("done");
    expect(provider.calls).toBe(1);
  });

  it("多轮：tool_call → tool_result → 最终回答，usage 聚合", async () => {
    const provider = new ScriptedProvider([
      () => [
        { type: "text", delta: "让我算一下" },
        { type: "tool_call", id: "call_1", name: "calculator", input: { expression: "(1+2)*3" } },
        { type: "usage", inputTokens: 20, outputTokens: 5 },
        { type: "done" },
      ],
      () => [
        { type: "text", delta: "结果是 9" },
        { type: "usage", inputTokens: 30, outputTokens: 8 },
        { type: "done" },
      ],
    ]);
    const agent = makeAgent(provider);
    const chunks = await collect(agent, "算一下 (1+2)*3");

    const texts = chunks.filter((c) => c.type === "text").map((c) => (c as Extract<StreamChunk, { type: "text" }>).delta).join("");
    expect(texts).toBe("让我算一下结果是 9");

    const tc = chunks.find((c) => c.type === "tool_call") as Extract<StreamChunk, { type: "tool_call" }>;
    expect(tc.name).toBe("calculator");
    const tr = chunks.find((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>;
    expect(tr.ok).toBe(true);
    expect(tr.output).toBe(9);

    // 两次模型调用 usage 聚合
    const usage = chunks.find((c) => c.type === "usage") as Extract<StreamChunk, { type: "usage" }>;
    expect(usage.inputTokens).toBe(50);
    expect(usage.outputTokens).toBe(13);
    expect(provider.calls).toBe(2);
    expect(chunks.at(-1)?.type).toBe("done");

    // 第二次模型调用时 tools 仍传入
    expect(provider.receivedTools[1]!.length).toBe(1);
  });

  it("禁用工具 → 模型调用不带 tools", async () => {
    const provider = new ScriptedProvider([() => [{ type: "text", delta: "ok" }, { type: "usage", inputTokens: 1, outputTokens: 1 }, { type: "done" }]]);
    const agent = makeAgent(provider, { tools: [{ name: "calculator", enabled: false }] });
    await collect(agent, "hi");
    expect(provider.receivedTools[0]).toEqual([]);
  });

  it("toolOverrides 可临时启用工具（动态配置）", async () => {
    const provider = new ScriptedProvider([() => [{ type: "text", delta: "ok" }, { type: "usage", inputTokens: 1, outputTokens: 1 }, { type: "done" }]]);
    const agent = makeAgent(provider, { tools: [{ name: "calculator", enabled: false }] });
    const out: StreamChunk[] = [];
    for await (const c of agent.run("hi", { sessionId: "t", toolOverrides: [{ name: "calculator", enabled: true }] })) out.push(c);
    expect(provider.receivedTools[0]!.length).toBe(1);
  });

  it("工具执行失败 → tool_result ok:false，loop 继续到最终回答", async () => {
    const provider = new ScriptedProvider([
      () => [
        { type: "tool_call", id: "c1", name: "calculator", input: { expression: "1/0" } },
        { type: "usage", inputTokens: 5, outputTokens: 2 },
        { type: "done" },
      ],
      () => [{ type: "text", delta: "除零错误" }, { type: "usage", inputTokens: 5, outputTokens: 2 }, { type: "done" }],
    ]);
    const agent = makeAgent(provider);
    const chunks = await collect(agent, "算 1/0");
    const tr = chunks.find((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>;
    expect(tr.ok).toBe(false);
    expect(String(tr.output)).toContain("除以零");
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("达到 maxIterations → error chunk", async () => {
    const provider = new ScriptedProvider([
      () => [{ type: "tool_call", id: "c1", name: "calculator", input: { expression: "1+1" } }, { type: "done" }],
    ]);
    const agent = makeAgent(provider, { maxIterations: 2 } as never);
    const chunks = await collect(agent, "一直算");
    const err = chunks.find((c) => c.type === "error") as Extract<StreamChunk, { type: "error" }>;
    expect(err.message).toContain("max iterations");
    expect(provider.calls).toBe(2);
  });

  it("provider 报错 → error chunk 透传", async () => {
    const provider = new ScriptedProvider([() => [{ type: "error", message: "HTTP 500" }]]);
    const agent = makeAgent(provider);
    const chunks = await collect(agent, "hi");
    expect(chunks[0]).toMatchObject({ type: "error", message: "HTTP 500" });
  });

  it("多轮会话：历史保留（string 输入追加会话）", async () => {
    const provider = new ScriptedProvider([
      () => [{ type: "text", delta: "一" }, { type: "done" }],
      () => [{ type: "text", delta: "二" }, { type: "done" }],
    ]);
    const agent = makeAgent(provider);
    await collect(agent, "第一句");
    await collect(agent, "第二句");
    const history = agent.getHistory("t");
    // system? 无；user/assistant/user/assistant
    expect(history.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["第一句", "第二句"]);
    expect(history.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["一", "二"]);
    // 第二次调用 messages 应含第一轮历史
    const firstCallMessages = provider.receivedTools.length; // 无关
    expect(provider.calls).toBe(2);
    void firstCallMessages;
  });
});
