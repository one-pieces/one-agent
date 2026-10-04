import AgentToolsPanel from "@/components/AgentToolsPanel";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Agent 详情 · 工具（/agents/[id]/tools）—— 运行时动态启停工具 + 规划规程 */
export default async function AgentToolsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = db.getAgent(id)!;

  return <AgentToolsPanel agentId={id} initial={config} />;
}
