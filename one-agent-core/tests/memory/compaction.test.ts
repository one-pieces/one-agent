import { describe, it, expect } from "vitest";
import { compactMessages, dropSyntheticMessages, estimateTokens } from "../../src/memory/index.ts";
import type { ProviderConfig } from "../../src/index.ts";
import { ScriptedProvider } from "../helpers/scripted-provider.ts";
import type { LLMMessage } from "../../src/index.ts";

const modelConfig: ProviderConfig = {
  provider: "openai-compatible",
  modelId: "mock",
  baseUrl: "http://localhost:1/v1",
  apiKey: "x",
};

describe("estimateTokens", () => {
  it("中文按 1 token/字、英文按 1 token/4 字符估算", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("hello world")).toBe(3); // 11 字符 → ceil(11/4)=3
    expect(estimateTokens("")).toBe(0);
  });
});

describe("compactMessages", () => {
  const history: LLMMessage[] = [
    { role: "system", content: "指令" },
    { role: "user", content: "问题1" },
    { role: "assistant", content: "回答1" },
    { role: "user", content: "问题2" },
    { role: "assistant", content: "回答2" },
    { role: "user", content: "问题3" },
    { role: "assistant", content: "回答3" },
    { role: "user", content: "问题4" },
    { role: "assistant", content: "回答4" },
  ];

  it("压缩中间历史，保留 system + 最近 keepRecent 条", async () => {
    const provider = new ScriptedProvider([
      () => [{ type: "text", delta: "用户问了四个问题，助手都做了回答。" }, { type: "done" }],
    ]);
    const messages = history.map((m) => ({ ...m }));
    const ok = await compactMessages({ provider, modelConfig, messages, keepRecent: 2 });

    expect(ok).toBe(true);
    expect(provider.calls).toBe(1);
    // 结构：system 指令 + 摘要 + 最近 2 条
    expect(messages.filter((m) => m.role === "system").length).toBe(2);
    expect(messages.some((m) => m.content.includes("[历史对话摘要]"))).toBe(true);
    expect(messages.at(-1)?.content).toBe("回答4");
    expect(messages.at(-2)?.content).toBe("问题4");
    // 中间内容被压缩掉
    expect(messages.some((m) => m.content === "问题1")).toBe(false);
  });

  it("历史太短不压缩（不调用模型）", async () => {
    const provider = new ScriptedProvider([
      () => [{ type: "text", delta: "摘要" }, { type: "done" }],
    ]);
    const messages: LLMMessage[] = [
      { role: "system", content: "指令" },
      { role: "user", content: "问题" },
      { role: "assistant", content: "回答" },
    ];
    const ok = await compactMessages({ provider, modelConfig, messages, keepRecent: 6 });
    expect(ok).toBe(false);
    expect(provider.calls).toBe(0);
  });

  it("摘要调用失败（error chunk）→ 返回 false 且不修改消息", async () => {
    const provider = new ScriptedProvider([() => [{ type: "error", message: "HTTP 500" }]]);
    const messages = history.map((m) => ({ ...m }));
    const snapshot = JSON.stringify(messages);
    const ok = await compactMessages({ provider, modelConfig, messages, keepRecent: 2 });
    expect(ok).toBe(false);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

describe("合成消息（todo 快照）与压缩的交互（P1-c）", () => {
  const withSynthetic: LLMMessage[] = [
    { role: "system", content: "指令" },
    { role: "user", content: "问题1" },
    { role: "assistant", content: "回答1" },
    { role: "user", content: "[你的任务清单在上下文压缩后被保留]\n[>] 步骤一", synthetic: "contextSnapshot" },
    { role: "user", content: "问题2" },
    { role: "assistant", content: "回答2" },
    { role: "user", content: "问题3" },
    { role: "assistant", content: "回答3" },
    { role: "user", content: "问题4" },
    { role: "assistant", content: "回答4" },
  ];

  it("旧快照不参与摘要，且压缩后被丢弃（由 AgentLoop 重新注入最新清单）", async () => {
    const seen: LLMMessage[][] = [];
    const provider = new ScriptedProvider([() => [{ type: "text", delta: "摘要内容" }, { type: "done" }]], (opts) =>
      seen.push(opts.messages.map((m) => ({ ...m }))),
    );
    const messages = withSynthetic.map((m) => ({ ...m }));
    const ok = await compactMessages({ provider, modelConfig, messages, keepRecent: 2 });

    expect(ok).toBe(true);
    // 摘要输入里没有合成消息
    expect(seen[0]!.some((m) => m.synthetic)).toBe(false);
    // 压缩后数组里也没有残留合成消息
    expect(messages.some((m) => m.synthetic)).toBe(false);
    expect(messages.at(-1)!.content).toBe("回答4");
  });

  it("摘要失败 → 消息数组完全不变（含合成消息）", async () => {
    const provider = new ScriptedProvider([() => [{ type: "error", message: "HTTP 500" }]]);
    const messages = withSynthetic.map((m) => ({ ...m }));
    const snapshot = JSON.stringify(messages);
    const ok = await compactMessages({ provider, modelConfig, messages, keepRecent: 2 });
    expect(ok).toBe(false);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("dropSyntheticMessages 从指定下标起移除合成消息并返回条数", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "摘要" },
      { role: "user", content: "a" },
      { role: "user", content: "snap", synthetic: "contextSnapshot" },
      { role: "assistant", content: "b" },
    ];
    expect(dropSyntheticMessages(messages, 1)).toBe(1);
    expect(messages.map((m) => m.content)).toEqual(["摘要", "a", "b"]);
  });
});
