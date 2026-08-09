import { DatabaseSync } from "node:sqlite";
import type { Session } from "./types.ts";
import type { SessionStore } from "./interfaces.ts";

/**
 * SQLite 会话存储（基于 Node 内置 node:sqlite，零第三方依赖）。
 * 默认 :memory:（单进程内共享）；传文件路径可跨进程/重启持久化。
 */
export class SqliteSessionStore implements SessionStore {
  private db: DatabaseSync;

  constructor(filePath = ":memory:") {
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL,
        data       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    `);
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare("SELECT data FROM sessions WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }

  async saveSession(session: Session): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_id = excluded.agent_id,
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(session.id, session.agentId, JSON.stringify(session), session.createdAt, session.updatedAt);
  }

  async listSessions(agentId?: string): Promise<Session[]> {
    const rows = agentId
      ? (this.db.prepare("SELECT data FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC").all(agentId) as { data: string }[])
      : (this.db.prepare("SELECT data FROM sessions ORDER BY updated_at DESC").all() as { data: string }[]);
    return rows.map((r) => JSON.parse(r.data) as Session);
  }

  async deleteSession(id: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
