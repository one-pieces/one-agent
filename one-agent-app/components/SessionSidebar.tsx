"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, BotIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { Session } from "@one-agent/core";

interface SessionSidebarProps {
  agentId: string | null;
  activeSessionId: string | null;
  /**
   * 宿主自定义"打开会话"的行为。返回 true = 已处理（例如 /chat 首页把对话内联渲染在右侧，不跳路由）；
   * 返回 false/未提供 = 侧边栏自己 router.push 到 /chat/session/[id]。
   */
  onOpenSession?: (sessionId: string) => boolean;
  /** 当前高亮的会话被删除时通知宿主（/chat 内联模式下需要清掉右侧） */
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
 * 会话侧边栏
 * - 有 agentId（/chat/agent/*、/chat/session/*）：显示该 Agent 的会话列表
 * - 无 agentId（/chat 首页）：把**所有 Agent 的对话平铺**成可折叠分组 —— 点 Agent 行收起/展开，
 *   展开后是该 Agent 的对话（含客服访客会话，带来源标记）
 */
export default function SessionSidebar({ agentId, activeSessionId, onOpenSession, onSessionDeleted }: SessionSidebarProps) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentName, setAgentName] = useState<string | null>(null);
  /** /chat 首页用：所有会话的轻量摘要 */
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  /** 各 Agent 分组的收起状态（记忆在 localStorage） */
  const [collapsedAgents, setCollapsedAgents] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setCollapsedAgents(readCollapsed());
  }, []);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setSessions([]);
      setAgentName(null);
      // /chat 首页：Agent 列表 + 全量会话摘要（并发拉取）
      try {
        const [agentsRes, sessionsRes] = await Promise.all([fetch("/api/agents"), fetch("/api/sessions?summary=1")]);
        if (agentsRes.ok) setAgents(await agentsRes.json());
        if (sessionsRes.ok) setSummaries(await sessionsRes.json());
      } catch {
        /* ignore */
      }
      return;
    }
    setAgents([]);
    setSummaries([]);
    // 拉取 Agent 配置用于侧边栏标题（显示名字而非 id）
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
      if (res.ok) {
        const cfg = await res.json();
        setAgentName(cfg.name ?? null);
      }
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch(`/api/sessions?agentId=${encodeURIComponent(agentId)}`);
      if (res.ok) setSessions(await res.json());
    } catch {
      /* ignore */
    }
  }, [agentId]);

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

  const handleNew = async (targetAgentId?: string) => {
    const id = targetAgentId ?? agentId;
    if (!id) return;
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: id }),
      });
      const session = await res.json();
      if (!res.ok) throw new Error(session.error ?? "创建失败");
      openSession(session.id);
      // 通知侧边栏刷新列表：内联打开时不会换路由，新会话否则不会出现在左侧列表里
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
        else router.push(`/chat/agent/${agentId}`);
      }
    } catch {
      /* ignore */
    }
  };

  const title = (s: Session): string => {
    const t = (s.meta as { title?: string } | undefined)?.title;
    return t && t.length > 0 ? t : s.id;
  };

  /** 会话 token 摘要（与 Chat.tsx token-badge 一致：↑输入 ↓输出 ◎缓存命中 ＋缓存写入） */
  const tokenSummary = (s: Session): string => {
    const u = (s.meta as { tokenUsage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number } } | undefined)?.tokenUsage;
    if (!u || (u.inputTokens ?? 0) === 0 && (u.outputTokens ?? 0) === 0) return "暂无 token";
    const parts = [`↑${(u.inputTokens ?? 0).toLocaleString()} ↓${(u.outputTokens ?? 0).toLocaleString()}`];
    if ((u.cachedTokens ?? 0) > 0) parts.push(`◎${(u.cachedTokens ?? 0).toLocaleString()}`);
    if ((u.cacheCreationTokens ?? 0) > 0) parts.push(`＋${(u.cacheCreationTokens ?? 0).toLocaleString()}`);
    return parts.join(" ");
  };

  const summaryLine = (s: SessionSummary): string => {
    const u = s.tokenUsage;
    if (!u || ((u.inputTokens ?? 0) === 0 && (u.outputTokens ?? 0) === 0)) return `${s.messageCount} 条消息`;
    return `↑${(u.inputTokens ?? 0).toLocaleString()} ↓${(u.outputTokens ?? 0).toLocaleString()}`;
  };

  /** /chat 首页：按 Agent 分组（最近有对话的排前面，组内按最后活动倒序） */
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

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <button className="sidebar-icon-btn" onClick={() => router.push("/chat")} title="返回选择 Agent">
          <ArrowLeftIcon size={18} />
        </button>
        <button className="sidebar-icon-btn" onClick={() => setCollapsed(false)} title="展开侧边栏">
          <PanelLeftOpenIcon size={18} />
        </button>
        {agentId ? (
          <button className="sidebar-icon-btn" onClick={() => void handleNew()} title="新建对话">
            <PlusIcon size={18} />
          </button>
        ) : (
          <button className="sidebar-icon-btn" onClick={() => router.push("/agents")} title="管理 Agent">
            <BotIcon size={18} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-left">
          {agentId && (
            <button className="sidebar-icon-btn" onClick={() => router.push("/chat")} title="返回选择 Agent">
              <ArrowLeftIcon size={16} />
            </button>
          )}
          <span className="sidebar-title">{agentId ? (agentName ?? agentId) : "会话 Agent"}</span>
        </div>
        <div className="sidebar-header-actions">
          {agentId ? (
            <button className="sidebar-icon-btn" onClick={() => void handleNew()} disabled={!agentId} title="新建对话">
              <PlusIcon size={16} />
            </button>
          ) : (
            <button className="sidebar-icon-btn" onClick={() => router.push("/agents")} title="管理 Agent">
              <BotIcon size={16} />
            </button>
          )}
          <button className="sidebar-icon-btn" onClick={() => setCollapsed(true)} title="折叠侧边栏">
            <PanelLeftCloseIcon size={16} />
          </button>
        </div>
      </div>

      <div className="sidebar-list">
        {!agentId ? (
          groups.length === 0 ? (
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
          )
        ) : sessions.length === 0 ? (
          <p className="sidebar-empty">暂无会话，点击上方 ＋ 新建</p>
        ) : (
          <ul>
            {sessions.map((s) => (
              <li key={s.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => openSession(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") openSession(s.id);
                  }}
                  className={`sidebar-item${activeSessionId === s.id ? " active" : ""}`}
                >
                  <span className="sidebar-item-body">
                    <span className="sidebar-item-title">{title(s)}</span>
                    <span className="sidebar-item-sub">{tokenSummary(s)}</span>
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
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-footer">
        <span className="sidebar-count">
          {agentId ? `${sessions.length} 个会话` : `${agents.length} 个 Agent · ${summaries.length} 段对话`}
        </span>
      </div>
    </div>
  );
}
