import {
  checkOrigin,
  corsHeaders,
  preflightResponse,
  publicWidgetConfig,
  resolvePublicWidget,
} from "@/lib/widget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OPTIONS /api/widget/config — CORS 预检 */
export async function OPTIONS(request: Request) {
  const url = new URL(request.url);
  const resolved = resolvePublicWidget(request, url.searchParams.get("agentId") ?? "", url.searchParams.get("key") ?? "");
  if (!resolved.ok) return resolved.response;
  const { settings } = resolved;
  return preflightResponse(request, settings, checkOrigin(request, settings));
}

/**
 * GET /api/widget/config?agentId=&key= — 访客侧拉取组件外观配置。
 * 只返回可公开字段（标题/欢迎语/配色/位置/限流），绝不包含 provider、工具、知识库等内部信息。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId") ?? "";
  const key = url.searchParams.get("key") ?? "";
  const resolved = resolvePublicWidget(request, agentId, key);
  if (!resolved.ok) return resolved.response;

  const { agent, settings } = resolved;
  return Response.json(
    { ...publicWidgetConfig(agent, settings), agentName: agent.name },
    { headers: corsHeaders(request, settings) },
  );
}
