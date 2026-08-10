import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** /chat 空状态：选择 Agent 开始（方案 A 入口） */
export default function ChatHomePage() {
  const agents = db.listAgents();
  return (
    <div className="empty-state">
      <h1 className="empty-title">one-agent</h1>
      <p className="empty-sub">选择一个 Agent 开始对话，或在 Agents 页新建。</p>
      {agents.length === 0 ? (
        <Link href="/agents/new" className="btn primary">
          ＋ 新建 Agent
        </Link>
      ) : (
        <div className="empty-agent-list">
          {agents.map((a) => (
            <Link key={a.id} href={`/chat/agent/${a.id}`} className="card empty-agent-card">
              <div>
                <h2>{a.name}</h2>
                <div className="card-sub">
                  <code>{a.id}</code> · {a.model.modelId}
                </div>
              </div>
              <span className="btn">进入对话 →</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
