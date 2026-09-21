import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessKernel } from "../lib/kernel";
import type { AgentConfig, ChatOptions, LanguageProvider, StreamChunk } from "@one-agent/core";

/** 记录每次模型调用参数的 Mock Provider；可选先发一个危险工具调用 */
class RecordingProvider implements LanguageProvider {
  readonly kind = "openai-compatible" as const;
  calls: ChatOptions[] = [];
  private emitToolCall: boolean;

  constructor(emitToolCall = false) {
    this.emitToolCall = emitToolCall;
  }

  async *chat(opts: ChatOptions): AsyncIterable<StreamChunk> {
    this.calls.push(opts);
    if (this.emitToolCall) {
      yield { type: "tool_call", id: "c1", name: "bash", input: { command: "echo hi" } };
    }
    yield { type: "text", delta: "ok" };
    yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    yield { type: "done" };
  }
}

const agentConfig: AgentConfig = {
  id: "test-agent",
  name: "测试",
  instructions: "测试指令",
  model: {
    provider: "openai-compatible",
    baseUrl: "http://localhost:1/v1",
    modelId: "default-model",
    apiKey: "x",
    temperature: 0.5,
  },
  tools: [{ name: "calculator", enabled: true }],
  maxIterations: 2,
};

const tempDirs: string[] = [];

function makeKernel(emitToolCall = false) {
  const dir = mkdtempSync(join(tmpdir(), "one-agent-kernel-"));
  tempDirs.push(dir);
  const provider = new RecordingProvider(emitToolCall);
  const kernel = new InProcessKernel(join(dir, "sessions.db"), {
    providerFactory: () => provider,
  });
  return { kernel, provider };
}

