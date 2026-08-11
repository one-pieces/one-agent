"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import SessionSidebar from "@/components/SessionSidebar";

/**
 * 聊天布局（方案 A）：左侧会话侧边栏显示"当前 Agent"的会话。
 * 当前 Agent 从 URL 解析：/chat/agent/[agentId] 直接取；/chat/session/[sessionId] 查会话的 agentId。
 *
 * 闪烁优化：从 /chat/agent/xxx 跳转到 /chat/session/yyy 时，agentMatch 立即失效，
 * 而 sessionAgentId 需要异步 fetch 才能拿到 —— 跳转瞬间 agentId 会变成 null，
 * 导致侧边栏先渲染成"Agent 列表"再切回"会话列表"（闪烁）。
 * 用 ref 缓存最近一次已知的 agentId，fetch 返回前沿用旧值，避免闪烁。
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const agentMatch = pathname.match(/^\/chat\/agent\/([^/]+)/);
  const sessionMatch = pathname.match(/^\/chat\/session\/([^/]+)/);
  const [sessionAgentId, setSessionAgentId] = useState<string | null>(null);
  // 最近一次已知的 agentId（agent 页 URL 直接写入；session 页 fetch 成功后写入）
  const lastAgentIdRef = useRef<string | null>(null);

  // agent 页：直接记录 agentId
  useEffect(() => {
    if (agentMatch) lastAgentIdRef.current = agentMatch[1];
  }, [agentMatch?.[1]]);

  // session 页：异步查会话归属的 agentId
  useEffect(() => {
    if (sessionMatch) {
      let cancelled = false;
      fetch(`/api/sessions/${sessionMatch[1]}`)
        .then((r) => r.json())
        .then((s) => {
          if (cancelled) return;
          const aid = s?.agentId ?? null;
          setSessionAgentId(aid);
          if (aid) lastAgentIdRef.current = aid;
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

  // 计算当前 agentId：agent 页直接取；session 页优先用 fetch 结果，
  // 未返回时沿用缓存值（避免跳转瞬间闪成 Agent 列表）
  const agentId = agentMatch?.[1] ?? sessionAgentId ?? (sessionMatch ? lastAgentIdRef.current : null);
  const activeSessionId = sessionMatch?.[1] ?? null;

  return (
    <div className="chat-layout">
      <SessionSidebar agentId={agentId} activeSessionId={activeSessionId} />
      <div className="chat-main">{children}</div>
    </div>
  );
}
