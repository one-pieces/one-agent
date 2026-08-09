/**
 * M1 交互式 CLI 对话：Agent + 内置工具 + 多轮工具调用（默认连本机 Ollama，免 key）。
 * 用法：npm run chat
 * 试试：算一下 (1234*5678)/2 是什么 / 列出当前目录 / 搜索 2026 诺贝尔物理学奖
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Agent, ToolRegistry, builtinTools } from "../src/index.js";

function env(key: string): string | undefined {
  return process.env[key];
}

const registry = new ToolRegistry();
for (const t of builtinTools) registry.add(t);

const agent = new Agent(
  {
    id: "demo",
    name: "one-agent 演示助手",
    instructions:
      "你是 one-agent 的演示助手。需要计算时调用 calculator；读取文件用 read_local_file；列目录用 list_local_dir；查实时资料用 web_search。使用工具时先简短说明意图，工具结果要简洁总结给用户。",
    model: {
      provider: "openai-compatible",
      baseUrl: env("OPENAI_BASE_URL") ?? "http://localhost:11434/v1",
      modelId: env("OPENAI_MODEL") ?? "qwen2.5-7b-64k",
      apiKey: env("OPENAI_API_KEY") ?? "not-needed",
      temperature: 0.5,
    },
    tools: [
      { name: "calculator", enabled: true },
      { name: "web_search", enabled: true },
      { name: "read_local_file", enabled: true },
      { name: "list_local_dir", enabled: true },
      { name: "write_local_file", enabled: false },
      { name: "run_local_command", enabled: false }, // 危险工具默认关闭
    ],
    maxIterations: 6,
  },
  { tools: registry },
);

const rl = createInterface({ input, output });

console.log(`[chat] 模型: ${agent.getConfig().model.modelId} @ ${agent.getConfig().model.baseUrl}`);
console.log("[chat] 输入 exit 退出。试试：算一下 (1234*5678)/2 / 列出当前目录 / 搜索 2026 诺贝尔物理学奖\n");

try {
  while (true) {
    let line: string;
    try {
      line = (await rl.question("你> ")).trim();
    } catch {
      break; // EOF / 管道输入结束
    }
    if (line === "") continue;
    if (line === "exit" || line === "quit" || line === "退出") break;

    process.stdout.write("助手> ");
    for await (const c of agent.run(line)) {
      switch (c.type) {
        case "text":
          process.stdout.write(c.delta);
          break;
        case "tool_call":
          console.log(`\n  🔧 ${c.name}(${JSON.stringify(c.input)})`);
          break;
        case "tool_result":
          console.log(`  📦 ${c.ok ? "成功" : "失败"}: ${JSON.stringify(c.output).slice(0, 300)}`);
          break;
        case "usage":
          console.log(`\n  [usage] in=${c.inputTokens} out=${c.outputTokens}`);
          break;
        case "error":
          console.error(`\n  ❌ ${c.message}`);
          break;
        case "done":
          break;
      }
    }
    console.log("\n");
  }
} finally {
  rl.close();
}
