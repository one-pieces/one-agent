import AgentForm from "@/components/AgentForm";

export default function NewAgentPage() {
  return (
    <div>
      <h1>新建 Agent</h1>
      <p className="muted">Agent 配置是一等数据（JSON）——模型、工具、指令全部可在运行时动态调整。</p>
      <AgentForm mode="new" />
    </div>
  );
}
