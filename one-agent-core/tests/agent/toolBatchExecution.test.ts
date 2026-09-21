import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Agent, ToolRegistry, defineTool } from "../../src/index.ts";
import { ScriptedProvider } from "../helpers/scripted-provider.ts";
import type { StreamChunk } from "../../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 探针工具：名字刻意用 read / write / bash，以便命中调度器的准入面板
 * （调度器按工具名判定作用域，与内置工具同名即可验证分段行为）。
 * 每次执行把 start/end 事件写入共享日志 → 用来断言"真的串行/真的并行"。
 */
function makeHarness(delays: Record<string, number> = {}) {
  const events: string[] = [];
  const registry = new ToolRegistry();

  registry.add(
    defineTool({
      name: "read",
      description: "探针：读文件",
      schema: z.object({ path: z.string() }),
      async execute(_ctx, { path }) {
        events.push(`read:start:${path}`);
        await sleep(delays[path] ?? 30);
        events.push(`read:end:${path}`);
        return { ok: true, output: `content:${path}` };
      },
    }),
  );
  registry.add(
    defineTool({
      name: "write",
      description: "探针：写文件",
      schema: z.object({ path: z.string(), content: z.string().optional() }),
      async execute(_ctx, { path }) {
        events.push(`write:start:${path}`);
        await sleep(delays[path] ?? 30);
        events.push(`write:end:${path}`);
        return { ok: true, output: { path } };
      },
    }),
  );
  registry.add(
    defineTool({
      name: "bash",
      description: "探针：shell",
      schema: z.object({ command: z.string() }),
      async execute(_ctx, { command }) {
        events.push(`bash:start:${command}`);
        await sleep(delays["bash"] ?? 30);
        events.push(`bash:end:${command}`);
        return { ok: true, output: command };
      },
    }),
  );

  const provider = new ScriptedProvider([]);
  const agent = new Agent(
    {
      id: "scheduler-probe",
      name: "scheduler probe",
      instructions: "探针",
      model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1" },
      tools: [
        { name: "read", enabled: true },
        { name: "write", enabled: true },
        { name: "bash", enabled: true },
      ],
      maxIterations: 3,
    },
    { provider, tools: registry },
  );

  return { agent, provider, events };
}

/** 第一轮发工具调用，第二轮给最终回答 */
function script(calls: Array<{ id: string; name: string; input: unknown }>): Array<() => StreamChunk[]> {
  return [
    () => [
      ...calls.map((c) => ({ type: "tool_call", id: c.id, name: c.name, input: c.input }) as StreamChunk),
      { type: "usage", inputTokens: 5, outputTokens: 5 },
      { type: "done" },
    ],
    () => [{ type: "text", delta: "完成" }, { type: "usage", inputTokens: 5, outputTokens: 5 }, { type: "done" }],
  ];
}

async function run(agent: Agent): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of agent.run("执行", { sessionId: "t" })) out.push(c);
  return out;
}

function resultOrder(chunks: StreamChunk[]): string[] {
  return chunks.filter((c) => c.type === "tool_result").map((c) => (c as Extract<StreamChunk, { type: "tool_result" }>).id);
}

describe("AgentLoop 工具批分段执行", () => {
  it("同轮读+写同一文件 → 串行（读完整结束后才开始写）", async () => {
    const { agent, provider, events } = makeHarness();
    provider.script = script([
      { id: "c1", name: "read", input: { path: "a.txt" } },
      { id: "c2", name: "write", input: { path: "a.txt", content: "新内容" } },
    ]);
    const chunks = await run(agent);

    expect(events).toEqual(["read:start:a.txt", "read:end:a.txt", "write:start:a.txt", "write:end:a.txt"]);
    expect(resultOrder(chunks)).toEqual(["c1", "c2"]);
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("两个不同文件的读 → 真并行（两个 start 都在任一 end 之前）", async () => {
    const { agent, provider, events } = makeHarness();
    provider.script = script([
      { id: "c1", name: "read", input: { path: "a.txt" } },
      { id: "c2", name: "read", input: { path: "b.txt" } },
    ]);
    await run(agent);

    expect(events.slice(0, 2).every((e) => e.endsWith(":start") || e.includes(":start:"))).toBe(true);
    expect(events[0]).toBe("read:start:a.txt");
    expect(events[1]).toBe("read:start:b.txt");
  });

  it("读 a + 写 b（路径不相干）→ 并行", async () => {
    const { agent, provider, events } = makeHarness();
    provider.script = script([
      { id: "c1", name: "read", input: { path: "a.txt" } },
      { id: "c2", name: "write", input: { path: "b.txt", content: "x" } },
    ]);
    await run(agent);

    expect(events[0]).toBe("read:start:a.txt");
    expect(events[1]).toBe("write:start:b.txt");
  });

  it("bash 是屏障：它之后的读必须等它结束", async () => {
    const { agent, provider, events } = makeHarness();
    provider.script = script([
      { id: "c1", name: "bash", input: { command: "ls" } },
      { id: "c2", name: "read", input: { path: "a.txt" } },
      { id: "c3", name: "read", input: { path: "b.txt" } },
    ]);
    await run(agent);

    expect(events[0]).toBe("bash:start:ls");
    expect(events[1]).toBe("bash:end:ls");
    // 屏障之后的两个读仍然是并行的
    expect(events[2]).toBe("read:start:a.txt");
    expect(events[3]).toBe("read:start:b.txt");
  });

  it("结果按原始调用顺序回填（与完成先后无关）", async () => {
    const { agent, provider } = makeHarness({ "slow.txt": 60, "fast.txt": 5 });
    provider.script = script([
      { id: "c1", name: "read", input: { path: "slow.txt" } },
      { id: "c2", name: "read", input: { path: "fast.txt" } },
    ]);
    const chunks = await run(agent);

    // 段内并行：fast 先完成，但结果事件仍按 c1、c2 顺序产出
    expect(resultOrder(chunks)).toEqual(["c1", "c2"]);
  });

  it("未注册的工具 → ok:false 的结果，不中断整轮对话", async () => {
    const { agent, provider } = makeHarness();
    provider.script = script([
      { id: "c1", name: "read", input: { path: "a.txt" } },
      { id: "c2", name: "ghost_tool", input: {} },
    ]);
    const chunks = await run(agent);

    const results = chunks.filter((c) => c.type === "tool_result") as Array<Extract<StreamChunk, { type: "tool_result" }>>;
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(String(results[1]!.output)).toContain("未注册");
    // 循环继续到最终回答，没有 error chunk
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(chunks.filter((c) => c.type === "text").map((c) => (c as Extract<StreamChunk, { type: "text" }>).delta).join("")).toBe("完成");
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("tool_call 事件仍按原始顺序先发出（流协议不变）", async () => {
    const { agent, provider } = makeHarness();
    provider.script = script([
      { id: "c1", name: "write", input: { path: "a.txt", content: "x" } },
      { id: "c2", name: "read", input: { path: "a.txt" } },
      { id: "c3", name: "read", input: { path: "b.txt" } },
    ]);
    const chunks = await run(agent);
    const callIds = chunks.filter((c) => c.type === "tool_call").map((c) => (c as Extract<StreamChunk, { type: "tool_call" }>).id);

    expect(callIds).toEqual(["c1", "c2", "c3"]);
    // tool_call 全部先于 tool_result
    const firstResultIdx = chunks.findIndex((c) => c.type === "tool_result");
    const lastCallIdx = chunks.map((c) => c.type).lastIndexOf("tool_call");
    expect(lastCallIdx).toBeLessThan(firstResultIdx);
  });
});
