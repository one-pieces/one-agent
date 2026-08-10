import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; messageId: string }> };

/** DELETE /api/sessions/[id]/messages/[messageId] — 删除会话中的一条消息 */
export async function DELETE(_request: Request, { params }: Params) {
  const { id, messageId } = await params;
  const session = await kernel.removeMessage(id, messageId);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
