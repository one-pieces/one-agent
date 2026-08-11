"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { KnowledgeBase, KnowledgeChunk, KnowledgeFile, KnowledgeIndexStatus } from "@/lib/db";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "-";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_META: Record<KnowledgeIndexStatus, { label: string; cls: string }> = {
  none: { label: "未建索引", cls: "kb-status-none" },
  building: { label: "构建中", cls: "kb-status-building" },
  done: { label: "已索引", cls: "kb-status-done" },
  error: { label: "失败", cls: "kb-status-error" },
};

interface VectorIndexItem {
  chunkId: string;
  fileName: string;
  chunkIndex: number;
  dim: number;
  embeddingPreview: number[];
  content: string;
}

interface Detail extends KnowledgeBase {
  files: KnowledgeFile[];
}

const VEC_LIMIT = 50;

export default function KnowledgeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [kb, setKb] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadResults, setUploadResults] = useState<Array<{ id: string; name: string; ok: boolean; error?: string }>>([]);

  // 编辑面板
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editRerank, setEditRerank] = useState(false);

  // 索引构建进度：fileId → percent
  const [buildProgress, setBuildProgress] = useState<Record<string, number>>({});
  const [buildFileId, setBuildFileId] = useState<string | null>(null);

  // 向量索引查看器
  const [vecOpen, setVecOpen] = useState(false);
  const [vecItems, setVecItems] = useState<VectorIndexItem[]>([]);
  const [vecTotal, setVecTotal] = useState(0);
  const [vecOffset, setVecOffset] = useState(0);
  const [vecSources, setVecSources] = useState<string[]>([]);
  const [vecSource, setVecSource] = useState("");
  const [vecLoading, setVecLoading] = useState(false);
  const [vecExpanded, setVecExpanded] = useState<string | null>(null);

  // 分块查看器
  const [chunksOpen, setChunksOpen] = useState(false);
  const [chunksFile, setChunksFile] = useState<KnowledgeFile | null>(null);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);

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

  /** SSE 构建索引：进度 → done/error */
  async function handleBuildIndex(file: KnowledgeFile) {
    if (buildFileId) return; // 一次只构建一个
    setBuildFileId(file.id);
    setBuildProgress((p) => ({ ...p, [file.id]: 0 }));
    try {
      const res = await fetch(`/api/knowledge/${kb!.id}/build-index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId: file.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream body");
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (true) {
        const { done: rd, value } = await reader.read();
        if (rd) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const lines = part.split("\n");
          let eventType = "";
          let eventData = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            else if (line.startsWith("data: ")) eventData = line.slice(6);
          }
          if (!eventData) continue;
          const payload = JSON.parse(eventData);
          if (eventType === "progress") {
            setBuildProgress((p) => ({ ...p, [file.id]: payload.percent }));
          } else if (eventType === "done") {
            done = true;
            setBuildProgress((p) => ({ ...p, [file.id]: 100 }));
          } else if (eventType === "error") {
            throw new Error(payload.message ?? "构建失败");
          }
        }
      }
      if (!done) throw new Error("流中断");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuildFileId(null);
      setBuildProgress((p) => {
        const next = { ...p };
        delete next[file.id];
        return next;
      });
      await load();
    }
  }

  async function handleDeleteIndex(file: KnowledgeFile) {
    if (!confirm(`删除「${file.name}」的向量索引？文件保留，可重新构建。`)) return;
    await fetch(`/api/knowledge/${kb!.id}/index?fileId=${file.id}`, { method: "DELETE" });
    await load();
  }

  async function handleDeleteFile(file: KnowledgeFile) {
    if (!confirm(`删除文件「${file.name}」及其全部索引？`)) return;
    await fetch(`/api/knowledge/${kb!.id}/files/${file.id}`, { method: "DELETE" });
    await load();
  }

  async function handleDeleteKb() {
    if (!kb || !confirm(`删除知识库「${kb.name}」及其全部文件与索引？`)) return;
    await fetch(`/api/knowledge/${kb.id}`, { method: "DELETE" });
    router.push("/knowledge");
    router.refresh();
  }

  async function handleEditSave() {
    if (!kb || !editName.trim()) return;
    const res = await fetch(`/api/knowledge/${kb.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: editName.trim(), description: editDesc.trim(), useRerank: editRerank }),
    });
    if (res.ok) {
      setEditOpen(false);
      await load();
    }
  }

  async function openVectorIndex(file?: KnowledgeFile) {
    setVecOpen(true);
    setVecExpanded(null);
    setVecSource(file?.name ?? "");
    await loadVectorIndex(0, file?.name ?? "");
  }

  const loadVectorIndex = useCallback(
    async (offset: number, source = "") => {
      setVecLoading(true);
      try {
        const params = new URLSearchParams({ offset: String(offset), limit: String(VEC_LIMIT) });
        if (source) params.set("source", source);
        const res = await fetch(`/api/knowledge/${id}/index?${params}`);
        if (!res.ok) throw new Error("加载向量索引失败");
        const data = await res.json();
        setVecItems(data.items ?? []);
        setVecTotal(data.total ?? 0);
        setVecOffset(offset);
        setVecSources(data.sources ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setVecLoading(false);
      }
    },
    [id],
  );

  async function openChunks(file: KnowledgeFile) {
    setChunksFile(file);
    setChunksOpen(true);
    const res = await fetch(`/api/knowledge/${kb!.id}/files/${file.id}/chunks`);
    if (res.ok) {
      const data = await res.json();
      setChunks(data.chunks ?? []);
    }
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

  if (loading) return <div className="page"><p className="muted">加载中…</p></div>;
  if (!kb) return <div className="page"><p className="muted">知识库不存在</p></div>;

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1>
          <Link href="/knowledge" className="muted" style={{ marginRight: 10, textDecoration: "none" }}>←</Link>
          {kb.name}
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => { setEditName(kb.name); setEditDesc(kb.description); setEditRerank(kb.useRerank); setEditOpen(true); }}>
            编辑
          </button>
          <button className="btn" onClick={() => void openVectorIndex()}>
            向量索引（{kb.files.reduce((s, f) => s + (f.indexStatus === "done" ? f.chunkCount : 0), 0)}）
          </button>
          <button className="btn danger" onClick={() => void handleDeleteKb()}>
            删除知识库
          </button>
        </div>
      </div>
      {kb.description && <p className="muted">{kb.description}</p>}
      <p className="muted">
        <code>{kb.id}</code> · {kb.files.length} 个文件 · 本地 SQLite 向量库
        {kb.useRerank && " · 已启用 cross-encoder 重排"}
      </p>

      {error && <p className="error">{error}</p>}

      <h3>上传文档（.txt / .md / .mdx，支持多选，单个 ≤2MB）</h3>
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
              {r.name}：{r.ok ? "已上传，可构建向量索引" : r.error}
            </li>
          ))}
        </ul>
      )}

      <h3>文件（{kb.files.length}）</h3>
      {kb.files.length === 0 ? (
        <p className="muted">还没有文件。上传后点「新建索引」进行向量化。</p>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th>文件名</th>
              <th>大小</th>
              <th>索引状态</th>
              <th>分块</th>
              <th>耗时</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {kb.files.map((f) => {
              const st = STATUS_META[f.indexStatus];
              const progress = buildProgress[f.id];
              return (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td>{formatBytes(f.size)}</td>
                  <td>
                    <span className={`kb-status ${st.cls}`} title={f.indexError ?? st.label}>
                      {st.label}
                    </span>
                    {progress !== undefined && (
                      <div className="kb-progress">
                        <div className="kb-progress-bar" style={{ width: `${progress}%` }} />
                      </div>
                    )}
                  </td>
                  <td>{f.chunkCount}</td>
                  <td>{formatDuration(f.indexDurationMs)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {f.indexStatus === "done" ? (
                        <button className="btn" onClick={() => void handleBuildIndex(f)} disabled={!!buildFileId}>
                          重建
                        </button>
                      ) : f.indexStatus === "building" ? (
                        <span className="muted">构建中…</span>
                      ) : (
                        <button className="btn primary" onClick={() => void handleBuildIndex(f)} disabled={!!buildFileId}>
                          新建索引
                        </button>
                      )}
                      {f.indexStatus === "done" && (
                        <>
                          <button className="btn" onClick={() => void handleDeleteIndex(f)}>
                            删索引
                          </button>
                          <button className="btn" onClick={() => void openVectorIndex(f)}>
                            向量
                          </button>
                        </>
                      )}
                      <button className="btn" onClick={() => void openChunks(f)}>
                        分块
                      </button>
                      <button className="btn danger" onClick={() => void handleDeleteFile(f)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3>检索预览（BM25 + 向量混合）</h3>
      <div className="field-inline">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
          placeholder="输入问题，例如：专业版定价多少"
        />
        <button className="btn primary" onClick={() => void handleSearch()} disabled={searching || !query.trim()}>
          {searching ? "检索中…" : "检索"}
        </button>
      </div>
      {searchResults.length > 0 && (
        <div className="search-results">
          {searchResults.map((c) => (
            <div key={c.id} className="search-hit">
              <div className="card-sub">【{c.fileName ?? "未知来源"}】片段 {c.chunkIndex + 1}</div>
              <p>{c.content}</p>
            </div>
          ))}
        </div>
      )}
      {!searching && query.trim() !== "" && searchResults.length === 0 && <p className="muted">未检索到相关内容（可先为文件构建向量索引）。</p>}

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
          <label className="tool-item" style={{ margin: "8px 0" }}>
            <input type="checkbox" checked={editRerank} onChange={(e) => setEditRerank(e.target.checked)} />
            <span>
              <code>cross-encoder 重排</code>
              <small>启用后用重排模型精算相关性（首次触发需下载模型，检索变慢但更准）</small>
            </span>
          </label>
          <div className="actions">
            <button className="btn primary" onClick={() => void handleEditSave()} disabled={!editName.trim()}>保存</button>
            <button className="btn" onClick={() => setEditOpen(false)}>取消</button>
          </div>
        </div>
      )}

      {vecOpen && (
        <div className="kb-dialog">
          <div className="kb-dialog-content">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <h3>向量索引（共 {vecTotal} 个向量）</h3>
              <button className="btn" onClick={() => setVecOpen(false)}>关闭</button>
            </div>
            <div className="field-inline" style={{ marginTop: 8 }}>
              <select value={vecSource} onChange={(e) => { setVecSource(e.target.value); void loadVectorIndex(0, e.target.value); }}>
                <option value="">全部来源</option>
                {vecSources.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            {vecLoading ? (
              <p className="muted">加载中…</p>
            ) : vecItems.length === 0 ? (
              <p className="muted">暂无向量（先为文件构建索引）</p>
            ) : (
              <div className="vec-list">
                {vecItems.map((it) => (
                  <div key={it.chunkId} className="vec-item">
                    <div className="card-sub">
                      【{it.fileName}】片段 {it.chunkIndex + 1} · 维度 {it.dim} · 向量 [{it.embeddingPreview.join(", ")}…]
                      <button className="btn" style={{ marginLeft: 8 }} onClick={() => setVecExpanded(vecExpanded === it.chunkId ? null : it.chunkId)}>
                        {vecExpanded === it.chunkId ? "收起" : "查看"}
                      </button>
                    </div>
                    {vecExpanded === it.chunkId && <p className="vec-content">{it.content}</p>}
                  </div>
                ))}
              </div>
            )}
            {vecTotal > VEC_LIMIT && (
              <div className="actions">
                <button className="btn" disabled={vecOffset <= 0} onClick={() => void loadVectorIndex(Math.max(0, vecOffset - VEC_LIMIT), vecSource)}>
                  上一页
                </button>
                <span className="muted">
                  {vecOffset + 1}-{Math.min(vecOffset + VEC_LIMIT, vecTotal)} / {vecTotal}
                </span>
                <button className="btn" disabled={vecOffset + VEC_LIMIT >= vecTotal} onClick={() => void loadVectorIndex(vecOffset + VEC_LIMIT, vecSource)}>
                  下一页
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {chunksOpen && chunksFile && (
        <div className="kb-dialog">
          <div className="kb-dialog-content">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <h3>分块查看：{chunksFile.name}（{chunks.length} 块）</h3>
              <button className="btn" onClick={() => setChunksOpen(false)}>关闭</button>
            </div>
            <div className="vec-list">
              {chunks.map((c) => (
                <div key={c.id} className="vec-item">
                  <div className="card-sub">片段 {c.chunkIndex + 1}</div>
                  <p className="vec-content">{c.content}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
