import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Agent,
  ToolRegistry,
  builtinTools,
  SqliteSessionStore,
  validateAgentConfig,
  type AgentConfig,
  type Session,
  type StreamChunk,
} from "@one-agent/core";

/**
 * InProcessKernel：应用层唯一依赖的内核面（§6.8 KernelClient）。
 * 进程内直调 @one-agent/core；未来可换成 HttpKernel 指向 Python 内核实现，接口不变。
 * - Agent 实例按 config 缓存，配置变更后自动失效重建 → 动态配置即时生效
 * - 会话持久化用内核 SqliteSessionStore（跨进程重启可恢复）
 */
export class InProcessKernel {
  private cache = new Map<string, { config: AgentConfig; agent: Agent }>();
  readonly store: SqliteSessionStore;

  constructor(sessionDbPath = join(process.cwd(), "data", "sessions.db")) {
    mkdirSync(dirname(sessionDbPath), { recursive: true });
    this.store = new SqliteSessionStore(sessionDbPath);
  }

  private getOrCreate(config: AgentConfig): Agent {
    const cached = this.cache.get(config.id);
    if (cached && JSON.stringify(cached.config) === JSON.stringify(config)) return cached.agent;

    const registry = new ToolRegistry();
    for (const t of builtinTools) registry.add(t);
    const agent = new Agent(validateAgentConfig(config), { tools: registry, sessionStore: this.store });
    this.cache.set(config.id, { config, agent });
    return agent;
  }

  /** 配置变更后调用，强制下次重建 Agent（动态配置即时生效） */
  invalidate(agentId: string): void {
    this.cache.delete(agentId);
  }

  runChat(req: {
    agentConfig: AgentConfig;
    sessionId: string;
    message: string;
    signal?: AbortSignal;
  }): AsyncIterable<StreamChunk> {
    const agent = this.getOrCreate(req.agentConfig);
    return agent.run(req.message, { sessionId: req.sessionId, signal: req.signal });
  }

  createSession(agentId: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: `session-${randomUUID().slice(0, 8)}`,
      agentId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    void this.store.saveSession(session);
    return session;
  }

  getSession(id: string): Promise<Session | null> {
    return this.store.getSession(id);
  }

  listSessions(agentId?: string): Promise<Session[]> {
    return this.store.listSessions(agentId);
  }
}

export const kernel = new InProcessKernel();
