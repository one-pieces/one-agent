import { db } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fileId: string }> };

/**
 * GET /api/knowledge/[id]/files/[fileId]/chunks — 查看某个文件的分块（含向量信息）
 * 返回 items 结构与 /index 对齐：{ chunkId, fileName, chunkIndex, dim, embeddingPreview, content }
 */
export async function GET(_request: Request, { params }: Params) {
  const { id, fileId } = await params;
  const file = db.getKnowledgeFile(id, fileId);
  if (!file) return Response.json({ error: "not found" }, { status: 404 });
  const chunks = db.getChunksForFile(id, fileId);
  return Response.json({
    file: { id: file.id, name: file.name, indexStatus: file.indexStatus, chunkCount: file.chunkCount },
    total: chunks.length,
    items: chunks.map((c) => {
      const embedding = c.embedding ? (JSON.parse(c.embedding) as number[]) : null;
      return {
        chunkId: c.id,
        fileName: file.name,
        chunkIndex: c.chunkIndex,
        dim: c.dim ?? embedding?.length ?? 0,
        embeddingPreview: embedding ? embedding.slice(0, 5) : [],
        content: c.content,
      };
    }),
  });
}
