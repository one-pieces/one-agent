"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, MessageSquareIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { Session } from "@one-agent/core";

interface SessionSidebarProps {
  agentId: string | null;
  activeSessionId: string | null;
}

/** 会话侧边栏（方案 A：显示"当前 Agent"的会话；可折叠） */
export default function SessionSidebar({ agentId, activeSessionId }: SessionSidebarProps) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setSessions([]);
      return;
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
        {agentId && (
          <button className="sidebar-icon-btn" onClick={() => void handleNew()} title="新建对话">
            <PlusIcon size={18} />
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
            {agentId ? <code>{agentId}</code> : "会话"}
          </span>
        </div>
        <div className="sidebar-header-actions">
          <button className="sidebar-icon-btn" onClick={() => void handleNew()} disabled={!agentId} title="新建对话">
            <PlusIcon size={16} />
          </button>
          <button className="sidebar-icon-btn" onClick={() => setCollapsed(true)} title="折叠侧边栏">
            <PanelLeftCloseIcon size={16} />
          </button>
        </div>
      </div>

      <div className="sidebar-list">
        {!agentId ? (
          <p className="sidebar-empty">先在 Agents 里选择一个 Agent 开始对话</p>
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
        <span className="sidebar-count">{sessions.length} 个会话</span>
      </div>
    </div>
  );
}
