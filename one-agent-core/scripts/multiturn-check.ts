/** 一次性验证：真实模型 + 多轮历史连续性（calculator 引用上一轮结果） */
import { Agent, ToolRegistry, builtinTools } from "../src/index.ts";

const registry = new ToolRegistry();
for (const t of builtinTools) registry.add(t);

const agent = new Agent(
  {
    id: "demo",
    name: "演示",
    instructions: "你是计算助手。需要计算时调用 calculator，回答要简洁。",
    model: {
      provider: "openai-compatible",
      baseUrl: process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1",
      modelId: process.env.OPENAI_MODEL ?? "qwen2.5-7b-64k",
      apiKey: "not-needed",
      temperature: 0.3,
    },
    tools: [{ name: "calculator", enabled: true }],
    maxIterations: 4,
  },
  { tools: registry },
);

for (const q of ["算一下 2^10", "把刚才的结果加 5"]) {
  let text = "";
  for await (const c of agent.run(q)) {
    if (c.type === "text") text += c.delta;
    if (c.type === "tool_call") console.log(`  🔧 ${c.name}(${JSON.stringify(c.input)})`);
    if (c.type === "tool_result") console.log(`  📦 ${JSON.stringify(c.output)}`);
  }
  console.log(`Q: ${q}\nA: ${text.trim()}\n`);
}
console.log("历史条数:", (await agent.getHistory()).length);
