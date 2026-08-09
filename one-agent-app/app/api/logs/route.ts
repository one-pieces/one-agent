import { getRequestLogs } from "@/lib/observability";

export const runtime = "nodejs";

/** GET /api/logs — 最近 LLM 请求日志（可观测性） */
export async function GET() {
  return Response.json(getRequestLogs());
}
