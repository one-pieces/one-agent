"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenIcon, SettingsIcon } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import SessionSidebar from "@/components/SessionSidebar";

/**
 * 左侧单列侧边栏（对齐线框图）：
 *   主体：会话树（Agent → 对话，点对话在主区打开）
 *   底部：主题切换 + 知识库 + 设置
 */
interface AppSidebarProps {
  activeSessionId: string | null;
  onOpenSession?: (sessionId: string) => boolean;
  onSessionDeleted?: (sessionId: string) => void;
}

export default function AppSidebar({ activeSessionId, onOpenSession, onSessionDeleted }: AppSidebarProps) {
  const pathname = usePathname() ?? "";
  const knowledgeActive = pathname.startsWith("/knowledge");
  const settingsActive =
    pathname.startsWith("/settings") || pathname.startsWith("/providers") || pathname.startsWith("/logs");

  return (
    <aside className="app-sidebar">
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
          href="/knowledge"
          className={`app-sidebar-bottom-item${knowledgeActive ? " active" : ""}`}
          title="知识库"
        >
          <BookOpenIcon size={16} />
          <span>知识库</span>
        </Link>
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
