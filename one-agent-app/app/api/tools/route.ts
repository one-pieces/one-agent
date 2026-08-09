import { builtinTools } from "@one-agent/core";

export const runtime = "nodejs";

/** GET /api/tools — 内核内置工具目录（供 Agent 表单勾选） */
export async function GET() {
  return Response.json(
    builtinTools.map((t) => ({
      name: t.name,
      description: t.description,
      dangerous: t.meta?.dangerous ?? false,
    })),
  );
}
