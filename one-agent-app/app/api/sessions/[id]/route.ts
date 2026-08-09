import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/sessions/[id] — 会话详情（messages 历史） */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const session = await kernel.getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(session);
}
