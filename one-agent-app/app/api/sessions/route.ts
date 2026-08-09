import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

/** GET /api/sessions?agentId=xxx — 会话列表 */
export async function GET(request: Request) {
  const agentId = new URL(request.url).searchParams.get("agentId") ?? undefined;
  const sessions = await kernel.listSessions(agentId);
  return Response.json(sessions);
}

/** POST /api/sessions — 新建空会话 { agentId } → { session } */
export async function POST(request: Request) {
  let body: { agentId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.agentId) return Response.json({ error: "agentId 必填" }, { status: 400 });
  const session = kernel.createSession(body.agentId);
  return Response.json(session, { status: 201 });
}
