import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { kernel } from "@/lib/kernel";
import AgentForm from "@/components/AgentForm";
import NewSessionButton from "@/components/NewSessionButton";
import DeleteAgentButton from "@/components/DeleteAgentButton";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = db.getAgent(id);
  if (!config) notFound();
  const sessions = await kernel.listSessions(id);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>{config.name}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <NewSessionButton agentId={id} />
          <DeleteAgentButton agentId={id} />
        </div>
      </div>

      <h3>会话历史</h3>
      {sessions.length === 0 ? (
        <p className="muted">暂无会话。点击「新建对话」开始。</p>
      ) : (
        <div className="session-list">
          {sessions.map((s) => (
            <Link key={s.id} href={`/chat/${s.id}`} className="session-item">
              <span>
                <code>{s.id}</code>
              </span>
              <span className="muted">{s.messages.length} 条消息 · {new Date(s.updatedAt).toLocaleString("zh-CN")}</span>
            </Link>
          ))}
        </div>
      )}

      <h3>配置（动态编辑，保存后即时生效）</h3>
      <AgentForm mode="edit" initial={config} />
    </div>
  );
}
