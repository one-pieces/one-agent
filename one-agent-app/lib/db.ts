import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "@one-agent/core";
import { decryptSecret, encryptSecret, isEncrypted } from "./crypto.ts";

/** 向量编码：number[]/Float32Array → Float32Array 二进制 BLOB（4B/维，约为 JSON 文本的 1/3） */
export function embeddingToBlob(embedding: number[] | Float32Array): Uint8Array {
  const arr = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** 向量解码：兼容 BLOB（新格式）与 JSON 文本（旧格式）两种落库 */
export function decodeEmbedding(value: string | Uint8Array | null | undefined): Float32Array {
  if (value == null) return new Float32Array(0);
  if (typeof value === "string") return Float32Array.from(JSON.parse(value) as number[]);
  return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
}

/** 多个知识库 id 的检索缓存键（顺序无关） */
function kbCacheKey(ids: string[]): string {
  return [...ids].sort().join("|");
}

/**
 * 应用层 Agent 配置存储（SQLite，node:sqlite 零依赖）。
 * 只存 AgentConfig（JSON 一等数据）；model.apiKey 加密存储（AES-256-GCM）。
 */
export class AppDatabase {
  private db: DatabaseSync;

  /** 数据版本：chunk/向量写入时自增，检索缓存（分块/向量/BM25）据此失效 */
  private version = 0;
  /** kbIds → 分块缓存（按 version 失效） */
  private chunksCache = new Map<string, { v: number; chunks: KnowledgeChunk[] }>();
  /** kbIds → 向量缓存（已解码为 Float32Array，避免每次查询重复解码/JSON.parse） */
  private vecCache = new Map<string, { v: number; vectors: StoredVector[] }>();

  constructor(filePath = join(process.cwd(), "data", "one-agent.db")) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    // WAL：多连接（dev server / 测试 / 后台任务）并发读写不互相阻塞
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id         TEXT PRIMARY KEY,
        config     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        vector_db_type TEXT NOT NULL DEFAULT 'sqlite',
        use_rerank     INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS knowledge_files (
        id                TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        name              TEXT NOT NULL,
        size              INTEGER NOT NULL,
        content           TEXT NOT NULL DEFAULT '',
        uploaded_at       TEXT NOT NULL,
        index_status      TEXT NOT NULL DEFAULT 'none',
        chunk_count       INTEGER NOT NULL DEFAULT 0,
        index_error       TEXT,
        indexed_at        TEXT,
        index_duration_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id                TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        file_id           TEXT NOT NULL,
        chunk_index       INTEGER NOT NULL,
        content           TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        chunk_id          TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        file_id           TEXT NOT NULL,
        dim               INTEGER NOT NULL,
        embedding         BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_files_kb   ON knowledge_files(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_kb  ON knowledge_chunks(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_kb ON knowledge_embeddings(knowledge_base_id);
    `);
    // 旧表迁移：为已存在的表补充列，并用已有分块回填文件原文（老版本上传时直接存了分块）
    const tableCols = (table: string): Set<string> =>
      new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
      );
    const kbCols = tableCols("knowledge_bases");
    if (!kbCols.has("vector_db_type")) {
      this.db.exec("ALTER TABLE knowledge_bases ADD COLUMN vector_db_type TEXT NOT NULL DEFAULT 'sqlite'");
    }
    if (!kbCols.has("use_rerank")) {
      this.db.exec("ALTER TABLE knowledge_bases ADD COLUMN use_rerank INTEGER NOT NULL DEFAULT 0");
    }
    const fileCols = tableCols("knowledge_files");
    for (const [col, def] of [
      ["content", "TEXT NOT NULL DEFAULT ''"],
      ["index_status", "TEXT NOT NULL DEFAULT 'none'"],
      ["chunk_count", "INTEGER NOT NULL DEFAULT 0"],
      ["index_error", "TEXT"],
      ["indexed_at", "TEXT"],
      ["index_duration_ms", "INTEGER"],
    ] as const) {
      if (!fileCols.has(col)) {
        this.db.exec(`ALTER TABLE knowledge_files ADD COLUMN ${col} ${def}`);
      }
    }
    // 旧数据回填：文件原文 = 已存分块拼接（老版本无 content 列）
    // 容错：dev server 与本进程同时连接同一 DB 时可能遇到锁，忽略等下次再迁移
    try {
      this.db.exec(
        `UPDATE knowledge_files
         SET content = (SELECT group_concat(content, '\n\n') FROM knowledge_chunks WHERE knowledge_chunks.file_id = knowledge_files.id)
         WHERE content = '' AND EXISTS (SELECT 1 FROM knowledge_chunks WHERE knowledge_chunks.file_id = knowledge_files.id)`,
      );
    } catch {
      /* 迁移失败（DB 被其他进程锁定）→ 跳过，下次启动重试 */
    }
  }

  listAgents(): AgentConfig[] {
    const rows = this.db.prepare("SELECT config FROM agents ORDER BY updated_at DESC").all() as { config: string }[];
    return rows.map((r) => withDecryptedKey(JSON.parse(r.config) as AgentConfig));
  }

  getAgent(id: string): AgentConfig | null {
    const row = this.db.prepare("SELECT config FROM agents WHERE id = ?").get(id) as { config: string } | undefined;
    return row ? withDecryptedKey(JSON.parse(row.config) as AgentConfig) : null;
  }

  createAgent(config: AgentConfig): AgentConfig {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO agents (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(config.id, JSON.stringify(withEncryptedKey(config)), now, now);
    return config;
  }

  updateAgent(config: AgentConfig): AgentConfig {
    this.db
      .prepare("UPDATE agents SET config = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(withEncryptedKey(config)), new Date().toISOString(), config.id);
    return config;
  }

  deleteAgent(id: string): void {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  // ── 知识库 ──

  listKnowledgeBases(): KnowledgeBase[] {
    const rows = this.db
      .prepare("SELECT * FROM knowledge_bases ORDER BY updated_at DESC")
      .all() as unknown as KnowledgeBaseRow[];
    return rows.map(rowToKnowledgeBase);
  }

  getKnowledgeBase(id: string): KnowledgeBase | null {
    const row = this.db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id) as
      | KnowledgeBaseRow
      | undefined;
    return row ? rowToKnowledgeBase(row) : null;
  }

  createKnowledgeBase(
    name: string,
    description = "",
    vectorDbType: KnowledgeBase["vectorDbType"] = "sqlite",
    useRerank = false,
  ): KnowledgeBase {
    const now = new Date().toISOString();
    const kb: KnowledgeBase = {
      id: `kb-${randomUUID().slice(0, 8)}`,
      name,
      description,
      createdAt: now,
      updatedAt: now,
      vectorDbType,
      useRerank,
    };
    this.db
      .prepare(
        "INSERT INTO knowledge_bases (id, name, description, created_at, updated_at, vector_db_type, use_rerank) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(kb.id, kb.name, kb.description, kb.createdAt, kb.updatedAt, kb.vectorDbType, kb.useRerank ? 1 : 0);
    return kb;
  }

  updateKnowledgeBase(
    id: string,
    patch: { name?: string; description?: string; vectorDbType?: KnowledgeBase["vectorDbType"]; useRerank?: boolean },
  ): KnowledgeBase | null {
    const existing = this.getKnowledgeBase(id);
    if (!existing) return null;
    const updated: KnowledgeBase = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.vectorDbType !== undefined ? { vectorDbType: patch.vectorDbType } : {}),
      ...(patch.useRerank !== undefined ? { useRerank: patch.useRerank } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "UPDATE knowledge_bases SET name = ?, description = ?, vector_db_type = ?, use_rerank = ?, updated_at = ? WHERE id = ?",
      )
      .run(updated.name, updated.description, updated.vectorDbType, updated.useRerank ? 1 : 0, updated.updatedAt, id);
    return updated;
  }

  /** 删除知识库：级联删除文件、分块与向量索引 */
  deleteKnowledgeBase(id: string): void {
    this.version++;
    this.db.prepare("DELETE FROM knowledge_embeddings WHERE knowledge_base_id = ?").run(id);
    this.db.prepare("DELETE FROM knowledge_chunks WHERE knowledge_base_id = ?").run(id);
    this.db.prepare("DELETE FROM knowledge_files WHERE knowledge_base_id = ?").run(id);
    this.db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(id);
  }

  listKnowledgeFiles(knowledgeBaseId: string): KnowledgeFile[] {
    const rows = this.db
      .prepare("SELECT * FROM knowledge_files WHERE knowledge_base_id = ? ORDER BY uploaded_at DESC")
      .all(knowledgeBaseId) as unknown as KnowledgeFileRow[];
    return rows.map(rowToKnowledgeFile);
  }

  getKnowledgeFile(knowledgeBaseId: string, fileId: string): KnowledgeFile | null {
    const row = this.db
      .prepare("SELECT * FROM knowledge_files WHERE id = ? AND knowledge_base_id = ?")
      .get(fileId, knowledgeBaseId) as KnowledgeFileRow | undefined;
    return row ? rowToKnowledgeFile(row) : null;
  }

  /** 上传文件：只存元数据 + 原文（索引由 build-index 另行构建，状态 none） */
  addKnowledgeFile(knowledgeBaseId: string, name: string, size: number, content: string): KnowledgeFile {
    const now = new Date().toISOString();
    const fileId = `kf-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        "INSERT INTO knowledge_files (id, knowledge_base_id, name, size, content, uploaded_at, index_status) VALUES (?, ?, ?, ?, ?, ?, 'none')",
      )
      .run(fileId, knowledgeBaseId, name, size, content, now);
    return {
      id: fileId,
      knowledgeBaseId,
      name,
      size,
      content,
      uploadedAt: now,
      indexStatus: "none",
      chunkCount: 0,
    };
  }

  /** 更新文件索引状态（构建进度/结果） */
  updateKnowledgeFileStatus(
    fileId: string,
    patch: Partial<Pick<KnowledgeFile, "indexStatus" | "chunkCount" | "indexError" | "indexedAt" | "indexDurationMs">>,
  ): void {
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    if (patch.indexStatus !== undefined) {
      sets.push("index_status = ?");
      vals.push(patch.indexStatus);
    }
    if (patch.chunkCount !== undefined) {
      sets.push("chunk_count = ?");
      vals.push(patch.chunkCount);
    }
    if (patch.indexError !== undefined) {
      sets.push("index_error = ?");
      vals.push(patch.indexError ?? null);
    }
    if (patch.indexedAt !== undefined) {
      sets.push("indexed_at = ?");
      vals.push(patch.indexedAt ?? null);
    }
    if (patch.indexDurationMs !== undefined) {
      sets.push("index_duration_ms = ?");
      vals.push(patch.indexDurationMs ?? null);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE knowledge_files SET ${sets.join(", ")} WHERE id = ?`).run(...vals, fileId);
  }

  deleteKnowledgeFile(knowledgeBaseId: string, fileId: string): boolean {
    this.version++;
    this.db.prepare("DELETE FROM knowledge_embeddings WHERE file_id = ?").run(fileId);
    this.db.prepare("DELETE FROM knowledge_chunks WHERE file_id = ?").run(fileId);
    const res = this.db
      .prepare("DELETE FROM knowledge_files WHERE id = ? AND knowledge_base_id = ?")
      .run(fileId, knowledgeBaseId);
    return res.changes > 0;
  }

  /** 只清某个文件的向量索引与分块（保留文件行，状态回到 none） */
  deleteFileIndex(fileId: string): void {
    this.version++;
    this.db.prepare("DELETE FROM knowledge_embeddings WHERE file_id = ?").run(fileId);
    this.db.prepare("DELETE FROM knowledge_chunks WHERE file_id = ?").run(fileId);
  }

  /** 重建某个文件的文本分块（先清后插） */
  replaceFileChunks(knowledgeBaseId: string, fileId: string, chunks: string[]): void {
    this.version++;
    this.db.prepare("DELETE FROM knowledge_chunks WHERE file_id = ?").run(fileId);
    const stmt = this.db.prepare(
      "INSERT INTO knowledge_chunks (id, knowledge_base_id, file_id, chunk_index, content) VALUES (?, ?, ?, ?, ?)",
    );
    chunks.forEach((content, i) => {
      stmt.run(`kc-${randomUUID().slice(0, 8)}`, knowledgeBaseId, fileId, i, content);
    });
  }

  /** 取单个文件的分块（查看分块），LEFT JOIN 向量表：已建索引的分块带 dim/embedding */
  getChunksForFile(knowledgeBaseId: string, fileId: string): KnowledgeChunk[] {
    return this.db
      .prepare(
        `SELECT c.id, c.knowledge_base_id AS knowledgeBaseId, c.file_id AS fileId,
                c.chunk_index AS chunkIndex, c.content,
                e.dim, e.embedding
         FROM knowledge_chunks c
         LEFT JOIN knowledge_embeddings e ON e.chunk_id = c.id
         WHERE c.knowledge_base_id = ? AND c.file_id = ?
         ORDER BY c.chunk_index`,
      )
      .all(knowledgeBaseId, fileId) as unknown as KnowledgeChunk[];
  }

  /** 取多个知识库的全部分块（BM25 检索），附带来源文件名；带版本缓存，写入后自动失效 */
  getChunksForKnowledgeBases(knowledgeBaseIds: string[]): KnowledgeChunk[] {
    if (knowledgeBaseIds.length === 0) return [];
    const key = kbCacheKey(knowledgeBaseIds);
    const hit = this.chunksCache.get(key);
    if (hit && hit.v === this.version) return hit.chunks;
    const placeholders = knowledgeBaseIds.map(() => "?").join(", ");
    const chunks = this.db
      .prepare(
        `SELECT c.id, c.knowledge_base_id AS knowledgeBaseId, c.file_id AS fileId, c.chunk_index AS chunkIndex, c.content, f.name AS fileName
         FROM knowledge_chunks c
         JOIN knowledge_files f ON f.id = c.file_id
         WHERE c.knowledge_base_id IN (${placeholders})
         ORDER BY c.knowledge_base_id, c.file_id, c.chunk_index`,
      )
      .all(...knowledgeBaseIds) as unknown as KnowledgeChunk[];
    this.chunksCache.set(key, { v: this.version, chunks });
    return chunks;
  }

  /** 保存某文件的分块向量（重建时先清后插）；以 BLOB（Float32Array 二进制）落库 */
  replaceEmbeddings(
    knowledgeBaseId: string,
    fileId: string,
    entries: Array<{ chunkId: string; embedding: number[] }>,
  ): void {
    this.version++;
    this.db.prepare("DELETE FROM knowledge_embeddings WHERE file_id = ?").run(fileId);
    const stmt = this.db.prepare(
      "INSERT INTO knowledge_embeddings (chunk_id, knowledge_base_id, file_id, dim, embedding) VALUES (?, ?, ?, ?, ?)",
    );
    for (const e of entries) {
      stmt.run(e.chunkId, knowledgeBaseId, fileId, e.embedding.length, embeddingToBlob(e.embedding));
    }
  }

  /** 取多个知识库的向量（向量检索），附带分块文本与来源 */
  getEmbeddingsForKnowledgeBases(knowledgeBaseIds: string[]): KnowledgeEmbeddingRow[] {
    if (knowledgeBaseIds.length === 0) return [];
    const placeholders = knowledgeBaseIds.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT e.chunk_id AS chunkId, e.dim, e.embedding,
                c.knowledge_base_id AS knowledgeBaseId, c.file_id AS fileId, c.chunk_index AS chunkIndex, c.content,
                f.name AS fileName
         FROM knowledge_embeddings e
         JOIN knowledge_chunks c ON c.id = e.chunk_id
         JOIN knowledge_files f ON f.id = c.file_id
         WHERE e.knowledge_base_id IN (${placeholders})
         ORDER BY e.knowledge_base_id, c.file_id, c.chunk_index`,
      )
      .all(...knowledgeBaseIds) as unknown as KnowledgeEmbeddingRow[];
  }

  /** 取多个知识库的向量（已解码为 Float32Array，带分块文本与来源）；带版本缓存，写入后自动失效 */
  getVectorChunks(knowledgeBaseIds: string[]): StoredVector[] {
    if (knowledgeBaseIds.length === 0) return [];
    const key = kbCacheKey(knowledgeBaseIds);
    const hit = this.vecCache.get(key);
    if (hit && hit.v === this.version) return hit.vectors;
    const vectors: StoredVector[] = this.getEmbeddingsForKnowledgeBases(knowledgeBaseIds).map((r) => ({
      chunk: {
        id: r.chunkId,
        knowledgeBaseId: r.knowledgeBaseId,
        fileId: r.fileId,
        chunkIndex: r.chunkIndex,
        content: r.content,
        fileName: r.fileName,
      },
      embedding: decodeEmbedding(r.embedding),
    }));
    this.vecCache.set(key, { v: this.version, vectors });
    return vectors;
  }

  /** 当前数据版本：chunk/向量写入时自增，供上层缓存（如 BM25）做失效判断 */
  getDataVersion(): number {
    return this.version;
  }

  /** 向量索引查看：分页 + 来源过滤，返回 { total, sources, items } */
  getVectorIndex(
    knowledgeBaseId: string,
    opts: { offset?: number; limit?: number; source?: string },
  ): { total: number; sources: string[]; items: KnowledgeEmbeddingRow[] } {
    const { offset = 0, limit = 50, source = "" } = opts;
    const sourceCond = source ? "AND f.name = ?" : "";
    const args: Array<string | number> = source ? [knowledgeBaseId, source] : [knowledgeBaseId];
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_embeddings e JOIN knowledge_chunks c ON c.id = e.chunk_id JOIN knowledge_files f ON f.id = c.file_id WHERE e.knowledge_base_id = ? ${sourceCond}`,
        )
        .get(...args) as { n: number }
    ).n;
    const sources = (
      this.db
        .prepare(
          "SELECT DISTINCT f.name AS name FROM knowledge_embeddings e JOIN knowledge_files f ON f.id = e.file_id WHERE e.knowledge_base_id = ? ORDER BY name",
        )
        .all(knowledgeBaseId) as Array<{ name: string }>
    ).map((r) => r.name);
    const items = this.db
      .prepare(
        `SELECT e.chunk_id AS chunkId, e.dim, e.embedding,
                c.knowledge_base_id AS knowledgeBaseId, c.file_id AS fileId, c.chunk_index AS chunkIndex, c.content,
                f.name AS fileName
         FROM knowledge_embeddings e
         JOIN knowledge_chunks c ON c.id = e.chunk_id
         JOIN knowledge_files f ON f.id = c.file_id
         WHERE e.knowledge_base_id = ? ${sourceCond}
         ORDER BY c.file_id, c.chunk_index
         LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as unknown as KnowledgeEmbeddingRow[];
    return { total, sources, items };
  }

  countEmbeddings(knowledgeBaseId: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_embeddings WHERE knowledge_base_id = ?").get(knowledgeBaseId) as {
        n: number;
      }
    ).n;
  }
}