async function drain(iter: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _ of iter) {
    /* drain */
  }
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("InProcessKernel 会话覆盖（M4）", () => {
  it("会话 meta 的 modelOverride 每轮自动生效", async () => {
    const { kernel, provider } = makeKernel();
    const session = kernel.createSession("test-agent");
    await kernel.updateSessionOverrides(session.id, {
      modelOverride: { modelId: "session-model", temperature: 0.9 },
    });

    await drain(kernel.runChat({ agentConfig, sessionId: session.id, message: "hi" }));

    const call = provider.calls[0]!;
    expect(call.config.modelId).toBe("session-model");
    expect(call.config.temperature).toBe(0.9);
  });

  it("请求级 override 优先于会话 meta", async () => {
    const { kernel, provider } = makeKernel();
    const session = kernel.createSession("test-agent");
    await kernel.updateSessionOverrides(session.id, { modelOverride: { modelId: "meta-model" } });

    await drain(
      kernel.runChat({
        agentConfig,
        sessionId: session.id,
        message: "hi",
        modelOverride: { modelId: "request-model" },
      }),
    );

    expect(provider.calls[0]!.config.modelId).toBe("request-model");
  });

  it("会话 meta 的 toolOverrides 生效（禁用 calculator）", async () => {
    const { kernel, provider } = makeKernel();
    const session = kernel.createSession("test-agent");
    await kernel.updateSessionOverrides(session.id, {
      toolOverrides: [{ name: "calculator", enabled: false }],
    });

    await drain(kernel.runChat({ agentConfig, sessionId: session.id, message: "hi" }));

    // Agent 配置里 calculator 是启用的，但会话覆盖禁用了它
    expect(provider.calls[0]!.tools).toEqual([]);
  });

  it("两个会话互不干扰（模型隔离）", async () => {
    const { kernel, provider } = makeKernel();
    const sA = kernel.createSession("test-agent");
    const sB = kernel.createSession("test-agent");
    await kernel.updateSessionOverrides(sA.id, { modelOverride: { modelId: "model-A" } });
    await kernel.updateSessionOverrides(sB.id, { modelOverride: { modelId: "model-B" } });

    await drain(kernel.runChat({ agentConfig, sessionId: sA.id, message: "a" }));
    await drain(kernel.runChat({ agentConfig, sessionId: sB.id, message: "b" }));

    expect(provider.calls[0]!.config.modelId).toBe("model-A");
    expect(provider.calls[1]!.config.modelId).toBe("model-B");
  });

  it("updateSessionOverrides 传 null 清除覆盖，回落 Agent 默认", async () => {
    const { kernel, provider } = makeKernel();
    const session = kernel.createSession("test-agent");
    await kernel.updateSessionOverrides(session.id, { modelOverride: { modelId: "override" } });
    await kernel.updateSessionOverrides(session.id, { modelOverride: null });

    await drain(kernel.runChat({ agentConfig, sessionId: session.id, message: "hi" }));
    expect(provider.calls[0]!.config.modelId).toBe("default-model");
  });

  it("onApproval 拒绝 → 危险工具不执行", async () => {
    const { kernel, provider } = makeKernel(true);
    const dangerousConfig: AgentConfig = {
      ...agentConfig,
      tools: [{ name: "bash", enabled: true }],
    };
    const session = kernel.createSession("test-agent");
    const chunks: StreamChunk[] = [];
    for await (const c of kernel.runChat({
      agentConfig: dangerousConfig,
      sessionId: session.id,
      message: "执行命令",
      onApproval: () => false,
    })) {
      chunks.push(c);
    }
    const tr = chunks.find((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>;
    expect(tr.ok).toBe(false);
    expect(String(tr.output)).toContain("已拒绝");
  });

  it("onApproval 放行 → 危险工具执行（沙箱内 echo）", async () => {
    const { kernel, provider } = makeKernel(true);
    const dangerousConfig: AgentConfig = {
      ...agentConfig,
      tools: [{ name: "bash", enabled: true }],
    };
    const session = kernel.createSession("test-agent");
    const chunks: StreamChunk[] = [];
    for await (const c of kernel.runChat({
      agentConfig: dangerousConfig,
      sessionId: session.id,
      message: "执行命令",
      onApproval: () => true,
    })) {
      chunks.push(c);
    }
    const tr = chunks.find((c) => c.type === "tool_result") as Extract<StreamChunk, { type: "tool_result" }>;
    expect(tr.ok).toBe(true);
    expect((tr.output as { stdout: string }).stdout.trim()).toBe("hi");
  });

  it("deleteSession 同时清理会话工作区文件", async () => {
    const { kernel } = makeKernel();
    const session = kernel.createSession("test-agent");
    // 模拟 agent 在工作区产出的文件
    const ws = kernel.sessionWorkspacePath(session.id);
    await mkdir(join(ws, "sub"), { recursive: true });
    await writeFile(join(ws, "sub", "report.md"), "内容", "utf-8");
    expect(existsSync(join(ws, "sub", "report.md"))).toBe(true);

    await kernel.deleteSession(session.id);

    expect(await kernel.getSession(session.id)).toBeNull();
    expect(existsSync(ws)).toBe(false);
  });

  it("sessionWorkspacePath 拒绝路径穿越的 sessionId", () => {
    const { kernel } = makeKernel();
    expect(() => kernel.sessionWorkspacePath("..")).toThrow();
    expect(() => kernel.sessionWorkspacePath("../../etc")).toThrow();
    expect(kernel.sessionWorkspacePath("session-abc")).toBe(join(kernel.workspaceRoot, "session-abc"));
  });
});

/** 发一个 todo 工具调用的 Provider（验证计划工件端到端落库） */
class TodoCallingProvider implements LanguageProvider {
  readonly kind = "openai-compatible" as const;
  calls: ChatOptions[] = [];
  async *chat(opts: ChatOptions): AsyncIterable<StreamChunk> {
    this.calls.push(opts);
    if (this.calls.length === 1) {
      yield {
        type: "tool_call",
        id: "t1",
        name: "todo",
        input: { todos: [{ content: "第一步", status: "in_progress" }, { content: "第二步" }] },
      };
    }
    yield { type: "text", delta: "ok" };
    yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    yield { type: "done" };
  }
}

describe("规划规程与 todo 计划工件（P1）", () => {
  function makePlanningKernel(provider: LanguageProvider) {
    const dir = mkdtempSync(join(tmpdir(), "one-agent-planning-"));
    tempDirs.push(dir);
    const kernel = new InProcessKernel(join(dir, "sessions.db"), { providerFactory: () => provider });
    return { kernel, provider };
  }

  it("planning.mode=prompt → system 注入规程 + 自动启用 todo 计划工件", async () => {
    const provider = new RecordingProvider();
    const { kernel } = makePlanningKernel(provider);
    const session = kernel.createSession("test-agent");

    await drain(
      kernel.runChat({
        agentConfig: { ...agentConfig, planning: { mode: "prompt" } },
        sessionId: session.id,
        message: "帮我规划一个多步任务",
      }),
    );

    const call = provider.calls[0]!;
    const system = call.messages.filter((m) => m.role === "system");
    expect(system).toHaveLength(1);
    expect(system[0]!.content).toContain("规划规程");
    // kernel 自动把 todo 加进 config.tools（否则规程会指导模型调用一个不存在的工具）
    expect(call.tools?.map((t) => t.name)).toContain("todo");
  });

  it("todo 条目存在但被禁用 → planning=prompt 仍会启用它（判据是「已启用」）", async () => {
    const provider = new RecordingProvider();
    const { kernel } = makePlanningKernel(provider);
    const session = kernel.createSession("test-agent");

    await drain(
      kernel.runChat({
        agentConfig: {
          ...agentConfig,
          tools: [{ name: "todo", enabled: false }],
          planning: { mode: "prompt" },
        },
        sessionId: session.id,
        message: "hi",
      }),
    );

    expect(provider.calls[0]!.tools?.map((t) => t.name)).toContain("todo");
  });

  it("planning.mode=off（缺省）→ 不加规程，也不自动启用 todo", async () => {
    const provider = new RecordingProvider();
    const { kernel } = makePlanningKernel(provider);
    const session = kernel.createSession("test-agent");

    await drain(kernel.runChat({ agentConfig, sessionId: session.id, message: "hi" }));

    const call = provider.calls[0]!;
    expect(call.messages.find((m) => m.role === "system")?.content).toBe("测试指令");
    expect(call.tools?.map((t) => t.name)).not.toContain("todo");
  });

  it("todo 写入 → 落进 session.meta.todos（工具与 kernel 共用同一 TodoStore）", async () => {
    const provider = new TodoCallingProvider();
    const { kernel } = makePlanningKernel(provider);
    const session = kernel.createSession("test-agent");

    await drain(
      kernel.runChat({
        agentConfig: { ...agentConfig, planning: { mode: "prompt" } },
        sessionId: session.id,
        message: "写个计划",
      }),
    );

    const stored = await kernel.getSession(session.id);
    const todos = (stored?.meta as { todos?: { items: Array<{ content: string; status: string }> } }).todos;
    expect(todos?.items.map((i) => i.content)).toEqual(["第一步", "第二步"]);
    expect(todos?.items[0]!.status).toBe("in_progress");
    // 压缩后注入用的渲染也来自同一份状态
    expect(await kernel.todos.formatForInjection(session.id)).toContain("第一步");
  });
});
