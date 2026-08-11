import { db } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fileId: string }> };

/** DELETE /api/knowledge/[id]/files/[fileId] — 删除文件（含分块与向量索引） */
export async function DELETE(_request: Request, { params }: Params) {
  const { id, fileId } = await params;
  const ok = db.deleteKnowledgeFile(id, fileId);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
