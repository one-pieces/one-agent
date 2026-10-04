import AgentForm from "@/components/AgentForm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Agent 配置页（/agents/[id]）—— 基础配置：名称 / 系统指令 / 模型 / 记忆与限制。
 * 工具、知识库、客服组件已拆到二级导航的独立子页（/tools、/knowledge、/widget）；
 * 标题栏与左侧二级导航在外层 layout（app/(app)/agents/[id]/layout.tsx）。
 */
export default async function AgentConfigPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = db.getAgent(id)!;

  return (
    <>
      <h3 style={{ marginTop: 0 }}>基础配置（动态编辑，保存后即时生效）</h3>
      <AgentForm mode="edit" initial={config} />
    </>
  );
}
