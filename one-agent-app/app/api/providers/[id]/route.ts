import { db } from "@/lib/db";
import { validateProviderInput } from "@/lib/providers";
import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/providers/[id] — 单个（带明文密钥，供编辑表单） */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const provider = db.getProvider(id);
  if (!provider) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(provider);
}

/** PATCH /api/providers/[id] — 更新（apiKey 传 undefined 不改、传空串清空） */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  if (!db.getProvider(id)) return Response.json({ error: "not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const checked = validateProviderInput(body, { partial: true });
  if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });

  const patch: Parameters<typeof db.updateProvider>[1] = {};
  if (checked.value.name !== undefined) patch.name = checked.value.name;
  if (checked.value.kind !== undefined) patch.kind = checked.value.kind;
  if (checked.value.baseUrl !== undefined) patch.baseUrl = checked.value.baseUrl;
  if (checked.value.models !== undefined) patch.models = checked.value.models;
  if (checked.value.notes !== undefined) patch.notes = checked.value.notes;
  if (typeof body.apiKey === "string") patch.apiKey = body.apiKey;

  const updated = db.updateProvider(id, patch);
  // 引用了它的 agent 重建实例 → 新密钥/新地址即时生效（运行时解析，不用改 agent）
  for (const agentId of db.agentsUsingProvider(id)) kernel.invalidate(agentId);
  return Response.json(updated);
}

/** DELETE /api/providers/[id] — 被 agent 引用时拒绝删除（避免静默把 agent 打坏） */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const provider = db.getProvider(id);
  if (!provider) return Response.json({ error: "not found" }, { status: 404 });
  const usedBy = db.agentsUsingProvider(id);
  if (usedBy.length > 0) {
    return Response.json(
      { error: `还有 ${usedBy.length} 个 agent 在用这个供应商（${usedBy.join(", ")}），请先改掉它们的供应商配置` },
      { status: 409 },
    );
  }
  db.deleteProvider(id);
  return Response.json({ ok: true });
}
