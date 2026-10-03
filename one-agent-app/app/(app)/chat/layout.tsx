"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import SessionSidebar from "@/components/SessionSidebar";
import Chat from "@/components/Chat";
import type { AgentConfig } from "@one-agent/core";

/** /chat 首页内联打开的会话（存 sessionStorage，同一标签页刷新后仍停在原对话） */
const INLINE_KEY = "one-agent:chat-inline-session";

/**
 * 聊天布局（方案 A）：左侧会话侧边栏 + 右侧对话区。
 *
 * 当前 Agent 从 URL 解析：/chat/agent/[agentId] 直接取；/chat/session/[sessionId] 查会话的 agentId。
 *
 * 闪烁优化：从 /chat/agent/xxx 跳转到 /chat/session/yyy 时，agentMatch 立即失效，
 * 而 sessionAgentId 需要异步 fetch 才能拿到 —— 跳转瞬间 agentId 会变成 null，
 * 导致侧边栏先渲染成"Agent 列表"再切回"会话列表"（闪烁）。
 * 用 ref 缓存最近一次已知的 agentId，fetch 返回前沿用旧值，避免闪烁。
 *
 * /chat 首页：侧边栏平铺所有 Agent 的对话，**点对话不跳路由**，直接在右侧渲染该会话。
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isChatHome = pathname === "/chat";
  const agentMatch = pathname.match(/^\/chat\/agent\/([^/]+)/);
  const sessionMatch = pathname.match(/^\/chat\/session\/([^/]+)/);
  const [sessionAgentId, setSessionAgentId] = useState<string | null>(null);
  // 最近一次已知的 agentId（agent 页 URL 直接写入；session 页 fetch 成功后写入）
  const lastAgentIdRef = useRef<string | null>(null);

  // ── /chat 首页的内联会话 ──
  const [inlineSessionId, setInlineSessionId] = useState<string | null>(null);
  const [inlineAgent, setInlineAgent] = useState<AgentConfig | null>(null);
  const [inlineError, setInlineError] = useState("");

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

  /** 侧边栏点对话：/chat 首页就地打开（返回 true = 已处理，侧边栏不跳路由） */
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

  // 计算当前 agentId：agent 页直接取；session 页优先用 fetch 结果，
  // 未返回时沿用缓存值（避免跳转瞬间闪成 Agent 列表）
  const agentId = agentMatch?.[1] ?? sessionAgentId ?? (sessionMatch ? lastAgentIdRef.current : null);
  // /chat 首页：内联选中的会话也要高亮（侧边栏此时仍是"平铺所有 Agent"模式）
  const activeSessionId = sessionMatch?.[1] ?? (isChatHome ? inlineSessionId : null);

  /** /chat 首页且已选中会话 → 右侧渲染该会话；否则渲染路由页面自身 */
  const showInline = isChatHome && Boolean(inlineSessionId);

  return (
    <div className="chat-layout">
      <SessionSidebar
        agentId={agentId}
        activeSessionId={activeSessionId}
        onOpenSession={isChatHome ? openSession : undefined}
        onSessionDeleted={isChatHome ? clearInline : undefined}
      />
      <div className="chat-main">
        {showInline ? (
          inlineAgent ? (
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
          )
        ) : (
          children
        )}
      </div>
    </div>
  );
}
