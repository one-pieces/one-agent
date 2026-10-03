import Link from "next/link";

/** /chat 空状态：左侧平铺了所有 Agent 的对话，点一条即可在右侧直接查看（不跳路由） */
export default function ChatHomePage() {
  return (
    <div className="empty-state">
      <h1 className="empty-title">one-agent</h1>
      <p className="empty-sub">
        左侧列出了所有 Agent 与它们的对话记录，<strong>点任意一条即可在右侧查看</strong>；点 Agent 行可收起/展开。
      </p>
      <p className="empty-hint">想开新对话：把鼠标移到左侧某个 Agent 上，点行尾的 ＋ 直接和它聊。</p>
      <Link href="/agents" className="btn">
        管理 Agent →
      </Link>
    </div>
  );
}
