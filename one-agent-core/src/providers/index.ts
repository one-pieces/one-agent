import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { LanguageProvider } from "./types.ts";
import type { ProviderConfig } from "../types.ts";

export type { LanguageProvider, ChatOptions } from "./types.ts";
export { ProviderError } from "./types.ts";
export { OpenAICompatibleProvider } from "./openai-compatible.ts";
export { AnthropicProvider } from "./anthropic.ts";

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
