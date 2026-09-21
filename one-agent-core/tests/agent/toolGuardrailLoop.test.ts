import { describe, it, expect } from "vitest";
import { Agent } from "../../src/agent/index.ts";
import { ToolRegistry } from "../../src/tools/index.ts";
import type { AgentConfig, LLMMessage, StreamChunk, ToolSpec } from "../../src/index.ts";
import { ScriptedProvider } from "../helpers/scripted-provider.ts";

/** 一个永远失败的只读工具（模拟"路径写错、反复撞"） */
const failingRead: ToolSpec = {
  name: "read",
  description: "读文件（测试替身：总是失败）",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async execute() {
    return { ok: false, output: { error: "ENOENT: no such file or directory" } };
  },
};

/** 每次都调同一个工具、参数完全相同的"卡住的模型" */
function stuckProvider(calls = 20): ScriptedProvider {
  return new ScriptedProvider(
    Array.from({ length: calls }, (_, i) => () => [
      { type: "tool_call", id: `c${i}`, name: "read", input: { path: "nope.txt" } },
      { type: "usage", inputTokens: 5, outputTokens: 5 },
      { type: "done" },
    ]),
  );
}

function makeAgent(provider: ScriptedProvider, extra?: Partial<AgentConfig>) {
  const tools = new ToolRegistry();
  tools.add(failingRead);
  return new Agent(
    {
      id: "guardrail-loop",
      name: "守卫集成",
      instructions: "测试",
      model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1" },
      tools: [{ name: "read", enabled: true }],
      maxIterations: 12,
      ...extra,
    },
    { provider, tools },
  );
}

async function collect(agent: Agent, input: string | LLMMessage[]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of agent.run(input, { sessionId: "t" })) out.push(c);
  return out;
}

describe("AgentLoop × 工具调用守卫", () => {
  it("反复调同一个失败工具：注入引导 → 拦下调用（不再执行）→ 停轮", async () => {
    const provider = stuckProvider();
    const agent = makeAgent(provider);

    const chunks = await collect(agent, "读 nope.txt");
    const results = chunks.filter((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>[];
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("");

    // ① 前面的失败是真的执行了（模型拿到错误）
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.ok).toBe(false);

    // ② 后续出现「被守卫拦下」的结果：带 guardrail 标记，且不是"工具执行失败"的口吻
    const blocked = results.filter((r) => typeof r.output === "object" && r.output !== null && "guardrail" in r.output);
    expect(blocked.length).toBeGreaterThan(0);
    const first = blocked[0]!.output as { error: string; guardrail: { code: string; count: number } };
    expect(["repeated_exact_failure", "idempotent_no_progress", "identical_call_cycle"]).toContain(first.guardrail.code);

    // ③ 停轮：有 [已停止] 提示，且总迭代远小于 maxIterations（没有一路试到 12）
    expect(text).toContain("[已停止]");
    expect(provider.calls).toBeLessThan(12);

    // ④ 引导进了对话（合成消息，前端隐藏、压缩时丢弃）
    const history = await agent.getHistory("t");
    const guidance = history.filter((m) => m.synthetic === "guardrailGuidance");
    expect(guidance.length).toBeGreaterThan(0);
    expect(guidance[0]!.content).toContain("重试");

    // ⑤ 每轮契约完整：最后一个 chunk 是 done
    expect(chunks.at(-1)!.type).toBe("done");
  });

  it("工具正常返回时不介入（守卫不误伤）", async () => {
    const okRead: ToolSpec = {
      name: "read",
      description: "读文件",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute() {
        return { ok: true, output: { content: "hello" } };
      },
    };
    const tools = new ToolRegistry();
    tools.add(okRead);
    const provider = new ScriptedProvider([
      () => [{ type: "tool_call", id: "c1", name: "read", input: { path: "a.txt" } }, { type: "done" }],
      () => [{ type: "text", delta: "读到了 hello" }, { type: "done" }],
    ]);
    const agent = new Agent(
      {
        id: "g2",
        name: "x",
        instructions: "测试",
        model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1" },
        tools: [{ name: "read", enabled: true }],
        maxIterations: 6,
      },
      { provider, tools },
    );

    const chunks = await collect(agent, "读 a.txt");
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("");
    expect(text).toBe("读到了 hello");
    expect(provider.calls).toBe(2);
    const history = await agent.getHistory("t");
    expect(history.some((m) => m.synthetic === "guardrailGuidance")).toBe(false);
    expect(chunks.filter((c) => c.type === "tool_result").every((r) => (r as { ok: boolean }).ok)).toBe(true);
  });

  it("同一批次里重复的只读调用只执行一次，其余被守卫抑制", async () => {
    let executions = 0;
    const countingRead: ToolSpec = {
      name: "read",
      description: "读文件（计数替身）",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute() {
        executions++;
        return { ok: true, output: { content: "hello" } };
      },
    };
    const tools = new ToolRegistry();
    tools.add(countingRead);
    const provider = new ScriptedProvider([
      () => [
        { type: "tool_call", id: "c1", name: "read", input: { path: "a.txt" } },
        { type: "tool_call", id: "c2", name: "read", input: { path: "a.txt" } },
        { type: "tool_call", id: "c3", name: "read", input: { path: "a.txt" } },
        { type: "done" },
      ],
      () => [{ type: "text", delta: "好" }, { type: "done" }],
    ]);
    const agent = new Agent(
      {
        id: "g3",
        name: "x",
        instructions: "测试",
        model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1" },
        tools: [{ name: "read", enabled: true }],
        maxIterations: 4,
      },
      { provider, tools },
    );

    const chunks = await collect(agent, "读 a.txt 三次");
    const results = chunks.filter((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>[];
    // 工具只真正执行了一次
    expect(executions).toBe(1);
    // 三条结果都在（契约：每个 tool_call 都有配对结果），后两条带守卫标记
    expect(results.length).toBe(3);
    const guarded = results.filter((r) => typeof r.output === "object" && r.output !== null && "guardrail" in r.output);
    expect(guarded.length).toBe(2);
    expect((guarded[0]!.output as { guardrail: { code: string } }).guardrail.code).toBe("duplicate_same_batch");
    // 不是死循环 → 不停轮
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("");
    expect(text).not.toContain("[已停止]");
  });

  it("enabled:false 时完全关闭（一路试到 maxIterations，行为与守卫生效前一致）", async () => {
    const provider = stuckProvider();
    const agent = makeAgent(provider, { toolGuardrails: { enabled: false }, maxIterations: 4 });

    const chunks = await collect(agent, "读 nope.txt");
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("");
    expect(text).not.toContain("[已停止]");
    const results = chunks.filter((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>[];
    expect(results.every((r) => typeof r.output !== "object" || r.output === null || !("guardrail" in r.output))).toBe(true);
    expect(provider.calls).toBe(4);
  });
});
