import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import AgentSubNav from "@/components/AgentSubNav";
import DeleteAgentButton from "@/components/DeleteAgentButton";
import NewSessionButton from "@/components/NewSessionButton";

export const dynamic = "force-dynamic";

/**
 * Agent 详情布局：标题栏 + 左侧二级导航（Agent 配置 / 对话记录）+ 右侧内容。
 * 配置页（/agents/[id]）与对话记录页（/agents/[id]/sessions）共用这一层外壳。
 */
export default async function AgentDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const config = db.getAgent(id);
  if (!config) notFound();

  return (
    <div className="page">
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

      <div className="agent-split">
        <AgentSubNav agentId={id} />
        <div className="agent-split-body">{children}</div>
      </div>
    </div>
  );
}
