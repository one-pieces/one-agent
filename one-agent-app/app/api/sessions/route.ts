import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

/**
 * 会话摘要（列表用）：不带 messages。
 * /chat 侧边栏要平铺所有 Agent 的会话，逐个拉全量消息会白搬几十 KB —— 摘要只给列表需要的字段。
 */
function summarize(sessions: Awaited<ReturnType<typeof kernel.listSessions>>, agentNames: Map<string, string>) {
  return sessions.map((s) => {
    const meta = (s.meta ?? {}) as {
      title?: string;
      tokenUsage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number };
      widget?: { origin?: string | null };
    };
    const visible = s.messages.filter((m) => (m.role === "user" || m.role === "assistant") && !m.synthetic);
    const firstUser = visible.find((m) => m.role === "user");
    const fallbackTitle = (firstUser?.content ?? "").trim().slice(0, 40);
    return {
      id: s.id,
      agentId: s.agentId,
      agentName: agentNames.get(s.agentId) ?? s.agentId,
      // 还没有内容的新会话不拿 session id 当标题
      title: (meta.title ?? "").trim() || fallbackTitle || "新对话",
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: visible.length,
      tokenUsage: meta.tokenUsage ?? null,
      /** 客服访客来源（内部会话为 null） */
      widgetOrigin: meta.widget?.origin ?? null,
    };
  });
}

/** GET /api/sessions?agentId=xxx — 会话列表；?summary=1 时返回轻量摘要（不含 messages） */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const agentId = params.get("agentId") ?? undefined;
  const sessions = await kernel.listSessions(agentId);
  if (params.get("summary") !== "1") return Response.json(sessions);

  const { db } = await import("@/lib/db");
  const agentNames = new Map(db.listAgents().map((a) => [a.id, a.name]));
  return Response.json(summarize(sessions, agentNames));
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
