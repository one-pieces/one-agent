import { db } from "@/lib/db";
import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

/**
 * POST /api/chat — SSE 流式对话
 * body: { agentId, sessionId, message, modelOverride?, toolOverrides?, allowDangerous? }
 * modelOverride/toolOverrides：请求级覆盖（未提供则用会话 meta 中的覆盖）
 * allowDangerous：默认 false —— 危险工具（run_local_command 等）默认拒绝，需显式开启
 * 响应：text/event-stream，每行 `data: <StreamChunk JSON>`（契约见 contracts/stream-protocol.md）
 */
export async function POST(request: Request) {
  let body: {
    agentId?: string;
    sessionId?: string;
    message?: string;
    modelOverride?: unknown;
    toolOverrides?: unknown;
    allowDangerous?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { agentId, sessionId, message, modelOverride, toolOverrides, allowDangerous } = body;
  if (!agentId || !sessionId || typeof message !== "string" || !message.trim()) {
    return Response.json({ error: "agentId, sessionId, message 必填" }, { status: 400 });
  }

  const config = db.getAgent(agentId);
  if (!config) return Response.json({ error: `agent not found: ${agentId}` }, { status: 404 });

  // 危险工具放行：请求级 allowDangerous 或会话 meta.allowDangerous
  const session = await kernel.getSession(sessionId);
  const metaAllow = (session?.meta as { allowDangerous?: boolean } | undefined)?.allowDangerous ?? false;
  const allowDangerousEffective = allowDangerous === true || metaAllow === true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of kernel.runChat({
          agentConfig: config,
          sessionId,
          message,
          signal: request.signal,
          modelOverride: modelOverride as never,
          toolOverrides: toolOverrides as never,
          // 危险工具默认拒绝（Web 安全默认）；请求级或会话级开启后才放行
          onApproval: () => allowDangerousEffective,
        })) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`));
      } finally {
        controller.close();
      }
    },
    cancel() {
      // 客户端断开：内核通过 request.signal 感知
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
