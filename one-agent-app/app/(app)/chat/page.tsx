import Link from "next/link";

/** /chat 空状态：Agent 列表在左侧侧边栏，主区提供进入 Agent 页面的入口 */
export default function ChatHomePage() {
  return (
    <div className="empty-state">
      <h1 className="empty-title">one-agent</h1>
      <p className="empty-sub">从左侧选择一个 Agent 开始对话，或在 Agents 页新建与管理。</p>
      <Link href="/agents" className="btn primary">
        进入 Agent 页面 →
      </Link>
      <p className="empty-hint">Agent 列表已移至左侧栏，点击即可进入对话。</p>
    </div>
  );
}
