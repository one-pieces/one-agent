import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import AgentForm from "@/components/AgentForm";
import NewSessionButton from "@/components/NewSessionButton";
import DeleteAgentButton from "@/components/DeleteAgentButton";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = db.getAgent(id);
  if (!config) notFound();

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1>{config.name}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href={`/chat/agent/${id}`} className="btn primary">
            进入对话
          </Link>
          <NewSessionButton agentId={id} />
          <DeleteAgentButton agentId={id} />
        </div>
      </div>

      <p className="muted">
        <code>{config.id}</code> · {config.model.provider} / {config.model.modelId} · 工具{" "}
        {config.tools.filter((t) => t.enabled).length} 个
      </p>

      <h3>配置（动态编辑，保存后即时生效）</h3>
      <AgentForm mode="edit" initial={config} />
    </div>
  );
}
