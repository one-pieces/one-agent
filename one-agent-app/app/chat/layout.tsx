"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import SessionSidebar from "@/components/SessionSidebar";

/**
 * 聊天布局（方案 A）：左侧会话侧边栏显示"当前 Agent"的会话。
 * 当前 Agent 从 URL 解析：/chat/agent/[agentId] 直接取；/chat/session/[sessionId] 查会话的 agentId。
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const agentMatch = pathname.match(/^\/chat\/agent\/([^/]+)/);
  const sessionMatch = pathname.match(/^\/chat\/session\/([^/]+)/);
  const [sessionAgentId, setSessionAgentId] = useState<string | null>(null);

  useEffect(() => {
    if (sessionMatch) {
      let cancelled = false;
      fetch(`/api/sessions/${sessionMatch[1]}`)
        .then((r) => r.json())
        .then((s) => {
          if (!cancelled) setSessionAgentId(s?.agentId ?? null);
        })
        .catch(() => {
          if (!cancelled) setSessionAgentId(null);
        });
      return () => {
        cancelled = true;
      };
    }
    setSessionAgentId(null);
  }, [sessionMatch?.[1]]);

  const agentId = agentMatch?.[1] ?? sessionAgentId;
  const activeSessionId = sessionMatch?.[1] ?? null;

  return (
    <div className="chat-layout">
      <SessionSidebar agentId={agentId} activeSessionId={activeSessionId} />
      <div className="chat-main">{children}</div>
    </div>
  );
}
