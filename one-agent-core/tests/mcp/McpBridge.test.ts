import { describe, it, expect } from "vitest";
import { McpBridge } from "../../src/mcp/index.ts";
import { ToolRegistry } from "../../src/tools/index.ts";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(new URL("../../scripts/mcp-fixture-server.ts", import.meta.url));

describe("McpBridge（外部 MCP server 动态接入）", () => {
  it("stdio 连接：拉取工具并注册，可调用，断开后注销", async () => {
    const registry = new ToolRegistry();
    const bridge = new McpBridge(registry, {
      name: "fixture",
      transport: { type: "stdio", command: process.execPath, args: [fixturePath] },
      prefix: "mcp_",
    });

    const count = await bridge.connect();
    expect(count).toBe(1);
    // 工具名 = 前缀 "mcp_" + MCP 原名 "mcp_echo"
    expect(registry.has("mcp_mcp_echo")).toBe(true);
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("mcp_mcp_echo");

    // 调用 MCP 工具
    const res = await registry.execute({}, { id: "c1", name: "mcp_mcp_echo", input: { text: "hello" } });
    expect(res.ok).toBe(true);
    expect(res.output).toBe("echo:hello");

    // 断开：工具注销
    await bridge.disconnect();
    expect(registry.has("mcp_mcp_echo")).toBe(false);
  });
}, 20_000);
