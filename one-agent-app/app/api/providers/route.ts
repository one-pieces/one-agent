import { db, newProviderId } from "@/lib/db";
import { ensureProviderMigration, providerSummary, validateProviderInput } from "@/lib/providers";

export const runtime = "nodejs";

/**
 * GET /api/providers — 供应商列表。
 * 列表**不带出密钥**，只给 hasApiKey 标记（UI 列表不需要密钥，编辑单个时才取明文）。
 */
export async function GET() {
  ensureProviderMigration();
  // 列表：带上"有没有配密钥"的标记（明文密钥只在 GET /api/providers/[id] 与 POST 响应里出现）
  const providers = db.listProviders(true).map(providerSummary);
  return Response.json(providers);
}

/** POST /api/providers — 新建 { name, kind?, baseUrl, apiKey?, models?, notes? } */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const checked = validateProviderInput(body);
  if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
  const id = newProviderId();
  const provider = db.createProvider(id, {
    name: checked.value.name!,
    baseUrl: checked.value.baseUrl!,
    ...(checked.value.kind ? { kind: checked.value.kind } : {}),
    apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
    ...(checked.value.models ? { models: checked.value.models } : {}),
    ...(checked.value.notes ? { notes: checked.value.notes } : {}),
  });
  return Response.json(provider, { status: 201 });
}
