import { db } from "@/lib/db";
import { searchKnowledgeChunks } from "@/lib/knowledge";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** POST /api/knowledge/[id]/search — 检索预览 { query, limit? } → Top-K 分块 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (!db.getKnowledgeBase(id)) return Response.json({ error: "not found" }, { status: 404 });

  let body: { query?: string; limit?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const query = body.query?.trim() ?? "";
  if (!query) return Response.json({ error: "查询词必填" }, { status: 400 });

  const chunks = searchKnowledgeChunks(db.getChunksForKnowledgeBases([id]), query, body.limit ?? 5);
  return Response.json({ chunks });
}
