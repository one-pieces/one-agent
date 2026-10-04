import AgentKnowledgePanel from "@/components/AgentKnowledgePanel";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Agent 详情 · 知识库（/agents/[id]/knowledge）—— 关联后对话可检索 */
export default async function AgentKnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = db.getAgent(id)!;

  return <AgentKnowledgePanel agentId={id} initial={config} />;
}
