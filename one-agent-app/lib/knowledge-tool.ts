import { db, type AppDatabase } from "./db";
import { searchKnowledgeChunks } from "./knowledge";
import type { ToolSpec } from "@one-agent/core";

/**
 * 应用层动态工具：知识库检索。
 * 当 AgentConfig.knowledgeBaseIds 非空时由 kernel 注册；模型按需调用，返回 Top-K 分块。
 * store 参数供测试注入临时数据库，缺省用全局单例。
 */
export function createKnowledgeSearchTool(knowledgeBaseIds: string[], store: AppDatabase = db): ToolSpec {
  return {
    name: "knowledge_search",
    description:
      "在关联的知识库中检索资料（支持中文/英文关键词），返回最相关的片段及来源。当用户询问知识库、公司文档、手册等内部资料时使用；不确定时先检索再回答。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词或问题" },
        limit: { type: "number", description: "返回片段数（1-10，默认 5）" },
      },
      required: ["query"],
    },
    async execute(_ctx, input) {
      const obj = (input ?? {}) as { query?: unknown; limit?: unknown };
      const query = typeof obj.query === "string" ? obj.query.trim() : "";
      if (!query) return { ok: false, output: null, error: "query 必填" };
      const limit =
        typeof obj.limit === "number" ? Math.min(Math.max(Math.floor(obj.limit), 1), 10) : 5;
      const chunks = searchKnowledgeChunks(store.getChunksForKnowledgeBases(knowledgeBaseIds), query, limit);
      if (chunks.length === 0) return { ok: true, output: "（知识库中未检索到相关内容）" };
      return {
        ok: true,
        output: chunks.map((c) => `【${c.fileName ?? "未知来源"}】\n${c.content}`).join("\n\n---\n\n"),
      };
    },
  };
}
