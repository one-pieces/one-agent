/**
 * M5 MCP 演示：连接本地 fixture MCP server（stdio）→ 工具动态注册 → 调用 → 断开。
 * 运行：npm run mcp-demo（需先启动 fixture：node scripts/mcp-fixture-server.ts 由本脚本自动拉起）
 */
import { McpBridge, ToolRegistry } from "../src/index.ts";
import { fileURLToPath } from "node:url";

const registry = new ToolRegistry();
const bridge = new McpBridge(registry, {
  name: "fixture",
  transport: {
    type: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./mcp-fixture-server.ts", import.meta.url))],
  },
  prefix: "mcp_",
});

console.log("[mcp] 连接 fixture server…");
const count = await bridge.connect();
console.log(`[mcp] 已注册 ${count} 个外部工具:`, registry.list().map((t) => t.name).join(", "));

const res = await registry.execute({}, { id: "c1", name: "mcp_mcp_echo", input: { text: "hello from one-agent" } });
console.log("[mcp] 调用 mcp_echo →", res.ok ? res.output : res.error);

await bridge.disconnect();
console.log("[mcp] 断开，剩余工具:", registry.list().length);
