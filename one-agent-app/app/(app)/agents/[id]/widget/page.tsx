import WidgetSettingsCard from "@/components/WidgetSettingsCard";

export const dynamic = "force-dynamic";

/** Agent 详情 · 客服组件（/agents/[id]/widget）—— 嵌入网站的一行 JS SDK */
export default async function AgentWidgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return <WidgetSettingsCard agentId={id} />;
}
