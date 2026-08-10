import { createParser } from "eventsource-parser";
import type { ChatOptions, LanguageProvider } from "./types.ts";
import { ProviderError } from "./types.ts";
import type { LLMMessage, StreamChunk, ToolSpec } from "../types.ts";
import { safeParseJSON, trimTrailingSlash } from "../utils.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** 工具参数分片累加器（OpenAI 的 tool_calls 参数会跨多个 chunk 分片下发） */
interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

function toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: m.role };
  if (m.role === "assistant") {
    base.content = m.content || null;
    if (m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input ?? {}),
        },
      }));
    }
  } else if (m.role === "tool") {
    base.tool_call_id = m.toolCallId ?? "";
    base.content = m.content;
  } else {
    base.content = m.content;
  }
  return base;
}

function toOpenAITool(t: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  };
}

/**
 * OpenAI 兼容端点 Provider：DeepSeek / Ollama / LM Studio / vLLM / OpenAI ...
 * 基于原生 fetch + eventsource-parser，无任何框架依赖。
 */
export class OpenAICompatibleProvider implements LanguageProvider {
  readonly kind = "openai-compatible" as const;
  private fetchImpl: typeof fetch;

  constructor(opts?: { fetch?: typeof fetch }) {
    this.fetchImpl = opts?.fetch ?? fetch;
  }

  async *chat(opts: ChatOptions): AsyncIterable<StreamChunk> {
    const { config, messages, tools, signal } = opts;
    if (!config.modelId) throw new ProviderError("OpenAICompatibleProvider: modelId is required");

    const baseUrl = trimTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
    const apiKey = config.apiKey ?? "not-needed";

    const body: Record<string, unknown> = {
      model: config.modelId,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens;
    if (tools && tools.length > 0) body.tools = tools.map(toOpenAITool);

    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          ...config.extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      yield { type: "error", message: `openai-compatible request failed: ${errMsg(err)}` };
      return;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield {
        type: "error",
        message: `openai-compatible HTTP ${res.status}: ${text.slice(0, 500)}`,
      };
      return;
    }

    const decoder = new TextDecoder();
    let queue: StreamChunk[] = [];
    const toolAcc = new Map<number, ToolCallAcc>();
    let usage: { input?: number; output?: number; cached?: number } = {};

    const parser = createParser({
      onEvent(event) {
        if (event.data === "[DONE]") return;
        let json: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
        };
        try {
          json = JSON.parse(event.data);
        } catch {
          return;
        }
        const choice = json.choices?.[0];
        const delta = choice?.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          queue.push({ type: "text", delta: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
            if (typeof tc.id === "string") acc.id = tc.id;
            if (typeof tc.function?.name === "string") acc.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
            toolAcc.set(idx, acc);
          }
        }
        if (json.usage) {
          usage.input = json.usage.prompt_tokens;
          usage.output = json.usage.completion_tokens;
          usage.cached = json.usage.prompt_tokens_details?.cached_tokens;
        }
      },
    });

    try {
      for await (const raw of res.body) {
        const text = decoder.decode(raw, { stream: true });
        queue = [];
        parser.feed(text);
        yield* queue;
      }
      const tail = decoder.decode();
      if (tail) {
        queue = [];
        parser.feed(tail);
        yield* queue;
      }
    } catch (err) {
      if (signal?.aborted) return; // 主动取消：静默结束
      yield { type: "error", message: `openai-compatible stream error: ${errMsg(err)}` };
      return;
    }

    // 聚合后的完整工具调用（在流结束后发出，符合 contracts/stream-protocol.md）
    for (const acc of toolAcc.values()) {
      yield { type: "tool_call", id: acc.id, name: acc.name, input: safeParseJSON(acc.args) };
    }
    yield {
      type: "usage",
      inputTokens: usage.input ?? 0,
      outputTokens: usage.output ?? 0,
      cachedTokens: usage.cached,
    };
    yield { type: "done" };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
