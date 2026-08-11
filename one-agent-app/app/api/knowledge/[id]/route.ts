import { db } from "@/lib/db";
import { deleteOriginalDir } from "@/lib/rag/file-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/knowledge/[id] — 知识库详情（含文件列表） */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const kb = db.getKnowledgeBase(id);
  if (!kb) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ...kb, files: db.listKnowledgeFiles(id) });
}

/** PATCH /api/knowledge/[id] — 更新 { name?, description?, useRerank? } */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  let body: { name?: string; description?: string; useRerank?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const updated = db.updateKnowledgeBase(id, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.description !== undefined ? { description: body.description.trim() } : {}),
    ...(body.useRerank !== undefined ? { useRerank: body.useRerank } : {}),
  });
  if (!updated) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(updated);
}

/** DELETE /api/knowledge/[id] — 删除知识库（级联删除文件、分块、向量索引与磁盘原始文件） */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!db.getKnowledgeBase(id)) return Response.json({ error: "not found" }, { status: 404 });
  db.deleteKnowledgeBase(id);
  await deleteOriginalDir(id);
  return Response.json({ ok: true });
}
