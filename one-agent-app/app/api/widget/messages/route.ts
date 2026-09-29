import { kernel } from "@/lib/kernel";
import { corsHeaders, preflightResponse, resolvePublicWidget, verifyVisitorSession } from "@/lib/widget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/widget/messages?agentId=&key=&sessionId=&visitorToken=
 * 访客重新打开面板时恢复对话记录。
 * 只回 user/assistant 的纯文本 —— 工具调用、工具结果、引导/催促等合成消息不进访客视野。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId") ?? "";
  const key = url.searchParams.get("key") ?? "";
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const visitorToken = url.searchParams.get("visitorToken") ?? undefined;

  const resolved = resolvePublicWidget(request, agentId, key);
  if (!resolved.ok) return resolved.response;
  const { settings } = resolved;

  const verified = await verifyVisitorSession(agentId, sessionId, visitorToken);
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: verified.status, headers: corsHeaders(request, settings) });
  }

  const session = await kernel.getSession(sessionId);
  const messages = (session?.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.synthetic)
    .map((m) => ({ id: m.id, role: m.role, content: m.content ?? "", createdAt: m.createdAt }))
    .filter((m) => m.content.trim().length > 0);

  return Response.json({ messages }, { headers: corsHeaders(request, settings) });
}

/** OPTIONS /api/widget/messages */
export async function OPTIONS(request: Request) {
  const url = new URL(request.url);
  const resolved = resolvePublicWidget(request, url.searchParams.get("agentId") ?? "", url.searchParams.get("key") ?? "");
  if (!resolved.ok) return resolved.response;
  const { settings } = resolved;
  return preflightResponse(request, settings, { ok: true, origin: null });
}
