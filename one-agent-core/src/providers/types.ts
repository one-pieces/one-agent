import type { LLMMessage, ProviderConfig, StreamChunk, ToolSpec } from "../types.js";

/** chat 调用参数：messages / tools / config 每次都传入 → 支持运行时动态配置 */
export interface ChatOptions {
  messages: LLMMessage[];
  tools?: ToolSpec[];
  config: ProviderConfig;
  signal?: AbortSignal;
}

/**
 * LanguageProvider 统一接口。
 * 实现：OpenAICompatibleProvider（OpenAI 兼容端点）、AnthropicProvider（原生 API）。
 */
export interface LanguageProvider {
  readonly kind: ProviderConfig["provider"];
  chat(opts: ChatOptions): AsyncIterable<StreamChunk>;
}

/** 配置/编程错误（调用前可发现）；HTTP/网络错误走 error chunk */
export class ProviderError extends Error {
  readonly status?: number;
  constructor(message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.status = opts?.status;
  }
}