/** 写库前加密 apiKey */
function withEncryptedKey(config: AgentConfig): AgentConfig {
  const apiKey = config.model.apiKey;
  if (apiKey && !isEncrypted(apiKey)) {
    return { ...config, model: { ...config.model, apiKey: encryptSecret(apiKey) } };
  }
  return config;
}

/** 读库后解密 apiKey */
function withDecryptedKey(config: AgentConfig): AgentConfig {
  const apiKey = config.model.apiKey;
  if (apiKey && isEncrypted(apiKey)) {
    try {
      return { ...config, model: { ...config.model, apiKey: decryptSecret(apiKey) } };
    } catch {
      return { ...config, model: { ...config.model, apiKey: "" } };
    }
  }
  return config;
}

export const db = new AppDatabase();

export function newAgentId(): string {
  return `agent-${randomUUID().slice(0, 8)}`;
}

// ── 知识库类型（SQLite 行 ↔ 对象） ──

export type KnowledgeIndexStatus = "none" | "building" | "done" | "error";

export type VectorDbType = "sqlite";

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /** 向量存储后端（当前内置 SQLite 持久化；预留 chroma/zvec） */
  vectorDbType: VectorDbType;
  /** 是否启用 cross-encoder 重排（首次触发需下载模型） */
  useRerank: boolean;
}

