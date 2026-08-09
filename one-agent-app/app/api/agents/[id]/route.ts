import { db } from "@/lib/db";
import { kernel } from "@/lib/kernel";
import { validateAgentConfig } from "@one-agent/core";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/agents/[id] */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const config = db.getAgent(id);
  if (!config) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(config);
}

/** PATCH /api/agents/[id] — 更新配置（动态配置：改完即时生效） */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  if (!db.getAgent(id)) return Response.json({ error: "not found" }, { status: 404 });

  let patch: unknown;
  try {
    patch = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const merged = { ...db.getAgent(id)!, ...(patch as object) };
    const validated = validateAgentConfig(merged);
    db.updateAgent(validated);
    kernel.invalidate(id); // 强制内核下次重建 Agent 实例 → 动态配置即时生效
    return Response.json(validated);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

/** DELETE /api/agents/[id] */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  db.deleteAgent(id);
  kernel.invalidate(id);
  return Response.json({ ok: true });
}
