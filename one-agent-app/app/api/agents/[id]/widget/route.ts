import { db } from "@/lib/db";
import { effectiveWidgetSettings, embedSnippet } from "@/lib/widget";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** 后台响应：配置 + 嵌入代码 + 预览链接 */
function adminPayload(request: Request, agentId: string, agentName: string) {
  const stored = db.getWidgetSettings(agentId);
  const settings = effectiveWidgetSettings({ id: agentId, name: agentName });
  const baseUrl = new URL(request.url).origin;
  return {
    settings,
    /** 是否已落库配置（没落库时 enabled=false —— 避免"看着开着其实没开"） */
    configured: stored !== null,
    snippet: stored
      ? embedSnippet(baseUrl, agentId, stored.embedKey, { position: settings.position, color: settings.primaryColor })
      : "",
    demoUrl: `${baseUrl}/widget-demo.html?agent=${agentId}${stored ? `&key=${stored.embedKey}` : ""}`,
    embedUrl: `${baseUrl}/embed/chat`,
  };
}

/** GET /api/agents/[id]/widget — 读客服组件配置（后台用） */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const agent = db.getAgent(id);
  if (!agent) return Response.json({ error: "agent not found" }, { status: 404 });
  return Response.json(adminPayload(request, id, agent.name));
}

/** PUT /api/agents/[id]/widget — 更新配置；`resetKey: true` 时同时重置嵌入 key */
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const agent = db.getAgent(id);
  if (!agent) return Response.json({ error: "agent not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: Parameters<typeof db.upsertWidgetSettings>[1] = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  for (const key of ["title", "subtitle", "welcome", "placeholder"] as const) {
    if (typeof body[key] === "string") patch[key] = (body[key] as string).slice(0, 300);
  }
  if (typeof body.primaryColor === "string") {
    const color = body.primaryColor.trim();
    if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) {
      return Response.json({ error: "primaryColor 需为 #RRGGBB 形式的十六进制颜色" }, { status: 400 });
    }
    patch.primaryColor = color;
  }
  if (body.position === "left" || body.position === "right") patch.position = body.position;
  if (Array.isArray(body.origins) || typeof body.origins === "string") {
    patch.origins = body.origins as string[] | string;
  }
  if (typeof body.rateLimit === "number") {
    if (!Number.isFinite(body.rateLimit) || body.rateLimit < 0 || body.rateLimit > 600) {
      return Response.json({ error: "rateLimit 需为 0–600 之间的数字（0 = 不限流）" }, { status: 400 });
    }
    patch.rateLimit = Math.floor(body.rateLimit);
  }

  db.upsertWidgetSettings(id, patch);
  if (body.resetKey === true) db.resetWidgetKey(id);
  return Response.json(adminPayload(request, id, agent.name));
}

/** DELETE /api/agents/[id]/widget — 关闭并清空配置（旧嵌入代码立即失效） */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!db.getAgent(id)) return Response.json({ error: "agent not found" }, { status: 404 });
  db.deleteWidgetSettings(id);
  return Response.json({ ok: true });
}
