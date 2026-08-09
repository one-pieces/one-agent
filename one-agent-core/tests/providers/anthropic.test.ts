import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.ts";
import type { LLMMessage, ProviderConfig, StreamChunk } from "../../src/index.ts";
import { sseResponse } from "../helpers/sse.ts";

const config: ProviderConfig = {
  provider: "anthropic",
  modelId: "claude-test",
  apiKey: "sk-ant-test",
};
const messages: LLMMessage[] = [{ role: "user", content: "hi" }];

async function collect(provider: AnthropicProvider, cfg = config, msgs = messages): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of provider.chat({ messages: msgs, config: cfg })) out.push(c);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnthropicProvider", () => {
  it("流式输出 text + usage + done", async () => {
    const sse = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    const chunks = await collect(new AnthropicProvider());
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as Extract<StreamChunk, { type: "text" }>).delta).join("");
    expect(text).toBe("你好");

    const usage = chunks.find((c) => c.type === "usage") as Extract<StreamChunk, { type: "usage" }>;
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("请求头与请求体正确（system 拆出、tool_use 映射）", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      sseResponse([`event: message_stop\ndata: {"type":"message_stop"}\n\n`]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicProvider();
    await collect(provider, config, [
      { role: "system", content: "你是助手" },
      { role: "assistant", content: "我先搜一下", toolCalls: [{ id: "toolu_1", name: "web_search", input: { q: "x" } }] },
      { role: "tool", content: "结果", toolCallId: "toolu_1" },
      { role: "user", content: "hi" },
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse((init!.body ?? "") as string);
    expect(body.system).toBe("你是助手");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先搜一下" },
          { type: "tool_use", id: "toolu_1", name: "web_search", input: { q: "x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "结果" }],
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("tool_use 分片聚合成完整 tool_call 事件", async () => {
    const sse = [
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"web_search"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"x\\"}"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    const chunks = await collect(new AnthropicProvider());
    const tc = chunks.find((c) => c.type === "tool_call") as Extract<StreamChunk, { type: "tool_call" }>;
    expect(tc.name).toBe("web_search");
    expect(tc.id).toBe("toolu_1");
    expect(tc.input).toEqual({ q: "x" });
  });

  it("HTTP 错误 → error chunk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403 })));
    const chunks = await collect(new AnthropicProvider());
    expect(chunks[0]?.type).toBe("error");
    expect((chunks[0] as Extract<StreamChunk, { type: "error" }>).message).toContain("403");
  });

  it("缺少 apiKey → 抛 ProviderError", async () => {
    const provider = new AnthropicProvider();
    await expect(
      (async () => {
        for await (const _ of provider.chat({ messages, config: { provider: "anthropic", modelId: "m" } })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/apiKey/);
  });
});
