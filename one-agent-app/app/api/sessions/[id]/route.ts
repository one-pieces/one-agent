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
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  let body: { modelOverride?: unknown; toolOverrides?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const session = await kernel.updateSessionOverrides(id, {
    modelOverride: body.modelOverride as never,
    toolOverrides: body.toolOverrides as never,
  });
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(session);
}
