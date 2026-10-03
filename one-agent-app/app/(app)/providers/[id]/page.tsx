import Link from "next/link";
import { notFound } from "next/navigation";
import ProviderForm from "@/components/ProviderForm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * /providers/[id] — 编辑供应商（独立页面）。
 * 注意：**不下发明文密钥**给前端，只给 hasApiKey 标记；留空提交 = 不修改密钥。
 */
export default async function EditProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = db.getProvider(id);
  if (!provider) notFound();

  const referencingAgents = db.agentsUsingProvider(id);

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1>{provider.name}</h1>
        <Link href="/providers" className="muted">
          ← 返回列表
        </Link>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        <code>{provider.id}</code> · 创建于 {new Date(provider.createdAt).toLocaleString("zh-CN", { hour12: false })} ·
        最近更新 {new Date(provider.updatedAt).toLocaleString("zh-CN", { hour12: false })}
      </p>
      <p className="muted">
        {referencingAgents.length > 0 ? (
          <>
            被 {referencingAgents.length} 个 Agent 引用（{referencingAgents.join("、")}）—— 保存后它们立即生效，无需逐个改；
            被引用时无法删除。
          </>
        ) : (
          "暂无 Agent 引用这个供应商。"
        )}
      </p>

      <ProviderForm
        mode="edit"
        initial={{
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          models: provider.models,
          notes: provider.notes,
          hasApiKey: provider.apiKey.length > 0,
        }}
      />
    </div>
  );
}
