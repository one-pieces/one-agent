"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SettingsIcon } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import SessionSidebar from "@/components/SessionSidebar";

/**
 * 左侧单列侧边栏（对齐线框图）：
 *   顶部：标题 Agent（→ 对话首页）+ 导航项 知识库
 *   —— 横线 ——
 *   中部：会话树（Agent → 对话，点对话在主区打开）
 *   底部：主题切换 + 设置
 */
const navItems = [
  { href: "/knowledge", label: "知识库", match: (p: string) => p.startsWith("/knowledge") },
];

interface AppSidebarProps {
  activeSessionId: string | null;
  onOpenSession?: (sessionId: string) => boolean;
  onSessionDeleted?: (sessionId: string) => void;
}

export default function AppSidebar({ activeSessionId, onOpenSession, onSessionDeleted }: AppSidebarProps) {
  const pathname = usePathname() ?? "";
  const settingsActive =
    pathname.startsWith("/settings") || pathname.startsWith("/providers") || pathname.startsWith("/logs");

  return (
    <aside className="app-sidebar">
      <div className="app-sidebar-top">
        <Link href="/chat" className="app-sidebar-title" title="对话首页">
          Agent
        </Link>
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`app-sidebar-nav-item${item.match(pathname) ? " active" : ""}`}
          >
            {item.label}
          </Link>
        ))}
      </div>

      <div className="app-sidebar-divider" />

      <div className="app-sidebar-tree">
        <SessionSidebar
          activeSessionId={activeSessionId}
          onOpenSession={onOpenSession}
          onSessionDeleted={onSessionDeleted}
        />
      </div>

      <div className="app-sidebar-bottom">
        <ThemeToggle />
        <Link
          href="/settings"
          className={`app-sidebar-bottom-item${settingsActive ? " active" : ""}`}
          title="设置"
        >
          <SettingsIcon size={16} />
          <span>设置</span>
        </Link>
      </div>
    </aside>
  );
}
