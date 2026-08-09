import { describe, it, expect } from "vitest";
import { Agent } from "../../src/agent/index.ts";
import { ToolRegistry, defineTool } from "../../src/tools/index.ts";
import { ScriptedProvider } from "../helpers/scripted-provider.ts";
import { z } from "zod";
import type { AgentConfig, StreamChunk } from "../../src/index.ts";

const dangerousTool = defineTool({
  name: "dangerous_cmd",
  description: "危险命令（测试）",
  schema: z.object({ command: z.string() }),
  meta: { dangerous: true },
  async execute(_ctx, { command }) {
    return { ok: true, output: `executed: ${command}` };
  },
});

function makeAgent(provider: ScriptedProvider, extra?: Partial<AgentConfig>) {
  const registry = new ToolRegistry();
  registry.add(dangerousTool);
  return new Agent(
    {
      id: "t",
      name: "测试",
      instructions: "你是测试助手。",
      model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1", apiKey: "x" },
      tools: [{ name: "dangerous_cmd", enabled: true }],
      maxIterations: 2,
      ...extra,
    },
    { provider, tools: registry },
  );
}

async function collect(agent: Agent, opts?: Parameters<Agent["run"]>[1]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of agent.run("执行危险命令", opts)) out.push(c);
  return out;
}

describe("危险工具审批 hook（M5）", () => {
  const script: Array<() => StreamChunk[]> = [
    () => [
      { type: "tool_call", id: "c1", name: "dangerous_cmd", input: { command: "rm -rf /" } },
      { type: "done" },
    ],
  ];

  it("未提供 onApproval → 危险工具默认放行", async () => {
    const provider = new ScriptedProvider([
      ...script,
      () => [{ type: "text", delta: "已完成" }, { type: "done" }],
    ]);
    const agent = makeAgent(provider);
    const chunks = await collect(agent);
    const tr = chunks.find((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>;
    expect(tr.ok).toBe(true);
    expect(tr.output).toBe("executed: rm -rf /");
  });

  it("onApproval 返回 false → 拒绝执行", async () => {
    const provider = new ScriptedProvider([
      ...script,
      () => [{ type: "text", delta: "已拒绝" }, { type: "done" }],
    ]);
    const agent = makeAgent(provider);
    const chunks = await collect(agent, { sessionId: "t", onApproval: () => false });
    const tr = chunks.find((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>;
    expect(tr.ok).toBe(false);
    expect(String(tr.output)).toContain("已拒绝");
  });

  it("onApproval 返回 true → 放行执行", async () => {
    const provider = new ScriptedProvider([
      ...script,
      () => [{ type: "text", delta: "已完成" }, { type: "done" }],
    ]);
    const agent = makeAgent(provider);
    const chunks = await collect(agent, { sessionId: "t", onApproval: () => true });
    const tr = chunks.find((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>;
    expect(tr.ok).toBe(true);
  });

  it("onApproval 收到工具调用与工具定义", async () => {
    const provider = new ScriptedProvider([
      ...script,
      () => [{ type: "text", delta: "x" }, { type: "done" }],
    ]);
    const agent = makeAgent(provider);
    let seenCall: unknown;
    let seenTool: unknown;
    await collect(agent, {
      sessionId: "t",
      onApproval: (call, tool) => {
        seenCall = call;
        seenTool = tool;
        return true;
      },
    });
    expect((seenCall as { name: string }).name).toBe("dangerous_cmd");
    expect((seenTool as { meta: { dangerous: boolean } }).meta.dangerous).toBe(true);
  });
});
