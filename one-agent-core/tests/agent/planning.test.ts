import { describe, it, expect } from "vitest";
import { Agent, TodoStore, createTodoTool, buildSystemPrompt, PLANNING_GUIDANCE } from "../../src/index.ts";
import { InMemorySessionStore } from "../../src/session/index.ts";
import { ToolRegistry } from "../../src/tools/index.ts";
import { ScriptedProvider } from "../helpers/scripted-provider.ts";
import type { AgentConfig, LLMMessage, StreamChunk } from "../../src/index.ts";

function baseConfig(extra?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "planner-agent",
    name: "规划测试",
    instructions: "你是测试助手。",
    model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1" },
    tools: [],
    maxIterations: 3,
    ...extra,
  };
}

async function collect(agent: Agent, input: string, sessionId = "t"): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of agent.run(input, { sessionId })) out.push(c);
  return out;
}

describe("规划规程（planning）", () => {
  it("buildSystemPrompt：mode=off → 仅 instructions；mode=prompt → 追加内置规程", () => {
    expect(buildSystemPrompt(baseConfig())).toBe("你是测试助手。");
    const withPrompt = buildSystemPrompt(baseConfig({ planning: { mode: "prompt" } }));
    expect(withPrompt).toContain("你是测试助手。");
    expect(withPrompt).toContain(PLANNING_GUIDANCE);
    expect(buildSystemPrompt(baseConfig({ planning: { mode: "prompt", guidance: "自定义规程" } }))).toContain("自定义规程");
    // 纯函数：同一 config 多次调用结果一致（prompt cache 稳定的前提）
    expect(buildSystemPrompt(baseConfig({ planning: { mode: "prompt" } }))).toBe(withPrompt);
  });

  it("instructions 为空但开启规程时，仍然注入 system（只有规程）", async () => {
    const provider = new ScriptedProvider([() => [{ type: "text", delta: "ok" }, { type: "done" }]]);
    const seen: LLMMessage[][] = [];
    const agent = new Agent(baseConfig({ instructions: "", planning: { mode: "prompt" } }), {
      provider,
      tools: new ToolRegistry(),
      sessionStore: new InMemorySessionStore(),
      todos: new TodoStore(new InMemorySessionStore()),
    });
    provider.onChat = (opts) => seen.push(opts.messages.map((m) => ({ ...m })));
    await collect(agent, "hi");

    const system = seen[0]!.filter((m) => m.role === "system");
    expect(system).toHaveLength(1);
    expect(system[0]!.content).toContain(PLANNING_GUIDANCE);
  });

  it("多轮后 system 只有一条且内容字节稳定（prompt cache 不变量）", async () => {
    const provider = new ScriptedProvider([
      () => [{ type: "text", delta: "一" }, { type: "done" }],
      () => [{ type: "text", delta: "二" }, { type: "done" }],
      () => [{ type: "text", delta: "三" }, { type: "done" }],
    ]);
    const seen: LLMMessage[][] = [];
    const agent = new Agent(baseConfig({ planning: { mode: "prompt" } }), {
      provider,
      tools: new ToolRegistry(),
      sessionStore: new InMemorySessionStore(),
      todos: new TodoStore(new InMemorySessionStore()),
    });
    provider.onChat = (opts) => seen.push(opts.messages.map((m) => ({ ...m })));

    await collect(agent, "第一轮");
    await collect(agent, "第二轮");
    await collect(agent, "第三轮");

    const hashes = seen.map((msgs) => {
      const system = msgs.filter((m) => m.role === "system");
      expect(system).toHaveLength(1);
      return system[0]!.content;
    });
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toContain(PLANNING_GUIDANCE);
  });
});

describe("todo 计划工件（Agent 端到端）", () => {
  function makeAgentWithTodo(provider: ScriptedProvider) {
    const sessionStore = new InMemorySessionStore();
    const todos = new TodoStore(sessionStore);
    const registry = new ToolRegistry();
    registry.add(createTodoTool(todos));
    const agent = new Agent(baseConfig({ tools: [{ name: "todo", enabled: true }], planning: { mode: "prompt" } }), {
      provider,
      tools: registry,
      sessionStore,
      todos,
    });
    return { agent, sessionStore, todos };
  }

  it("模型写清单 → tool_result 正常 + 轮尾持久化到 session.meta.todos", async () => {
    const provider = new ScriptedProvider([
      () => [
        {
          type: "tool_call",
          id: "c1",
          name: "todo",
          input: { todos: [{ content: "读代码", status: "in_progress" }, { content: "写测试" }] },
        },
        { type: "usage", inputTokens: 5, outputTokens: 5 },
        { type: "done" },
      ],
      () => [{ type: "text", delta: "计划已写好" }, { type: "usage", inputTokens: 5, outputTokens: 5 }, { type: "done" }],
    ]);
    const { agent, sessionStore } = makeAgentWithTodo(provider);

    const chunks = await collect(agent, "帮我重构这个模块");
    const result = chunks.find((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>;
    expect(result.ok).toBe(true);

    const session = await sessionStore.getSession("t");
    const todos = (session?.meta as { todos?: { items: Array<{ content: string; status: string }>; revision: number } }).todos;
    expect(todos?.items.map((i) => i.content)).toEqual(["读代码", "写测试"]);
    expect(todos?.items[0]!.status).toBe("in_progress");
    expect(todos?.revision).toBe(1);
  });

  it("清单随会话恢复（新 Agent/新 Store 也能读到），且会话间隔离", async () => {
    const provider = new ScriptedProvider([
      () => [
        { type: "tool_call", id: "c1", name: "todo", input: { todos: [{ content: "A 会话的步骤" }] } },
        { type: "done" },
      ],
      () => [{ type: "text", delta: "ok" }, { type: "done" }],
      () => [
        { type: "tool_call", id: "c2", name: "todo", input: { todos: [{ content: "B 会话的步骤" }] } },
        { type: "done" },
      ],
      () => [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { agent, sessionStore } = makeAgentWithTodo(provider);
    await collect(agent, "会话 A", "sA");
    await collect(agent, "会话 B", "sB");

    // 模拟重启：新的 store / 新的 agent，同一 sessionStore
    const freshStore = new TodoStore(sessionStore);
    const freshRegistry = new ToolRegistry();
    freshRegistry.add(createTodoTool(freshStore));
    const freshAgent = new Agent(baseConfig({ tools: [{ name: "todo", enabled: true }] }), {
      provider,
      tools: freshRegistry,
      sessionStore,
      todos: freshStore,
    });

    const stateA = await freshStore.read("sA");
    const stateB = await freshStore.read("sB");
    expect(stateA.items[0]!.content).toBe("A 会话的步骤");
    expect(stateB.items[0]!.content).toBe("B 会话的步骤");
    expect(await freshAgent.todos.formatForInjection("sA")).toContain("A 会话的步骤");
  });

  it("未启用 todo 时，模型调用它会得到 ok:false 且对话继续", async () => {
    const provider = new ScriptedProvider([
      () => [{ type: "tool_call", id: "c1", name: "todo", input: { todos: [{ content: "x" }] } }, { type: "done" }],
      () => [{ type: "text", delta: "继续" }, { type: "done" }],
    ]);
    const agent = new Agent(baseConfig({ tools: [] }), {
      provider,
      tools: new ToolRegistry(), // 未注册 todo
      sessionStore: new InMemorySessionStore(),
      todos: new TodoStore(new InMemorySessionStore()),
    });
    const chunks = await collect(agent, "写计划");
    const result = chunks.find((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>;
    expect(result.ok).toBe(false);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(chunks.at(-1)?.type).toBe("done");
  });
});
