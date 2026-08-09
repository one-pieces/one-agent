import type { Session } from "./types.js";
import type { SessionStore } from "./interfaces.js";

/** 内存会话存储（默认实现；进程重启即丢失） */
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  async getSession(id: string): Promise<Session | null> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async listSessions(agentId?: string): Promise<Session[]> {
    const all = [...this.sessions.values()];
    return structuredClone(agentId ? all.filter((s) => s.agentId === agentId) : all);
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}
