import Link from "next/link";
import { db } from "@/lib/db";
import { ensureProviderMigration } from "@/lib/providers";
import DeleteAgentButton from "@/components/DeleteAgentButton";

export const dynamic = "force-dynamic";

export default function AgentsPage() {
  ensureProviderMigration();
  const agents = db.listAgents();
  /** providerId → 供应商名（列表上直接看出这个 agent 用的哪家连接） */
  const providerName = new Map(db.listProviders().map((p) => [p.id, p.name]));
  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Agents</h1>
        <Link href="/agents/new" className="btn primary">
          ＋ 新建 Agent
        </Link>
      </div>
      {agents.length === 0 ? (
        <p className="muted">还没有 Agent。点击「新建 Agent」创建一个，动态配置模型与工具。</p>
      ) : (
        agents.map((a) => (
          <div key={a.id} className="card">
            <div className="card-main">
              <h2>{a.name}</h2>
              <div className="card-sub card-sub-wrap">
                <code>{a.id}</code> ·{" "}
                {a.providerId ? (
                  <>
                    <Link href="/settings/providers">{providerName.get(a.providerId) ?? a.providerId}</Link> /{" "}
                  </>
                ) : (
                  <>{a.model.provider} / </>
                )}
                {a.model.modelId} · 工具 {a.tools.filter((t) => t.enabled).length} 个
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <Link href={`/agents/${a.id}`} className="btn">
                详情 / 编辑
              </Link>
              <DeleteAgentButton agentId={a.id} />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
