import { db } from "@/lib/db";
import { kernel } from "@/lib/kernel";
import { ensureProviderMigration, resolveAgentModel } from "@/lib/providers";

export const runtime = "nodejs";

/**
 * POST /api/chat — SSE 流式对话
 * body: { agentId, sessionId, message, allowDangerous? }
 * 模型与工具一律取自 Agent 配置（会话级/请求级覆盖已移除，避免同一会话出现"看着是 A 实际跑 B"）
 * allowDangerous：默认 false —— 危险工具（bash 等）默认拒绝，需显式开启
 * 响应：text/event-stream，每行 `data: <StreamChunk JSON>`（契约见 contracts/stream-protocol.md）
 */
export async function POST(request: Request) {
  let body: {
    agentId?: string;
    sessionId?: string;
    message?: string;
    allowDangerous?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { agentId, sessionId, message, allowDangerous } = body;
  if (!agentId || !sessionId || typeof message !== "string" || !message.trim()) {
    return Response.json({ error: "agentId, sessionId, message 必填" }, { status: 400 });
  }

  ensureProviderMigration();
  const stored = db.getAgent(agentId);
  if (!stored) return Response.json({ error: `agent not found: ${agentId}` }, { status: 404 });
  // 运行时解析模型供应商：改了 provider 的密钥/地址，所有引用它的 agent 立即生效
  const config = resolveAgentModel(stored);

  // 危险工具放行：仅请求级 allowDangerous（会话级开关已随会话覆盖一并移除）
  const allowDangerousEffective = allowDangerous === true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of kernel.runChat({
          agentConfig: config,
          sessionId,
          message,
          signal: request.signal,
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
