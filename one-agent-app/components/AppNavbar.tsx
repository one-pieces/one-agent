"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BotIcon, FileTextIcon, MessageSquareIcon } from "lucide-react";

const navItems = [
  {
    href: "/chat",
    label: "对话",
    icon: MessageSquareIcon,
    match: (p: string) => p === "/" || p.startsWith("/chat"),
  },
  {
    href: "/agents",
    label: "Agents",
    icon: BotIcon,
    match: (p: string) => p.startsWith("/agents"),
  },
  {
    href: "/logs",
    label: "日志",
    icon: FileTextIcon,
    match: (p: string) => p.startsWith("/logs"),
  },
];

/** 左侧图标导航栏（对齐 eve-agent 的 AppNavbar） */
export default function AppNavbar() {
  const pathname = usePathname();
  return (
    <nav className="app-nav">
      <Link href="/chat" className="app-nav-brand" title="one-agent">
        ⚡
      </Link>
      {navItems.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`app-nav-item${active ? " active" : ""}`}
            title={item.label}
          >
            <item.icon size={20} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
