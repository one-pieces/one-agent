"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
/**
 * Agent 详情页的左侧二级导航：Agent 配置 / 对话记录。
 * 用 usePathname 判断高亮（配置页是索引路由 /agents/[id]，不是 /config）。
 */
export default function AgentSubNav({ agentId }: { agentId: string }) {
  const pathname = usePathname() ?? "";
  const base = `/agents/${agentId}`;
  const inSessions = pathname.startsWith(`${base}/sessions`);

  const items = [
    { href: base, label: "Agent 配置", active: !inSessions },
    { href: `${base}/sessions`, label: "对话记录", active: inSessions },
  ];

  return (
    <nav className="agent-subnav" aria-label="Agent 详情导航">
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          className={`agent-subnav-item${it.active ? " active" : ""}`}
          aria-current={it.active ? "page" : undefined}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
