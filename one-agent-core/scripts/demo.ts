/**
 * M0 演示脚本：真实流式调用 LLM。
 * 默认连本机 Ollama（无需 key）；可用环境变量切换（见 .env.example）。
 * 用法：npm run demo  或  node scripts/demo.ts
 */
import { createProvider } from "../src/index.js";
import type { LLMMessage, ProviderConfig } from "../src/index.js";

function env(key: string): string | undefined {
  return process.env[key];
}

const providerKind = (env("DEMO_PROVIDER") ?? "openai-compatible") as ProviderConfig["provider"];
const message = env("DEMO_MESSAGE") ?? "用一句话介绍你自己";

const config: ProviderConfig =
  providerKind === "anthropic"
    ? {
        provider: "anthropic",
        modelId: env("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5",
        apiKey: env("ANTHROPIC_API_KEY"),
        temperature: 0.7,
      }
    : {
        provider: "openai-compatible",
        baseUrl: env("OPENAI_BASE_URL") ?? "http://localhost:11434/v1",
        modelId: env("OPENAI_MODEL") ?? "qwen2.5-7b-64k",
        apiKey: env("OPENAI_API_KEY") ?? "not-needed",
        temperature: 0.7,
      };

const messages: LLMMessage[] = [
  { role: "system", content: "你是一个简洁的中文助手。" },
  { role: "user", content: message },
];

const provider = createProvider(providerKind);
console.log(`[demo] provider=${providerKind} model=${config.modelId} baseUrl=${config.baseUrl ?? "(default)"}`);
console.log(`[demo] 输入: ${message}\n`);

let text = "";
for await (const chunk of provider.chat({ messages, config })) {
  switch (chunk.type) {
    case "text":
      text += chunk.delta;
      process.stdout.write(chunk.delta);
      break;
    case "tool_call":
      console.log(`\n[tool_call] ${chunk.name} ${JSON.stringify(chunk.input)}`);
      break;
    case "usage":
      console.log(`\n[usage] inputTokens=${chunk.inputTokens} outputTokens=${chunk.outputTokens}`);
      break;
    case "error":
      console.error(`\n[error] ${chunk.message}`);
      process.exit(1);
      break;
    case "tool_result":
      break;
    case "done":
      break;
  }
}
console.log(`\n[done] 总字符数=${text.length}`);