export interface KnowledgeFile {
  id: string;
  knowledgeBaseId: string;
  name: string;
  size: number;
  /** 提取的原文（上传时保存；索引构建时切分） */
  content: string;
  uploadedAt: string;
  /** 向量索引状态：none（未建）→ building → done / error */
  indexStatus: KnowledgeIndexStatus;
  chunkCount: number;
  indexError?: string | null;
  indexedAt?: string;
  indexDurationMs?: number;
}

export interface KnowledgeChunk {
  id: string;
  knowledgeBaseId: string;
  fileId: string;
  chunkIndex: number;
  content: string;
  /** 来源文件名（联表附带） */
  fileName?: string;
  /** 向量维度（分块已建索引时附带） */
  dim?: number | null;
  /** 向量（分块已建索引时附带）：BLOB（新格式）或旧版 JSON 数组字符串 */
  embedding?: string | Uint8Array | null;
}

/** 向量行：embedding + 联表附带的分块文本与来源 */
export interface KnowledgeEmbeddingRow {
  chunkId: string;
  dim: number;
  /** BLOB（新格式）或旧版 JSON 数组字符串 */
  embedding: string | Uint8Array;
  knowledgeBaseId: string;
  fileId: string;
  chunkIndex: number;
  content: string;
  fileName: string;
}

