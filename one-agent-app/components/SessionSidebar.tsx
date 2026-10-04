"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BotIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { Session } from "@one-agent/core";

interface SessionSidebarProps {
  /** 当前高亮的会话（内联打开或路由上的会话） */
  activeSessionId: string | null;
  /**
   * 宿主自定义“打开会话”的行为。返回 true = 已处理（例如 /chat 首页把对话内联渲染在右侧，不跳路由）；
   * 返回 false/未提供 = 自己 router.push 到 /chat/session/[id]。
   */
  onOpenSession?: (sessionId: string) => boolean;
  /** 当前高亮的会话被删除时通知宿主 */
  onSessionDeleted?: (sessionId: string) => void;
}

interface AgentListItem {
  id: string;
  name: string;
  model: { modelId: string };
  tools: Array<{ name: string; enabled: boolean }>;
}

/** /api/sessions?summary=1 的轻量行（不带 messages） */
interface SessionSummary {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  tokenUsage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number } | null;
  /** 客服访客来源（内部会话为 null） */
  widgetOrigin: string | null;
}

const COLLAPSE_KEY = "one-agent:sidebar-collapsed-agents";

function readCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * 会话树（侧边栏主体，对应线框图里横线以下的列表）
 * 按 Agent 分组平铺：点 Agent 行收起/展开，展开后是该 Agent 的对话（含客服访客会话，带来源标记）。
 */
export default function SessionSidebar({ activeSessionId, onOpenSession, onSessionDeleted }: SessionSidebarProps) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  /** 所有会话的轻量摘要 */
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  /** 各 Agent 分组的收起状态（记忆在 localStorage） */
  const [collapsedAgents, setCollapsedAgents] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setCollapsedAgents(readCollapsed());
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [agentsRes, sessionsRes] = await Promise.all([fetch("/api/agents"), fetch("/api/sessions?summary=1")]);
      if (agentsRes.ok) setAgents(await agentsRes.json());
      if (sessionsRes.ok) setSummaries(await sessionsRes.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handler = () => void refresh();
    window.addEventListener("one-agent:sessions-changed", handler);
    return () => window.removeEventListener("one-agent:sessions-changed", handler);
  }, [refresh]);

  /** 打开会话：宿主能处理（内联展示）就不跳路由 */
  const openSession = (sessionId: string) => {
    if (onOpenSession?.(sessionId)) return;
    router.push(`/chat/session/${sessionId}`);
  };

  const handleNew = async (targetAgentId: string) => {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: targetAgentId }),
      });
      const session = await res.json();
      if (!res.ok) throw new Error(session.error ?? "创建失败");
      openSession(session.id);
      // 通知侧边栏刷新列表：内联打开时不会换路由，新会话否则不会出现在列表里
      window.dispatchEvent(new Event("one-agent:sessions-changed"));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("删除该会话？")) return;
    try {
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      await refresh();
      if (activeSessionId === id) {
        if (onSessionDeleted) onSessionDeleted(id);
        else router.push("/chat");
      }
    } catch {
      /* ignore */
    }
  };

  /** 平铺模式的行副标题：只显示消息条数 */
  const summaryLine = (s: SessionSummary): string => `${s.messageCount} 条消息`;

  /** 按 Agent 分组（最近有对话的排前面，组内按最后活动倒序） */
  const groups = useMemo(() => {
    const byAgent = new Map<string, SessionSummary[]>();
    for (const s of summaries) {
      const list = byAgent.get(s.agentId) ?? [];
      list.push(s);
      byAgent.set(s.agentId, list);
    }
    for (const list of byAgent.values()) list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return agents
      .map((a) => {
        const list = byAgent.get(a.id) ?? [];
        return { agent: a, sessions: list, lastAt: list[0]?.updatedAt ?? "" };
      })
      .sort((x, y) => {
        if (x.lastAt === y.lastAt) return x.agent.name.localeCompare(y.agent.name, "zh-CN");
        if (!x.lastAt) return 1;
        if (!y.lastAt) return -1;
        return x.lastAt < y.lastAt ? 1 : -1;
      });
  }, [agents, summaries]);

  const toggleAgent = (id: string) => {
    setCollapsedAgents((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* 隐私模式忽略 */
      }
      return next;
    });
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-left">
          <span className="sidebar-title">工作区</span>
        </div>
        <div className="sidebar-header-actions">
          <button className="sidebar-icon-btn" onClick={() => router.push("/agents")} title="管理 Agent">
            <BotIcon size={16} />
          </button>
        </div>
      </div>

      <div className="sidebar-list">
        {groups.length === 0 ? (
          <p className="sidebar-empty">还没有 Agent，去 Agents 页新建。</p>
        ) : (
          <ul>
            {groups.map(({ agent, sessions: list }) => {
              const isCollapsed = collapsedAgents[agent.id] === true;
              return (
                <li key={agent.id}>
                  {/* Agent 行本身是收起/展开开关 */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={!isCollapsed}
                    data-agent-id={agent.id}
                    onClick={() => toggleAgent(agent.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleAgent(agent.id);
                      }
                    }}
                    className="sidebar-item sidebar-group-head"
                    title={isCollapsed ? "展开该 Agent 的对话" : "收起该 Agent 的对话"}
                  >
                    <ChevronRightIcon size={14} className={`sidebar-chevron${isCollapsed ? "" : " open"}`} />
                    <span className="sidebar-item-body">
                      <span className="sidebar-item-title">{agent.name}</span>
                      <span className="sidebar-item-sub">
                        {list.length > 0 ? `${list.length} 段对话` : "暂无对话"}
                        {agent.model?.modelId ? ` · ${agent.model.modelId}` : ""}
                      </span>
                    </span>
                    <button
                      className="sidebar-item-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleNew(agent.id);
                      }}
                      title="与该 Agent 新建对话"
                    >
                      <PlusIcon size={13} />
                    </button>
                  </div>

                  {!isCollapsed && (
                    <ul className="sidebar-sublist">
                      {list.length === 0 ? (
                        <li className="sidebar-sub-empty">暂无对话</li>
                      ) : (
                        list.map((s) => (
                          <li key={s.id}>
                            <div
                              role="button"
                              tabIndex={0}
                              data-session-id={s.id}
                              onClick={() => openSession(s.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") openSession(s.id);
                              }}
                              className={`sidebar-item sidebar-subitem${activeSessionId === s.id ? " active" : ""}`}
                            >
                              <span className="sidebar-item-body">
                                <span className="sidebar-item-title">{s.title}</span>
                                <span className="sidebar-item-sub">
                                  {s.widgetOrigin ? "客服访客 · " : ""}
                                  {summaryLine(s)}
                                </span>
                              </span>
                              <button
                                className="sidebar-item-delete"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleDelete(s.id);
                                }}
                                title="删除会话"
                              >
                                <Trash2Icon size={13} />
                              </button>
                            </div>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
