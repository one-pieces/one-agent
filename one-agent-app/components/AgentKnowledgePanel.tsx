"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AgentConfig } from "@one-agent/core";
import type { KnowledgeBase } from "@/lib/db";
import { Switch } from "@/components/ui/Switch";

/**
 * Agent 详情 · 知识库页：关联/取消关联知识库。
 * 关联后自动启用 knowledge_search 工具，全部取消则移除（同一段 PATCH 一起提交，避免两处状态打架）。
 */
export default function AgentKnowledgePanel({ agentId, initial }: { agentId: string; initial: AgentConfig }) {
  const router = useRouter();
  const [bases, setBases] = useState<KnowledgeBase[] | null>(null);
  const [selected, setSelected] = useState<string[]>(initial.knowledgeBaseIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    fetch("/api/knowledge")
      .then((r) => r.json())
      .then((list: KnowledgeBase[]) => setBases(list))
      .catch(() => setBases([]));
  }, []);

  const toggle = (kbId: string) => {
    setSelected((prev) => (prev.includes(kbId) ? prev.filter((x) => x !== kbId) : [...prev, kbId]));
    setSaved("");
  };

  const submit = async () => {
    setError("");
    setSaved("");
    setSaving(true);
    try {
      // 工具列表：以当前配置为基准，按是否还关联知识库增删 knowledge_search
      const tools = initial.tools.map((t) => ({ ...t }));
      const has = tools.some((t) => t.name === "knowledge_search");
      if (selected.length > 0 && !has) tools.push({ name: "knowledge_search", enabled: true });
      if (selected.length === 0) {
        const idx = tools.findIndex((t) => t.name === "knowledge_search");
        if (idx >= 0) tools.splice(idx, 1);
      }
      const res = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseIds: selected, tools }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSelected((data.knowledgeBaseIds ?? []) as string[]);
      setSaved(`已保存（${new Date().toLocaleTimeString("zh-CN")}）· 下一次对话生效`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form">
      <p className="muted" style={{ marginTop: 0 }}>
        关联后对话时模型会按需检索这些知识库（自动启用 <code>knowledge_search</code> 工具）。
      </p>

      {bases === null ? (
        <p className="muted">加载知识库…</p>
      ) : bases.length === 0 ? (
        <p className="muted">
          还没有知识库。{" "}
          <Link href="/knowledge" className="muted" style={{ textDecoration: "underline" }}>
            去创建 →
          </Link>
        </p>
      ) : (
        <div className="tool-list">
          {bases.map((kb) => (
            <div key={kb.id} className="tool-item tool-item-switch">
              <div className="tool-item-info">
                <div className="tool-item-name">
                  <code>{kb.name}</code>
                </div>
                <small>
                  {kb.description || kb.id}
                </small>
              </div>
              <Switch checked={selected.includes(kb.id)} onCheckedChange={() => toggle(kb.id)} />
            </div>
          ))}
        </div>
      )}

      {selected.length > 0 && (
        <p className="muted">已自动启用 knowledge_search 工具，对话时模型会按需检索知识库。</p>
      )}

      {error && <p className="error">{error}</p>}
      {saved && <p className="muted">{saved}</p>}
      <div className="actions">
        <button className="btn primary" onClick={() => void submit()} disabled={saving}>
          {saving ? "保存中…" : "保存知识库关联"}
        </button>
      </div>
    </div>
  );
}
