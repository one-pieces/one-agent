import { db } from "@/lib/db";
import { deleteOriginalFile } from "@/lib/rag/file-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fileId: string }> };

/** DELETE /api/knowledge/[id]/files/[fileId] — 删除文件（含分块、向量索引与磁盘原始文件） */
export async function DELETE(_request: Request, { params }: Params) {
  const { id, fileId } = await params;
  const file = db.getKnowledgeFile(id, fileId);
  const ok = db.deleteKnowledgeFile(id, fileId);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  if (file) await deleteOriginalFile(id, fileId, file.name);
  return Response.json({ ok: true });
}
