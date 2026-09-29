"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BotIcon, GlobeIcon, SearchIcon, Trash2Icon } from "lucide-react";

/** 一行对话记录（服务端组装好，客户端只做过滤/展示） */
export interface AgentSessionRow {
  id: string;
  title: string;
  kind: "visitor" | "internal";
  /** 客服会话的访客来源（域名）；内部会话为 null */
  origin: string | null;
  userAgent: string | null;
  messageCount: number;
  userMessageCount: number;
  createdAt: string;
  updatedAt: string;
  lastSnippet: string;
  inputTokens: number;
  outputTokens: number;
}

type Filter = "all" | "visitor" | "internal";

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, "0");
  return sameDay ? `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 对话记录列表：每一行 = 一个"用户"与该 agent 的一段对话。
 * 客服会话（网站访客，带来源域名）与内部会话（后台自己聊的）分开标记，可按类型筛选与搜索。
 */
export default function AgentSessionsList({ agentId, rows }: { agentId: string; rows: AgentSessionRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.kind !== filter) return false;
      if (!q) return true;
      return [r.title, r.id, r.origin ?? "", r.userAgent ?? "", r.lastSnippet].join(" ").toLowerCase().includes(q);
    });
  }, [rows, filter, query]);

  const remove = async (id: string) => {
    if (!window.confirm("删除这段对话记录？不可恢复。")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
      window.dispatchEvent(new Event("one-agent:sessions-changed"));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="session-filters">
        <div className="seg">
          {(
            [
              ["all", "全部", rows.length],
              ["visitor", "客服会话", rows.filter((r) => r.kind === "visitor").length],
              ["internal", "内部会话", rows.filter((r) => r.kind === "internal").length],
            ] as Array<[Filter, string, number]>
          ).map(([value, label, count]) => (
            <button key={value} className={`seg-item${filter === value ? " active" : ""}`} onClick={() => setFilter(value)}>
              {label} <span className="seg-count">{count}</span>
            </button>
          ))}
        </div>
        <label className="session-search">
          <SearchIcon size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索标题 / 来源 / 内容…" />
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="muted">
          {rows.length === 0
            ? "还没有对话记录。在「对话」页与该 agent 聊几句，或把客服组件嵌入网站让访客来聊。"
            : "没有匹配的对话记录。"}
        </p>
      ) : (
        filtered.map((r) => (
          <div key={r.id} className="card session-row">
            <div className="card-main">
              <div className="session-row-head">
                <Link href={`/chat/session/${r.id}`} className="session-row-title">
                  {r.title}
                </Link>
                {r.kind === "visitor" ? (
                  <span className="tag tag-visitor" title={`访客来源${r.origin ? `：${r.origin}` : "未知"}`}>
                    <GlobeIcon size={11} /> 客服{r.origin ? ` · ${host(r.origin)}` : ""}
                  </span>
                ) : (
                  <span className="tag" title="在后台与该 agent 的对话">
                    <BotIcon size={11} /> 内部
                  </span>
                )}
              </div>
              {r.lastSnippet && <div className="session-row-snippet">{r.lastSnippet}</div>}
              <div className="card-sub session-row-meta">
                <code>{r.id}</code> · {r.messageCount} 条消息（用户 {r.userMessageCount}） · 最后活动 {formatTime(r.updatedAt)}
                {r.inputTokens + r.outputTokens > 0 && <> · ↑{r.inputTokens.toLocaleString()} ↓{r.outputTokens.toLocaleString()}</>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
              <Link href={`/chat/session/${r.id}`} className="btn">
                打开对话
              </Link>
              <button className="btn danger" disabled={busyId === r.id} title="删除这段对话记录" onClick={() => void remove(r.id)}>
                <Trash2Icon size={13} />
              </button>
            </div>
          </div>
        ))
      )}

      <p className="muted" style={{ marginTop: 8 }}>
        <Link href={`/chat/agent/${agentId}`}>进入该 agent 的对话页</Link> 可以继续聊；客服会话由网站访客在嵌入的组件里发起。
      </p>
    </>
  );
}
