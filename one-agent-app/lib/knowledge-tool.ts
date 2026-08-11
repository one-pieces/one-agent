import { db, type AppDatabase } from "./db";
import { searchKnowledge, type SearchDeps } from "./rag/indexer";
import type { ToolSpec } from "@one-agent/core";

/**
 * 应用层动态工具：知识库检索（混合检索：BM25 + 向量 + RRF，可选 cross-encoder 重排）。
 * 当 AgentConfig.knowledgeBaseIds 非空时由 kernel 注册；模型按需调用，返回 Top-K 分块及来源。
 * store/deps 供测试注入临时数据库与假 embedder，缺省用全局单例与本地 Transformers.js。
 */
export function createKnowledgeSearchTool(
  knowledgeBaseIds: string[],
  store: AppDatabase = db,
  deps?: SearchDeps,
): ToolSpec {
  return {
    name: "knowledge_search",
    description:
      "在关联的知识库中检索资料（语义 + 关键词混合检索），返回最相关的片段及来源。当用户询问知识库、公司文档、手册等内部资料时使用；不确定时先检索再回答。",
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
      const useRerank = knowledgeBaseIds.some((id) => store.getKnowledgeBase(id)?.useRerank);
      const results = await searchKnowledge(knowledgeBaseIds, query, {
        topK: limit,
        useRerank,
        store,
        deps,
      });
      if (results.length === 0) return { ok: true, output: "（知识库中未检索到相关内容）" };
      return {
        ok: true,
        output: results
          .map((r) => `【${r.chunk.fileName ?? "未知来源"}】\n${r.chunk.content}`)
          .join("\n\n---\n\n"),
      };
    },
  };
}
