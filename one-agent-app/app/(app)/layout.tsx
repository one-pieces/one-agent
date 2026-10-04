"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import AppSidebar from "@/components/AppSidebar";
import Chat from "@/components/Chat";
import type { AgentConfig } from "@one-agent/core";

/** /chat 首页内联打开的会话（存 sessionStorage，同一标签页刷新后仍停在原对话） */
const INLINE_KEY = "one-agent:chat-inline-session";

/**
 * 应用外壳（route group 不影响 URL）：左侧单列侧边栏 + 右侧主区。
 *
 * 侧边栏常驻（导航 + 会话树 + 设置），所以会话的打开逻辑提到这一层：
 * - 在 /chat 首页点会话 → 主区就地渲染该会话（不跳路由）
 * - 其它路由点会话 → 走 /chat/session/[id]
 * 主区默认渲染各路由页面自身（= 对应导航项的内容）。
 */
export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const isChatHome = pathname === "/chat";
  const sessionMatch = pathname.match(/^\/chat\/session\/([^/]+)/);

  const [inlineSessionId, setInlineSessionId] = useState<string | null>(null);
  const [inlineAgent, setInlineAgent] = useState<AgentConfig | null>(null);
  const [inlineError, setInlineError] = useState("");

  // 回到 /chat 首页时恢复上次内联打开的会话
  useEffect(() => {
    if (!isChatHome) return;
    try {
      const saved = sessionStorage.getItem(INLINE_KEY);
      if (saved) setInlineSessionId(saved);
    } catch {
      /* 隐私模式忽略 */
    }
  }, [isChatHome]);

  // 内联会话：拉会话 → 拉该 agent 配置（对话历史由 Chat 自己加载）
  useEffect(() => {
    if (!isChatHome || !inlineSessionId) {
      setInlineAgent(null);
      return;
    }
    let cancelled = false;
    setInlineError("");
    (async () => {
      try {
        const sres = await fetch(`/api/sessions/${inlineSessionId}`);
        if (!sres.ok) throw new Error(`会话不存在或已被删除（HTTP ${sres.status}）`);
        const session = (await sres.json()) as { agentId?: string };
        if (!session.agentId) throw new Error("会话缺少 agentId");
        const ares = await fetch(`/api/agents/${session.agentId}`);
        if (!ares.ok) throw new Error(`Agent 不存在（HTTP ${ares.status}）`);
        const agent = (await ares.json()) as AgentConfig;
        if (!cancelled) setInlineAgent(agent);
      } catch (err) {
        if (!cancelled) {
          setInlineAgent(null);
          setInlineError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isChatHome, inlineSessionId]);

  const clearInline = useCallback(() => {
    setInlineSessionId(null);
    setInlineAgent(null);
    setInlineError("");
    try {
      sessionStorage.removeItem(INLINE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  /** 侧边栏点对话：/chat 首页就地打开（返回 true = 已处理，不跳路由） */
  const openSession = useCallback(
    (sessionId: string) => {
      if (!isChatHome) return false;
      setInlineSessionId(sessionId);
      try {
        sessionStorage.setItem(INLINE_KEY, sessionId);
      } catch {
        /* ignore */
      }
      return true;
    },
    [isChatHome],
  );

  const showInline = isChatHome && Boolean(inlineSessionId);
  const activeSessionId = sessionMatch?.[1] ?? (isChatHome ? inlineSessionId : null);

  return (
    <div className="app-shell">
      <AppSidebar
        activeSessionId={activeSessionId}
        onOpenSession={isChatHome ? openSession : undefined}
        onSessionDeleted={isChatHome ? clearInline : undefined}
      />
      <main className="app-main">
        {showInline ? (
          <div className="chat-main">
            {inlineAgent ? (
              <Chat sessionId={inlineSessionId as string} agent={inlineAgent} />
            ) : (
              <div className="empty-state">
                <h1 className="empty-title">{inlineError ? "打不开这段对话" : "正在加载对话…"}</h1>
                {inlineError && <p className="empty-sub">{inlineError}</p>}
                <button className="btn" onClick={clearInline}>
                  返回
                </button>
                <p className="empty-hint">也可以直接从左侧换一个对话</p>
              </div>
            )}
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
