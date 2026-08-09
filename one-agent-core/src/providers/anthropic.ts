import { createParser } from "eventsource-parser";
import type { ChatOptions, LanguageProvider } from "./types.ts";
import { ProviderError } from "./types.ts";
import type { LLMMessage, StreamChunk, ToolSpec } from "../types.ts";
import { safeParseJSON, trimTrailingSlash } from "../utils.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/** tool_use 块累加器（Anthropic 的 input_json 以 partial_json 分片下发） */
interface ToolUseAcc {
  id: string;
  name: string;
  args: string;
}

function toAnthropicMessage(m: LLMMessage): Record<string, unknown> {
  if (m.role === "assistant") {
    const parts: Record<string, unknown>[] = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const tc of m.toolCalls ?? []) {
      parts.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input ?? {} });
    }
    return { role: "assistant", content: parts };
  }
  if (m.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }],
    };
  }
  return { role: m.role, content: [{ type: "text", text: m.content }] };
}

function toAnthropicTool(t: ToolSpec): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  };
}

/**
 * Anthropic 原生 API Provider（/v1/messages，stream）。
 */
export class AnthropicProvider implements LanguageProvider {
  readonly kind = "anthropic" as const;
  private fetchImpl: typeof fetch;

  constructor(opts?: { fetch?: typeof fetch }) {
    this.fetchImpl = opts?.fetch ?? fetch;
  }

  async *chat(opts: ChatOptions): AsyncIterable<StreamChunk> {
    const { config, messages, tools, signal } = opts;
    if (!config.modelId) throw new ProviderError("AnthropicProvider: modelId is required");
    if (!config.apiKey) throw new ProviderError("AnthropicProvider: apiKey is required");

    const baseUrl = trimTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const body: Record<string, unknown> = {
      model: config.modelId,
      max_tokens: config.maxTokens ?? 4096,
      messages: messages.filter((m) => m.role !== "system").map(toAnthropicMessage),
      stream: true,
    };
    if (system) body.system = system;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (tools && tools.length > 0) body.tools = tools.map(toAnthropicTool);

    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          ...config.extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      yield { type: "error", message: `anthropic request failed: ${errMsg(err)}` };
      return;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield { type: "error", message: `anthropic HTTP ${res.status}: ${text.slice(0, 500)}` };
      return;
    }

    const decoder = new TextDecoder();
    let queue: StreamChunk[] = [];
    const toolAcc = new Map<number, ToolUseAcc>();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const parser = createParser({
      onEvent(event) {
        let json: {
          type?: string;
          index?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: { usage?: { input_tokens?: number } };
          content_block?: { type?: string; text?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        };
        try {
          json = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (json.type) {
          case "message_start":
            inputTokens = json.message?.usage?.input_tokens;
            break;
          case "content_block_start": {
            const block = json.content_block ?? {};
            const idx = json.index ?? 0;
            if (block.type === "text") {
              if (block.text) queue.push({ type: "text", delta: block.text });
            } else if (block.type === "tool_use") {
              toolAcc.set(idx, { id: block.id ?? "", name: block.name ?? "", args: "" });
            }
            break;
          }
          case "content_block_delta": {
            const delta = json.delta ?? {};
            const idx = json.index ?? 0;
            if (delta.type === "text_delta" && delta.text) {
              queue.push({ type: "text", delta: delta.text });
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const acc = toolAcc.get(idx);
              if (acc) acc.args += delta.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const acc = toolAcc.get(json.index ?? 0);
            if (acc) {
              toolAcc.delete(json.index ?? 0);
              queue.push({ type: "tool_call", id: acc.id, name: acc.name, input: safeParseJSON(acc.args) });
            }
            break;
          }
          case "message_delta":
            outputTokens = json.usage?.output_tokens;
            break;
          default:
            break;
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
      if (signal?.aborted) return;
      yield { type: "error", message: `anthropic stream error: ${errMsg(err)}` };
      return;
    }

    yield { type: "usage", inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
    yield { type: "done" };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
