import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLANS_DIR } from "../../src/index.ts";
import { Agent, TodoStore, createTodoTool } from "../../src/index.ts";
import { InMemorySessionStore } from "../../src/session/index.ts";
import { ToolRegistry } from "../../src/tools/index.ts";
import { ScriptedProvider } from "../helpers/scripted-provider.ts";
import type { AgentConfig, LLMMessage, Message, StreamChunk } from "../../src/index.ts";

/**
 * P1-c 端到端：上下文压缩后，未完成的任务清单必须回到上下文（否则模型会忘进度、重做已完成的工作）。
 *
 * 触发条件提醒：compactMessages 要求待摘要消息 ≥3 条且保留最近 6 条（memory/index.ts），
 * 因此这里预置 12 条历史，让压缩真正发生。
 */

const LONG_HISTORY: Message[] = [
  { id: "h1", role: "user", content: "我们要重构 parser 模块的 token 化逻辑，先看现有实现再动手改，注意别破坏既有行为", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "h2", role: "assistant", content: "好的，我先通读 tokenize 函数与它的调用点，梳理清楚输入输出契约再决定怎么改", createdAt: "2026-01-01T00:00:01.000Z" },
  { id: "h3", role: "user", content: "顺便确认一下当前单元测试的覆盖情况，边界用例是否齐全，缺的部分要补上", createdAt: "2026-01-01T00:00:02.000Z" },
  { id: "h4", role: "assistant", content: "统计下来语句覆盖率约百分之六十二，边界用例明显偏少，尤其是空输入与超长输入", createdAt: "2026-01-01T00:00:03.000Z" },
  { id: "h5", role: "user", content: "那就先改 token 化逻辑本身，把状态机拆清楚，边界处理单独抽成小函数便于测试", createdAt: "2026-01-01T00:00:04.000Z" },
  { id: "h6", role: "assistant", content: "已经定位到 tokenize 函数，它现在同时负责切词和状态推进，确实是耦合过重", createdAt: "2026-01-01T00:00:05.000Z" },
  { id: "h7", role: "user", content: "继续推进，改完记得把所有受影响的下游调用点一起检查一遍，别留下隐式依赖", createdAt: "2026-01-01T00:00:06.000Z" },
  { id: "h8", role: "assistant", content: "正在改写，先把切词部分抽成独立函数，再让主流程只负责状态推进与错误处理", createdAt: "2026-01-01T00:00:07.000Z" },
  { id: "h9", role: "user", content: "注意保留原有的边界处理语义，尤其是遇到非法字符时的报错信息不能变", createdAt: "2026-01-01T00:00:08.000Z" },
  { id: "h10", role: "assistant", content: "明白，我会保留原有报错文案，并在改动处补上注释说明为什么要拆", createdAt: "2026-01-01T00:00:09.000Z" },
  { id: "h11", role: "user", content: "改完跑一遍完整测试，确认没有回归之后再说下一步的优化方向", createdAt: "2026-01-01T00:00:10.000Z" },
  { id: "h12", role: "assistant", content: "好的，跑完测试我会汇报结果与剩余风险点，方便你决定要不要继续", createdAt: "2026-01-01T00:00:11.000Z" },
];

function baseConfig(): AgentConfig {
  return {
    id: "todo-injection",
    name: "压缩注入测试",
    instructions: "你是测试助手。",
    model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1" },
    tools: [{ name: "todo", enabled: true }],
    // 极低阈值 → 每次迭代都尝试压缩（真实场景是接近窗口上限时触发）
    memory: { strategy: "compaction", thresholdPercent: 0.001, contextWindowTokens: 1 },
    maxIterations: 3,
  };
}

async function makeAgent(script: Array<() => StreamChunk[]>) {
  const sessionStore = new InMemorySessionStore();
  const todos = new TodoStore(sessionStore);
  const registry = new ToolRegistry();
  registry.add(createTodoTool(todos));
  const provider = new ScriptedProvider(script);
  const agent = new Agent(baseConfig(), { provider, tools: registry, sessionStore, todos });
  await sessionStore.saveSession({
    id: "s1",
    agentId: "todo-injection",
    messages: LONG_HISTORY.map((m) => ({ ...m })),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:11.000Z",
    meta: {
      todos: {
        items: [
          { id: "t1", content: "改写 tokenize 函数", status: "in_progress" },
          { id: "t2", content: "补边界测试", status: "pending" },
          { id: "t3", content: "读现有实现", status: "completed" },
        ],
        revision: 2,
        updatedAt: "2026-01-01T00:00:11.000Z",
      },
    },
  });
  return { agent, provider, sessionStore, todos };
}

async function runTurn(agent: Agent, cwd?: string): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of agent.run("继续推进", cwd ? { sessionId: "s1", cwd } : { sessionId: "s1" })) out.push(c);
  return out;
}

