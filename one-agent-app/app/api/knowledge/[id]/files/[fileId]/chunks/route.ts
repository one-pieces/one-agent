import { db } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fileId: string }> };

/** GET /api/knowledge/[id]/files/[fileId]/chunks — 查看某个文件的分块 */
export async function GET(_request: Request, { params }: Params) {
  const { id, fileId } = await params;
  const file = db.getKnowledgeFile(id, fileId);
  if (!file) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({
    file: { id: file.id, name: file.name, indexStatus: file.indexStatus, chunkCount: file.chunkCount },
    chunks: db.getChunksForFile(id, fileId),
  });
}
