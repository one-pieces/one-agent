import type { StreamChunk } from "@one-agent/core";

/**
 * 客户端 SSE 消费：POST /api/chat 返回 text/event-stream，
 * 逐行解析 `data: <json>`，回调每个 StreamChunk。
 */
export async function consumeSSE(
  response: Response,
  onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.body) throw new Error("response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        onChunk(JSON.parse(line.slice(6)) as StreamChunk);
      } catch {
        // 忽略无法解析的事件
      }
    }
  }
}
