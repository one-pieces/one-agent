import { db, newAgentId } from "@/lib/db";
import { ensureProviderMigration, snapshotAgentModel } from "@/lib/providers";
import { validateAgentConfig } from "@one-agent/core";

export const runtime = "nodejs";

/** GET /api/agents — 列表（首次访问顺带把老 agent 的模型配置迁移成 provider 引用） */
export async function GET() {
  ensureProviderMigration();
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
    // 引用了 provider 时把 kind/baseUrl/apiKey 快照进 model（其它读取路径拿到的仍是完整配置）
    const snapshotted = validateAgentConfig(snapshotAgentModel(withId));
    db.createAgent(snapshotted);
    return Response.json(snapshotted, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
