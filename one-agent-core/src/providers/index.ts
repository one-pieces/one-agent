import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";
import type { LanguageProvider } from "./types.js";
import type { ProviderConfig } from "../types.js";

export type { LanguageProvider, ChatOptions } from "./types.js";
export { ProviderError } from "./types.js";
export { OpenAICompatibleProvider } from "./openai-compatible.js";
export { AnthropicProvider } from "./anthropic.js";

/** 按 provider 类型创建实例（config 每次 chat 调用传入，实例本身无状态） */
export function createProvider(kind: ProviderConfig["provider"]): LanguageProvider {
  switch (kind) {
    case "openai-compatible":
      return new OpenAICompatibleProvider();
    case "anthropic":
      return new AnthropicProvider();
    default: {
      const never: never = kind as never;
      throw new Error(`unknown provider: ${String(never)}`);
    }
  }
}
