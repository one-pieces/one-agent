import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/sessions/[id] — 会话详情（messages 历史 + meta 覆盖） */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const session = await kernel.getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(session);
}

/**
 * PATCH /api/sessions/[id] — 更新会话级配置覆盖
 * body: { modelOverride?: Partial<ProviderConfig> | null, toolOverrides?: Array<{name,enabled}> | null }
 * 传 null 清除对应覆盖；不传则保留。
 */
/** DELETE /api/sessions/[id] — 删除会话（含对应工作区文件） */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  await kernel.deleteSession(id);
  return Response.json({ ok: true });
}
