"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Agent 详情页的左侧二级导航：Agent 配置 / 工具 / 知识库 / 客服组件 / 对话记录。
 * 用 usePathname 判断高亮（配置页是索引路由 /agents/[id]，不是 /config）。
 */
export default function AgentSubNav({ agentId }: { agentId: string }) {
  const pathname = usePathname() ?? "";
  const base = `/agents/${agentId}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";

  const items = [
    { href: base, label: "Agent 配置", active: rest === "" || rest === "/" },
    { href: `${base}/tools`, label: "工具", active: rest.startsWith("/tools") },
    { href: `${base}/knowledge`, label: "知识库", active: rest.startsWith("/knowledge") },
    { href: `${base}/widget`, label: "客服组件", active: rest.startsWith("/widget") },
    { href: `${base}/sessions`, label: "对话记录", active: rest.startsWith("/sessions") },
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
