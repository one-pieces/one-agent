import { buildFileIndex } from "@/lib/rag/indexer";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/knowledge/[id]/build-index — 构建某个文件的向量索引（SSE 进度流）
 * body: { fileId }
 * 事件：progress { phase, percent, done, total, message } → done { chunkCount, durationMs } / error { message }
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  let body: { fileId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.fileId) return Response.json({ error: "fileId 必填" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const result = await buildFileIndex(id, body.fileId!, (p) => {
          send("progress", { phase: p.percent < 5 ? "chunking" : "embedding", percent: p.percent, done: p.done, total: p.total, message: p.message });
        });
        send("done", { chunkCount: result.chunkCount, durationMs: result.durationMs, message: "索引构建完成" });
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
