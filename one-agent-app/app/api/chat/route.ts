import { db } from "@/lib/db";
import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

/**
 * POST /api/chat — SSE 流式对话
 * body: { agentId, sessionId, message }
 * 响应：text/event-stream，每行 `data: <StreamChunk JSON>`（契约见 contracts/stream-protocol.md）
 */
export async function POST(request: Request) {
  let body: { agentId?: string; sessionId?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { agentId, sessionId, message } = body;
  if (!agentId || !sessionId || typeof message !== "string" || !message.trim()) {
    return Response.json({ error: "agentId, sessionId, message 必填" }, { status: 400 });
  }

  const config = db.getAgent(agentId);
  if (!config) return Response.json({ error: `agent not found: ${agentId}` }, { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of kernel.runChat({
          agentConfig: config,
          sessionId,
          message,
          signal: request.signal,
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
