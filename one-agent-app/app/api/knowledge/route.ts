import { db } from "@/lib/db";

export const runtime = "nodejs";

/** GET /api/knowledge — 知识库列表 */
export async function GET() {
  return Response.json(db.listKnowledgeBases());
}

/** POST /api/knowledge — 创建知识库 { name, description? } */
export async function POST(request: Request) {
  let body: { name?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return Response.json({ error: "名称必填" }, { status: 400 });
  const kb = db.createKnowledgeBase(name, body.description?.trim() ?? "");
  return Response.json(kb, { status: 201 });
}
