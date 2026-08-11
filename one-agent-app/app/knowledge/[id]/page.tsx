"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Database,
  ExternalLink,
  FileText,
  List,
  Loader2,
  Pencil,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import type { KnowledgeBase, KnowledgeChunk, KnowledgeFile, KnowledgeIndexStatus } from "@/lib/db";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import Select from "@/components/ui/Select";

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
  const [uploadResults, setUploadResults] = useState<Array<{ id: string; name: string; ok: boolean; error?: string; extra?: string }>>([]);

  // 编辑面板
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editRerank, setEditRerank] = useState(false);

  // 索引构建进度：fileId → percent
  const [buildProgress, setBuildProgress] = useState<Record<string, number>>({});
  const [buildFileId, setBuildFileId] = useState<string | null>(null);

  // 向量/分块查看器（统一弹窗，eve 表格风格）
  const [vecOpen, setVecOpen] = useState(false);
  const [vecItems, setVecItems] = useState<VectorIndexItem[]>([]);
  const [vecTotal, setVecTotal] = useState(0);
  const [vecOffset, setVecOffset] = useState(0);
  const [vecSources, setVecSources] = useState<string[]>([]);
  const [vecSource, setVecSource] = useState("");
  const [vecLoading, setVecLoading] = useState(false);
  const [vecExpanded, setVecExpanded] = useState<string | null>(null);
  /** 当前查看的文件（null = 全库向量） */
  const [viewerFile, setViewerFile] = useState<KnowledgeFile | null>(null);

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

  /** 打开统一查看器：file 给定 → 该文件的分块+向量（chunks API）；null → 全库向量索引（index API，分页） */
  async function openViewer(file?: KnowledgeFile) {
    setVecOpen(true);
    setVecExpanded(null);
    setViewerFile(file ?? null);
    setVecSource(file?.name ?? "");
    if (file) {
      await loadFileViewer(file);
    } else {
      await loadVectorIndex(0, "");
    }
  }

  /** 加载单个文件的分块+向量（无分页，chunks API 已带向量信息） */
  const loadFileViewer = useCallback(
    async (file: KnowledgeFile) => {
      setVecLoading(true);
      try {
        const res = await fetch(`/api/knowledge/${id}/files/${file.id}/chunks`);
        if (!res.ok) throw new Error("加载分块失败");
        const data = await res.json();
        setVecItems(data.items ?? []);
        setVecTotal(data.total ?? 0);
        setVecOffset(0);
        setVecSources([]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setVecLoading(false);
      }
    },
    [id],
  );

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

  const indexedCount = kb.files.reduce((s, f) => s + (f.indexStatus === "done" ? f.chunkCount : 0), 0);

  return (
    <div className="page">
      {/* ═══ Header：返回 + 标题/描述 + 右侧操作 ═══ */}
      <div className="kb-header">
        <Link
          href="/knowledge"
          className="kb-header-back"
          title="返回知识库列表"
        >
          <ArrowLeft />
        </Link>
        <div className="kb-header-info">
          <div className="kb-header-title-row">
            <h1>{kb.name}</h1>
            <span className="kb-badge">{kb.vectorDbType === "sqlite" ? "SQLite 向量" : kb.vectorDbType}</span>
            {kb.useRerank && <span className="kb-badge kb-badge-rerank">重排</span>}
          </div>
          {kb.description && <p className="kb-header-desc">{kb.description}</p>}
        </div>
        <div className="kb-header-actions">
          <button className="btn" onClick={() => void openViewer()} title="查看向量索引">
            <List style={{ verticalAlign: -2, marginRight: 4 }} />
            向量索引（{indexedCount}）
          </button>
          <button
            className="btn"
            onClick={() => { setEditName(kb.name); setEditDesc(kb.description); setEditRerank(kb.useRerank); setEditOpen(true); }}
            title="编辑知识库"
          >
            <Pencil style={{ verticalAlign: -2, marginRight: 4 }} />
            编辑
          </button>
          <button className="btn danger" onClick={() => void handleDeleteKb()} title="删除知识库">
            <Trash2 style={{ verticalAlign: -2, marginRight: 4 }} />
            删除
          </button>
          <button className="btn primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="kb-spin" style={{ verticalAlign: -2, marginRight: 4 }} /> : <Upload style={{ verticalAlign: -2, marginRight: 4 }} />}
            {uploading ? "上传中…" : "上传文档"}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.mdx,.markdown,.pdf"
          multiple
          className="kb-hidden-input"
          onChange={(e) => void handleUpload(e.target.files)}
        />
      </div>

      {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
      {uploadResults.length > 0 && (
        <ul className="upload-results">
          {uploadResults.map((r, i) => (
            <li key={i} className={r.ok ? "ok" : "error"}>
              {r.name}：{r.ok ? `已上传${r.extra ? `（${r.extra}）` : ""}，可构建向量索引` : r.error}
            </li>
          ))}
        </ul>
      )}

      {/* ═══ 文件列表（卡片式，对齐 eve）═══ */}
      {kb.files.length === 0 ? (
        <div className="kb-empty">
          <FileText className="kb-empty-icon" />
          <p>还没有文件，点击右上角「上传文档」添加。</p>
        </div>
      ) : (
        <div className="kb-file-list">
          {kb.files.map((f) => {
            const st = STATUS_META[f.indexStatus];
            const progress = buildProgress[f.id];
            return (
              <div key={f.id} className="kb-file-item">
                <FileText className="kb-file-icon shrink-0" />
                <div className="kb-file-main">
                  <p className="kb-file-name">{f.name}</p>
                  <div className="kb-file-meta">
                    <span>{formatBytes(f.size)}</span>
                    <span>·</span>
                    <span>{new Date(f.uploadedAt).toLocaleString("zh-CN")}</span>
                    {f.indexStatus === "done" && (
                      <>
                        <span>·</span>
                        <span className="kb-meta-ok"><CheckCircle2  /> 已索引 {f.chunkCount} 块</span>
                        {f.indexedAt && (
                          <>
                            <span>·</span>
                            <span>索引于 {new Date(f.indexedAt).toLocaleString("zh-CN")}</span>
                          </>
                        )}
                        {f.indexDurationMs !== undefined && (
                          <>
                            <span>·</span>
                            <span>耗时 {formatDuration(f.indexDurationMs)}</span>
                          </>
                        )}
                      </>
                    )}
                    {f.indexStatus === "error" && (
                      <>
                        <span>·</span>
                        <span className="kb-meta-error" title={f.indexError ?? st.label}>
                          <XCircle  /> 索引失败
                        </span>
                      </>
                    )}
                    {f.indexStatus === "none" && (
                      <>
                        <span>·</span>
                        <span className="muted">{st.label}</span>
                      </>
                    )}
                  </div>
                  {progress !== undefined && (
                    <div className="kb-progress-inline">
                      <div className="kb-progress-bar" style={{ width: `${progress}%` }} />
                      <span className="kb-progress-text">{progress}%</span>
                    </div>
                  )}
                </div>

                <div className="kb-file-actions">
                  <button className="btn btn-xs" onClick={() => void openViewer(f)} title={f.indexStatus === "done" ? "查看该文件的分块与向量索引" : "查看该文件的文本分块"}>
                    <List style={{ verticalAlign: -2, marginRight: 4 }} />查看索引
                  </button>
                  <button className="btn btn-xs" onClick={() => window.open(`/api/knowledge/${kb!.id}/files/${f.id}/content`, "_blank", "noopener,noreferrer")} title="在新窗口查看文件原文">
                    <ExternalLink style={{ verticalAlign: -2, marginRight: 4 }} />查看文件
                  </button>
                  {f.indexStatus === "building" ? (
                    <span className="muted kb-building-label">
                      <Loader2 className="kb-spin" /> 构建中…
                    </span>
                  ) : f.indexStatus === "done" ? (
                    <>
                      <button className="btn btn-xs" onClick={() => void handleBuildIndex(f)} disabled={!!buildFileId} title="重新构建索引">
                        <Database style={{ verticalAlign: -2, marginRight: 4 }} />重建
                      </button>
                      <button className="btn btn-xs" onClick={() => void handleDeleteIndex(f)} title="删除向量索引（文件保留）">
                        删索引
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-xs primary" onClick={() => void handleBuildIndex(f)} disabled={!!buildFileId} title="构建向量索引">
                      <Database style={{ verticalAlign: -2, marginRight: 4 }} />新建索引
                    </button>
                  )}
                  <button
                    className="kb-file-delete"
                    onClick={() => void handleDeleteFile(f)}
                    title="删除文件及其索引"
                  >
                    <Trash2  />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ 检索预览 ═══ */}
      <h3 style={{ marginTop: 28 }}>检索预览（BM25 + 向量混合）</h3>
      <div className="field-inline" style={{ maxWidth: 560 }}>
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

      {/* ═══ 编辑 Dialog（radix-ui）═══ */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="ui-dialog-narrow">
          <DialogHeader>
            <DialogTitle>编辑知识库</DialogTitle>
            <DialogDescription>修改名称、描述与检索设置</DialogDescription>
          </DialogHeader>
          <div className="field">
            <label>名称 *</label>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
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
          <DialogFooter>
            <DialogClose asChild>
              <button className="btn">取消</button>
            </DialogClose>
            <button className="btn primary" onClick={() => void handleEditSave()} disabled={!editName.trim()}>保存</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ 分块 + 向量查看器 Dialog（radix-ui，eve 表格风格）═══ */}
      <Dialog open={vecOpen} onOpenChange={setVecOpen}>
        <DialogContent className="ui-dialog-wide">
          <DialogHeader>
            <DialogTitle className="kb-dialog-title">
              {viewerFile ? <FileText /> : <Database />}
              {viewerFile ? `分块与向量：${viewerFile.name}` : `向量索引（共 ${vecTotal} 个向量）`}
            </DialogTitle>
            <DialogDescription>
              {viewerFile ? (
                `共 ${vecTotal} 条${viewerFile.indexStatus === "done" ? "（含向量）" : "（未建索引，无向量）"}`
              ) : (
                <span className="kb-dialog-toolbar-inline">
                  <Select
                    value={vecSource}
                    onChange={(v) => { setVecSource(v); void loadVectorIndex(0, v); }}
                    options={[{ value: "", label: "全部来源" }, ...vecSources.map((s) => ({ value: s, label: s }))]}
                    placeholder="全部来源"
                  />
                  <span className="muted">{vecOffset + 1}-{Math.min(vecOffset + VEC_LIMIT, vecTotal)} / {vecTotal}</span>
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {vecLoading ? (
            <p className="muted kb-dialog-loading"><Loader2 className="kb-spin" /> 加载中…</p>
          ) : vecItems.length === 0 ? (
            <p className="muted kb-dialog-empty">暂无数据（先为文件构建索引）</p>
          ) : (
            <div className="kb-vec-table-wrap">
              <table className="kb-vec-table">
                <thead>
                  <tr>
                    <th className="kb-col-idx">#</th>
                    {!viewerFile && <th className="kb-col-src">来源</th>}
                    <th>内容</th>
                    <th className="kb-col-emb">Embedding</th>
                  </tr>
                </thead>
                <tbody>
                  {vecItems.map((it, idx) => {
                    const isExpanded = vecExpanded === it.chunkId;
                    const textPreview = it.content.length > 120 ? it.content.slice(0, 120) + "…" : it.content;
                    return (
                      <tr
                        key={it.chunkId}
                        className={isExpanded ? "kb-row-expanded" : ""}
                        onClick={() => setVecExpanded(isExpanded ? null : it.chunkId)}
                        title={it.content.length > 120 ? "点击展开/收起全文" : undefined}
                      >
                        <td className="kb-col-idx">{vecOffset + idx + 1}</td>
                        {!viewerFile && <td className="kb-col-src">{it.fileName}</td>}
                        <td>
                          <p className="kb-cell-text">{isExpanded ? it.content : textPreview}</p>
                          {it.content.length > 120 && (
                            <span className="kb-cell-chars">{it.content.length} chars</span>
                          )}
                        </td>
                        <td className="kb-col-emb">
                          {it.dim > 0 ? (
                            <>
                              <span className="kb-emb-preview">[{it.embeddingPreview.join(", ")}, …]</span>
                              <br />
                              <span className="muted">dim={it.dim}</span>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!viewerFile && vecTotal > VEC_LIMIT && (
            <DialogFooter>
              <button className="btn" disabled={vecOffset <= 0} onClick={() => void loadVectorIndex(Math.max(0, vecOffset - VEC_LIMIT), vecSource)}>
                上一页
              </button>
              <span className="muted">
                {vecOffset + 1}-{Math.min(vecOffset + VEC_LIMIT, vecTotal)} / {vecTotal}
              </span>
              <button className="btn" disabled={vecOffset + VEC_LIMIT >= vecTotal} onClick={() => void loadVectorIndex(vecOffset + VEC_LIMIT, vecSource)}>
                下一页
              </button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
