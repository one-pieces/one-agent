"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenIcon, BotIcon, MessageSquareIcon, SettingsIcon } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";

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
    href: "/knowledge",
    label: "知识库",
    icon: BookOpenIcon,
    match: (p: string) => p.startsWith("/knowledge"),
  },
];

/** 底部固定项：设置（供应商、日志收进这里） */
const settingsItem = {
  href: "/settings",
  label: "设置",
  icon: SettingsIcon,
  match: (p: string) => p.startsWith("/settings") || p.startsWith("/providers") || p.startsWith("/logs"),
};

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
      <div className="app-nav-spacer" />
      <ThemeToggle />
      <Link
        href={settingsItem.href}
        className={`app-nav-item${settingsItem.match(pathname) ? " active" : ""}`}
        title={settingsItem.label}
      >
        <settingsItem.icon size={20} />
        <span>{settingsItem.label}</span>
      </Link>
    </nav>
  );
}
