import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolRegistry } from "../tools/index.ts";
import type { ToolSpec } from "../types.ts";

export interface McpServerConfig {
  /** 连接名（仅用于标识） */
  name: string;
  transport:
    | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { type: "http"; url: string; headers?: Record<string, string> };
  /** 工具名前缀，避免与内置工具冲突（如 "mcp_"） */
  prefix?: string;
}

/**
 * MCP 桥接：把外部 MCP server 的工具动态注册进 ToolRegistry（§6.3 McpBridge）。
 * - connect()：连接 + 拉取工具列表 + 注册（带前缀）
 * - disconnect()：注销全部 + 关闭连接
 */
export class McpBridge {
  private client: Client | null = null;
  private registered: string[] = [];
  private prefix: string;
  private registry: ToolRegistry;
  private config: McpServerConfig;

  constructor(registry: ToolRegistry, config: McpServerConfig) {
    this.registry = registry;
    this.config = config;
    this.prefix = config.prefix ?? "";
  }

  async connect(): Promise<number> {
    if (this.client) throw new Error(`MCP ${this.config.name} already connected`);
    const client = new Client({ name: "one-agent", version: "0.1.0" });

    const t = this.config.transport;
    if (t.type === "stdio") {
      const transport = new StdioClientTransport({
        command: t.command,
        args: t.args,
        env: t.env,
      });
      await client.connect(transport);
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(t.url), {
        requestInit: t.headers ? { headers: t.headers } : undefined,
      });
      await client.connect(transport);
    }

    const { tools } = await client.listTools();
    for (const tool of tools) {
      const name = this.prefix + tool.name;
      const spec: ToolSpec = {
        name,
        description: tool.description ?? `MCP 工具（${this.config.name}）`,
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        execute: async (_ctx, input) => {
          try {
            const result = (await client.callTool({
              name: tool.name,
              arguments: (input ?? {}) as Record<string, unknown>,
            })) as {
              content: Array<{ type: string; text?: string }>;
              isError?: boolean;
              structuredContent?: unknown;
            };
            const text = result.content
              .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
              .join("\n");
            return {
              ok: !result.isError,
              output: text || (result.structuredContent ?? null),
              error: result.isError ? text || "MCP tool error" : undefined,
            };
          } catch (err) {
            return {
              ok: false,
              output: null,
              error: `MCP 调用失败: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      };
      this.registry.add(spec);
      this.registered.push(name);
    }

    this.client = client;
    return tools.length;
  }

  async disconnect(): Promise<void> {
    for (const name of this.registered) this.registry.remove(name);
    this.registered = [];
    await this.client?.close();
    this.client = null;
  }
}