describe("压缩后重新注入任务清单（P1-c）", () => {
  it("压缩后注入合成 user 消息：只含未完成项，已完成项不出现", async () => {
    const seen: LLMMessage[][] = [];
    const { agent, provider } = await makeAgent([
      // 第 1 次调用 = 压缩摘要（compactMessages 内部调用）
      () => [{ type: "text", delta: "用户在重构 parser 模块。" }, { type: "done" }],
      // 第 2 次调用 = 真正的对话轮
      () => [{ type: "text", delta: "继续处理" }, { type: "usage", inputTokens: 5, outputTokens: 5 }, { type: "done" }],
    ]);
    provider.onChat = (opts) => seen.push(opts.messages.map((m) => ({ ...m })));

    await runTurn(agent);

    // 最后一次真实对话调用应当看到：压缩摘要 + 注入的清单
    const finalCall = seen[seen.length - 1]!;
    const snapshot = finalCall.filter((m) => m.synthetic === "contextSnapshot");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.role).toBe("user"); // 必须是 user（改 system 会破 prompt cache 前缀）
    expect(snapshot[0]!.content).toContain("改写 tokenize 函数");
    expect(snapshot[0]!.content).toContain("补边界测试");
    expect(snapshot[0]!.content).not.toContain("读现有实现"); // 已完成项不注入
    // 压缩确实发生了
    expect(finalCall.some((m) => m.content.includes("[历史对话摘要]"))).toBe(true);
    // system 仍然只有一条（缓存不变量）
    expect(finalCall.filter((m) => m.role === "system" && !m.content.includes("[历史对话摘要]"))).toHaveLength(1);
  });

  it("注入消息会随会话持久化（带合成标记），且 UI 侧可据此隐藏", async () => {
    const { agent, sessionStore } = await makeAgent([
      () => [{ type: "text", delta: "摘要" }, { type: "done" }],
      () => [{ type: "text", delta: "继续" }, { type: "done" }],
    ]);
    await runTurn(agent);

    const session = await sessionStore.getSession("s1");
    const injected = session!.messages.filter((m) => m.synthetic === "contextSnapshot");
    expect(injected).toHaveLength(1);
    expect(injected[0]!.content).toContain("改写 tokenize 函数");
  });

  it("无未完成项 → 不注入（全部完成时清单不再回到上下文）", async () => {
    const seen: LLMMessage[][] = [];
    const { agent, provider, sessionStore } = await makeAgent([
      () => [{ type: "text", delta: "摘要" }, { type: "done" }],
      () => [{ type: "text", delta: "继续" }, { type: "done" }],
    ]);
    // 全部标记完成
    const session = await sessionStore.getSession("s1");
    (session!.meta as { todos: { items: Array<{ status: string }> } }).todos.items.forEach((i) => (i.status = "completed"));
    await sessionStore.saveSession(session!);
    provider.onChat = (opts) => seen.push(opts.messages.map((m) => ({ ...m })));

    await runTurn(agent);

    const finalCall = seen[seen.length - 1]!;
    expect(finalCall.filter((m) => m.synthetic === "contextSnapshot")).toHaveLength(0);
  });

  it("多次压缩不堆积重复快照（幂等：旧快照先移除再追加）", async () => {
    const seen: LLMMessage[][] = [];
    const { agent, provider } = await makeAgent([
      () => [{ type: "text", delta: "摘要一" }, { type: "done" }],
      () => [{ type: "tool_call", id: "c1", name: "todo", input: { todos: [{ id: "t1", content: "改写 tokenize 函数", status: "completed" }, { id: "t2", content: "补边界测试", status: "in_progress" }], merge: true } }, { type: "done" }],
      () => [{ type: "text", delta: "摘要二" }, { type: "done" }],
      () => [{ type: "text", delta: "收尾" }, { type: "done" }],
    ]);
    provider.onChat = (opts) => seen.push(opts.messages.map((m) => ({ ...m })));

    await runTurn(agent);

    // 任何一次模型调用里，快照最多一条
    for (const call of seen) {
      expect(call.filter((m) => m.synthetic === "contextSnapshot").length).toBeLessThanOrEqual(1);
    }
    // 本轮最后一次调用看到的是**最新**清单（t1 已完成 → 不再出现）
    const finalCall = seen[seen.length - 1]!;
    const snapshot = finalCall.filter((m) => m.synthetic === "contextSnapshot");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.content).toContain("补边界测试");
    expect(snapshot[0]!.content).not.toContain("改写 tokenize 函数");
  });
});

describe("方案文档路径也进入压缩后快照（P1-d）", () => {
  it("工作区里有方案 → 注入内容含方案路径，提示不要再从零重写", async () => {
    const seen: LLMMessage[][] = [];
    const { agent, provider } = await makeAgent([
      () => [{ type: "text", delta: "摘要" }, { type: "done" }],
      () => [{ type: "text", delta: "继续" }, { type: "done" }],
    ]);
    provider.onChat = (opts) => seen.push(opts.messages.map((m) => ({ ...m })));

    const workspace = mkdtempSync(join(tmpdir(), "oa-plan-inject-"));
    try {
      await mkdir(join(workspace, PLANS_DIR), { recursive: true });
      await writeFile(join(workspace, PLANS_DIR, "2026-01-01_000000-方案.md"), "# 方案\n先改 A 再改 B", "utf-8");

      await runTurn(agent, workspace);

      const finalCall = seen[seen.length - 1]!;
      const snapshot = finalCall.filter((m) => m.synthetic === "contextSnapshot");
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]!.content).toContain("方案.md");
      expect(snapshot[0]!.content).toContain("[方案文档]");
      // 任务清单也在同一条快照里
      expect(snapshot[0]!.content).toContain("改写 tokenize 函数");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("没有方案且清单全部完成 → 不注入任何快照", async () => {
    const seen: LLMMessage[][] = [];
    const { agent, provider, sessionStore } = await makeAgent([
      () => [{ type: "text", delta: "摘要" }, { type: "done" }],
      () => [{ type: "text", delta: "继续" }, { type: "done" }],
    ]);
    const session = await sessionStore.getSession("s1");
    (session!.meta as { todos: { items: Array<{ status: string }> } }).todos.items.forEach((i) => (i.status = "completed"));
    await sessionStore.saveSession(session!);
    provider.onChat = (opts) => seen.push(opts.messages.map((m) => ({ ...m })));

    const workspace = mkdtempSync(join(tmpdir(), "oa-plan-empty-"));
    try {
      await runTurn(agent, workspace);
      expect(seen[seen.length - 1]!.filter((m) => m.synthetic)).toHaveLength(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
