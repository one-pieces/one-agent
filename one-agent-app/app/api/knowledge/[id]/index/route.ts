import { db } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/knowledge/[id]/index — 向量索引查看（分页 + 来源过滤）
 * query: offset?, limit?, source?
 * 返回 { total, sources, items: [{ chunkId, dim, embeddingPreview, fileName, chunkIndex, content }] }
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  if (!db.getKnowledgeBase(id)) return Response.json({ error: "not found" }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const offset = Math.max(0, parseInt(searchParams.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10) || 50));
  const source = searchParams.get("source") ?? "";

  const { total, sources, items } = db.getVectorIndex(id, { offset, limit, source });
  return Response.json({
    total,
    offset,
    limit,
    sources,
    items: items.map((r) => ({
      chunkId: r.chunkId,
      fileName: r.fileName,
      chunkIndex: r.chunkIndex,
      dim: r.dim,
      embeddingPreview: (JSON.parse(r.embedding) as number[]).slice(0, 5),
      content: r.content,
    })),
  });
}

/** DELETE /api/knowledge/[id]/index?fileId=xxx — 删除某个文件的向量索引（同时清分块） */
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  if (!db.getKnowledgeBase(id)) return Response.json({ error: "not found" }, { status: 404 });
  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get("fileId");
  if (!fileId) return Response.json({ error: "fileId 必填" }, { status: 400 });
  if (!db.getKnowledgeFile(id, fileId)) return Response.json({ error: "file not found" }, { status: 404 });
  db.deleteFileIndex(fileId);
  db.updateKnowledgeFileStatus(fileId, { indexStatus: "none", chunkCount: 0, indexError: undefined });
  return Response.json({ ok: true });
}
