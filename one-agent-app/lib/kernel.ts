import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Agent,
  ToolRegistry,
  builtinTools,
  createProvider,
  SqliteSessionStore,
  validateAgentConfig,
  type AgentConfig,
  type LanguageProvider,
  type ProviderConfig,
  type Session,
  type StreamChunk,
  type ToolCall,
  type ToolSpec,
} from "@one-agent/core";
import { createLoggingFetch } from "./observability.ts";
import { createKnowledgeSearchTool } from "./knowledge-tool.ts";

/** 会话级配置覆盖（存在 Session.meta，每轮自动生效）—— 多会话模型/工具隔离的核心 */
export interface SessionOverrides {
  modelOverride?: Partial<ProviderConfig>;
  toolOverrides?: Array<{ name: string; enabled: boolean }>;
  /** 会话级：是否允许执行危险工具（Web 默认拒绝） */
  allowDangerous?: boolean;
}

type ToolOverride = SessionOverrides["toolOverrides"];

/**
 * InProcessKernel：应用层唯一依赖的内核面（§6.8 KernelClient）。
 * 进程内直调 @one-agent/core；未来可换成 HttpKernel 指向 Python 内核实现，接口不变。
 * - Agent 实例按 config 缓存，配置变更后自动失效重建 → 动态配置即时生效
 * - 会话覆盖（modelOverride/toolOverrides）存在 session.meta，每轮自动合并
 */
export class InProcessKernel {
  private cache = new Map<string, { config: AgentConfig; agent: Agent }>();
  private providerFactory: (kind: ProviderConfig["provider"]) => LanguageProvider;
  readonly store: SqliteSessionStore;
  /** 会话工作区根目录（与 sessions.db 同级：data/workspace）—— agent 文件类工具的相对路径基准 */
  readonly workspaceRoot: string;

  constructor(
    sessionDbPath = join(process.cwd(), "data", "sessions.db"),
    deps?: { providerFactory?: (kind: ProviderConfig["provider"]) => LanguageProvider },
  ) {
    mkdirSync(dirname(sessionDbPath), { recursive: true });
    this.store = new SqliteSessionStore(sessionDbPath);
    this.workspaceRoot = join(dirname(sessionDbPath), "workspace");
    // 默认注入日志型 fetch → 每次 LLM 请求记录到 /api/logs
    this.providerFactory =
      deps?.providerFactory ?? ((kind) => createProvider(kind, { fetch: createLoggingFetch() }));
  }

  /** 会话级工作区路径；sessionId 带路径穿越时抛错（只允许落在 workspaceRoot 内） */
  sessionWorkspacePath(sessionId: string): string {
    const root = resolve(this.workspaceRoot);
    const target = resolve(root, sessionId);
    if (target === root || !target.startsWith(root + sep)) {
      throw new Error(`非法会话工作区路径: ${sessionId}`);
    }
    return target;
  }

  private getOrCreate(config: AgentConfig): Agent {
    // 关联了知识库但未在 tools 里启用 knowledge_search 时自动启用（表单或直连 API 都覆盖）
    if (config.knowledgeBaseIds?.length && !config.tools.some((t) => t.name === "knowledge_search")) {
      config = { ...config, tools: [...config.tools, { name: "knowledge_search", enabled: true }] };
    }
    const cached = this.cache.get(config.id);
    if (cached && JSON.stringify(cached.config) === JSON.stringify(config)) return cached.agent;

    const registry = new ToolRegistry();
    for (const t of builtinTools) registry.add(t);
    if (config.knowledgeBaseIds?.length) registry.add(createKnowledgeSearchTool(config.knowledgeBaseIds));
    const agent = new Agent(validateAgentConfig(config), {
      provider: this.providerFactory(config.model.provider),
      tools: registry,
      sessionStore: this.store,
    });
    this.cache.set(config.id, { config, agent });
    return agent;
  }

  /** 配置变更后调用，强制下次重建 Agent（动态配置即时生效） */
  invalidate(agentId: string): void {
    this.cache.delete(agentId);
  }