/** 检索用向量：embedding 已解码为 Float32Array（避免每次查询重复 JSON.parse/解码） */
export interface StoredVector {
  chunk: KnowledgeChunk;
  embedding: Float32Array;
}

interface KnowledgeBaseRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  vector_db_type: VectorDbType;
  use_rerank: number;
}

interface KnowledgeFileRow {
  id: string;
  knowledge_base_id: string;
  name: string;
  size: number;
  content: string;
  uploaded_at: string;
  index_status: KnowledgeIndexStatus;
  chunk_count: number;
  index_error: string | null;
  indexed_at: string | null;
  index_duration_ms: number | null;
}

function rowToKnowledgeBase(r: KnowledgeBaseRow): KnowledgeBase {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    vectorDbType: r.vector_db_type ?? "sqlite",
    useRerank: (r.use_rerank ?? 0) === 1,
  };
}

function rowToKnowledgeFile(r: KnowledgeFileRow): KnowledgeFile {
  return {
    id: r.id,
    knowledgeBaseId: r.knowledge_base_id,
    name: r.name,
    size: r.size,
    content: r.content ?? "",
    uploadedAt: r.uploaded_at,
    indexStatus: r.index_status ?? "none",
    chunkCount: r.chunk_count ?? 0,
    ...(r.index_error ? { indexError: r.index_error } : {}),
    ...(r.indexed_at ? { indexedAt: r.indexed_at } : {}),
    ...(r.index_duration_ms !== null && r.index_duration_ms !== undefined ? { indexDurationMs: r.index_duration_ms } : {}),
  };
}
