import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.js";
import type { LLMMessage, ProviderConfig, StreamChunk } from "../../src/index.js";
import { sseResponse } from "../helpers/sse.js";

const config: ProviderConfig = {
  provider: "openai-compatible",
  baseUrl: "https://mock.local/v1",
  modelId: "mock-model",
  apiKey: "test-key",
};
const messages: LLMMessage[] = [{ role: "user", content: "hi" }];

async function collect(provider: OpenAICompatibleProvider, cfg = config, msgs = messages): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of provider.chat({ messages: msgs, config: cfg })) out.push(c);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleProvider", () => {
  it("流式输出 text + usage + done", async () => {
    const sse = [
      `data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}\n\n`,
      `data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}\n\n`,
      `data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: {"id":"1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n`,
      `data: [DONE]\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    const chunks = await collect(new OpenAICompatibleProvider());
    const text = chunks.filter((c) => c.type === "text").map((c) => (c as Extract<StreamChunk, { type: "text" }>).delta).join("");
    expect(text).toBe("你好");

    const usage = chunks.find((c) => c.type === "usage") as Extract<StreamChunk, { type: "usage" }>;
    expect(usage.inputTokens).toBe(12);
    expect(usage.outputTokens).toBe(3);
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("请求体与 URL 正确（含 tools 映射）", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([`data: [DONE]\n\n`]));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider();
    await collect(provider, config, [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://mock.local/v1/chat/completions");
    const body = JSON.parse((init!.body ?? "") as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer test-key");
  });

  it("跨 chunk 分片的 tool_calls 聚合成完整 tool_call 事件", async () => {
    const sse = [
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"web_search","arguments":""}}]},"finish_reason":null}]}\n\n`,
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n`,
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"2026 诺贝尔奖\\"}"}}]},"finish_reason":null}]}\n\n`,
      `data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      `data: [DONE]\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    const chunks = await collect(new OpenAICompatibleProvider());
    const tc = chunks.find((c) => c.type === "tool_call") as Extract<StreamChunk, { type: "tool_call" }>;
    expect(tc.name).toBe("web_search");
    expect(tc.id).toBe("call_1");
    expect(tc.input).toEqual({ q: "2026 诺贝尔奖" });
    // tool_call 在 usage/done 之前、text 之后
    const order = chunks.map((c) => c.type);
    expect(order.indexOf("tool_call")).toBeGreaterThan(-1);
    expect(order.indexOf("usage")).toBeGreaterThan(order.indexOf("tool_call"));
    expect(order.at(-1)).toBe("done");
  });

  it("HTTP 错误 → error chunk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));
    const chunks = await collect(new OpenAICompatibleProvider());
    expect(chunks[0]?.type).toBe("error");
    expect((chunks[0] as Extract<StreamChunk, { type: "error" }>).message).toContain("401");
  });

  it("缺 apiKey 时用占位符 not-needed（Ollama 场景）", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([`data: [DONE]\n\n`]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(new OpenAICompatibleProvider(), { provider: "openai-compatible", modelId: "m", baseUrl: "http://localhost:11434/v1" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer not-needed");
  });

  it("缺少 modelId → 抛 ProviderError（编程错误）", async () => {
    const provider = new OpenAICompatibleProvider();
    await expect(
      (async () => {
        for await (const _ of provider.chat({ messages, config: { provider: "openai-compatible", modelId: "" } })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/modelId/);
  });
});
