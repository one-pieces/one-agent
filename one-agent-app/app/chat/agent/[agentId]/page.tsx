import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import NewSessionButton from "@/components/NewSessionButton";

export const dynamic = "force-dynamic";

/** /chat/agent/[agentId] 空状态：该 Agent 的会话从侧边栏选择，主区提示新建 */
export default async function ChatAgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const config = db.getAgent(agentId);
  if (!config) notFound();

  return (
    <div className="empty-state">
      <h1 className="empty-title">{config.name}</h1>
      <p className="empty-sub">
        模型：{config.model.modelId} · 工具：{config.tools.filter((t) => t.enabled).length} 个
      </p>
      <NewSessionButton agentId={agentId} />
      <p className="empty-hint">也可以从左侧选择一个已有会话继续</p>
    </div>
  );
}
