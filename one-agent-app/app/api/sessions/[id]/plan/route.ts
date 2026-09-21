import { listPlanFiles } from "@one-agent/core";
import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

/**
 * GET /api/sessions/[id]/plan — 该会话最新的方案文档（无则 plan:null）。
 * 方案文件落在会话工作区 `.oneagent/plans/`（文件即真相：重启/压缩后依然可读）。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await kernel.getSession(id);
  if (!session) return Response.json({ error: `session not found: ${id}` }, { status: 404 });

  let workspace: string;
  try {
    workspace = kernel.sessionWorkspacePath(id);
  } catch {
    return Response.json({ plan: null, count: 0 });
  }

  const plans = await listPlanFiles(workspace);
  const latest = plans[0];
  return Response.json({
    plan: latest ? { path: latest.path, content: latest.content, updatedAt: latest.updatedAt } : null,
    count: plans.length,
  });
}
