"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { KnowledgeBase, KnowledgeChunk, KnowledgeFile } from "@/lib/db";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Detail extends KnowledgeBase {
  files: KnowledgeFile[];
}

export default function KnowledgeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [kb, setKb] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadResults, setUploadResults] = useState<Array<{ name: string; ok: boolean; error?: string; chunkCount?: number }>>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  // 检索预览
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<KnowledgeChunk[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/knowledge/${id}`);
    if (!res.ok) return;
    setKb((await res.json()) as Detail);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0 || !kb || uploading) return;
    setUploading(true);
    setUploadResults([]);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("file", f);
      const res = await fetch(`/api/knowledge/${kb.id}/upload`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUploadResults(data.results ?? []);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteFile(file: KnowledgeFile) {
    if (!confirm(`删除文件「${file.name}」及其 ${file.chunkCount} 个分块？`)) return;
    await fetch(`/api/knowledge/${kb!.id}/files/${file.id}`, { method: "DELETE" });
    await load();
  }

  async function handleDeleteKb() {
    if (!kb || !confirm(`删除知识库「${kb.name}」及其全部文件？`)) return;
    await fetch(`/api/knowledge/${kb.id}`, { method: "DELETE" });
    router.push("/knowledge");
    router.refresh();
  }

  async function handleSearch() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/knowledge/${kb!.id}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, limit: 5 }),
      });
      const data = await res.json();
      setSearchResults(data.chunks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  async function handleEditSave() {
    if (!kb || !editName.trim()) return;
    const res = await fetch(`/api/knowledge/${kb.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: editName.trim(), description: editDesc.trim() }),
    });
    if (res.ok) {
      setEditOpen(false);
      await load();
    }
  }

  if (loading) return <div className="page"><p className="muted">加载中…</p></div>;
  if (!kb) return <div className="page"><p className="muted">知识库不存在</p></div>;

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1>
          <Link href="/knowledge" className="muted" style={{ marginRight: 10, textDecoration: "none" }}>
            ←
          </Link>
          {kb.name}
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => { setEditName(kb.name); setEditDesc(kb.description); setEditOpen(true); }}>
            编辑
          </button>
          <button className="btn danger" onClick={() => void handleDeleteKb()}>
            删除知识库
          </button>
        </div>
      </div>
      {kb.description && <p className="muted">{kb.description}</p>}
      <p className="muted">
        <code>{kb.id}</code> · {kb.files.length} 个文件 · 更新于 {new Date(kb.updatedAt).toLocaleString("zh-CN")}
      </p>

      {error && <p className="error">{error}</p>}

      <h3>上传文档（.txt / .md / .mdx，单个 ≤512KB）</h3>
      <div className="field-inline">
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.mdx,.markdown"
          multiple
          onChange={(e) => void handleUpload(e.target.files)}
        />
        <button className="btn primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? "上传中…" : "选择并上传"}
        </button>
      </div>
      {uploadResults.length > 0 && (
        <ul className="upload-results">
          {uploadResults.map((r, i) => (
            <li key={i} className={r.ok ? "ok" : "error"}>
              {r.name}：{r.ok ? `已索引 ${r.chunkCount} 个分块` : r.error}
            </li>
          ))}
        </ul>
      )}

      <h3>文件（{kb.files.length}）</h3>
      {kb.files.length === 0 ? (
        <p className="muted">还没有文件。上传 .txt / .md 文档后即可被 Agent 检索。</p>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th>文件名</th>
              <th>大小</th>
              <th>分块数</th>
              <th>上传时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {kb.files.map((f) => (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td>{formatBytes(f.size)}</td>
                <td>{f.chunkCount}</td>
                <td>{new Date(f.uploadedAt).toLocaleString("zh-CN")}</td>
                <td>
                  <button className="btn danger" onClick={() => void handleDeleteFile(f)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>检索预览（BM25 关键词）</h3>
      <div className="field-inline">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
          placeholder="输入关键词，例如：定价 政策"
        />
        <button className="btn primary" onClick={() => void handleSearch()} disabled={searching || !query.trim()}>
          {searching ? "检索中…" : "检索"}
        </button>
      </div>
      {searchResults.length > 0 && (
        <div className="search-results">
          {searchResults.map((c) => (
            <div key={c.id} className="search-hit">
              <div className="card-sub">
                【{c.fileName ?? "未知来源"}】片段 {c.chunkIndex + 1}
              </div>
              <p>{c.content}</p>
            </div>
          ))}
        </div>
      )}
      {searching === false && query.trim() !== "" && searchResults.length === 0 && (
        <p className="muted">未检索到相关内容。</p>
      )}

      {editOpen && (
        <div className="form panel">
          <h3>编辑知识库</h3>
          <div className="field">
            <label>名称 *</label>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>
          <div className="field">
            <label>描述</label>
            <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={2} />
          </div>
          <div className="actions">
            <button className="btn primary" onClick={() => void handleEditSave()} disabled={!editName.trim()}>
              保存
            </button>
            <button className="btn" onClick={() => setEditOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
