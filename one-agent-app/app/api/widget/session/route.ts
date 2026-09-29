import { checkOrigin, corsHeaders, createVisitorSession, preflightResponse, resolvePublicWidget, verifyVisitorSession } from "@/lib/widget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/widget/session — 建立或恢复访客会话
 * body: { agentId, key, sessionId?, visitorToken? }
 * - 带 sessionId + visitorToken 且校验通过 → 复用（刷新页面继续同一段对话）
 * - 否则新建，返回 { sessionId, visitorToken }；token 只回给这个访客，后续读写都要带
 */
export async function POST(request: Request) {
  let body: { agentId?: string; key?: string; sessionId?: string; visitorToken?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { agentId = "", key = "", sessionId, visitorToken } = body;

  const resolved = resolvePublicWidget(request, agentId, key);
  if (!resolved.ok) return resolved.response;
  const { settings, origin } = resolved;
  const headers = corsHeaders(request, settings);

  if (sessionId && visitorToken) {
    const verified = await verifyVisitorSession(agentId, sessionId, visitorToken);
    if (verified.ok) {
      return Response.json({ sessionId, visitorToken, resumed: true }, { headers });
    }
  }

  const created = await createVisitorSession(agentId, origin, request.headers.get("user-agent"));
  return Response.json({ ...created, resumed: false }, { status: 201, headers });
}

/** OPTIONS /api/widget/session — CORS 预检 */
export async function OPTIONS(request: Request) {
  let agentId = "";
  let key = "";
  try {
    const body = (await request.clone().json()) as { agentId?: string; key?: string };
    agentId = body.agentId ?? "";
    key = body.key ?? "";
  } catch {
    const url = new URL(request.url);
    agentId = url.searchParams.get("agentId") ?? "";
    key = url.searchParams.get("key") ?? "";
  }
  const resolved = resolvePublicWidget(request, agentId, key);
  if (!resolved.ok) return resolved.response;
  const { settings } = resolved;
  return preflightResponse(request, settings, checkOrigin(request, settings));
}
