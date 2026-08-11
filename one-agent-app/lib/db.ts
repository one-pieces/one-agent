import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "@one-agent/core";
import { decryptSecret, encryptSecret, isEncrypted } from "./crypto.ts";

/**
 * 应用层 Agent 配置存储（SQLite，node:sqlite 零依赖）。
 * 只存 AgentConfig（JSON 一等数据）；model.apiKey 加密存储（AES-256-GCM）。
 */
export class AppDatabase {
  private db: DatabaseSync;

  constructor(filePath = join(process.cwd(), "data", "one-agent.db")) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id         TEXT PRIMARY KEY,
        config     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_files (
        id                TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        name              TEXT NOT NULL,
        size              INTEGER NOT NULL,
        uploaded_at       TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'done',
        chunk_count       INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id                TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        file_id           TEXT NOT NULL,
        chunk_index       INTEGER NOT NULL,
        content           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_files_kb   ON knowledge_files(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_kb  ON knowledge_chunks(knowledge_base_id);
    `);
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

  createKnowledgeBase(name: string, description: string): KnowledgeBase {
    const now = new Date().toISOString();
    const kb: KnowledgeBase = {
      id: `kb-${randomUUID().slice(0, 8)}`,
      name,
      description,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare("INSERT INTO knowledge_bases (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(kb.id, kb.name, kb.description, kb.createdAt, kb.updatedAt);
    return kb;
  }

  updateKnowledgeBase(id: string, patch: { name?: string; description?: string }): KnowledgeBase | null {
    const existing = this.getKnowledgeBase(id);
    if (!existing) return null;
    const updated: KnowledgeBase = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare("UPDATE knowledge_bases SET name = ?, description = ?, updated_at = ? WHERE id = ?")
      .run(updated.name, updated.description, updated.updatedAt, id);
    return updated;
  }

  /** 删除知识库：级联删除其文件与分块 */
  deleteKnowledgeBase(id: string): void {
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

  addKnowledgeFile(knowledgeBaseId: string, name: string, size: number, chunks: string[]): KnowledgeFile {
    const now = new Date().toISOString();
    const fileId = `kf-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        "INSERT INTO knowledge_files (id, knowledge_base_id, name, size, uploaded_at, status, chunk_count) VALUES (?, ?, ?, ?, ?, 'done', ?)",
      )
      .run(fileId, knowledgeBaseId, name, size, now, chunks.length);
    const chunkStmt = this.db.prepare(
      "INSERT INTO knowledge_chunks (id, knowledge_base_id, file_id, chunk_index, content) VALUES (?, ?, ?, ?, ?)",
    );
    chunks.forEach((content, i) => {
      chunkStmt.run(`kc-${randomUUID().slice(0, 8)}`, knowledgeBaseId, fileId, i, content);
    });
    return { id: fileId, knowledgeBaseId, name, size, uploadedAt: now, status: "done", chunkCount: chunks.length };
  }

  deleteKnowledgeFile(knowledgeBaseId: string, fileId: string): boolean {
    this.db.prepare("DELETE FROM knowledge_chunks WHERE file_id = ?").run(fileId);
    const res = this.db
      .prepare("DELETE FROM knowledge_files WHERE id = ? AND knowledge_base_id = ?")
      .run(fileId, knowledgeBaseId);
    return res.changes > 0;
  }

  /** 取多个知识库的全部分块（供检索），附带来源文件名 */
  getChunksForKnowledgeBases(knowledgeBaseIds: string[]): KnowledgeChunk[] {
    if (knowledgeBaseIds.length === 0) return [];
    const placeholders = knowledgeBaseIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT c.id, c.knowledge_base_id AS knowledgeBaseId, c.file_id AS fileId, c.chunk_index AS chunkIndex, c.content, f.name AS fileName
         FROM knowledge_chunks c
         JOIN knowledge_files f ON f.id = c.file_id
         WHERE c.knowledge_base_id IN (${placeholders})
         ORDER BY c.knowledge_base_id, c.file_id, c.chunk_index`,
      )
      .all(...knowledgeBaseIds) as unknown as KnowledgeChunk[];
    return rows;
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

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeFile {
  id: string;
  knowledgeBaseId: string;
  name: string;
  size: number;
  uploadedAt: string;
  status: KnowledgeIndexStatus;
  chunkCount: number;
}

export interface KnowledgeChunk {
  id: string;
  knowledgeBaseId: string;
  fileId: string;
  chunkIndex: number;
  content: string;
  /** 来源文件名（getChunksForKnowledgeBases 联表附带） */
  fileName?: string;
}

interface KnowledgeBaseRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface KnowledgeFileRow {
  id: string;
  knowledge_base_id: string;
  name: string;
  size: number;
  uploaded_at: string;
  status: KnowledgeIndexStatus;
  chunk_count: number;
}

function rowToKnowledgeBase(r: KnowledgeBaseRow): KnowledgeBase {
  return { id: r.id, name: r.name, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at };
}

function rowToKnowledgeFile(r: KnowledgeFileRow): KnowledgeFile {
  return {
    id: r.id,
    knowledgeBaseId: r.knowledge_base_id,
    name: r.name,
    size: r.size,
    uploadedAt: r.uploaded_at,
    status: r.status,
    chunkCount: r.chunk_count,
  };
}
