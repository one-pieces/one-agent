"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KnowledgeBase } from "@/lib/db";

export default function KnowledgePage() {
  const router = useRouter();
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [fileCounts, setFileCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 创建/编辑面板状态
  const [panelOpen, setPanelOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeBase | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rerank, setRerank] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/knowledge");
    const list = (await res.json()) as KnowledgeBase[];
    setBases(list);
    // 每个知识库的文件数（并行请求详情）
    const counts = await Promise.all(
      list.map(async (kb) => {
        try {
          const r = await fetch(`/api/knowledge/${kb.id}`);
          const detail = (await r.json()) as { files?: unknown[] };
          return [kb.id, detail.files?.length ?? 0] as const;
        } catch {
          return [kb.id, 0] as const;
        }
      }),
    );
    setFileCounts(Object.fromEntries(counts));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setRerank(false);
    setPanelOpen(true);
  }

  function openEdit(kb: KnowledgeBase) {
    setEditing(kb);
    setName(kb.name);
    setDescription(kb.description);
    setRerank(kb.useRerank);
    setPanelOpen(true);
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const body = JSON.stringify({ name: trimmed, description: description.trim(), useRerank: rerank });
      const res = editing
        ? await fetch(`/api/knowledge/${editing.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body,
          })
        : await fetch("/api/knowledge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPanelOpen(false);
      await refresh();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(kb: KnowledgeBase) {
    if (!confirm(`删除知识库「${kb.name}」？其 ${fileCounts[kb.id] ?? 0} 个文件与分块将一并删除。`)) return;
    await fetch(`/api/knowledge/${kb.id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>知识库</h1>
        <button className="btn primary" onClick={openCreate}>
          ＋ 新建知识库
        </button>
      </div>
      <p className="muted">
        上传 .txt / .md 文档，Agent 配置里勾选知识库后，对话时通过 knowledge_search 工具检索（关键词 BM25，无需向量库）。
      </p>

      {loading ? (
        <p className="muted">加载中…</p>
      ) : bases.length === 0 ? (
        <p className="muted">还没有知识库。点击「新建知识库」创建第一个。</p>
      ) : (
        <div className="kb-grid">
          {bases.map((kb) => (
            <div key={kb.id} className="card kb-card">
              <Link href={`/knowledge/${kb.id}`} className="kb-card-link" />
              <div className="card-main">
                <h2>{kb.name}</h2>
                {kb.description && <p className="kb-desc">{kb.description}</p>}
                <div className="card-sub">
                  <code>{kb.id}</code> · {fileCounts[kb.id] ?? 0} 个文件 · 更新于{" "}
                  {new Date(kb.updatedAt).toLocaleString("zh-CN")}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <Link href={`/knowledge/${kb.id}`} className="btn">
                  管理
                </Link>
                <button className="btn" onClick={() => openEdit(kb)}>
                  编辑
                </button>
                <button className="btn danger" onClick={() => void handleDelete(kb)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {panelOpen && (
        <div className="form panel">
          <h3>{editing ? `编辑知识库：${editing.name}` : "新建知识库"}</h3>
          <div className="field">
            <label>名称 *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="公司产品手册" autoFocus />
          </div>
          <div className="field">
            <label>描述（可选）</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <label className="tool-item" style={{ margin: "8px 0" }}>
            <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} />
            <span>
              <code>cross-encoder 重排</code>
              <small>检索后精算相关性（首次触发需下载重排模型）</small>
            </span>
          </label>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="btn primary" onClick={() => void handleSave()} disabled={saving || !name.trim()}>
              {saving ? "保存中…" : "保存"}
            </button>
            <button className="btn" onClick={() => setPanelOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
