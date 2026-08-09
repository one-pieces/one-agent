import type { Session } from "./types.js";

/**
 * 会话存储接口（内核只定义接口，实现可插拔：内存 / SQLite / Postgres…）
 * 应用层/未来 Python 内核实现同一契约。
 */
export interface SessionStore {
  getSession(id: string): Promise<Session | null>;
  /** upsert：不存在则创建，存在则整体覆盖 */
  saveSession(session: Session): Promise<void>;
  listSessions(agentId?: string): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;
}
