import { db, newAgentId } from "@/lib/db";
import { validateAgentConfig } from "@one-agent/core";

export const runtime = "nodejs";

/** GET /api/agents — 列表 */
export async function GET() {
  return Response.json(db.listAgents());
}

/** POST /api/agents — 创建（config 由内核 zod 校验） */
export async function POST(request: Request) {
  let config: unknown;
  try {
    config = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const validated = validateAgentConfig(config);
    const withId = validated.id ? validated : { ...validated, id: newAgentId() };
    if (db.getAgent(withId.id)) {
      return Response.json({ error: `agent id 已存在: ${withId.id}` }, { status: 409 });
    }
    db.createAgent(withId);
    return Response.json(withId, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
