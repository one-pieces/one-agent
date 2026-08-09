import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { LanguageProvider } from "./types.ts";
import type { ProviderConfig } from "../types.ts";

export type { LanguageProvider, ChatOptions } from "./types.ts";
export { ProviderError } from "./types.ts";
export { OpenAICompatibleProvider } from "./openai-compatible.ts";
export { AnthropicProvider } from "./anthropic.ts";

export interface ProviderFactoryOptions {
  /** 注入自定义 fetch（可观测性/日志/代理）。缺省用全局 fetch。 */
  fetch?: typeof fetch;
}

/** 按 provider 类型创建实例（config 每次 chat 调用传入，实例本身无状态） */
export function createProvider(kind: ProviderConfig["provider"], opts?: ProviderFactoryOptions): LanguageProvider {
  switch (kind) {
    case "openai-compatible":
      return new OpenAICompatibleProvider(opts);
    case "anthropic":
      return new AnthropicProvider(opts);
    default: {
      const never: never = kind as never;
      throw new Error(`unknown provider: ${String(never)}`);
    }
  }
}
