import { builtinTools } from "@one-agent/core";
import { createKnowledgeSearchTool } from "@/lib/knowledge-tool";

export const runtime = "nodejs";

/** GET /api/tools — 内置工具目录（供 Agent 表单勾选）；knowledge_search 为知识库动态工具 */
export async function GET() {
  const tools = [
    ...builtinTools.map((t) => ({
      name: t.name,
      description: t.description,
      dangerous: t.meta?.dangerous ?? false,
    })),
    {
      name: "knowledge_search",
      description: "在关联的知识库中检索资料（需先在 Agent 配置里勾选知识库）",
      dangerous: false,
    },
  ];
  return Response.json(tools);
}