  /**
   * 流式对话。优先用请求级 override；未提供则回落到会话 meta 中的覆盖。
   * 会话覆盖 → 同一 Agent、不同会话可用不同模型/工具，互不干扰（多用户模型隔离）。
   */
  async *runChat(req: {
    agentConfig: AgentConfig;
    sessionId: string;
    message: string;
    signal?: AbortSignal;
    modelOverride?: Partial<ProviderConfig>;
    toolOverrides?: ToolOverride;
    /** 危险工具审批：返回 false 拒绝（未提供则危险工具默认放行） */
    onApproval?: (call: ToolCall, tool: ToolSpec) => boolean | Promise<boolean>;
  }): AsyncIterable<StreamChunk> {
    const session = await this.store.getSession(req.sessionId);
    const meta = (session?.meta ?? {}) as SessionOverrides;

    const modelOverride = req.modelOverride ?? meta.modelOverride;
    const toolOverrides = req.toolOverrides ?? meta.toolOverrides;

    const agent = this.getOrCreate(req.agentConfig);
    // 确保会话工作区已存在（run_local_command 等以它为 cwd 的工具需要目录就绪）
    mkdirSync(this.sessionWorkspacePath(req.sessionId), { recursive: true });
    yield* agent.run(req.message, {
      sessionId: req.sessionId,
      signal: req.signal,
      // 工具相对路径基准：会话级工作区（data/workspace/{sessionId}），避免 agent 文件写入服务进程目录
      cwd: this.sessionWorkspacePath(req.sessionId),
      ...(modelOverride ? { modelOverride } : {}),
      ...(toolOverrides ? { toolOverrides } : {}),
      ...(req.onApproval ? { onApproval: req.onApproval } : {}),
    });
  }

  /** 更新会话覆盖（modelOverride/toolOverrides；传 null 清除对应项；allowDangerous 单独处理） */
  async updateSessionOverrides(
    sessionId: string,
    patch: {
      modelOverride?: Partial<ProviderConfig> | null;
      toolOverrides?: ToolOverride | null;
      allowDangerous?: boolean;
    },
  ): Promise<Session | null> {
    const session = await this.store.getSession(sessionId);
    if (!session) return null;
    const meta: SessionOverrides = { ...(session.meta as SessionOverrides | undefined) };
    if (patch.modelOverride === null) delete meta.modelOverride;
    else if (patch.modelOverride !== undefined) meta.modelOverride = patch.modelOverride;
    if (patch.toolOverrides === null) delete meta.toolOverrides;
    else if (patch.toolOverrides !== undefined) meta.toolOverrides = patch.toolOverrides;
    if (patch.allowDangerous !== undefined) {
      if (patch.allowDangerous) meta.allowDangerous = true;
      else delete meta.allowDangerous;
    }
    session.meta = meta as Record<string, unknown>;
    session.updatedAt = new Date().toISOString();
    await this.store.saveSession(session);
    return session;
  }

  /** 删除会话中的一条消息（用于前端消息删除） */
  async removeMessage(sessionId: string, messageId: string): Promise<Session | null> {
    const session = await this.store.getSession(sessionId);
    if (!session) return null;
    session.messages = session.messages.filter((m) => m.id !== messageId);
    session.updatedAt = new Date().toISOString();
    await this.store.saveSession(session);
    return session;
  }

  /** 删除会话：同时清理对应会话工作区文件（防止孤儿文件堆积） */
  async deleteSession(sessionId: string): Promise<void> {
    await this.store.deleteSession(sessionId);
    try {
      await rm(this.sessionWorkspacePath(sessionId), { recursive: true, force: true });
    } catch {
      // 工作区不存在或路径非法 → 忽略（DB 记录已删除）
    }
  }

  createSession(agentId: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: `session-${randomUUID().slice(0, 8)}`,
      agentId,
      messages: [],
      createdAt: now,
      updatedAt: now,
      meta: {},
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
