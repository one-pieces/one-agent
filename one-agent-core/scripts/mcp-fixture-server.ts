/**
 * MCP fixture server（测试/演示用）：
 * 通过 stdio 暴露一个工具 mcp_echo（回显输入）。
 * 运行：node scripts/mcp-fixture-server.ts
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "one-agent-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mcp_echo",
      description: "回显输入文本（MCP 测试工具）",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as { text?: string };
  return {
    content: [{ type: "text", text: `echo:${args.text ?? ""}` }],
  };
});

await server.connect(new StdioServerTransport());
