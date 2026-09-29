import { db } from "@/lib/db";
import { kernel } from "@/lib/kernel";
import { resolveAgentModel } from "@/lib/providers";
import {
  checkRateLimit,
  corsHeaders,
  preflightResponse,
  resolvePublicWidget,
  sanitizeVisitorChunk,
  verifyVisitorSession,
} from "@/lib/widget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 访客可选消息长度上限（防止把网页表单当 API 刷） */
const MAX_MESSAGE_CHARS = 2000;

/** OPTIONS /api/widget/chat — CORS 预检 */
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
  return preflightResponse(request, settings, { ok: true, origin: null });
}

/**
 * POST /api/widget/chat — 访客对话（SSE）
 * body: { agentId, key, sessionId, visitorToken, message }
 *
 * 与后台 /api/chat 的差异（访客是公网用户，权限收紧）：
 * - 只认 agentId + embedKey + 访客 token，不接受任何 modelOverride / toolOverrides / allowDangerous
 * - 需要审批的工具一律拒绝（onApproval 恒 false）—— 访客永远无法触发 bash 之类操作
 * - 工具调用只以「正在…」状态提示透出，工具名/参数/结果不进访客视野
 * - 按会话限流（每分钟消息数，可在后台配置）
 */
export async function POST(request: Request) {
  let body: {
    agentId?: string;
    key?: string;
    sessionId?: string;
    visitorToken?: string;
    message?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { agentId = "", key = "", sessionId = "", visitorToken, message = "" } = body;

  const resolved = resolvePublicWidget(request, agentId, key);
  if (!resolved.ok) return resolved.response;
  const { settings } = resolved;
  const headers = corsHeaders(request, settings);

  if (!sessionId || !message.trim()) {
    return Response.json({ error: "sessionId 与 message 必填" }, { status: 400, headers });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return Response.json({ error: `消息过长（最多 ${MAX_MESSAGE_CHARS} 字）` }, { status: 413, headers });
  }

  const verified = await verifyVisitorSession(agentId, sessionId, visitorToken);
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: verified.status, headers });
  }

  const limit = checkRateLimit(`widget:${sessionId}`, settings.rateLimit);
  if (!limit.ok) {
    return Response.json(
      { error: `发送太频繁，请 ${limit.retryAfterSec} 秒后再试` },
      { status: 429, headers: { ...headers, "retry-after": String(limit.retryAfterSec) } },
    );
  }

  const agent = db.getAgent(agentId)!;
  const config = resolveAgentModel(agent);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        for await (const chunk of kernel.runChat({
          agentConfig: config,
          sessionId,
          message,
          signal: request.signal,
          // 访客一律不能触发需要审批的工具
          onApproval: () => false,
        })) {
          const sanitized = sanitizeVisitorChunk(chunk);
          if (sanitized) send(sanitized);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: "error", message: `服务异常：${msg}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
