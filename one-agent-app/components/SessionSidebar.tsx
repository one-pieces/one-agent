"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, BotIcon, MessageSquareIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { Session } from "@one-agent/core";

interface SessionSidebarProps {
  agentId: string | null;
  activeSessionId: string | null;
}

interface AgentListItem {
  id: string;
  name: string;
  model: { modelId: string };
  tools: Array<{ name: string; enabled: boolean }>;
}

/** 会话侧边栏（方案 A：显示"当前 Agent"的会话；可折叠；无 Agent 时显示 Agent 列表） */
export default function SessionSidebar({ agentId, activeSessionId }: SessionSidebarProps) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentName, setAgentName] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setSessions([]);
      setAgentName(null);
      // 无 Agent 上下文时拉取 Agent 列表（/chat 首页）
      try {
        const res = await fetch("/api/agents");
        if (res.ok) setAgents(await res.json());
      } catch {
        /* ignore */
      }
      return;
    }
    setAgents([]);
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

  const handleNew = async () => {
    if (!agentId) return;
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const session = await res.json();
      if (!res.ok) throw new Error(session.error ?? "创建失败");
      router.push(`/chat/session/${session.id}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("删除该会话？")) return;
    try {
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      await refresh();
      if (activeSessionId === id) router.push(`/chat/agent/${agentId}`);
    } catch {
      /* ignore */
    }
  };

  const title = (s: Session): string => {
    const t = (s.meta as { title?: string } | undefined)?.title;
    return t && t.length > 0 ? t : s.id;
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
          <span className="sidebar-title">
            {agentId ? (agentName ?? agentId) : "会话 Agent"}
          </span>
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
          agents.length === 0 ? (
            <p className="sidebar-empty">还没有 Agent，去 Agents 页新建。</p>
          ) : (
            <ul>
              {agents.map((a) => (
                <li key={a.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => router.push(`/chat/agent/${a.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") router.push(`/chat/agent/${a.id}`);
                    }}
                    className="sidebar-item"
                  >
                    <BotIcon size={15} className="sidebar-item-icon" />
                    <span className="sidebar-item-body">
                      <span className="sidebar-item-title">{a.name}</span>
                      <span className="sidebar-item-sub">
                        {a.model?.modelId ?? ""} · {a.tools?.filter((t) => t.enabled).length ?? 0} 个工具
                      </span>
                    </span>
                  </div>
                </li>
              ))}
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
                  onClick={() => router.push(`/chat/session/${s.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") router.push(`/chat/session/${s.id}`);
                  }}
                  className={`sidebar-item${activeSessionId === s.id ? " active" : ""}`}
                >
                  <MessageSquareIcon size={15} className="sidebar-item-icon" />
                  <span className="sidebar-item-title">{title(s)}</span>
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
          {agentId ? `${sessions.length} 个会话` : `${agents.length} 个 Agent`}
        </span>
      </div>
    </div>
  );
}
