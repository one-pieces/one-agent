import { db } from "@/lib/db";
import { searchKnowledge } from "@/lib/rag/indexer";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** POST /api/knowledge/[id]/search — 混合检索预览 { query, limit? } → Top-K 分块 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const kb = db.getKnowledgeBase(id);
  if (!kb) return Response.json({ error: "not found" }, { status: 404 });

  let body: { query?: string; limit?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const query = body.query?.trim() ?? "";
  if (!query) return Response.json({ error: "查询词必填" }, { status: 400 });

  const results = await searchKnowledge([id], query, {
    topK: body.limit ?? 5,
    useRerank: kb.useRerank,
    store: db,
  });
  return Response.json({ chunks: results.map((r) => r.chunk) });
}
